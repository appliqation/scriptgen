// Calls the (now enriched, see appq's AutomatePrompt.php) appq:automate
// workflow through the shared engine, offering it exactly two tool
// surfaces: read-only appq context tools (get_scenario, get_run_evidence,
// get_defect_context, ...) and real coding tools (read_file/write_file/
// list_directory/run_command, scoped to one repo). No appq write tool, no
// git operation, no browser — the prompt's own Phase 0/3/5/6 already
// describe exactly the bootstrap-draft-verify loop needed, and Phase 4
// (optional live browsing) is skipped outright once autotest_run_id is
// passed (see AutomatePrompt.php's autonomous mode).

import {
  fetchAppqToolDefs,
  createGatedAppqDispatcher,
  runWorkflow,
  type McpClient,
  type ProviderAdapter,
  type RunBudget,
  type ToolDispatcher,
} from '@appliqation/agent-core';
import { READONLY_CONTEXT_TOOLS } from '../tools/safety.js';
import { CODING_TOOL_DEFS, CodingTools } from '../tools/codingTools.js';

export interface GenerateOptions {
  client: McpClient;
  adapter: ProviderAdapter;
  projectId: number;
  scenarioId: number;
  testCaseUuid: string;
  /** Repo root every read_file/write_file/run_command call is scoped to. */
  repoPath: string;
  budget: RunBudget;
  commandTimeoutMs: number;
  filePath?: string;
  /** A prior appliqation-autotest run — passed straight through to appq:automate's autotest_run_id arg. */
  autotestRunId?: string;
  /** If this TC needs authentication, the role the generated script should reference. */
  role?: string;
  /** Target app base URL, offered as context only — not a formal appq:automate arg. */
  environmentUrl?: string;
  onEvent?: (event: { type: string; detail?: unknown }) => void;
}

export interface GenerateResult {
  report: string;
  turns: number;
  budgetExceeded: boolean;
  /** Repo-relative paths written during this run. */
  writtenPaths: string[];
  testRun: {
    /** Whether a `npx playwright test` invocation happened at all. */
    ran: boolean;
    /**
     * Real, execFile-reported success — AND it happened after the most
     * recent file write, so an earlier pass before further edits doesn't
     * count. This is the one field that decides the CLI's exit code; it is
     * never derived from the model's own report text.
     */
    ok: boolean;
    exitCode: number | null;
  };
}

function seedMessage(opts: GenerateOptions): string {
  const lines = [
    `Project ID: ${opts.projectId}`,
    `Scenario ID: ${opts.scenarioId}`,
    `Test case UUID: ${opts.testCaseUuid}`,
    `Target repo root (every file/command tool call is scoped here): ${opts.repoPath}`,
  ];
  if (opts.filePath) lines.push(`Target spec file: ${opts.filePath}`);
  if (opts.role) {
    lines.push(
      `This TC authenticates as role "${opts.role}" — if the target app is gated, the generated script ` +
        `should call setupAuth({ project_id: ${opts.projectId}, role: "${opts.role}" }) per the contract rule.`,
    );
  }
  if (opts.environmentUrl) {
    lines.push(`Target app base URL (for playwright.config's baseURL, only if you need to bootstrap one): ${opts.environmentUrl}`);
  }
  lines.push('Begin now — start with get_scenario.');
  return lines.join('\n');
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const coding = new CodingTools(opts.repoPath, opts.commandTimeoutMs);
  const appqToolDefs = await fetchAppqToolDefs(opts.client, READONLY_CONTEXT_TOOLS);
  const gatedAppq = createGatedAppqDispatcher(opts.client, READONLY_CONTEXT_TOOLS);

  const codingToolNames = new Set(CODING_TOOL_DEFS.map((t) => t.name));
  const dispatch: ToolDispatcher = async (name, args) => {
    if (codingToolNames.has(name)) return coding.dispatch(name, args);
    return gatedAppq(name, args);
  };

  const promptArgs: Record<string, unknown> = {
    project_id: opts.projectId,
    scenario_id: opts.scenarioId,
    test_case_uuid: opts.testCaseUuid,
  };
  if (opts.filePath) promptArgs.file_path = opts.filePath;
  if (opts.autotestRunId) promptArgs.autotest_run_id = opts.autotestRunId;

  const loopResult = await runWorkflow({
    source: { kind: 'appq', name: 'appq:automate', args: promptArgs },
    fetchPrompt: opts.client.fetchPrompt,
    seedMessage: seedMessage(opts),
    tools: [...appqToolDefs, ...CODING_TOOL_DEFS],
    dispatch,
    adapter: opts.adapter,
    budget: opts.budget,
    onEvent: opts.onEvent,
  });

  const writtenPaths = coding.getWrittenPaths();
  const lastTestRun = coding.lastPlaywrightTestRun();
  const lastWriteAt = writtenPaths.size > 0 ? Math.max(...writtenPaths.values()) : 0;
  const verifiedAfterLastWrite = lastTestRun !== null && lastTestRun.ok && lastTestRun.timestamp >= lastWriteAt;

  return {
    report: loopResult.report,
    turns: loopResult.turns,
    budgetExceeded: loopResult.budgetExceeded,
    writtenPaths: [...writtenPaths.keys()],
    testRun: {
      ran: lastTestRun !== null,
      ok: verifiedAfterLastWrite,
      exitCode: lastTestRun?.exitCode ?? null,
    },
  };
}
