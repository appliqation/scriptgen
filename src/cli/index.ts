#!/usr/bin/env node
// `generate`: draft + verify a Playwright script for one test case, via
// appq's (enriched) appq:automate workflow given real filesystem + shell
// tools. See src/orchestrator/generate.ts for the actual mechanism.

import { Command } from 'commander';
import {
  createMcpClient,
  createAnthropicAdapter,
  createOpenAiAdapter,
  createUsageAccumulator,
  resolveScenarioId,
  fetchScenarioInfo,
  resolveUrl,
  knownRolesForProject,
  inferRole,
  type ProviderAdapter,
} from '@appliqation/agent-core';
import { config, resolveProvider, resolveModel } from '../config/env.js';
import { generate } from '../orchestrator/generate.js';
import type { GenerateResult } from '../orchestrator/generate.js';
import { recordGenerateRun } from './audit.js';
import { printJsonSummary, printHumanSummary, exitCodeFor } from './output.js';
import type { GenerateSummary } from './output.js';

const client = createMcpClient({ origin: config.appqOrigin, apiKey: config.appqApiKey() });

function buildAdapter(): ProviderAdapter {
  const provider = resolveProvider();
  const model = resolveModel();
  return provider === 'anthropic'
    ? createAnthropicAdapter(config.anthropicApiKey!, model, config.anthropicMaxTokens)
    : createOpenAiAdapter(config.openaiApiKey!, model, config.openaiMaxOutputTokens);
}

function logEvent(prefix: string) {
  return (e: { type: string; detail?: unknown }) => {
    if (e.type === 'assistant') {
      const text = ((e.detail as string) ?? '').trim();
      if (text) console.error(`${prefix}[thinking] ${text}`);
    } else if (e.type === 'tool') {
      const d = e.detail as { name: string; result: string };
      console.error(`${prefix}[tool] ${d.name} -> ${d.result.slice(0, 300)}`);
    } else if (e.type === 'log') {
      console.error(`${prefix}[log] ${e.detail}`);
    } else if (e.type === 'usage') {
      const u = e.detail as { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number };
      const cacheNote = u.cacheReadTokens
        ? ` (${u.cacheReadTokens} from cache)`
        : u.cacheWriteTokens
          ? ` (${u.cacheWriteTokens} written to cache)`
          : '';
      console.error(`${prefix}[usage] in=${u.inputTokens} out=${u.outputTokens}${cacheNote}`);
    }
  };
}

const program = new Command();
program
  .name('appliqation-scriptgen')
  .description('Draft and verify an enterprise-grade Playwright script for one Appliqation test case.');

program
  .command('generate')
  .description(
    "Compose a Playwright test for one TC via appq's appq:automate workflow (context: scenario, sibling-TC " +
      'flakiness, linked defects, manual/agentic execution evidence, canonical script if present), given real ' +
      'filesystem + an allowlisted shell so it can bootstrap the target repo and actually run the result — ' +
      '`npx playwright test` is what decides pass/fail, never the model\'s own claim. Writes local files only: ' +
      'no appq write tool call, no git operation. scenario_id/project_id are always derived from ' +
      '--test-case-uuid, never accepted as separate inputs.',
  )
  .requiredOption('--test-case-uuid <uuid>', 'test case UUID to generate a script for')
  .option(
    '--environment <name>',
    'environment name — its URL (from get_project_settings) is offered as context for the target app\'s ' +
      'baseURL, only if the target repo needs a Playwright config bootstrapped from scratch',
  )
  .option(
    '--role <name>',
    'authenticate as this role in the generated script (setupAuth). Omit for per-TC inference from the TC\'s ' +
      'own tag/name (same mechanism appliqation-autotest uses), or for ungated projects where neither applies.',
  )
  .option(
    '--autotest-run-id <id>',
    'a prior appliqation-autotest run for this TC. Passed straight through as appq:automate\'s autotest_run_id ' +
      "arg — pulls that run's execution evidence and switches to autonomous mode (no confirmation steps, no " +
      'live-browsing phase).',
  )
  .option('--repo-path <path>', 'target repo root every file/command tool call is scoped to', process.cwd())
  .option('--file-path <path>', 'local spec file to extend or create. Omit to let the AI discover/propose one.')
  .option('--max-turns <n>', 'override BUDGET_MAX_TURNS for this run')
  .option('--json', 'print a single structured JSON summary on stdout instead of a human-readable report')
  .option('--ci', 'shorthand for --json; exit code already reflects the real, execFile-verified outcome either way')
  .action(
    async (opts: {
      testCaseUuid: string;
      environment?: string;
      role?: string;
      autotestRunId?: string;
      repoPath: string;
      filePath?: string;
      maxTurns?: string;
      json?: boolean;
      ci?: boolean;
    }) => {
      const json = (opts.json ?? false) || (opts.ci ?? false);
      const adapter = buildAdapter();

      const scenarioId = resolveScenarioId({ testCaseUuid: opts.testCaseUuid });
      const { projectId, tcs } = await fetchScenarioInfo(client, scenarioId);

      const environmentUrl = opts.environment ? await resolveUrl(client, opts.environment, projectId) : undefined;

      let role = opts.role;
      if (!role) {
        const knownRoles = knownRolesForProject(projectId);
        const tcInfo = tcs.find((t) => t.testCaseUuid === opts.testCaseUuid);
        const inferred = tcInfo ? inferRole(tcInfo, knownRoles) : null;
        if (inferred) {
          role = inferred;
          console.error(`[setup] authenticated as role "${inferred}" (inferred)`);
        }
      }

      const budget = { ...config.budget, ...(opts.maxTurns ? { maxTurns: Number(opts.maxTurns) } : {}) };

      const startedAt = Date.now();
      const usage = createUsageAccumulator();
      const baseLog = logEvent('');
      let result: GenerateResult | undefined;
      try {
        result = await generate({
          client,
          adapter,
          projectId,
          scenarioId,
          testCaseUuid: opts.testCaseUuid,
          repoPath: opts.repoPath,
          budget,
          commandTimeoutMs: config.commandTimeoutMs,
          filePath: opts.filePath,
          autotestRunId: opts.autotestRunId,
          role,
          environmentUrl,
          onEvent: (e) => {
            baseLog(e);
            if (e.type === 'usage') usage.onUsage(e.detail as { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number });
          },
        });
      } finally {
        // Audit write happens whether the run succeeded or threw — see
        // @appliqation/agent-core's audit/sink.ts: safeRecord() (used
        // inside recordGenerateRun) never lets a failed/unreachable audit
        // sink affect this process's real outcome.
        await recordGenerateRun({ sink: config.auditSink, startedAt, endedAt: Date.now(), model: resolveModel(), usage: usage.totals(), testCaseUuid: opts.testCaseUuid, result });
      }

      if (!json) {
        console.log('\n=== Report ===\n');
        console.log(result.report);
        console.error(`\n(${result.turns} turns, budget exceeded: ${result.budgetExceeded})`);
      }

      const summary: GenerateSummary = {
        testCaseUuid: opts.testCaseUuid,
        writtenPaths: result.writtenPaths,
        testRan: result.testRun.ran,
        verified: result.testRun.ok,
        report: result.report,
      };
      if (json) printJsonSummary(summary);
      else printHumanSummary(summary);
      process.exitCode = exitCodeFor(summary);
    },
  );

program.parseAsync(process.argv);
