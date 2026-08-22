// The capability appq:automate's own prompt (Phase 0/3/5/6) assumes a full
// coding-agent session has: read/write a local repo, and run real shell
// commands to bootstrap Playwright and actually verify the generated spec.
// Every path is scoped to repoPath (no traversal out of it); every command
// goes through commandGate.ts's allowlist AND is spawned via execFile with
// an explicit argv array — never a shell string — so the OS never parses
// arguments as shell syntax in the first place.

import { readFile, writeFile, mkdir, readdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
// ANTHROPIC_API_KEY/APPQ_API_KEY (this agent's own MCP credential) and, in a
// chained autopilot run, GITHUB_TOKEN, straight to npm/npx/git and to any
// lifecycle script a dependency runs. But `npx playwright test` runs a real
// generated spec that's typically built on @appliqation/automation-sdk, and
// that SDK reads its own env vars to authenticate and report — most
// critically APPLIQATION_API_KEY (the project's own reporting key, a
// different credential from this agent's APPQ_API_KEY) in its Playwright
// fixture/global-setup, and APPQ_AUTH_STATE_DIR in setupAuth(). An earlier
// version of this allowlist stripped those too, which doesn't fail loudly —
// a gated project's spec (or defect-fix's Phase 5 --appq-run-id reporter)
// just can't authenticate, and that environmental failure gets reported as
// a real product failure, exactly what this family's verification
// discipline exists to prevent. This list is deliberately explicit — see
// automation-sdk-js's README/.env.example for the vocabulary — not a
// blanket APPQ_/APPLIQATION_ prefix passthrough, which would also leak this
// agent's own APPQ_API_KEY.
const SAFE_ENV_VARS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'CI',
  'NODE_ENV',
  'APPLIQATION_API_KEY',
  'APPLIQATION_PROJECT_KEY',
  'APPLIQATION_BASE_URL',
  'APPLIQATION_SUT_BASE_URL',
  'APPLIQATION_APP_URL',
  'APPLIQATION_ENVIRONMENT',
  'APPLIQATION_SCENARIO_ID',
  'APPLIQATION_RUN_ID',
  'APPLIQATION_RUN_TITLE',
  'APPLIQATION_USE_JWT_AUTH',
  'APPLIQATION_ON_SCOPE_MISMATCH',
  'APPLIQATION_AUTO_TAG_ENABLED',
  'APPLIQATION_AUTO_TAG_NAME',
  'APPLIQATION_ENABLE',
  'APPQ_ENABLE',
  'APPQ_AUTH_STATE_DIR',
  'APPQ_LOGIN_FILE',
];

// Per-project/role SUT credentials appq-auth-setup and a generated login.ts
// read (APPQ_PROJECT_<id>_<ROLE>_USERNAME/_PASSWORD/_API_KEY/_API_HEADER_NAME
// — see @appliqation/agent-core's authState.ts). A narrow shape, not a
// blanket APPQ_ prefix, specifically so this agent's own APPQ_API_KEY (no
// _PROJECT_<id>_ segment) can never match it.
const SAFE_ENV_PATTERN = /^APPQ_PROJECT_\d+_[A-Z0-9_]+$/;

function safeChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SAFE_ENV_VARS.includes(key) || SAFE_ENV_PATTERN.test(key)) env[key] = value;
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

  private async resolveScoped(relPath: string): Promise<string> {
    const resolved = resolve(this.repoPath, relPath);
    const rel = relative(this.repoPath, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path "${relPath}" escapes the target repo root — refusing.`);
    }
    // The check above is purely lexical — a symlink whose own path sits
    // inside repoPath but whose target resolves outside it would pass. Walk
    // up to the nearest existing ancestor (the target itself may not exist
    // yet — write_file creates new files/directories) and confirm ITS real,
    // symlink-resolved path also stays within the repo root's real path.
    let probe = resolved;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break; // hit the filesystem root; let the real fs op fail naturally
      probe = parent;
    }
    const [rootReal, probeReal] = await Promise.all([realpath(this.repoPath), realpath(probe)]);
    const realRel = relative(rootReal, probeReal);
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new Error(`Path "${relPath}" escapes the target repo root via a symlink — refusing.`);
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
          const content = await readFile(await this.resolveScoped(rawPath), 'utf-8');
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
        const resolved = await this.resolveScoped(rawPath);
        await mkdir(dirname(resolved), { recursive: true });
        await writeFile(resolved, content, 'utf-8');
        this.writtenPaths.set(rawPath, Date.now());
        return { ok: true, text: `Wrote ${content.length} bytes to ${rawPath}` };
      }
      case 'list_directory': {
        const rawPath = String(args.path ?? '.');
        try {
          const entries = await readdir(await this.resolveScoped(rawPath), { withFileTypes: true });
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
