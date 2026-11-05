import { describe, expect, it } from "vitest";
import { decideControlAction, type ControllerInput } from "../../src/decision/control.js";
import { answerSummary, buildDecisionJournalEvent } from "../../src/decision/evidence.js";
import { gateConsequentialRouting } from "../../src/decision/routing.js";
import type { DecisionEvidence, VerificationDecision } from "../../src/decision/types.js";
import type { MissionClosureEvidence } from "../../src/mission/closure.js";

function closureEvidence(): MissionClosureEvidence {
  return {
    missionId: "m1",
    objective: "Deliver the requested feature",
    missionRevision: "r1",
    evidenceRevision: "e1",
    criteria: [],
    tests: { passed: false, independent: false, revision: "t1" },
    operations: { pending: 1, uncertain: 0 },
    blockers: [],
  };
}

describe("routing / authorization / verification are distinguishable", () => {
  it("control decisions record the authorization family", () => {
    const input: ControllerInput = {
      evidence: closureEvidence(),
      prior: [],
      attempts: 0,
      transientFailure: false,
    };
    expect(decideControlAction(input).kind).toBe("authorization");
  });

  it("routing gates record the routing family", () => {
    const result = gateConsequentialRouting({
      active: {
        backend: "typesafe",
        model: "jev-1.14.0",
        modelVersion: "v",
        questionFamily: "q",
        policyHash: "p",
      },
      confidence: 0.9,
    });
    expect(result.kind).toBe("routing");
  });

  it("verification decisions carry their own family literal", () => {
    const verification: VerificationDecision = {
      kind: "verification",
      subject: "tests pass on the current candidate",
      verdict: "fail",
      reasons: ["no current passing run"],
      evidence: [],
      policyVersion: "control-loop/1",
    };
    expect(verification.kind).toBe("verification");
    expect(verification.kind).not.toBe("routing");
  });
});

describe("structured decision evidence via the journal", () => {
  const evidence: DecisionEvidence = {
    kind: "routing",
    runId: "run-1",
    revisionHash: "rev-1",
    nodeId: "branch-node",
    questionSetHash: "qhash",
    effectiveEvidenceDigest: "eff-digest",
    backend: "typesafe",
    model: "jev-1.14.0",
    modelVersion: "2026-09-01",
    qualificationId: "qual-routing-001",
    answer: { type: "choice", value: "proceed", confidence: 0.91 },
    selectedBranch: "cond:decision.choice:proceed@0.910",
    policyVersion: "policy-routing-v3",
    mode: "consequential",
    reasons: ["consequential route admitted"],
  };

  it("persists run+revision, node, question set, digests, identity, branch, policy, and mode", () => {
    const event = buildDecisionJournalEvent({ evidence }, "2026-01-01T00:00:00.000Z");
    expect(event).toMatchObject({
      type: "node-terminal",
      runId: "run-1",
      nodeId: "branch-node",
      revisionHash: "rev-1",
      effectiveInputHash: "eff-digest",
      policyHash: "policy-routing-v3",
      modelVersion: "2026-09-01",
      qualificationId: "qual-routing-001",
      decisionKind: "routing",
      decisionMode: "consequential",
      branch: "cond:decision.choice:proceed@0.910",
    });
    expect(event.jev).toMatchObject({
      provider: "typesafe",
      model: "jev-1.14.0",
      questionHash: "qhash",
      calibrated: true,
    });
  });

  it("records advisory mode for unqualified judgments", () => {
    const { qualificationId: _droppedQual, answer: _droppedAnswer, selectedBranch: _droppedBranch, ...rest } =
      evidence;
    const event = buildDecisionJournalEvent(
      { evidence: { ...rest, mode: "advisory" } },
      "2026-01-01T00:00:00.000Z",
    );
    expect(event.decisionMode).toBe("advisory");
    expect(event.qualificationId).toBeUndefined();
    expect(event.branch).toBeUndefined();
    expect(event.jev?.calibrated).toBe(false);
  });

  it("preserves a full typed judgment verbatim, including confidence", () => {
    const jev = {
      provider: "typesafe",
      model: "jev-1.14.0",
      questionHash: "qhash",
      calibrated: true,
      answers: {
        proceed: {
          type: "choice",
          choice: "proceed",
          probabilities: { proceed: 0.91, hold: 0.09 },
          confidence: 0.91,
        },
      },
    } as const;
    const event = buildDecisionJournalEvent({ evidence, jev: { ...jev } }, "2026-01-01T00:00:00.000Z");
    expect(event.jev?.answers?.["proceed"]).toMatchObject({ choice: "proceed", confidence: 0.91 });
    expect(answerSummary(event.jev, "proceed")).toEqual({
      type: "choice",
      value: "proceed",
      confidence: 0.91,
    });
  });

  it("summarizes verdict fallbacks and unknown questions without guessing", () => {
    expect(answerSummary(undefined, "proceed")).toBeUndefined();
    expect(
      answerSummary(
        { provider: "typesafe", questionHash: "q", calibrated: false, verdict: "yes", noul: 0.8 },
        "missing",
      ),
    ).toEqual({ type: "verdict", value: "yes", confidence: 0.8 });
  });
});
