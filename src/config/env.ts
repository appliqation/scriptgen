import 'dotenv/config';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL } from '@appliqation/agent-core/providers';
import { required, optional } from '@appliqation/agent-core/config';
import { resolveAuditSink } from '@appliqation/agent-core/audit';

export const config = {
  appqOrigin: optional('APPQ_ORIGIN') ?? 'https://appq.appliqation.io',
  appqApiKey: () => required('APPQ_API_KEY'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),
  anthropicModel: optional('ANTHROPIC_MODEL'),
  openaiModel: optional('OPENAI_MODEL'),
  anthropicMaxTokens: Number(optional('ANTHROPIC_MAX_TOKENS') ?? 8192),
  openaiMaxOutputTokens: Number(optional('OPENAI_MAX_OUTPUT_TOKENS') ?? 8192),
  // A single, generous budget — unlike appliqation-autotest there is no
  // executor/validator split here, just one drafting-and-verifying pass that
  // may need several rounds of "run the test, read the failure, fix it".
  budget: {
    maxCalls: Number(optional('BUDGET_MAX_CALLS') ?? 60),
    // This agent never calls browser_navigate (no browser tools offered at
    // all), so BudgetTracker's page counter never increments — a large,
    // effectively-unreachable cap rather than 0, since 0 would trip
    // immediately (exceeded() checks pages >= maxPages, and 0 >= 0 is true).
    maxPages: Number(optional('BUDGET_MAX_PAGES') ?? 999_999),
    maxMillis: Number(optional('BUDGET_MAX_MILLIS') ?? 20 * 60 * 1000),
    maxTurns: Number(optional('BUDGET_MAX_TURNS') ?? 60),
  },
  // Wall-clock cap per run_command invocation (npm install / playwright test
  // can each legitimately take a while) — separate from the overall budget.
  commandTimeoutMs: Number(optional('COMMAND_TIMEOUT_MS') ?? 5 * 60 * 1000),

  // Observability, entirely opt-in — see @appliqation/agent-core's audit/sink.ts.
  auditSink: resolveAuditSink({
    auditMongoUri: optional('AUDIT_MONGO_URI'),
    auditMongoDb: optional('AUDIT_MONGO_DB'),
    auditMongoCollection: optional('AUDIT_MONGO_COLLECTION'),
    auditJsonlPath: optional('AUDIT_JSONL_PATH'),
  }),
};

export function resolveProvider(): 'anthropic' | 'openai' {
  if (config.anthropicApiKey) return 'anthropic';
  if (config.openaiApiKey) return 'openai';
  throw new Error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY');
}

export function resolveModel(): string {
  const provider = resolveProvider();
  return provider === 'anthropic' ? (config.anthropicModel ?? DEFAULT_ANTHROPIC_MODEL) : (config.openaiModel ?? DEFAULT_OPENAI_MODEL);
}
