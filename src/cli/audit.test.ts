import { describe, it, expect, vi } from 'vitest';
import { recordGenerateRun } from './audit.js';
import type { AuditSink } from '@appliqation/agent-core';

const usage = { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 0 };

describe('recordGenerateRun', () => {
  it('records one call with agent/subcommand and the outcome shaped like GenerateSummary', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordGenerateRun({
      sink,
      startedAt: 1000,
      endedAt: 3000,
      model: 'claude-sonnet-5',
      usage,
      testCaseUuid: '2424-abc',
      result: {
        report: 'done',
        turns: 5,
        budgetExceeded: false,
        writtenPaths: ['tests/x.spec.ts'],
        testRun: { ran: true, ok: true, exitCode: 0 },
      },
    });

    expect(sink.record).toHaveBeenCalledTimes(1);
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record).toMatchObject({ agent: 'appliqation-scriptgen', subcommand: 'generate', startedAt: 1000, endedAt: 3000, durationMillis: 2000, model: 'claude-sonnet-5', usage, exitCode: 0 });
    expect(record.outcome).toEqual({ testCaseUuid: '2424-abc', writtenPaths: ['tests/x.spec.ts'], testRan: true, verified: true, report: 'done' });
  });

  it('exitCode is 1 when the script never verified — matches the CLI\'s own exitCodeFor()', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordGenerateRun({
      sink,
      startedAt: 0,
      endedAt: 1,
      model: 'x',
      usage,
      testCaseUuid: 'tc-1',
      result: { report: 'r', turns: 1, budgetExceeded: false, writtenPaths: [], testRun: { ran: false, ok: false, exitCode: null } },
    });
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.exitCode).toBe(1);
  });

  it('records exitCode 1 and an error outcome when result is undefined — generate() threw', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordGenerateRun({ sink, startedAt: 0, endedAt: 1, model: 'x', usage, testCaseUuid: 'tc-1', result: undefined });
    const record = (sink.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(record.exitCode).toBe(1);
    expect(record.outcome).toEqual({ testCaseUuid: 'tc-1', error: true });
  });

  it('a sink failure never rejects — safeRecord swallows it', async () => {
    const sink: AuditSink = { record: vi.fn().mockRejectedValue(new Error('down')), close: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      recordGenerateRun({
        sink,
        startedAt: 0,
        endedAt: 1,
        model: 'x',
        usage,
        testCaseUuid: 'tc-1',
        result: { report: 'r', turns: 1, budgetExceeded: false, writtenPaths: [], testRun: { ran: true, ok: true, exitCode: 0 } },
      }),
    ).resolves.toBeUndefined();
  });

  it('closes the sink after recording — N-03: an unclosed Mongo client hangs the process since this CLI never calls process.exit()', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    await recordGenerateRun({ sink, startedAt: 0, endedAt: 1, model: 'x', usage, testCaseUuid: 'tc-1', result: undefined });
    expect(sink.close).toHaveBeenCalledTimes(1);
  });

  it('still closes the sink even when record() failed', async () => {
    const sink: AuditSink = { record: vi.fn().mockRejectedValue(new Error('down')), close: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await recordGenerateRun({ sink, startedAt: 0, endedAt: 1, model: 'x', usage, testCaseUuid: 'tc-1', result: undefined });
    expect(sink.close).toHaveBeenCalledTimes(1);
  });
});
