import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetchAppqToolDefs, mockCreateGatedAppqDispatcher, mockRunWorkflow } = vi.hoisted(() => ({
  mockFetchAppqToolDefs: vi.fn(),
  mockCreateGatedAppqDispatcher: vi.fn(),
  mockRunWorkflow: vi.fn(),
}));
vi.mock('@appliqation/agent-core', () => ({
  fetchAppqToolDefs: mockFetchAppqToolDefs,
  createGatedAppqDispatcher: mockCreateGatedAppqDispatcher,
  runWorkflow: mockRunWorkflow,
}));

const { mockCodingDispatch, mockGetWrittenPaths, mockLastPlaywrightTestRun, MockCodingTools } = vi.hoisted(() => {
  const mockCodingDispatch = vi.fn();
  const mockGetWrittenPaths = vi.fn();
  const mockLastPlaywrightTestRun = vi.fn();
  class MockCodingTools {
    dispatch = mockCodingDispatch;
    getWrittenPaths = mockGetWrittenPaths;
    lastPlaywrightTestRun = mockLastPlaywrightTestRun;
  }
  return { mockCodingDispatch, mockGetWrittenPaths, mockLastPlaywrightTestRun, MockCodingTools };
});
vi.mock('../tools/codingTools.js', () => ({
  CodingTools: MockCodingTools,
  CODING_TOOL_DEFS: [
    { name: 'read_file', description: 'x', inputSchema: {} },
    { name: 'write_file', description: 'x', inputSchema: {} },
    { name: 'list_directory', description: 'x', inputSchema: {} },
    { name: 'run_command', description: 'x', inputSchema: {} },
  ],
}));

import { generate } from './generate.js';
import type { McpClient, ProviderAdapter, RunBudget } from '@appliqation/agent-core';

function fakeClient(): McpClient {
  return {
    fetchPrompt: vi.fn(),
    startWorkflow: vi.fn(),
    callTool: vi.fn(),
    listTools: vi.fn(),
    uploadScreenshot: vi.fn(),
  };
}

const budget: RunBudget = { maxCalls: 60, maxPages: 999_999, maxMillis: 900_000, maxTurns: 60 };

function baseOpts() {
  return {
    client: fakeClient(),
    adapter: { complete: vi.fn() } as ProviderAdapter,
    projectId: 1349,
    scenarioId: 2424,
    testCaseUuid: '2424-abc',
    repoPath: '/tmp/repo',
    budget,
    commandTimeoutMs: 30_000,
  };
}

describe('generate', () => {
  beforeEach(() => {
    mockFetchAppqToolDefs.mockReset().mockResolvedValue([{ name: 'get_scenario', description: 'x', inputSchema: {} }]);
    mockCreateGatedAppqDispatcher.mockReset().mockReturnValue(vi.fn().mockResolvedValue({ ok: true, text: 'appq result' }));
    mockRunWorkflow.mockReset().mockResolvedValue({ report: 'done', turns: 3, budgetExceeded: false });
    mockCodingDispatch.mockReset().mockResolvedValue({ ok: true, text: 'coding result' });
    mockGetWrittenPaths.mockReset().mockReturnValue(new Map());
    mockLastPlaywrightTestRun.mockReset().mockReturnValue(null);
  });

  it('calls runWorkflow against appq:automate with project/scenario/test_case_uuid', async () => {
    await generate(baseOpts());
    expect(mockRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          kind: 'appq',
          name: 'appq:automate',
          args: { project_id: 1349, scenario_id: 2424, test_case_uuid: '2424-abc' },
        },
      }),
    );
  });

  it('includes file_path in the prompt args only when given', async () => {
    await generate({ ...baseOpts(), filePath: 'tests/x.spec.ts' });
    const call = mockRunWorkflow.mock.calls[0][0];
    expect(call.source.args.file_path).toBe('tests/x.spec.ts');
  });

  it('includes autotest_run_id in the prompt args only when given, switching appq:automate to autonomous mode', async () => {
    await generate({ ...baseOpts(), autotestRunId: 'run_123' });
    const call = mockRunWorkflow.mock.calls[0][0];
    expect(call.source.args.autotest_run_id).toBe('run_123');
  });

  it('omits file_path/autotest_run_id entirely when not given, not as empty strings', async () => {
    await generate(baseOpts());
    const call = mockRunWorkflow.mock.calls[0][0];
    expect(call.source.args).not.toHaveProperty('file_path');
    expect(call.source.args).not.toHaveProperty('autotest_run_id');
  });

  it('offers both the read-only appq tool defs and the coding tool defs to the model', async () => {
    await generate(baseOpts());
    const call = mockRunWorkflow.mock.calls[0][0];
    const toolNames = call.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(['get_scenario', 'read_file', 'write_file', 'list_directory', 'run_command']));
  });

  it('routes coding-tool-named dispatches to CodingTools, everything else to the gated appq dispatcher', async () => {
    await generate(baseOpts());
    const dispatch = mockRunWorkflow.mock.calls[0][0].dispatch;

    await dispatch('write_file', { path: 'x', content: 'y' });
    expect(mockCodingDispatch).toHaveBeenCalledWith('write_file', { path: 'x', content: 'y' });

    const gatedFn = mockCreateGatedAppqDispatcher.mock.results[0].value;
    await dispatch('get_scenario', { scenario_id: 2424 });
    expect(gatedFn).toHaveBeenCalledWith('get_scenario', { scenario_id: 2424 });
  });

  it('the seed message includes the role and its setupAuth instruction when a role is given', async () => {
    await generate({ ...baseOpts(), role: 'manager' });
    const call = mockRunWorkflow.mock.calls[0][0];
    expect(call.seedMessage).toContain('role "manager"');
    expect(call.seedMessage).toContain('setupAuth');
  });

  it('the seed message includes the environment URL as context when given', async () => {
    await generate({ ...baseOpts(), environmentUrl: 'https://stage.example.com' });
    const call = mockRunWorkflow.mock.calls[0][0];
    expect(call.seedMessage).toContain('https://stage.example.com');
  });

  it('returns loopResult.report/turns/budgetExceeded unchanged', async () => {
    mockRunWorkflow.mockResolvedValue({ report: 'my report', turns: 7, budgetExceeded: true });
    const result = await generate(baseOpts());
    expect(result.report).toBe('my report');
    expect(result.turns).toBe(7);
    expect(result.budgetExceeded).toBe(true);
  });

  describe('testRun outcome — never trusts the model, only real coding-tool state', () => {
    it('ran=false, ok=false when no playwright test invocation ever happened', async () => {
      mockLastPlaywrightTestRun.mockReturnValue(null);
      const result = await generate(baseOpts());
      expect(result.testRun).toEqual({ ran: false, ok: false, exitCode: null });
    });

    it('ok=true when the last test run succeeded and happened after the last file write', async () => {
      mockGetWrittenPaths.mockReturnValue(new Map([['spec.ts', 1000]]));
      mockLastPlaywrightTestRun.mockReturnValue({ command: 'npx', args: ['playwright', 'test'], ok: true, exitCode: 0, timestamp: 2000 });
      const result = await generate(baseOpts());
      expect(result.testRun).toEqual({ ran: true, ok: true, exitCode: 0 });
    });

    it('ok=false when the test run failed, even though it happened after the write', async () => {
      mockGetWrittenPaths.mockReturnValue(new Map([['spec.ts', 1000]]));
      mockLastPlaywrightTestRun.mockReturnValue({ command: 'npx', args: ['playwright', 'test'], ok: false, exitCode: 1, timestamp: 2000 });
      const result = await generate(baseOpts());
      expect(result.testRun).toEqual({ ran: true, ok: false, exitCode: 1 });
    });

    it('ok=false when a PASSING run happened BEFORE the last edit — stale, proves nothing about the file as it stands now', async () => {
      mockGetWrittenPaths.mockReturnValue(new Map([['spec.ts', 5000]])); // written after the test ran
      mockLastPlaywrightTestRun.mockReturnValue({ command: 'npx', args: ['playwright', 'test'], ok: true, exitCode: 0, timestamp: 2000 });
      const result = await generate(baseOpts());
      expect(result.testRun.ok).toBe(false);
      expect(result.testRun.ran).toBe(true); // it did run, just not authoritative for the current file content
    });

    it('reports every path that was written', async () => {
      mockGetWrittenPaths.mockReturnValue(new Map([['a.ts', 1], ['b.ts', 2]]));
      const result = await generate(baseOpts());
      expect(result.writtenPaths.sort()).toEqual(['a.ts', 'b.ts']);
    });
  });
});
