// The capability appq:automate's own prompt (Phase 0/3/5/6) assumes a full
// coding-agent session has: read/write a local repo, and run real shell
// commands to bootstrap Playwright and actually verify the generated spec.
// Every path is scoped to repoPath (no traversal out of it); every command
// goes through commandGate.ts's allowlist AND is spawned via execFile with
// an explicit argv array — never a shell string — so the OS never parses
// arguments as shell syntax in the first place.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import type { LlmToolDef, ToolResult } from '@appliqation/agent-core';
import { assertCommandAllowed } from './commandGate.js';

interface ExecOutcome {
  stdout: string;
  stderr: string;
}

interface ExecFailure extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

// Hand-rolled rather than util.promisify(execFile) — Node's real execFile
// resolves {stdout, stderr} via an internal util.promisify.custom symbol
// that a mocked module in tests won't have, so promisify(execFile) silently
// degrades to generic single-value promisify (stdout only, stderr dropped)
// under mocking. This wrapper has one obvious behavior either way.
function execFileAsync(
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<ExecOutcome> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const failure = error as ExecFailure;
        failure.stdout = String(stdout ?? '');
        failure.stderr = String(stderr ?? '');
        rejectPromise(failure);
      } else {
        resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    });
  });
}

// execFile inherits the FULL parent process env by default — this would hand
// ANTHROPIC_API_KEY/APPQ_API_KEY (and, in a chained autopilot run, GITHUB_TOKEN)
// straight to npm/npx/git and to any lifecycle script a dependency runs.
// Pass through only what these specific allowlisted commands actually need
// to resolve and run correctly.
const SAFE_ENV_VARS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'];

function safeChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_VARS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// npm runs a package's preinstall/install/postinstall scripts by default —
// the actual code-execution mechanism behind a typosquatted or hallucinated
// package name. commandGate.ts already restricts what can be installed by
// shape; this closes what that shape check can't: what a malicious package's
// own install scripts would do. Applied transparently so the model never
// needs to know to ask for it, and never duplicated if it already did.
function withSafetyFlags(command: string, args: string[]): string[] {
  if (command === 'npm' && args[0] === 'install' && !args.includes('--ignore-scripts')) {
    return [...args, '--ignore-scripts'];
  }
  return args;
}

export const CODING_TOOL_DEFS: LlmToolDef[] = [
  {
    name: 'read_file',
    description: 'Read a text file, relative to the target repo root.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description:
      'Write (create or overwrite) a text file, relative to the target repo root. Creates parent ' +
      'directories as needed. This is how you write the generated spec and any config files.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List entries (files and directories) in a directory, relative to the target repo root.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
  },
  {
    name: 'run_command',
    description:
      'Run an allowlisted shell command (npm init/install -D, npx playwright install/--version/test, ' +
      'node --version, git status/diff) in the target repo. Anything outside that allowlist is refused ' +
      'before it runs. Use this for Phase 0 bootstrap and Phase 6 verification — never claim a test ' +
      'passed without actually running it here.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The binary, e.g. "npm", "npx", "node", "git".' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argv, one element per argument.' },
      },
      required: ['command', 'args'],
    },
  },
];

export interface CommandRunRecord {
  command: string;
  args: string[];
  exitCode: number | null;
  ok: boolean;
  timestamp: number;
}

/** Wraps a real filesystem + shell surface, scoped to one repo root, tracking what actually happened. */
export class CodingTools {
  private readonly writtenPaths = new Map<string, number>(); // relative path -> last-written timestamp
  private readonly commandHistory: CommandRunRecord[] = [];

  constructor(
    private readonly repoPath: string,
    private readonly commandTimeoutMs: number,
  ) {}

  private resolveScoped(relPath: string): string {
    const resolved = resolve(this.repoPath, relPath);
    const rel = relative(this.repoPath, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path "${relPath}" escapes the target repo root — refusing.`);
    }
    return resolved;
  }

  /** Relative paths written so far, each with the timestamp of its most recent write. */
  getWrittenPaths(): Map<string, number> {
    return new Map(this.writtenPaths);
  }

  getCommandHistory(): CommandRunRecord[] {
    return [...this.commandHistory];
  }

  /** The most recent `npx playwright test` invocation's real, execFile-reported outcome — or null if none ran. */
  lastPlaywrightTestRun(): CommandRunRecord | null {
    for (let i = this.commandHistory.length - 1; i >= 0; i--) {
      const r = this.commandHistory[i];
      if (r.command === 'npx' && r.args[0] === 'playwright' && r.args[1] === 'test') return r;
    }
    return null;
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'read_file': {
        const rawPath = String(args.path ?? '');
        try {
          const content = await readFile(this.resolveScoped(rawPath), 'utf-8');
          return {
            ok: true,
            text: content.length > 50_000 ? `${content.slice(0, 50_000)}\n... (truncated)` : content,
          };
        } catch (err) {
          return { ok: false, text: `Could not read "${rawPath}": ${(err as Error).message}` };
        }
      }
      case 'write_file': {
        const rawPath = String(args.path ?? '');
        const content = String(args.content ?? '');
        const resolved = this.resolveScoped(rawPath);
        await mkdir(dirname(resolved), { recursive: true });
        await writeFile(resolved, content, 'utf-8');
        this.writtenPaths.set(rawPath, Date.now());
        return { ok: true, text: `Wrote ${content.length} bytes to ${rawPath}` };
      }
      case 'list_directory': {
        const rawPath = String(args.path ?? '.');
        try {
          const entries = await readdir(this.resolveScoped(rawPath), { withFileTypes: true });
          const lines = entries.map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${e.name}`).sort();
          return { ok: true, text: lines.join('\n') || '(empty directory)' };
        } catch (err) {
          return { ok: false, text: `Could not list "${rawPath}": ${(err as Error).message}` };
        }
      }
      case 'run_command': {
        const command = String(args.command ?? '');
        const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        try {
          assertCommandAllowed(command, cmdArgs);
        } catch (err) {
          return { ok: false, text: (err as Error).message };
        }
        return this.runAllowed(command, cmdArgs);
      }
      default:
        return { ok: false, text: `Unknown coding tool "${name}"` };
    }
  }

  private async runAllowed(command: string, cmdArgs: string[]): Promise<ToolResult> {
    const execArgs = withSafetyFlags(command, cmdArgs);
    try {
      const { stdout, stderr } = await execFileAsync(command, execArgs, {
        cwd: this.repoPath,
        timeout: this.commandTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: safeChildEnv(),
      });
      this.commandHistory.push({ command, args: execArgs, exitCode: 0, ok: true, timestamp: Date.now() });
      const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
      return { ok: true, text: out.length > 20_000 ? out.slice(-20_000) : out || '(no output, exit 0)' };
    } catch (err) {
      const e = err as ExecFailure;
      const exitCode = typeof e.code === 'number' ? e.code : null;
      this.commandHistory.push({ command, args: execArgs, exitCode, ok: false, timestamp: Date.now() });
      const out = `${e.stdout ?? ''}\n[stderr]\n${e.stderr ?? e.message}`.trim();
      return { ok: false, text: out.length > 20_000 ? out.slice(-20_000) : out };
    }
  }
}
