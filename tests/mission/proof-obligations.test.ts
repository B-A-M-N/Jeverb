import { describe, expect, it } from "vitest";
import { buildMissionProofObligation, proofObligationId, validMissionProofObligation } from "../../src/mission/proof-obligations.js";

describe("mission proof obligations", () => {
  it("binds stable obligation identity to the exact criterion and requirement", () => {
    expect(proofObligationId("criterion-1", "  Run   current tests ")).toBe(
      proofObligationId("criterion-1", "run current tests"),
    );
    expect(proofObligationId("criterion-1", "run current tests")).not.toBe(
      proofObligationId("criterion-2", "run current tests"),
    );
    expect(proofObligationId("criterion-1", "run current tests")).not.toBe(
      proofObligationId("criterion-1", "run all tests"),
    );
  });

  it("records predecessor states and accepts only a complete, succeeded obligation", () => {
    const obligation = buildMissionProofObligation({
      criterionId: "criterion-1",
      requirement: "Run current tests",
      graphEvidence: [{
        criterionId: "criterion-1",
        runId: "run-1",
        nodeId: "verify",
        state: "bound",
        detail: "host journal binding",
        dependencies: [{ nodeId: "build", state: "succeeded" }],
      }],
    });
    expect(obligation.dependencies).toEqual([{ runId: "run-1", nodeId: "build", state: "succeeded" }]);
    expect(validMissionProofObligation(obligation, "criterion-1", "Run current tests")).toBe(true);
    expect(validMissionProofObligation(obligation, "criterion-2", "Run current tests")).toBe(false);

    for (const state of ["failed", "blocked", "skipped", "missing", "outcome_unknown"] as const) {
      expect(validMissionProofObligation({
        ...obligation,
        dependencies: [{ runId: "run-1", nodeId: "build", state }],
      }, "criterion-1", "Run current tests")).toBe(false);
    }
  });

  it("keeps a root obligation distinct from absent or incorrect proof metadata", () => {
    const root = buildMissionProofObligation({ criterionId: "criterion-1", requirement: "Build artifact", graphEvidence: [] });
    expect(root.dependencies).toEqual([]);
    expect(validMissionProofObligation(root, "criterion-1", "Build artifact")).toBe(true);
    expect(validMissionProofObligation(undefined, "criterion-1", "Build artifact")).toBe(false);
    expect(validMissionProofObligation({ ...root, requiredEvidence: [] as never }, "criterion-1", "Build artifact")).toBe(false);
  });
});
