import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

const { CodingTools } = await import('./codingTools.js');

/** Makes the promisified execFile resolve like a real successful process. */
function mockExecSuccess(stdout: string, stderr = '') {
  mockExecFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    process.nextTick(() => cb(null, stdout, stderr));
  });
}

/** Makes the promisified execFile reject like a real failed process (non-zero exit). */
function mockExecFailure(code: number, stdout = '', stderr = 'boom') {
  mockExecFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    const err = Object.assign(new Error(`Command failed`), { code });
    // Node's real execFile callback passes stdout/stderr as separate
    // positional args even on failure — not properties pre-attached to the
    // error object, which is what the wrapper under test actually reads.
    process.nextTick(() => cb(err, stdout, stderr));
  });
}

describe('CodingTools', () => {
  let dir: string;
  let tools: InstanceType<typeof CodingTools>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scriptgen-test-'));
    tools = new CodingTools(dir, 30_000);
    mockExecFile.mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('write_file / read_file', () => {
    it('writes a file and reads it back', async () => {
      const writeResult = await tools.dispatch('write_file', { path: 'tests/appliqation/scenario-1/uuid.spec.ts', content: 'const x = 1;' });
      expect(writeResult.ok).toBe(true);
      expect(existsSync(join(dir, 'tests/appliqation/scenario-1/uuid.spec.ts'))).toBe(true);

      const readResult = await tools.dispatch('read_file', { path: 'tests/appliqation/scenario-1/uuid.spec.ts' });
      expect(readResult.ok).toBe(true);
      expect(readResult.text).toBe('const x = 1;');
    });

    it('creates parent directories that do not exist yet', async () => {
      await tools.dispatch('write_file', { path: 'a/b/c/file.txt', content: 'x' });
      expect(existsSync(join(dir, 'a/b/c/file.txt'))).toBe(true);
    });

    it('records the written path with a timestamp', async () => {
      await tools.dispatch('write_file', { path: 'spec.ts', content: 'x' });
      const written = tools.getWrittenPaths();
      expect(written.has('spec.ts')).toBe(true);
      expect(written.get('spec.ts')).toBeGreaterThan(0);
    });

    it('refuses to read a path that escapes the repo root', async () => {
      const result = await tools.dispatch('read_file', { path: '../../etc/passwd' });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/escapes the target repo root/);
    });

    it('refuses to write a path that escapes the repo root, and does not create the file', async () => {
      await expect(tools.dispatch('write_file', { path: '../outside.txt', content: 'x' })).rejects.toThrow(/escapes the target repo root/);
      expect(existsSync(join(tmpdir(), 'outside.txt'))).toBe(false);
    });

    it('returns a clear error for a nonexistent file rather than throwing', async () => {
      const result = await tools.dispatch('read_file', { path: 'nope.ts' });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/Could not read/);
    });

    it('an absolute path is still scoped under the repo root, not treated as a real absolute path', async () => {
      // resolve(repoPath, '/etc/passwd') === '/etc/passwd' in Node's path semantics — this must not
      // let the model escape the sandbox by just passing an absolute path.
      const result = await tools.dispatch('read_file', { path: '/etc/passwd' });
      expect(result.ok).toBe(false);
    });
  });

  describe('list_directory', () => {
    it('lists files and directories, sorted, with type markers', async () => {
      writeFileSync(join(dir, 'b.txt'), 'x');
      writeFileSync(join(dir, 'a.txt'), 'x');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(dir, 'sub'));
      const result = await tools.dispatch('list_directory', { path: '.' });
      expect(result.ok).toBe(true);
      const lines = result.text.split('\n');
      expect(lines).toEqual(['dir   sub', 'file  a.txt', 'file  b.txt']);
    });

    it('reports "(empty directory)" for an empty dir', async () => {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(dir, 'empty'));
      const result = await tools.dispatch('list_directory', { path: 'empty' });
      expect(result.text).toBe('(empty directory)');
    });

    it('defaults to the repo root when no path is given', async () => {
      writeFileSync(join(dir, 'x.txt'), 'x');
      const result = await tools.dispatch('list_directory', {});
      expect(result.text).toContain('x.txt');
    });
  });

  describe('run_command — allowlist enforcement', () => {
    it('refuses a disallowed command without ever calling execFile', async () => {
      const result = await tools.dispatch('run_command', { command: 'rm', args: ['-rf', '/'] });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/not in the allowlist/);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('refuses a disallowed subcommand for an otherwise-allowed binary', async () => {
      const result = await tools.dispatch('run_command', { command: 'git', args: ['push'] });
      expect(result.ok).toBe(false);
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('run_command — allowed command execution and tracking', () => {
    it('runs an allowed command, scoped to the repo root as cwd', async () => {
      mockExecSuccess('1.0.0\n');
      const result = await tools.dispatch('run_command', { command: 'node', args: ['--version'] });
      expect(result.ok).toBe(true);
      expect(result.text).toContain('1.0.0');
      expect(mockExecFile).toHaveBeenCalledWith('node', ['--version'], expect.objectContaining({ cwd: dir }), expect.any(Function));
    });

    it('records a successful run in the command history', async () => {
      mockExecSuccess('ok');
      await tools.dispatch('run_command', { command: 'node', args: ['--version'] });
      const history = tools.getCommandHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ command: 'node', args: ['--version'], exitCode: 0, ok: true });
    });

    it('reports failure with the real exit code, not a fabricated one', async () => {
      mockExecFailure(1, '', '1 failed\n  Expected: visible\n  Received: hidden');
      const result = await tools.dispatch('run_command', { command: 'npx', args: ['playwright', 'test'] });
      expect(result.ok).toBe(false);
      expect(result.text).toContain('1 failed');
      const history = tools.getCommandHistory();
      expect(history[0]).toMatchObject({ ok: false, exitCode: 1 });
    });

    it('lastPlaywrightTestRun returns null when no test run has happened', () => {
      expect(tools.lastPlaywrightTestRun()).toBeNull();
    });

    it('lastPlaywrightTestRun returns the most recent playwright test invocation, real outcome included', async () => {
      mockExecSuccess('setup ok');
      await tools.dispatch('run_command', { command: 'npm', args: ['install', '-D', '@playwright/test'] });
      mockExecFailure(1, '', '1 failed');
      await tools.dispatch('run_command', { command: 'npx', args: ['playwright', 'test'] });
      mockExecSuccess('1 passed');
      await tools.dispatch('run_command', { command: 'npx', args: ['playwright', 'test'] });

      const last = tools.lastPlaywrightTestRun();
      expect(last).toMatchObject({ ok: true, exitCode: 0 });
    });

    it('the model cannot fabricate a pass — the tool result always reflects execFile\'s real outcome', async () => {
      mockExecFailure(1, '', 'assertion failed');
      const result = await tools.dispatch('run_command', { command: 'npx', args: ['playwright', 'test'] });
      // Regardless of what a model might claim in its own report text afterward,
      // the tool call itself is ground truth and cannot be talked around.
      expect(result.ok).toBe(false);
    });

    it('does not leak the parent process env to the child — only the safe allowlist passes through', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-super-secret';
      mockExecSuccess('ok');
      await tools.dispatch('run_command', { command: 'node', args: ['--version'] });
      const passedEnv = mockExecFile.mock.calls[0][2].env;
      expect(passedEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(passedEnv.PATH).toBe(process.env.PATH);
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('appends --ignore-scripts to npm install, transparently, so a malicious package cannot run lifecycle scripts', async () => {
      mockExecSuccess('added 1 package');
      await tools.dispatch('run_command', { command: 'npm', args: ['install', '-D', '@playwright/test'] });
      expect(mockExecFile).toHaveBeenCalledWith(
        'npm',
        ['install', '-D', '@playwright/test', '--ignore-scripts'],
        expect.anything(),
        expect.any(Function),
      );
      const history = tools.getCommandHistory();
      expect(history[0].args).toContain('--ignore-scripts');
    });

    it('does not duplicate --ignore-scripts if the model already passed it', async () => {
      mockExecSuccess('added 1 package');
      await tools.dispatch('run_command', { command: 'npm', args: ['install', '-D', '@playwright/test', '--ignore-scripts'] });
      const [, calledArgs] = mockExecFile.mock.calls[0];
      expect(calledArgs.filter((a: string) => a === '--ignore-scripts')).toHaveLength(1);
    });
  });

  describe('dispatch — unknown tool', () => {
    it('returns an explicit error for an unrecognized tool name', async () => {
      const result = await tools.dispatch('delete_everything', {});
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/Unknown coding tool/);
    });
  });
});
