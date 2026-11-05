import { describe, expect, it } from "vitest";
import { calculateRequestCeiling, combineWithGlobalBackstop, globalBackstopDisposition } from "../../scripts/jev-dag-local-paired-dev.js";
import type { MissionClosureEvidence } from "../../src/mission/closure.js";

function row(id: string, criteria: number) {
  return {
    id,
    evidence: {
      criteria: Array.from({ length: criteria }, (_, index) => ({ id: `criterion-${index + 1}` })),
    } as unknown as MissionClosureEvidence,
  };
}

describe("DAG-local paired request budget", () => {
  it("counts one global baseline plus one request per criterion", () => {
    expect(calculateRequestCeiling(Array.from({ length: 12 }, (_, index) => row(`case-${index}`, 2)))).toEqual({
      baseline: 12,
      candidate: 24,
      total: 36,
      criterionCount: 24,
    });
  });

  it("derives candidate ceiling from the actual declared criterion count", () => {
    expect(calculateRequestCeiling([row("case-a", 1), row("case-b", 4)])).toEqual({
      baseline: 2,
      candidate: 5,
      total: 7,
      criterionCount: 5,
    });
  });
});

describe("global semantic backstop for criterion-local comparison", () => {
  it("requires the unchanged 0.90 confidence and COMPLETE concentration gates", () => {
    expect(globalBackstopDisposition("COMPLETE", 0.9, 0.9)).toBe("FULFILLED");
    expect(globalBackstopDisposition("COMPLETE", 0.89, 0.99)).toBe("UNCERTAIN");
    expect(globalBackstopDisposition("COMPLETE", 0.99, 0.89)).toBe("UNCERTAIN");
  });

  it("allows local evidence to veto but never replace the global completion judgment", () => {
    expect(combineWithGlobalBackstop("FULFILLED", "NOT_FULFILLED")).toBe("NOT_FULFILLED");
    expect(combineWithGlobalBackstop("FULFILLED", "UNCERTAIN")).toBe("UNCERTAIN");
    expect(combineWithGlobalBackstop("NOT_FULFILLED", "FULFILLED")).toBe("NOT_FULFILLED");
    expect(combineWithGlobalBackstop("UNCERTAIN", "FULFILLED")).toBe("UNCERTAIN");
  });
});
