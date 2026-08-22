// Extracted out of cli/index.ts so this is testable without triggering that
// file's top-level program.parseAsync(process.argv) side effect — same
// reasoning as appliqation-autotest's cli/resolvers.ts.

import { safeRecord, safeClose, type AuditSink, type AuditRecord } from '@appliqation/agent-core';
import type { GenerateResult } from '../orchestrator/generate.js';
import { exitCodeFor } from './output.js';
import type { GenerateSummary } from './output.js';

export interface RecordGenerateRunArgs {
  sink: AuditSink;
  startedAt: number;
  endedAt: number;
  model: string;
  usage: AuditRecord['usage'];
  testCaseUuid: string;
  /** undefined means generate() threw — the run never produced a result. */
  result: GenerateResult | undefined;
}

export async function recordGenerateRun(args: RecordGenerateRunArgs): Promise<void> {
  const { sink, startedAt, endedAt, model, usage, testCaseUuid, result } = args;
  const summary: GenerateSummary | undefined = result
    ? { testCaseUuid, writtenPaths: result.writtenPaths, testRan: result.testRun.ran, verified: result.testRun.ok, report: result.report }
    : undefined;

  await safeRecord(sink, {
    agent: 'appliqation-scriptgen',
    subcommand: 'generate',
    startedAt,
    endedAt,
    durationMillis: endedAt - startedAt,
    model,
    usage,
    turns: result?.turns,
    budgetExceeded: result?.budgetExceeded,
    exitCode: summary ? exitCodeFor(summary) : 1,
    outcome: summary ? { ...summary } : { testCaseUuid, error: true },
  });
  await safeClose(sink);
}
