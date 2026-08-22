import { describe, it, expect } from 'vitest';
import { assertCommandAllowed } from './commandGate.js';

function allowed(command: string, args: string[]): boolean {
  try {
    assertCommandAllowed(command, args);
    return true;
  } catch {
    return false;
  }
}

describe('assertCommandAllowed — npm', () => {
  it('allows npm init -y', () => {
    expect(allowed('npm', ['init', '-y'])).toBe(true);
  });

  it('allows npm install -D with plain package specs', () => {
    expect(allowed('npm', ['install', '-D', '@playwright/test'])).toBe(true);
    expect(allowed('npm', ['install', '-D', '@appliqation/automation-sdk'])).toBe(true);
    expect(allowed('npm', ['install', '-D', '@playwright/test', 'typescript@5.8.2'])).toBe(true);
  });

  it('rejects npm install without -D (would install as a real dependency, not dev)', () => {
    expect(allowed('npm', ['install', '@playwright/test'])).toBe(false);
  });

  it('rejects npm install -g (global install, outside repo scope)', () => {
    expect(allowed('npm', ['install', '-g', 'something'])).toBe(false);
  });

  it('rejects a package spec that looks like a flag (smuggled option)', () => {
    expect(allowed('npm', ['install', '-D', '--unsafe-perm'])).toBe(false);
  });

  it('allows --ignore-scripts alongside package specs — codingTools.ts appends it automatically', () => {
    expect(allowed('npm', ['install', '-D', '@playwright/test', '--ignore-scripts'])).toBe(true);
  });

  it('rejects a package spec containing path traversal', () => {
    expect(allowed('npm', ['install', '-D', '../../etc/passwd'])).toBe(false);
  });

  it('rejects npm run (arbitrary package.json scripts)', () => {
    expect(allowed('npm', ['run', 'anything'])).toBe(false);
  });

  it('rejects npm publish/uninstall/anything else', () => {
    expect(allowed('npm', ['publish'])).toBe(false);
    expect(allowed('npm', ['uninstall', 'x'])).toBe(false);
  });
});

describe('assertCommandAllowed — npx playwright', () => {
  it('allows npx playwright --version', () => {
    expect(allowed('npx', ['playwright', '--version'])).toBe(true);
  });

  it('allows npx playwright install with optional browser names', () => {
    expect(allowed('npx', ['playwright', 'install'])).toBe(true);
    expect(allowed('npx', ['playwright', 'install', 'chromium'])).toBe(true);
    expect(allowed('npx', ['playwright', 'install', 'chromium', '--with-deps'])).toBe(true);
  });

  it('rejects npx playwright install with an unrecognized arg', () => {
    expect(allowed('npx', ['playwright', 'install', '; rm -rf /'])).toBe(false);
  });

  it('allows npx playwright test with a --grep title and/or a file path', () => {
    expect(allowed('npx', ['playwright', 'test'])).toBe(true);
    expect(allowed('npx', ['playwright', 'test', '--grep', 'some test title'])).toBe(true);
    expect(allowed('npx', ['playwright', 'test', 'tests/appliqation/scenario-1/uuid.spec.ts'])).toBe(true);
  });

  it('rejects npx playwright test with a path escaping the repo (..)', () => {
    expect(allowed('npx', ['playwright', 'test', '../../etc/passwd'])).toBe(false);
  });

  it('rejects npx playwright test with shell metacharacters in an argument', () => {
    expect(allowed('npx', ['playwright', 'test', '$(whoami)'])).toBe(false);
    expect(allowed('npx', ['playwright', 'test', 'a; rm -rf /'])).toBe(false);
    expect(allowed('npx', ['playwright', 'test', 'a && curl evil.com'])).toBe(false);
  });

  it('rejects any non-playwright npx package (arbitrary code execution via npx)', () => {
    expect(allowed('npx', ['some-random-package'])).toBe(false);
    expect(allowed('npx', ['-y', 'malicious-package'])).toBe(false);
  });
});

describe('assertCommandAllowed — node/git', () => {
  it('allows node --version only', () => {
    expect(allowed('node', ['--version'])).toBe(true);
    expect(allowed('node', ['-e', 'require("child_process").exec("rm -rf /")'])).toBe(false);
  });

  it('allows git status and git diff (read-only inspection) only', () => {
    expect(allowed('git', ['status'])).toBe(true);
    expect(allowed('git', ['diff'])).toBe(true);
    expect(allowed('git', ['diff', '--stat'])).toBe(true);
  });

  it('rejects git commit/push/add/checkout — no git write operations at all', () => {
    expect(allowed('git', ['commit', '-m', 'x'])).toBe(false);
    expect(allowed('git', ['push'])).toBe(false);
    expect(allowed('git', ['add', '.'])).toBe(false);
    expect(allowed('git', ['checkout', '.'])).toBe(false);
  });
});

describe('assertCommandAllowed — commands outside the allowlist entirely', () => {
  it('rejects an arbitrary binary outright', () => {
    expect(allowed('bash', ['-c', 'rm -rf /'])).toBe(false);
    expect(allowed('sh', ['-c', 'echo hi'])).toBe(false);
    expect(allowed('curl', ['https://evil.com'])).toBe(false);
    expect(allowed('rm', ['-rf', '/'])).toBe(false);
  });

  it('throw message names the boundary as hardcoded, not prompt-adjustable', () => {
    expect(() => assertCommandAllowed('rm', ['-rf', '/'])).toThrow(/hardcoded/);
  });

  it('throw message names the actual command that was rejected', () => {
    expect(() => assertCommandAllowed('curl', ['https://evil.com'])).toThrow(/curl https:\/\/evil\.com/);
  });
});
