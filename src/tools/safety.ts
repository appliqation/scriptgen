// This agent's own domain knowledge of which appq tools it may touch — the
// enforcement mechanism (assertToolAllowed / the gated dispatcher) lives in
// @appliqation/agent-core, shared with every sibling agent; only the
// allowlist content is local. Zero write tools — not gated behind a flag,
// genuinely absent from the set. This agent never calls an appq write tool
// and never performs a git operation; it writes local files only, and a
// separate future agent is responsible for reviewing/committing/pushing
// them.

export const READONLY_CONTEXT_TOOLS = new Set([
  'get_scenario',
  'get_defect_context',
  'get_analytics',
  'get_failure_patterns',
  'get_execution_evidence',
  'get_run_evidence',
  'get_automation_readiness',
  'get_coverage_analysis',
  'get_evidence_summary',
  'get_test_results',
  'get_project_settings',
  'get_validation_targets',
  'search_tests',
  'get_project_test_data',
]);
