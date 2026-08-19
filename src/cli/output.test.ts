import { describe, it, expect, vi } from 'vitest';
import { printJsonSummary, printHumanSummary, exitCodeFor } from './output.js';
import type { GenerateSummary } from './output.js';

const written: GenerateSummary = { testCaseUuid: 'tc-1', writtenPaths: ['tests/x.spec.ts'], testRan: true, verified: true, report: 'r' };
const failedRun: GenerateSummary = { testCaseUuid: 'tc-2', writtenPaths: ['tests/y.spec.ts'], testRan: true, verified: false, report: 'r' };
const neverRan: GenerateSummary = { testCaseUuid: 'tc-3', writtenPaths: [], testRan: false, verified: false, report: 'r' };

describe('exitCodeFor', () => {
  it('is 0 when the test actually ran and passed', () => {
    expect(exitCodeFor(written)).toBe(0);
  });

  it('is 1 when the test ran but failed', () => {
    expect(exitCodeFor(failedRun)).toBe(1);
  });

  it('is 1 when the test never ran at all — no verification, no pass', () => {
    expect(exitCodeFor(neverRan)).toBe(1);
  });

  it('is 1 for the pathological case of verified=true but testRan=false (should not be reachable, but exit code must not trust verified alone)', () => {
    expect(exitCodeFor({ ...neverRan, verified: true })).toBe(1);
  });
});

describe('printJsonSummary', () => {
  it('prints the summary as JSON to stdout', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printJsonSummary(written);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual(written);
  });
});

describe('printHumanSummary', () => {
  it('lists every written path', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary({ ...written, writtenPaths: ['a.ts', 'b.ts'] });
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('a.ts');
    expect(output).toContain('b.ts');
  });

  it('reports "No files were written" when nothing was written', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary(neverRan);
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('No files were written');
  });

  it('reports "Never actually ran" when testRan is false', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary(neverRan);
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Never actually ran');
  });

  it('reports PASSED when verified', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary(written);
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('PASSED');
  });

  it('reports FAILED when the test ran but did not verify', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printHumanSummary(failedRun);
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('FAILED');
  });
});
