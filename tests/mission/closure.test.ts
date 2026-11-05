import { describe, expect, it } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionModel } from "../../src/decision/types.js";
import { hashQuestions } from "../../src/decision/provenance.js";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import { testLedgerForFile } from "../helpers/control-state.js";
import { buildMissionProofObligation } from "../../src/mission/proof-obligations.js";
import {
  decideMissionClosure,
  EVIDENCE_SUMMARY_MAX_CHARS,
  EVIDENCE_SUMMARY_MAX_LINES,
  MissionClosureGate,
  MISSION_CLOSURE_QUESTION,
  preflightMissionClosure,
  selectDagLocalProbe,
  summarizeVerifiedEvidence,
  DAG_LOCAL_NO_PROBE,
  type DagLocalCriterionJudgment,
  type RegisteredDagLocalProbeAction,
  type MissionClosureEvidence,
  type MissionClosurePolicy,
} from "../../src/mission/closure.js";

describe("DAG-local probe selection", () => {
  const registry: RegisteredDagLocalProbeAction[] = [{
    id: "probe-revocation", description: "Check authorization after membership revocation",
    command: "npm test -- --run revocation", sourceReadOnly: true,
  }];
  const judgment = (overrides: Partial<DagLocalCriterionJudgment>): DagLocalCriterionJudgment => ({
    criterionId: "feature", missionRevision: "a".repeat(64), candidateDigest: "b".repeat(64),
    evidenceDigest: "c".repeat(64), graphRevision: "d".repeat(64), contextHash: "e".repeat(64),
    graphNodeIds: [], verifierProvenance: {}, choice: "UNCERTAIN", disposition: "UNCERTAIN",
    confidence: 0.5, probabilities: { FULFILLED: 0.2, NOT_FULFILLED: 0.2, UNCERTAIN: 0.6 },
    provider: "typesafe", model: "typesafe/jev-latest", questionHash: "f".repeat(64),
    latencyMs: 1, inputTokens: 1, outputTokens: 1, ...overrides,
  });

  it("respects an explicit NO_PROBE response instead of dispatching the first registry entry", () => {
    expect(selectDagLocalProbe(judgment({ recommendedProbe: DAG_LOCAL_NO_PROBE }), registry))
      .toEqual({ status: "none", reason: "model-declined-probe" });
  });

  it("uses one registered fallback only when uncertainty has no explicit probe decision", () => {
    expect(selectDagLocalProbe(judgment({}), registry)).toMatchObject({
      status: "selected", source: "uncertainty-fallback", probe: { id: "probe-revocation" },
    });
  });

  it("never dispatches a probe for a satisfied criterion", () => {
    expect(selectDagLocalProbe(judgment({ choice: "FULFILLED", disposition: "SATISFIED" }), registry))
      .toEqual({ status: "none", reason: "satisfied" });
  });
});

const evidence: MissionClosureEvidence = {
  missionId: "mission-1",
  objective: "Deliver the requested feature",
  objectiveCoverage: { status: "attested", missionRevision: "mission-r7", promptHash: "a".repeat(64), source: "user-prompt-objective-coverage" },
  missionRevision: "mission-r7",
  evidenceRevision: "evidence-r12",
  criteria: [{
    id: "feature",
    statement: "The feature works",
    verified: true,
    proofObligation: buildMissionProofObligation({ criterionId: "feature", requirement: "The feature works", graphEvidence: [{ criterionId: "feature", runId: "run-1", nodeId: "verify", state: "bound", detail: "host journal binding", dependencies: [] }] }),
    outcome: "The requested feature is implemented and its regression case passes",
    evidenceRef: "journal:run-1/node-1",
    graphEvidence: [{ criterionId: "feature", runId: "run-1", nodeId: "verify", state: "bound", detail: "host journal binding", attemptId: "verify/1", provenance: "host:journal-projection/v2" }],
    criterionVerification: {
      result: "satisfied", verifierId: "host-verifier", detail: "receipt-backed observation",
      receiptCorrelationId: "receipt-1", observedResult: "observed expected feature state", adapterVersion: "verifier/1",
    },
    missionRevision: "mission-r7",
    evidenceRevision: "evidence-r12",
  }],
  tests: { passed: true, independent: true, evidenceRef: "verification:run-2", revision: "evidence-r12" },
  operations: { pending: 0, uncertain: 0 },
  blockers: [],
  graphRuns: [{
    runId: "run-1",
    graphHash: "a".repeat(64),
    policyHash: "b".repeat(64),
    nodes: [{ nodeId: "verify-retry-safety", status: "succeeded", outputDigest: "c".repeat(64), declaredDependencies: [] }],
  }],
};

const policy: MissionClosurePolicy = {
  policyVersion: "mission-closure/1",
  minConfidence: 0.8,
  calibrated: true,
  backend: "typesafe",
  model: "jev-1.14.0",
  modelVersion: "jev-1.14.0",
  questionHash: hashQuestions({ closure: MISSION_CLOSURE_QUESTION }),
  calibrationVersion: "fixture-calibration-1",
};

function model(
  choice: string,
  confidence = 1,
  probabilities?: Record<string, number>,
  onEvaluate?: (input: Parameters<DecisionModel["evaluate"]>[0]) => void,
): DecisionModel {
  const distribution = probabilities ?? Object.fromEntries(
    ["COMPLETE", "INCOMPLETE", "BLOCKED", "INSUFFICIENT_EVIDENCE"].map((option) => [
      option,
      option === choice ? confidence : (1 - confidence) / 3,
    ]),
  );
  return {
    name: "jev-1.14.0",
    evaluate: async (input) => {
      onEvaluate?.(input);
      return ({
      model: "jev-1.14.0",
      provider: "typesafe",
      questionHash: policy.questionHash,
      answers: {
        closure: {
          type: "choice",
          choice,
          confidence,
          probabilities: distribution,
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
      latency_ms: 1,
      }) as never;
    },
    choice: async () => { throw new Error("unused"); },
    score: async () => { throw new Error("unused"); },
    probability: async () => { throw new Error("unused"); },
  };
}

describe("mission closure gate", () => {
  it("allows a gateway decision only when its returned version is pinned and calibrated", async () => {
    const gatewayPolicy: MissionClosurePolicy = {
      ...policy,
      backend: "jev-gateway",
      model: "typesafe/jev-1.14",
      modelVersion: "typesafe/jev-1.14-20261014",
    };
    const gatewayModel: DecisionModel = {
      name: gatewayPolicy.model,
      evaluate: async () => ({
        model: gatewayPolicy.modelVersion,
        correlationId: "gateway-request-id-1",
        provider: "jev-gateway",
        questionHash: gatewayPolicy.questionHash,
        answers: { closure: { type: "choice", choice: "COMPLETE", confidence: 0.9, probabilities: { COMPLETE: 0.9, INCOMPLETE: 0.04, BLOCKED: 0.03, INSUFFICIENT_EVIDENCE: 0.03 } } },
        usage: { input_tokens: 1, output_tokens: 1 },
        latency_ms: 1,
      }) as never,
      choice: async () => { throw new Error("unused"); },
      score: async () => { throw new Error("unused"); },
      probability: async () => { throw new Error("unused"); },
    };
    const result = await decideMissionClosure(gatewayModel, evidence, gatewayPolicy);
    expect(result.complete).toBe(true);
    expect(result.provider).toBe("jev-gateway");
    expect(result.model).toBe("typesafe/jev-1.14-20261014");
    expect(result.providerRequestId).toBe("gateway-request-id-1");
  });

  it("allows OpenRouter mission closure only with the exact qualified serving identity", async () => {
    const openRouterPolicy: MissionClosurePolicy = {
      ...policy,
      backend: "openrouter",
      model: "typesafe/jev-latest",
      // The alias may resolve to a separate serving id; the manifest pins it.
      modelVersion: "typesafe/jev-latest-20261103",
    };
    expect(preflightMissionClosure(evidence, openRouterPolicy).reasons).toContain(
      "deterministic evidence checks passed; semantic review required",
    );
    const openRouterModel: DecisionModel = {
      name: openRouterPolicy.model,
      evaluate: async () => ({
        model: openRouterPolicy.modelVersion,
        correlationId: "gen-openrouter-1",
        provider: "openrouter",
        questionHash: openRouterPolicy.questionHash,
        answers: {
          closure: {
            type: "choice",
            choice: "COMPLETE",
            confidence: 0.97,
            probabilities: { COMPLETE: 0.97, INCOMPLETE: 0.01, BLOCKED: 0.01, INSUFFICIENT_EVIDENCE: 0.01 },
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
        latency_ms: 1,
      }) as never,
      choice: async () => { throw new Error("unused"); },
      score: async () => { throw new Error("unused"); },
      probability: async () => { throw new Error("unused"); },
    };
    const accepted = await decideMissionClosure(openRouterModel, evidence, openRouterPolicy);
    expect(accepted).toMatchObject({
      complete: true,
      provider: "openrouter",
      model: openRouterPolicy.modelVersion,
      providerRequestId: "gen-openrouter-1",
    });

    const mismatched: DecisionModel = {
      ...openRouterModel,
      evaluate: async () => ({
        model: "typesafe/jev-other-version",
        correlationId: "gen-openrouter-2",
        provider: "openrouter",
        questionHash: openRouterPolicy.questionHash,
        answers: {
          closure: {
            type: "choice",
            choice: "COMPLETE",
            confidence: 0.97,
            probabilities: { COMPLETE: 0.97, INCOMPLETE: 0.01, BLOCKED: 0.01, INSUFFICIENT_EVIDENCE: 0.01 },
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
        latency_ms: 1,
      }) as never,
    };
    const rejected = await decideMissionClosure(mismatched, evidence, openRouterPolicy);
    expect(rejected.complete).toBe(false);
    expect(rejected.failure?.kind).toBe("invalid");

    const unqualified = preflightMissionClosure(evidence, { ...openRouterPolicy, calibrated: false });
    expect(unqualified.checks.calibrationBound).toBe(false);
    expect(unqualified.reasons).not.toContain("deterministic evidence checks passed; semantic review required");
  });

  it("requires separate mission and evidence revisions to be internally current", () => {
    expect(preflightMissionClosure(evidence, policy).reasons).toContain(
      "deterministic evidence checks passed; semantic review required",
    );
    const stale = structuredClone(evidence);
    stale.criteria[0]!.evidenceRevision = "old-evidence";
    expect(preflightMissionClosure(stale, policy).complete).toBe(false);
  });

  it("does not review or close an objective without the original user's exhaustive coverage attestation", async () => {
    let called = false;
    const { objectiveCoverage: _coverage, ...legacy } = evidence;
    const preflight = preflightMissionClosure(legacy, policy);
    expect(preflight.status).toBe("INCOMPLETE");
    expect(preflight.checks.objectiveCoverageEstablished).toBe(false);
    expect(preflight.reasons).toContain("explicit objective coverage attestation is missing or stale");
    await decideMissionClosure(model("COMPLETE", 1, undefined, () => { called = true; }), legacy, policy);
    expect(called).toBe(false);
  });

  it("requires receipt-backed independent verification and host graph lineage for every criterion", () => {
    const missingVerification = {
      ...evidence,
      criteria: evidence.criteria.map((criterion) => ({
        ...criterion,
        criterionVerification: { result: "unresolved" as const, detail: "missing trusted receipt" },
      })),
    };
    expect(preflightMissionClosure(missingVerification, policy).checks.allCriteriaVerified).toBe(false);
    const untrustedGraph = {
      ...evidence,
      criteria: evidence.criteria.map((criterion) => ({
        ...criterion,
        graphEvidence: (criterion.graphEvidence ?? []).map((row) => ({ ...row, provenance: "agent-claim" })),
      })),
    };
    expect(preflightMissionClosure(untrustedGraph, policy).checks.allCriteriaVerified).toBe(false);
  });

  it("does not call Jev when mechanical evidence has a failed criterion", async () => {
    const incomplete = structuredClone(evidence);
    incomplete.criteria[0]!.verified = false;
    const result = await decideMissionClosure(model("COMPLETE"), incomplete, policy);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.confidence).toBeUndefined();
  });

  it("does not ask Jev to close while a terminal graph outcome remains unknown", async () => {
    const uncertain = structuredClone(evidence);
    uncertain.operations = { pending: 0, uncertain: 1 };
    uncertain.graphRuns = [{
      runId: "run-uncertain",
      nodes: [{ nodeId: "write", status: "outcome_unknown" }],
    }];
    let calls = 0;
    const result = await decideMissionClosure(
      model("COMPLETE", 1, undefined, () => { calls += 1; }),
      uncertain,
      policy,
    );

    expect(result.status).toBe("INCOMPLETE");
    expect(result.checks.noUncertainOperations).toBe(false);
    expect(result.reasons).toContain("pending or uncertain operations remain");
    expect(calls).toBe(0);
  });

  it("requires a substantive criterion outcome summary before asking Jev to close", async () => {
    const missingOutcome = structuredClone(evidence);
    delete missingOutcome.criteria[0]!.outcome;
    const result = await decideMissionClosure(model("COMPLETE"), missingOutcome, policy);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.confidence).toBeUndefined();
  });

  it("gives Jev the bounded reported outcome beside the original acceptance criterion", async () => {
    let semanticState: unknown;
    await decideMissionClosure(model("COMPLETE", 1, undefined, (input) => { semanticState = input.state; }), evidence, policy);
    expect(semanticState).toMatchObject({
      objective: evidence.objective,
      acceptanceCriteria: [{
        id: "feature",
        statement: "The feature works",
        outcome: "The requested feature is implemented and its regression case passes",
      }],
      graphRuns: [{
        runId: "run-1",
        nodes: [{ nodeId: "verify-retry-safety", status: "succeeded", outputDigest: "c".repeat(64) }],
      }],
    });
  });

  it("requires a calibrated semantic COMPLETE answer and records confidence as non-proof", async () => {
    const result = await decideMissionClosure(model("COMPLETE", 1), evidence, policy);
    expect(result.complete).toBe(true);
    expect(result.status).toBe("COMPLETE");
    expect(result.confidence).toBe(1);
    expect(result.confidenceIsProof).toBe(false);
    expect(result).toMatchObject({
      model: policy.model,
      modelVersion: policy.modelVersion,
      provider: policy.backend,
      questionHash: policy.questionHash,
      calibrationVersion: policy.calibrationVersion,
    });
  });

  it("does not allow a concentrated Jev answer to override a non-COMPLETE choice", async () => {
    const result = await decideMissionClosure(model("INCOMPLETE", 1), evidence, policy);
    expect(result.complete).toBe(false);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.confidenceIsProof).toBe(false);
  });

  it("rejects a confidence value that overstates the selected outcome's probability mass", async () => {
    const result = await decideMissionClosure(model("COMPLETE", 1, {
      COMPLETE: 0.8,
      INCOMPLETE: 0.2,
      BLOCKED: 0,
      INSUFFICIENT_EVIDENCE: 0,
    }), evidence, policy);
    expect(result.complete).toBe(false);
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("names the cause when a semantic judgment is rejected", async () => {
    const badChoice = await decideMissionClosure(model("BOGUS", 1), evidence, policy);
    expect(badChoice.reasons).toContain(
      "semantic judgment chose an outcome outside the calibrated set; the vote is not usable",
    );
    const badDistribution = await decideMissionClosure(model("COMPLETE", 1, {
      COMPLETE: 0.8,
      INCOMPLETE: 0.2,
      BLOCKED: 0,
      INSUFFICIENT_EVIDENCE: 0,
    }), evidence, policy);
    expect(badDistribution.reasons).toContain(
      "semantic judgment distribution was invalid or did not support the selected outcome",
    );
    const wrongBackend: DecisionModel = {
      name: "jev-1.14.0",
      evaluate: async () => ({
        model: "jev-1.14.0",
        provider: "other-backend",
        questionHash: policy.questionHash,
        answers: {
          closure: {
            type: "choice",
            choice: "COMPLETE",
            confidence: 1,
            probabilities: { COMPLETE: 1, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
        latency_ms: 1,
      }) as never,
      choice: async () => { throw new Error("unused"); },
      score: async () => { throw new Error("unused"); },
      probability: async () => { throw new Error("unused"); },
    };
    const badBinding = await decideMissionClosure(wrongBackend, evidence, policy);
    expect(badBinding.reasons).toContain(
      "semantic judgment binding did not match the calibrated backend, model version, or question set",
    );
    for (const rejected of [badChoice, badDistribution, badBinding]) {
      expect(rejected.complete).toBe(false);
      expect(rejected.status).toBe("INSUFFICIENT_EVIDENCE");
    }
  });

  it("rejects COMPLETE when the categorical distribution favors another outcome", async () => {
    const result = await decideMissionClosure(model("COMPLETE", 0.9, {
      COMPLETE: 0.1,
      INCOMPLETE: 0.9,
      BLOCKED: 0,
      INSUFFICIENT_EVIDENCE: 0,
    }), evidence, policy);
    expect(result.complete).toBe(false);
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("falls back to preflight when the model throws on sparse evidence, never COMPLETE", async () => {
    const throwing: DecisionModel = {
      name: "jev-1.14.0",
      evaluate: async () => { throw new Error("JevValidationError: sparse evidence cannot support a judgment"); },
      choice: async () => { throw new Error("unused"); },
      score: async () => { throw new Error("unused"); },
      probability: async () => { throw new Error("unused"); },
    };
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-gate-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const gate = new MissionClosureGate(
      throwing,
      policy,
      { load: async () => evidence, isCurrent: async () => true },
      ledger,
    );
    const result = await gate.close("session-1", evidence.missionId);
    expect(result.terminalComplete).toBe(false);
    expect(result.decision.complete).toBe(false);
    expect(result.decision.status).not.toBe("COMPLETE");
    expect(result.decision.reasons.join(" ")).toContain("semantic judgment unavailable");
    expect(ledger.read().records.filter((record) => record.event === "MissionClosure")).toHaveLength(1);
  });

  it("sanitizes model-controlled error names in rejection reasons", async () => {
    const hostile: DecisionModel = {
      name: "jev-1.14.0",
      evaluate: async () => {
        const failure = new Error("transport exploded");
        failure.name = "EVIL'; DROP TABLE missions; --";
        throw failure;
      },
      choice: async () => { throw new Error("unused"); },
      score: async () => { throw new Error("unused"); },
      probability: async () => { throw new Error("unused"); },
    };
    const result = await decideMissionClosure(hostile, evidence, policy);
    expect(result.complete).toBe(false);
    expect(result.reasons).toEqual(["semantic judgment unavailable: Error"]);
    const known: DecisionModel = {
      name: "jev-1.14.0",
      evaluate: async () => {
        const failure = new Error("sparse evidence cannot support a judgment");
        failure.name = "JevValidationError";
        throw failure;
      },
      choice: async () => { throw new Error("unused"); },
      score: async () => { throw new Error("unused"); },
      probability: async () => { throw new Error("unused"); },
    };
    const knownResult = await decideMissionClosure(known, evidence, policy);
    expect(knownResult.reasons).toEqual(["semantic judgment unavailable: JevValidationError"]);
  });

  it("returns terminal completion only after an idempotent durable receipt succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-gate-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const gate = new MissionClosureGate(
      model("COMPLETE", 1),
      policy,
      { load: async () => evidence, isCurrent: async () => true },
      ledger,
    );
    const first = await gate.close("session-1", evidence.missionId);
    const retry = await gate.close("session-1", evidence.missionId);
    expect(first.terminalComplete).toBe(true);
    expect(first.receipt.status).toBe("appended");
    expect(retry.receipt.status).toBe("duplicate");
    expect(retry.terminalComplete).toBe(true);
    expect(ledger.read().records.filter((record) => record.event === "MissionClosure")).toHaveLength(1);
  });

  it("turns evidence-source failure into a durable insufficient-evidence outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-gate-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const gate = new MissionClosureGate(
      model("COMPLETE", 1),
      policy,
      { load: async () => { throw new Error("private source detail"); }, isCurrent: async () => true },
      ledger,
    );
    const result = await gate.close("session-1", evidence.missionId);
    expect(result.terminalComplete).toBe(false);
    expect(result.decision.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.receipt.status).toBe("appended");
    expect(ledger.read().records[0]?.reasons).not.toContain("private source detail");
    expect((await gate.close("session-1", evidence.missionId)).receipt.status).toBe("duplicate");
  });

  it("bounds evidence loading and aborts the source when it exceeds its deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-gate-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    let wasAborted = false;
    const gate = new MissionClosureGate(
      model("COMPLETE", 1),
      policy,
      {
        load: async (_sessionId, _missionId, signal) => new Promise<MissionClosureEvidence>((_resolve) => {
          signal?.addEventListener("abort", () => { wasAborted = true; }, { once: true });
        }),
        isCurrent: async () => true,
      },
      ledger,
      5,
    );
    const result = await gate.close("session-1", evidence.missionId);
    expect(wasAborted).toBe(true);
    expect(result.terminalComplete).toBe(false);
    expect(result.decision.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.receipt.status).toBe("appended");
  });

  it("rejects and records evidence returned for a different mission identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-gate-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const gate = new MissionClosureGate(
      model("COMPLETE", 1),
      policy,
      { load: async () => ({ ...evidence, missionId: "forged-mission" }), isCurrent: async () => true },
      ledger,
    );
    const result = await gate.close("session-1", evidence.missionId);
    expect(result.decision.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.decision.missionId).toBe(evidence.missionId);
    expect(result.terminalComplete).toBe(false);
    expect(result.receipt.status).toBe("appended");
  });

  it("downgrades a completion if mission evidence changes during semantic review", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-stale-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const gate = new MissionClosureGate(
      model("COMPLETE", 1),
      policy,
      {
        load: async () => evidence,
        isCurrent: async (_sessionId, _missionId, missionRevision, evidenceRevision) =>
          missionRevision === evidence.missionRevision && evidenceRevision === "e-r3",
      },
      ledger,
    );
    const result = await gate.close("session-1", evidence.missionId);
    expect(result.terminalComplete).toBe(false);
    expect(result.decision.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.decision.reasons).toContain("mission or evidence revision changed during closure review");
    expect(result.receipt.status).toBe("appended");
  });

  it("never reports complete when the verdict cannot be durably recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-gate-"));
    const path = join(dir, "evidence.log");
    writeFileSync(path, "not a receipt\n");
    chmodSync(path, 0o600);
    const ledger = testLedgerForFile(path);
    const gate = new MissionClosureGate(
      model("COMPLETE", 1),
      policy,
      { load: async () => evidence, isCurrent: async () => true },
      ledger,
    );
    const result = await gate.close("session-1", evidence.missionId);
    expect(result.receipt.status).toBe("unavailable");
    expect(result.terminalComplete).toBe(false);
    expect(result.decision.complete).toBe(false);
    expect(result.decision.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.decision.reasons.join(" ")).toContain("could not be durably recorded");
  });

  it("downgrades a complete decision that conflicts with a recorded verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-gate-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const gate = new MissionClosureGate(
      model("COMPLETE", 1),
      policy,
      { load: async () => evidence, isCurrent: async () => true },
      ledger,
    );
    const first = await gate.close("session-1", evidence.missionId);
    expect(first.terminalComplete).toBe(true);
    // Same mission/evidence revisions but a different candidate: the recorded
    // verdict governs, so the new COMPLETE must not stand.
    const moved = structuredClone(evidence);
    moved.candidateDigest = "d".repeat(64);
    const gate2 = new MissionClosureGate(
      model("COMPLETE", 1),
      policy,
      { load: async () => moved, isCurrent: async () => true },
      ledger,
    );
    const second = await gate2.close("session-1", evidence.missionId);
    expect(second.receipt.status).toBe("conflict");
    expect(second.terminalComplete).toBe(false);
    expect(second.decision.complete).toBe(false);
    expect(second.decision.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(second.decision.reasons.join(" ")).toContain("could not be durably recorded");
  });

  it("does not publish a stale BLOCKED terminal outcome after the blocker is resolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-unblocked-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    let checkedRevisions: string[] | undefined;
    const gate = new MissionClosureGate(
      model("COMPLETE", 1),
      policy,
      {
        load: async () => ({
          ...evidence,
          blockers: [{ id: "dependency", unresolved: true }],
        }),
        isCurrent: async (_sessionId, _missionId, missionRevision, evidenceRevision) => {
          checkedRevisions = [missionRevision, evidenceRevision];
          return false;
        },
      },
      ledger,
    );
    const result = await gate.close("session-1", evidence.missionId);
    expect(checkedRevisions).toEqual([evidence.missionRevision, evidence.evidenceRevision]);
    expect(result.terminalComplete).toBe(false);
    expect(result.decision.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.decision.reasons).toContain("mission or evidence revision changed during closure review");
    expect(result.receipt.status).toBe("appended");
  });
});

describe("verified evidence summary backbone (P1-E candidate, not wired into requests)", () => {
  function richEvidence(): MissionClosureEvidence {
    return {
      missionId: "mission-1",
      objective: "Deliver the requested feature",
      missionRevision: "mission-r7",
      evidenceRevision: "evidence-r12",
      criteria: [
        {
          id: "feature",
          statement: "The feature works",
          verified: true,
          outcome: "xyzzy agent claim must never appear as summary fact",
          evidenceRef: "journal:run-1/node-1",
          missionRevision: "mission-r7",
          evidenceRevision: "evidence-r12",
        },
        {
          id: "docs",
          statement: "Docs updated",
          verified: false,
          missionRevision: "mission-r7",
          evidenceRevision: "evidence-r12",
        },
      ],
      tests: { passed: true, independent: true, evidenceRef: "verifier:v:1", revision: "evidence-r12" },
      operations: { pending: 0, uncertain: 0 },
      blockers: [],
    };
  }

  it("cites verified facts and never asserts agent outcome claims", () => {
    const lines = summarizeVerifiedEvidence(richEvidence());
    const joined = lines.join("\n");
    expect(joined).not.toContain("xyzzy");
    expect(joined).toContain("mission-r7");
    expect(joined).toContain("evidence-r12");
    expect(joined).toContain("journal:run-1/node-1");
    expect(joined).toContain('criterion "feature" verified');
    expect(joined).toContain('criterion "docs" unverified');
  });

  it("flags tests revision drift against the bundle revision", () => {
    const lines = summarizeVerifiedEvidence({
      ...richEvidence(),
      tests: { passed: true, independent: true, revision: "evidence-r9" },
    });
    expect(lines.join("\n")).toContain("revision drift vs bundle rev evidence-r12");
  });

  it("stays bounded and deterministic on hostile input", () => {
    const criteria = Array.from({ length: 30 }, (_, index) => ({
      id: `c-${index}`,
      statement: "s".repeat(500),
      verified: index % 2 === 0,
      outcome: "o".repeat(500),
      evidenceRef: `ref-${index}`,
      missionRevision: "m",
      evidenceRevision: "e",
    }));
    const lines = summarizeVerifiedEvidence({ ...richEvidence(), criteria });
    expect(lines.length).toBeLessThanOrEqual(EVIDENCE_SUMMARY_MAX_LINES);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(160);
    expect(lines.join("\n").length).toBeLessThanOrEqual(EVIDENCE_SUMMARY_MAX_CHARS);
    expect(summarizeVerifiedEvidence({ ...richEvidence(), criteria })).toEqual(lines);
  });
});
