/**
 * Explicit criterion→producer-node associations (Phase 4 lineage).
 *
 * The trusted producer converts host-declared associations into bindings
 * against persisted journal evidence — it never guesses. Covered here with
 * stub data only (no inference, no network):
 *
 * - an unrelated succeeded node never satisfies a criterion (no binding
 *   without a declaration);
 * - missing runs/nodes/hashes and superseded attempts yield no binding, so
 *   the criterion stays unresolved;
 * - divergent declared nodes for one criterion both bind, and the resolver
 *   marks them conflict (the producer never picks a winner);
 * - one node serves several criteria only when each contribution is
 *   explicitly declared;
 * - retries and repairs preserve lineage: the journaled attempt list
 *   survives a second terminal, bindings can name the actual attempt, and a
 *   candidate rotation renders the old declaration stale;
 * - resolver checks for the new `attemptId` and `missionRevision` fields.
 *
 * Limitation (reported, not fixed here): the projected outcome is
 * last-terminal-wins, but the journal reconcile does not surface WHICH
 * attempt produced the last terminal — so a binding can only require
 * lineage membership, not settle-identity. Surfacing the settling attempt
 * per terminal is a needed interface on the graph journal owner.
 */
import { describe, expect, it } from "vitest";
import {
  buildCriterionGraphBindings,
  resolveCriterionGraphBindings,
  TRUSTED_GRAPH_BINDING_PROVENANCE,
  type CriterionProducerAssociation,
} from "../../src/mission/graph-binding.js";
import type { MissionGraphRunEvidence } from "../../src/mission/closure.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);
const F = "f".repeat(64);
const R = "9".repeat(64);

function runs(): MissionGraphRunEvidence[] {
  return [
    {
      runId: "run-1",
      graphHash: A,
      policyHash: B,
      nodes: [
        { nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D, declaredDependencies: [], attemptIds: ["build/1", "build/2"] },
        { nodeId: "lint", status: "succeeded", inputHash: E, outputDigest: F, declaredDependencies: [], attemptIds: ["lint/1"] },
      ],
    },
  ];
}

function build(associations: CriterionProducerAssociation[]): ReturnType<typeof buildCriterionGraphBindings> {
  return buildCriterionGraphBindings({
    criteria: [{ id: "criterion-01" }, { id: "criterion-02" }],
    associations,
    graphRuns: runs(),
    missionRevision: R,
    candidateDigest: A,
  });
}

describe("explicit producer associations", () => {
  it("binds only declared nodes; unrelated success never satisfies", () => {
    const bindings = build([{ criterionId: "criterion-01", runId: "run-1", nodeId: "build" }]);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      criterionId: "criterion-01",
      runId: "run-1",
      nodeId: "build",
      inputHash: C,
      outputDigest: D,
      executionStatus: "succeeded",
      missionRevision: R,
      candidateDigest: A,
      provenance: TRUSTED_GRAPH_BINDING_PROVENANCE,
    });
    // criterion-02 has a succeeded node available (lint) but no declaration:
    // no binding, so it can never count as satisfied.
    expect(bindings.some((binding) => binding.criterionId === "criterion-02")).toBe(false);
  });

  it("one node serves several criteria only when each contribution is declared", () => {
    const one = build([{ criterionId: "criterion-01", runId: "run-1", nodeId: "build" }]);
    expect(one).toHaveLength(1);
    const both = build([
      { criterionId: "criterion-01", runId: "run-1", nodeId: "build" },
      { criterionId: "criterion-02", runId: "run-1", nodeId: "build" },
    ]);
    expect(both.map((binding) => binding.criterionId)).toEqual(["criterion-01", "criterion-02"]);
  });

  it("missing runs, nodes, hashes, and attempts yield no binding", () => {
    expect(
      build([
        { criterionId: "criterion-01", runId: "run-missing", nodeId: "build" },
        { criterionId: "criterion-01", runId: "run-1", nodeId: "node-missing" },
        { criterionId: "criterion-01", runId: "run-1", nodeId: "build", attemptId: "build/99" },
        { criterionId: "unknown-criterion", runId: "run-1", nodeId: "build" },
      ]),
    ).toEqual([]);
    const noHashes: MissionGraphRunEvidence[] = [
      { runId: "run-1", nodes: [{ nodeId: "build", status: "succeeded" }] },
    ];
    expect(
      buildCriterionGraphBindings({
        criteria: [{ id: "criterion-01" }],
        associations: [{ criterionId: "criterion-01", runId: "run-1", nodeId: "build" }],
        graphRuns: noHashes,
        missionRevision: R,
      }),
    ).toEqual([]);
  });

  it("records the actual attempt when the association names lineage", () => {
    const bindings = build([{ criterionId: "criterion-01", runId: "run-1", nodeId: "build", attemptId: "build/2" }]);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.attemptId).toBe("build/2");
  });

  it("is deterministic and collapses duplicate declarations", () => {
    const associations: CriterionProducerAssociation[] = [
      { criterionId: "criterion-02", runId: "run-1", nodeId: "lint" },
      { criterionId: "criterion-01", runId: "run-1", nodeId: "build" },
      { criterionId: "criterion-01", runId: "run-1", nodeId: "build" },
    ];
    const first = build(associations);
    const second = build([...associations].reverse());
    expect(first).toEqual(second);
    expect(first.map((binding) => binding.criterionId)).toEqual(["criterion-01", "criterion-02"]);
  });

  it("emits divergent bindings for contradictory declarations; the resolver conflicts them", () => {
    const bindings = build([
      { criterionId: "criterion-01", runId: "run-1", nodeId: "build" },
      { criterionId: "criterion-01", runId: "run-1", nodeId: "lint" },
    ]);
    expect(bindings).toHaveLength(2);
    const states = resolveCriterionGraphBindings({
      bindings,
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs(),
      missionRevision: R,
      candidateDigest: A,
    });
    expect(states.map((state) => state.state)).toEqual(["conflict", "conflict"]);
  });
});

describe("resolver lineage checks", () => {
  it("binds when the named attempt is in the journaled lineage", () => {
    const [state] = resolveCriterionGraphBindings({
      bindings: [{
        criterionId: "criterion-01", runId: "run-1", nodeId: "build",
        inputHash: C, outputDigest: D, executionStatus: "succeeded",
        attemptId: "build/1", missionRevision: R, candidateDigest: A,
      }],
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs(),
      missionRevision: R,
      candidateDigest: A,
    });
    expect(state?.state).toBe("bound");
  });

  it("mismatches a superseded attempt and a rotated mission revision", () => {
    const bindings = build([{ criterionId: "criterion-01", runId: "run-1", nodeId: "build", attemptId: "build/2" }]);
    const [staleAttempt] = resolveCriterionGraphBindings({
      bindings: [{ ...bindings[0]!, attemptId: "build/99" }],
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs(),
      missionRevision: R,
      candidateDigest: A,
    });
    expect(staleAttempt?.state).toBe("mismatched");
    const [staleRevision] = resolveCriterionGraphBindings({
      bindings,
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs(),
      missionRevision: "0".repeat(64),
      candidateDigest: A,
    });
    expect(staleRevision?.state).toBe("mismatched");
  });

  it("rejects malformed attempt and revision fields instead of binding", () => {
    const [badAttempt] = resolveCriterionGraphBindings({
      bindings: [{
        criterionId: "criterion-01", runId: "run-1", nodeId: "build",
        inputHash: C, outputDigest: D, attemptId: "",
      }],
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs(),
    });
    expect(badAttempt?.state).toBe("mismatched");
    const [badRevision] = resolveCriterionGraphBindings({
      bindings: [{
        criterionId: "criterion-01", runId: "run-1", nodeId: "build",
        inputHash: C, outputDigest: D, missionRevision: "not-hex",
      }],
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs(),
    });
    expect(badRevision?.state).toBe("mismatched");
  });
});
