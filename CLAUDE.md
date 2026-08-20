# CLAUDE.md — appliqation-scriptgen

Part of the Appliqation workspace. See `~/Sites/localhost/CLAUDE.md` for how the
product fits together; this file is the map of **this repo only**.

## What this repo is

A standalone agent that drafts and verifies an enterprise-grade Playwright script for
one Appliqation test case — the "no canonical script exists" case
`appliqation-autotest`'s `judge` already detects via `get_automation_readiness`, but
never generates for. Second consumer of `@appliqation/agent-core`
(`~/Sites/localhost/appliqation-agent-core/`); read that repo's `CLAUDE.md` first for
the shared engine this is built from.

**Deliberately thin.** The context-gathering and drafting *methodology* lives entirely
in appq's own `appq:automate` MCP prompt (deepened for this purpose — see
`appq/web/modules/custom/appq_vibe_api/src/McpPrompt/AutomatePrompt.php`), not
duplicated here. This repo's own code is only: the two tool surfaces `generate` offers
the model (read-only appq context tools, and real filesystem + an allowlisted shell —
see below), the CLI, and result-shaping that never trusts the model's own claims.

## The core design decision: give the loop real coding-agent tools, not a browser

`appq:automate`'s prompt (Phase 0/3/5/6) is written assuming a full coding-agent
session: check/bootstrap `package.json`/Playwright config, read local code, write the
spec file, then **actually run `npx playwright test` and iterate until green** — "never
fabricate a pass without actually executing the spec" is already the prompt's own
instruction. The original design for this repo (see the plan doc referenced from
`appliqation-autotest/CLAUDE.md`) proposed a separate stage that would launch its own
`chromium.launch()` and replay the draft's actions live, self-healing selectors step by
step — deliberately **not built**. Once the design work landed on "just call
`appq:automate`", it became clear that mechanism would just duplicate what the
prompt's own draft→verify→iterate loop already does, more simply, if the loop actually
had the tools the prompt assumes. So `generate()` (`src/orchestrator/generate.ts`)
offers the model exactly two tool surfaces and nothing else:

1. **Read-only appq context tools** (`src/tools/safety.ts`'s `READONLY_CONTEXT_TOOLS` —
   `get_scenario`, `get_defect_context`, `get_failure_patterns`, `get_run_evidence`,
   `get_execution_evidence`, `get_automation_readiness`, `get_coverage_analysis`,
   `get_validation_targets`, etc.). Zero write tools — not gated behind a flag,
   genuinely absent. This agent never calls an appq write tool and never performs a
   git operation; a separate future agent ("PR-raise", not yet built) is responsible
   for reviewing and pushing what this one writes locally.
2. **Real coding tools** (`src/tools/codingTools.ts`'s `CodingTools` —
   `read_file`/`write_file`/`list_directory`/`run_command`), scoped to one repo root
   (`--repo-path`, no path traversal out of it). `run_command` is gated by
   `src/tools/commandGate.ts` — an explicit allowlist (`npm init -y`, `npm install -D
   <pkgs>`, `npx playwright install/--version/test`, `node --version`, `git
   status/diff`), spawned via `child_process.execFile` with an explicit argv array
   (never a shell string, so the OS never parses arguments as shell syntax regardless
   of allowlist correctness). This is the one genuinely new, more-dangerous capability
   in this agent family so far — treat any change to the allowlist with the same
   weight as `destructiveActionGate.ts`'s regex bank elsewhere in the family: it's a
   hardcoded, non-negotiable boundary, not something a workflow prompt can widen.

No browser tools are offered at all. `appq:automate`'s Phase 4 (optional live browsing)
is skipped outright once `autotest_run_id` is passed (see below) — this agent always
passes it when it has one, so that phase never actually runs for this caller.

## Never trust the model's own claim

`generate()`'s result and the CLI's exit code are derived **only** from what
`CodingTools` actually observed happening — never from the model's final report text.
Specifically: `CodingTools.lastPlaywrightTestRun()` returns the most recent
`npx playwright test` invocation's real, `execFile`-reported exit code (the model
cannot fabricate this — the tool result the model sees on its next turn is the same
ground truth `generate()` reads afterward), and that run only counts as verifying the
*current* file content if its timestamp is at or after the most recent `write_file`
call — an earlier passing run before further edits proves nothing about the file as it
stands now. `src/cli/output.ts`'s `exitCodeFor()` is 0 only when a test both ran and
passed under those conditions; "the model said it passed" is never sufficient on its
own, matching the same "verify via a durable side channel, don't trust self-report"
discipline `appliqation-autotest`'s `judge` uses (polling appq's own authoritative
run status rather than parsing the validator's report prose).

## Where to find what

- `src/cli/index.ts` — `generate` command. `--test-case-uuid` is the only required
  identifier; `scenario_id`/`project_id` are always derived from it
  (`resolveScenarioId`/`fetchScenarioInfo` from `@appliqation/agent-core`), never
  accepted as separate inputs — same reasoning as `appliqation-autotest`'s `judge`.
  `--environment` is optional (offered to the model as base-URL context only, not a
  formal `appq:automate` arg — that prompt has no live-navigation concept in
  autonomous mode). `--role` defaults to per-TC inference
  (`knownRolesForProject`/`inferRole`, same mechanism `judge` uses) when omitted.
  `--autotest-run-id` is passed straight through as `appq:automate`'s
  `autotest_run_id` arg. `--repo-path` defaults to `process.cwd()`.
- `src/orchestrator/generate.ts` — the one real piece of orchestration: constructs the
  tool palette (appq read tools + coding tools), routes dispatch between them, builds
  the seed message (role/environment-URL/file-path context), calls `runWorkflow()`
  against `appq:automate`, and shapes the result via `CodingTools`'s tracked state (see
  "Never trust the model's own claim" above) — not by parsing `loopResult.report`.
- `src/tools/codingTools.ts` — `CodingTools`: the filesystem + shell surface. Tracks
  every write (`getWrittenPaths()`, path → timestamp) and every command run
  (`getCommandHistory()`, `lastPlaywrightTestRun()`) so `generate.ts` can reason about
  what actually happened without re-parsing anything.
- `src/tools/commandGate.ts` — `assertCommandAllowed(command, args)`: the shell-command
  allowlist. Pure and directly unit-tested (`commandGate.test.ts`) — extend the
  allowlist here, never by loosening `codingTools.ts`'s call site.
- `src/tools/safety.ts` — `READONLY_CONTEXT_TOOLS`, this agent's own appq-tool
  allowlist content (the enforcement mechanism is `@appliqation/agent-core`'s
  `assertToolAllowed`/`createGatedAppqDispatcher`, shared with every sibling agent).
- `src/cli/output.ts` — `GenerateSummary`/`printJsonSummary`/`printHumanSummary`/
  `exitCodeFor()` — see "Never trust the model's own claim" above.
- `src/config/env.ts` — this agent's own config. No executor/validator split (unlike
  `appliqation-autotest` — there's one role here), so a single `resolveModel()`, not a
  per-role one. `COMMAND_TIMEOUT_MS` caps each individual `run_command` call
  (`npm install`/`playwright test` can each legitimately take a while); `BUDGET_MAX_*`
  caps the overall tool-calling loop, same shape as `appliqation-autotest`'s budget.
  `auditSink` resolves `AUDIT_MONGO_*`/`AUDIT_JSONL_PATH` via
  `@appliqation/agent-core/audit`'s `resolveAuditSink()` — opt-in, no-op when
  unconfigured.
- `src/cli/audit.ts` — `recordGenerateRun()`, extracted out of `cli/index.ts` so it's
  testable without triggering that file's `program.parseAsync(process.argv)` side
  effect (same reasoning as `appliqation-autotest`'s `cli/resolvers.ts`). `outcome` is
  exactly the same shape as `GenerateSummary`; `exitCode` reuses `output.ts`'s own
  `exitCodeFor()` rather than re-deriving the pass/fail rule a second time.

## Explicitly out of scope for v1

- Any appq write tool call, any git/GitHub operation — see "What this repo is" above.
- Whole-scenario/coverage-policy batch mode — this agent is single-TC only. The
  decision of *which* TCs need a script (no canonical exists) is made by the caller
  before invoking `generate`, not looped over internally.
- Project-specific post-processing (POM conversion, pulling context from
  Confluence/other in-house systems) — discussed as a possible future direction, not
  built, no extension seam added for it either.
- A real Confluence/wiki integration.
- Reimplementing `workers/shared/scriptContract`'s validation client-side — compliant
  boilerplate is appq's job now, baked into the enriched `appq:automate` prompt itself
  (Phase 5's `mapAppqUuid`/`setupAuth` template snippets), not duplicated here.

## Commands

- `npm run dev -- generate --test-case-uuid <uuid> [--environment <name>] [--role <name>] [--autotest-run-id <id>] [--repo-path <path>] [--file-path <path>] [--max-turns <n>] [--json|--ci]`
- `npm run build` / `npm run typecheck`
- `npm test` / `npm run test:watch` — vitest, colocated `src/**/*.test.ts` files

## Config

Copy `.env.example` to `.env`. Requires `APPQ_API_KEY` and one of
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` — same credentials as `appliqation-autotest`'s
`.env` work here too (same appq account/org).

## Keeping this file current

When you add, remove, or rename a top-level file or a directory under `src/`, update
the map above in the same change.
