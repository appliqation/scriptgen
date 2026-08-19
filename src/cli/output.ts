// --json/--ci's renderer, matching appliqation-autotest's output.ts shape.
// exitCodeFor() never trusts the model's own report text — only
// GenerateResult.testRun.ok, which is derived from a real execFile exit
// code, decides success. A file that was never actually run — or was run
// before its last edit — is not a pass, no matter what the report claims.

export interface GenerateSummary {
  testCaseUuid: string;
  writtenPaths: string[];
  testRan: boolean;
  verified: boolean;
  report: string;
}

export function printJsonSummary(summary: GenerateSummary): void {
  console.log(JSON.stringify(summary, null, 2));
}

export function printHumanSummary(summary: GenerateSummary): void {
  console.log(`\n=== Test case ${summary.testCaseUuid} ===\n`);
  if (summary.writtenPaths.length === 0) {
    console.log('  No files were written.');
  } else {
    for (const p of summary.writtenPaths) console.log(`  wrote  ${p}`);
  }
  if (!summary.testRan) {
    console.log('\n  Never actually ran `npx playwright test` — not verified.');
  } else {
    console.log(`\n  Verification: ${summary.verified ? 'PASSED' : 'FAILED (or stale — run predates the last edit)'}`);
  }
}

/** 1 unless the file was actually run — via a real, execFile-reported exit code — after its last edit, and passed. */
export function exitCodeFor(summary: GenerateSummary): number {
  return summary.testRan && summary.verified ? 0 : 1;
}
