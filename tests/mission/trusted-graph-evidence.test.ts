/**
 * Trusted graph-to-criterion integration + deterministic qualification.
 *
 * Covers all 16 scenarios with stub models only (no metered inference):
 * satisfied-with-evidence+verification; succeeded-nodes-but-unsatisfied;
 * success-then-regression; failed-node-with-plausible-claims;
 * interrupted/unknown; missing/malformed; cross-session injection; stale
 * candidate/revision; conflicting receipts; forged verifierId;
 * valid-receipt-without-independent-verification;
 * superseded-failure-with-verified-repair; multi-run→one-criterion;
 * one-run→many-criteria; missing-artifact/changed-digest; disabled-feature
 * bit-identical. Plus the request-profile boundary (v1 pins cannot silently
 * validate v2 requests), projection allowlist/caps, and a durable
 * gate-level close. The full chain
 * Graph→journal→receipt→binding→verification→session→request→closure→Stop
 * runs on real local persistence (FileJournal, Store, EvidenceLedger);
 * the Stop leg itself is exercised by tests/hooks/stop-mission-workflow.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashQuestions } from "../../src/decision/provenance.js";
import type { DecisionModel } from "../../src/decision/types.js";
import { FileJournal } from "../../src/graph/journal.js";
import {
  addMissionAttestations,
  parseMissionAttestation,
  parseMissionContract,
} from "../../src/mission/contract.js";
import {
  affirmativeRequest,
  decideMissionClosure,
  MISSION_CLOSURE_QUESTION,
  MISSION_CLOSURE_QUESTION_V2,
  MISSION_CLOSURE_REQUEST_PROFILE_V2,
  MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2,
  semanticFulfillmentCandidateRequest,
  DAG_LOCAL_CRITERION_QUESTION_V1,
  DAG_LOCAL_ATOMIC_QUESTIONS_V1,
  DAG_LOCAL_ATOMIC_QUESTION_HASH_V1,
  dagLocalCriterionRequest,
  evaluateDagLocalCriterion,
  selectDagLocalProbe,
  validDagLocalProbeRegistry,
  dagLocalProbeGraph,
  MAX_DAG_LOCAL_PROBES_PER_EVIDENCE,
  DAG_LOCAL_NO_PROBE,
  evaluateDagLocalAtomicCriterion,
  aggregateDagLocalAtomicJudgments,
  composeDagLocalAtomicDisposition,
  aggregateDagLocalCriterionJudgments,
  MissionClosureGate,
  preflightMissionClosure,
  preflightReachedReview,
  projectCriterionEvidenceForRequest,
  type MissionClosureEvidence,
  type MissionClosurePolicy,
  type MissionCriterionVerification,
} from "../../src/mission/closure.js";
import {
  buildCriterionGraphBindings,
  qualifyTrustedCriteria,
  resolveCriterionGraphBindings,
  TRUSTED_GRAPH_BINDING_PROVENANCE,
  validateCriterionVerifications,
  type CriterionProducerAssociation,
} from "../../src/mission/graph-binding.js";
import { createSessionMissionClosureSource } from "../../src/mission/session-source.js";
import { analyzeCriterionTypeScriptStructure } from "../../src/mission/structural-analysis.js";
import { scoreSemanticFulfillmentCandidate } from "../../src/jev/lockbox.js";
import { testLedger, testStore } from "../helpers/control-state.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jeverb-trusted-graph-evidence-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const prompt = `Implement graph recovery.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- Interrupted effects remain uncertain until reconciled.\n- The tests prove retry safety.`;
const migrationPrompt = `Serve API v2 writes alongside v1, sunset v1 after six months, and evict expired sessions.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- v1 and v2 reads coexist during migration.\n- v1 sunset carries six months notice.`;

const singlePrompt = `Ship the parser change.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- Parser handles the new syntax.`;

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);
const F = "f".repeat(64);

const V1_HASH = hashQuestions({ closure: MISSION_CLOSURE_QUESTION });
const V2_HASH = hashQuestions({ closure: MISSION_CLOSURE_QUESTION_V2 });
const SEMANTIC_FULFILLMENT_HASH = hashQuestions({ closure: MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2 });
const DAG_LOCAL_CRITERION_HASH = hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 });

function policyFor(questionHash: string): MissionClosurePolicy {
  return {
    policyVersion: "mission-closure/1",
    minConfidence: 0.8,
    calibrated: true,
    backend: "typesafe",
    model: "jev-1.14.0",
    modelVersion: "jev-1.14.0",
    questionHash,
    calibrationVersion: "trusted-fixture-1",
  };
}
const POLICY_V1 = policyFor(V1_HASH);
const POLICY_V2 = policyFor(V2_HASH);
const POLICY_SEMANTIC_FULFILLMENT = { ...policyFor(SEMANTIC_FULFILLMENT_HASH), minConfidence: 0.9 };

function stubModel(choice: "COMPLETE" | "INCOMPLETE", onCall?: () => void): DecisionModel {
  return {
    evaluate: async (input: Parameters<DecisionModel["evaluate"]>[0]) => {
      onCall?.();
      return {
        provider: "typesafe",
        model: "jev-1.14.0",
        questionHash: hashQuestions(input.questions),
        answers: {
          closure: {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: { COMPLETE: choice === "COMPLETE" ? 1 : 0, INCOMPLETE: choice === "COMPLETE" ? 0 : 1, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
          },
        },
      };
    },
  } as unknown as DecisionModel;
}

function writeJournal(
  graphDir: string,
  sessionId: string,
  runId: string,
  terminals: Array<{ nodeId: string; status: "succeeded" | "failed" | "outcome_unknown"; inputHash: string; outputDigest: string }>,
  opts: { runningOnlyNode?: string; authorizedOnlyNode?: string } = {},
): void {
  mkdirSync(graphDir, { recursive: true, mode: 0o700 });
  const journal = new FileJournal(runId, graphDir, sessionId);
  journal.record({ type: "run-started", runId, ts: "2026-01-01T00:00:00.000Z", graphHash: A, policyHash: B });
  for (const terminal of terminals) {
    journal.record({ type: "node-authorized", runId, ts: "2026-01-01T00:00:01.000Z", nodeId: terminal.nodeId, attemptId: `${terminal.nodeId}/1`, allowed: true, inputHash: terminal.inputHash });
    journal.record({ type: "node-running", runId, ts: "2026-01-01T00:00:02.000Z", nodeId: terminal.nodeId, attemptId: `${terminal.nodeId}/1`, inputHash: terminal.inputHash });
    journal.record({ type: "node-terminal", runId, ts: "2026-01-01T00:00:03.000Z", nodeId: terminal.nodeId, declaredDependencies: [], status: terminal.status, inputHash: terminal.inputHash, outputDigest: terminal.outputDigest });
  }
  if (opts.authorizedOnlyNode !== undefined) {
    const nodeId = opts.authorizedOnlyNode;
    journal.record({ type: "node-authorized", runId, ts: "2026-01-01T00:00:01.000Z", nodeId, attemptId: `${nodeId}/1`, allowed: true, inputHash: C });
  }
  if (opts.runningOnlyNode !== undefined) {
    const nodeId = opts.runningOnlyNode;
    journal.record({ type: "node-authorized", runId, ts: "2026-01-01T00:00:01.000Z", nodeId, attemptId: `${nodeId}/1`, allowed: true, inputHash: C });
    journal.record({ type: "node-running", runId, ts: "2026-01-01T00:00:02.000Z", nodeId, attemptId: `${nodeId}/1`, inputHash: C });
  }
}

function attestBoth(store: ReturnType<typeof testStore>, sessionId: string, contract: NonNullable<ReturnType<typeof parseMissionContract>>): void {
  const userPrompt =
    `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\nverified:\n` +
    `- criterion-01: interrupted effects remain uncertain until reconciled\n` +
    `- criterion-02: regression tests cover retry safety`;
  const attestations = parseMissionAttestation(sessionId, userPrompt, contract, 200);
  if (attestations === undefined) throw new Error("attestation fixture failed to parse");
  store.updateSession(sessionId, (state) => ({ ...state, mission_contract: addMissionAttestations(contract, attestations) }));
}

function recordPassingTests(store: ReturnType<typeof testStore>, sessionId: string): void {
  store.updateSession(sessionId, (state) => ({
    ...state,
    verification: { last: { kind: "test" as const, ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
  }));
}

function satisfiedVerification(criterionId: string, missionRevision: string, candidateDigest: string, verifierId = "host-verifier-1"): MissionCriterionVerification {
  return {
    criterionId,
    verifierId,
    missionRevision,
    candidateDigest,
    result: "satisfied",
    receiptCorrelationId: `receipt-${criterionId}-1`,
    evidenceRef: `artifact:${criterionId}.txt`,
    verifiedAt: 400,
    observedResult: `Observed verifier fact for ${criterionId}: expected state matched.`,
    adapterVersion: "fixture-verifier/1",
    graphNodes: [{ runId: "run-1", nodeId: "build", attemptId: "build/1" }],
  };
}

/** A structurally valid execution-observed graph terminal receipt. */
function validTerminalReceipt(correlationId: string, sessionId: string, outputDigest: string): {
  correlationId: string;
  event: string;
  outcome: string;
  sessionId: string;
  outputDigest: string;
  executionStatus: string;
} {
  return {
    schema: 1,
    id: `rcpt-${correlationId.slice(0, 8)}`,
    ts: "2026-01-01T00:00:00.000Z",
    sessionId,
    event: "GraphNodeTerminal",
    subjectHash: "ab12cd34ab12cd34ab12cd34ab12cd34",
    policyVersion: "graph-execution/1",
    deterministicFindings: ["node_status=succeeded"],
    enforcement: "execution_succeeded",
    reasons: ["terminal graph status recorded; output text excluded"],
    latencyMs: 0,
    correlationId,
    outcome: "execution-observed",
    outputDigest,
    executionStatus: "succeeded",
  } as unknown as {
    correlationId: string;
    event: string;
    outcome: string;
    sessionId: string;
    outputDigest: string;
    executionStatus: string;
  };
}

/** Explicit associations for the two-criterion prompt: each criterion traces the named producer node. */
function bothCriteria(runId: string, nodeId = "build"): CriterionProducerAssociation[] {
  return [
    { criterionId: "criterion-01", runId, nodeId },
    { criterionId: "criterion-02", runId, nodeId },
  ];
}

/** Satisfied baseline: journal + tests + attestations + mission-level + per-criterion verification. */
async function satisfiedSetup(sessionId = "session-satisfied", missionPrompt = prompt): Promise<{
  dataDir: string;
  store: ReturnType<typeof testStore>;
  contract: NonNullable<ReturnType<typeof parseMissionContract>>;
  evidence: MissionClosureEvidence;
}> {
  const dataDir = tempDir();
  const store = testStore(dataDir);
  const contract = parseMissionContract(sessionId, missionPrompt, 100);
  if (contract === undefined) throw new Error("contract fixture failed to parse");
  store.updateSession(sessionId, (state) => ({ ...state, mission_contract: contract }));
  writeJournal(join(dataDir, "graph-journals"), sessionId, "run-1", [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D }]);
  recordPassingTests(store, sessionId);
  const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load(sessionId, contract.missionId);
  if (probe.candidateDigest === undefined || probe.candidateRevision === undefined) throw new Error("probe lacks candidate identity");
  attestBoth(store, sessionId, contract);
  store.updateSession(sessionId, (state) => ({
    ...state,
    mission_contract: {
      ...(state.mission_contract as NonNullable<typeof contract>),
      independentVerifications: [{
        verifierId: "mission-verifier-1",
        missionRevision: contract.missionRevision,
        evidenceRevision: probe.candidateRevision as string,
        candidate: probe.candidateDigest as string,
        verificationResult: "pass" as const,
        receiptCorrelationId: "mission-receipt-1",
        verifiedAt: 350,
      }],
    },
  }));
  const evidence = await createSessionMissionClosureSource({
    store,
    dataDir,
    now: () => 400,
    enableTrustedGraphEvidence: true,
    criterionProducerAssociations: bothCriteria("run-1"),
    criterionVerifications: [
      satisfiedVerification("criterion-01", contract.missionRevision, probe.candidateDigest),
      satisfiedVerification("criterion-02", contract.missionRevision, probe.candidateDigest),
    ],
    trustedVerifierIds: ["host-verifier-1"],
  }).load(sessionId, contract.missionId);
  return { dataDir, store, contract, evidence };
}

/** Attach compiler-derived AST observations to fixture obligations for local-Jev tests. */
function withCriterionAst(evidence: MissionClosureEvidence): MissionClosureEvidence {
  const root = tempDir();
  const sourceRoot = join(root, "src");
  mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const criteria = evidence.criteria.map((criterion, index) => {
    const obligation = criterion.proofObligation;
    if (obligation === undefined || evidence.candidateDigest === undefined) throw new Error("fixture proof obligation is missing");
    const file = `src/criterion-${index + 1}.ts`;
    writeFileSync(join(root, file), `export function criterion${index + 1}() { return ${JSON.stringify(criterion.statement)}; }\n`, { mode: 0o600 });
    const codeStructure = analyzeCriterionTypeScriptStructure({
      root,
      files: [file],
      criterionId: criterion.id,
      proofObligationId: obligation.id,
      missionRevision: evidence.missionRevision,
      candidateDigest: evidence.candidateDigest,
    });
    return { ...criterion, proofObligation: { ...obligation, codeStructure } };
  });
  return { ...evidence, criteria };
}

describe("trusted graph-to-criterion integration (16 scenarios)", () => {
  it("1. satisfied-with-evidence+verification qualifies and completes under the v2 profile", async () => {
    const { evidence, contract } = await satisfiedSetup();
    expect(evidence.requestProfile).toBe(MISSION_CLOSURE_REQUEST_PROFILE_V2);
    for (const criterion of evidence.criteria) {
      expect(criterion.verified).toBe(true);
      expect(criterion.graphEvidence).toEqual([{
        criterionId: criterion.id,
        runId: "run-1",
        nodeId: "build",
        dependencies: [],
        state: "bound",
        detail: expect.any(String),
        provenance: TRUSTED_GRAPH_BINDING_PROVENANCE,
      }]);
      expect(criterion.criterionVerification?.result).toBe("satisfied");
      expect(criterion.criterionVerification?.observedResult).toContain(criterion.id);
    }
    expect(evidence.operations).toEqual({ pending: 0, uncertain: 0 });
    expect(preflightReachedReview(preflightMissionClosure(evidence, POLICY_V2))).toBe(true);

    const { state, questions } = affirmativeRequest(evidence);
    expect(state.requestProfile).toBe(MISSION_CLOSURE_REQUEST_PROFILE_V2);
    expect(hashQuestions(questions)).toBe(V2_HASH);
    expect(V2_HASH).not.toBe(V1_HASH);
    expect(state.criterionEvidence).toHaveLength(2);
    for (const entry of state.criterionEvidence ?? []) {
      expect(entry.verificationResult).toBe("satisfied");
      expect(entry.unresolved).toBe(false);
      expect(entry.contradiction).toBe(false);
      expect(entry.verificationScope).toEqual({ missionRevision: contract.missionRevision, candidateDigest: evidence.candidateDigest });
      expect(entry.observedGraphState).toEqual([{ runId: "run-1", nodeId: "build", state: "bound" }]);
    }

    let called = false;
    const result = await decideMissionClosure(stubModel("COMPLETE", () => { called = true; }), evidence, POLICY_V2);
    expect(called).toBe(true);
    expect(result.status).toBe("COMPLETE");
    expect(result.complete).toBe(true);
  });

  it("compares the development semantic-fulfillment question only on a trusted v2 source snapshot", async () => {
    const { evidence } = await satisfiedSetup("session-semantic-candidate", migrationPrompt);
    const request = semanticFulfillmentCandidateRequest(evidence, POLICY_SEMANTIC_FULFILLMENT);
    expect(request).toBeDefined();
    expect(hashQuestions(request!.questions)).toBe(SEMANTIC_FULFILLMENT_HASH);
    expect(SEMANTIC_FULFILLMENT_HASH).not.toBe(V2_HASH);
    expect(request!.questions.closure.criteria).toHaveProperty("FULFILLED");
    expect(request!.questions.closure.criteria).toHaveProperty("NOT_FULFILLED");
    expect(request!.questions.closure.criteria).toHaveProperty("UNCERTAIN");
    expect(request!.state.objective).toBe(evidence.objective);
    expect(request!.state.criterionEvidence?.every((row) => row.verificationResult === "satisfied")).toBe(true);

    // Explicitly broaden the objective while retaining the real snapshot's
    // verified criteria. This is the semantic coverage failure: preflight is
    // valid, but the question exposes that a requested scope may be omitted.
    const scopeGap = evidence;
    const gapRequest = semanticFulfillmentCandidateRequest(scopeGap, POLICY_SEMANTIC_FULFILLMENT);
    expect(gapRequest?.state.objective).toContain("Serve API v2 writes");
    expect(gapRequest?.state.acceptanceCriteria).toEqual(evidence.criteria.map(({ id, statement, outcome, evidenceRef }) => ({
      id, statement, ...(outcome === undefined ? {} : { outcome }), ...(evidenceRef === undefined ? {} : { evidenceRef }),
    })));

    const candidateModel = {
      name: "semantic-question-test-double",
      async evaluate(input: Parameters<DecisionModel["evaluate"]>[0]) {
        const responseHash = hashQuestions(input.questions);
        if (responseHash === V2_HASH) {
          return {
            provider: "typesafe", model: "jev-1.14.0", questionHash: V2_HASH,
            answers: { closure: {
              type: "choice", choice: "COMPLETE", confidence: 1,
              probabilities: { COMPLETE: 1, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
            } },
            usage: { input_tokens: 100, output_tokens: 8 }, latency_ms: 1,
          };
        }
        expect(responseHash).toBe(SEMANTIC_FULFILLMENT_HASH);
        expect(JSON.stringify(input.state)).toContain("evict expired sessions");
        return {
          provider: "typesafe", model: "jev-1.14.0", questionHash: SEMANTIC_FULFILLMENT_HASH,
          answers: { closure: {
            type: "choice", choice: "NOT_FULFILLED", confidence: 0.7,
            probabilities: { FULFILLED: 0.1, NOT_FULFILLED: 0.8, UNCERTAIN: 0.1 },
          } },
          usage: { input_tokens: 100, output_tokens: 8 }, latency_ms: 1,
        };
      },
    } as unknown as DecisionModel;
    const baseline = await decideMissionClosure(candidateModel, scopeGap, { ...POLICY_V2, minConfidence: 0.9 });
    expect(baseline.complete).toBe(true);
    expect(baseline.confidence).toBe(1);
    const score = await scoreSemanticFulfillmentCandidate(
      candidateModel, scopeGap, POLICY_SEMANTIC_FULFILLMENT, "NOT_FULFILLED",
    );
    expect(score).toMatchObject({ status: "answered", choice: "NOT_FULFILLED", correct: true, questionHash: SEMANTIC_FULFILLMENT_HASH });
    // This is a semantic judgment score only; it cannot mark a mission closed.
    expect(score).not.toHaveProperty("terminalComplete");
  });

  it("evaluates one criterion in an isolated request and deterministically aggregates without authority", async () => {
    const setup = await satisfiedSetup("session-dag-local");
    expect(dagLocalCriterionRequest(setup.evidence, "criterion-01")).toBeUndefined();
    const evidence = withCriterionAst(setup.evidence);
    const request = dagLocalCriterionRequest(evidence, "criterion-01");
    expect(request).toBeDefined();
    expect(request!.state).toMatchObject({
      criterionId: "criterion-01",
      missionRevision: evidence.missionRevision,
      candidateDigest: evidence.candidateDigest,
      requirement: evidence.criteria[0]!.statement,
      predecessorStates: [{
        runId: "run-1", nodeId: "build", attemptId: "build/1", status: "succeeded", bindingState: "bound",
        provenance: TRUSTED_GRAPH_BINDING_PROVENANCE,
      }],
      verifierObservation: {
        result: "satisfied",
        verifierId: "host-verifier-1",
        receiptCorrelationId: "receipt-criterion-01-1",
        evidenceRef: "artifact:criterion-01.txt",
        adapterVersion: "fixture-verifier/1",
        observedResult: "Observed verifier fact for criterion-01: expected state matched.",
        graphNodes: [{ runId: "run-1", nodeId: "build", attemptId: "build/1" }],
      },
    });
    expect(request!.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(request!.graphRevision).toMatch(/^[0-9a-f]{64}$/);
    const changedGraph = dagLocalCriterionRequest({
      ...evidence,
      graphRuns: (evidence.graphRuns ?? []).map((run) => ({
        ...run,
        nodes: run.nodes.map((node) => node.nodeId === "build" ? { ...node, status: "outcome_unknown" as const } : node),
      })),
    }, "criterion-01");
    expect(changedGraph?.graphRevision).not.toBe(request!.graphRevision);
    expect(changedGraph?.evidenceDigest).not.toBe(request!.evidenceDigest);
    expect(JSON.stringify(request!.state)).not.toContain("criterion-02");
    expect(JSON.stringify(request!.state)).not.toContain(evidence.objective);
    expect(hashQuestions(request!.questions)).toBe(hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 }));
    expect(DAG_LOCAL_CRITERION_HASH).toBe("d696868a58033d3cb652ecf5f065ae8053e43a5dc0a639d8113cfd6d071f1316");
    expect(request!.state.claimedOutcome).toBe(evidence.criteria[0]!.outcome);

    const model = {
      name: "criterion-local-test-double",
      async evaluate(input: Parameters<DecisionModel["evaluate"]>[0]) {
        expect(Object.keys(input.state).sort()).toEqual([
          "candidateDigest", "claimedOutcome", "criterionId", "missionRevision", "predecessorStates", "proofObligation", "requirement", "verifierObservation",
        ]);
        return {
          provider: "typesafe", model: "jev-1.14.0", questionHash: hashQuestions(input.questions),
          latency_ms: 12, usage: { input_tokens: 40, output_tokens: 8 },
          answers: { fulfillment: {
            type: "choice", choice: "FULFILLED", confidence: 0.97,
            probabilities: { FULFILLED: 0.97, NOT_FULFILLED: 0.02, UNCERTAIN: 0.01 },
          } },
        };
      },
    } as unknown as DecisionModel;
    const judgments = await Promise.all(evidence.criteria.map((criterion) =>
      evaluateDagLocalCriterion(model, evidence, criterion.id),
    ));
    expect(judgments[0]?.graphNodeIds[0]).toMatchObject({ runId: "run-1", nodeId: "build", attemptId: "build/1", status: "succeeded" });
    expect(judgments[0]?.disposition).toBe("SATISFIED");
    expect(judgments[0]?.evidenceDigest).toBe(request!.evidenceDigest);
    expect(judgments[0]?.graphRevision).toBe(request!.graphRevision);
    expect(judgments[0]?.verifierProvenance).toEqual({
      verifierId: "host-verifier-1", receiptCorrelationId: "receipt-criterion-01-1", evidenceRef: "artifact:criterion-01.txt", adapterVersion: "fixture-verifier/1",
    });
    const complete = aggregateDagLocalCriterionJudgments({
      evidence,
      judgments: judgments.filter((row) => row !== undefined),
      expectedProvider: "typesafe",
      expectedModel: "jev-1.14.0",
      expectedQuestionHash: hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 }),
    });
    expect(complete).toEqual({ semanticDisposition: "FULFILLED", disposition: "FULFILLED", missingCriterionIds: [], unqualifiedCriterionIds: [], objectiveCoverage: "covered", terminalComplete: false });

    const missing = aggregateDagLocalCriterionJudgments({
      evidence, judgments: judgments.filter((row): row is NonNullable<typeof row> => row !== undefined && row.criterionId !== "criterion-02"),
      expectedProvider: "typesafe", expectedModel: "jev-1.14.0",
      expectedQuestionHash: hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 }),
    });
    expect(missing.disposition).toBe("UNCERTAIN");
    expect(missing.missingCriterionIds).toEqual(["criterion-02"]);
    expect(missing.terminalComplete).toBe(false);

    const omitted = aggregateDagLocalCriterionJudgments({
      evidence: { ...evidence, objectiveCoverage: { status: "missing" } }, judgments: judgments.filter((row) => row !== undefined),
      expectedProvider: "typesafe", expectedModel: "jev-1.14.0",
      expectedQuestionHash: hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 }),
    });
    expect(omitted.disposition).toBe("UNCERTAIN");
    expect(omitted.terminalComplete).toBe(false);
  });

  it("selects only bounded host-registered probes and investigates uncertainty without calling it a defect", async () => {
    const setup = await satisfiedSetup("session-dag-probes");
    const evidence = withCriterionAst(setup.evidence);
    const registry = [
      { id: "check-revoked-membership", description: "Exercise revoked membership behavior", command: "node verify-revoked.cjs", sourceReadOnly: true as const },
      { id: "check-guest-access", description: "Exercise guest authorization behavior", command: "node verify-guest.cjs", sourceReadOnly: true as const },
    ];
    expect(validDagLocalProbeRegistry(registry)).toBe(true);
    expect(validDagLocalProbeRegistry([{ ...registry[0]!, command: "node test.cjs\nrm -rf /", sourceReadOnly: true }])).toBe(false);
    expect(validDagLocalProbeRegistry(Array.from({ length: 9 }, (_, index) => ({
      id: `probe-${index}`, description: "bounded", command: "true", sourceReadOnly: true as const,
    })))).toBe(false);

    const request = dagLocalCriterionRequest(evidence, "criterion-01", registry);
    expect(request?.questions.probe).toBeDefined();
    expect(JSON.stringify(request?.state)).not.toContain("verify-revoked.cjs");
    expect(JSON.stringify(request?.questions)).not.toContain("verify-revoked.cjs");
    expect(request?.probeOptions).toEqual(registry);
    const changedAction = dagLocalCriterionRequest(evidence, "criterion-01", [
      { ...registry[0]!, command: "node verify-revoked-v2.cjs" }, registry[1]!,
    ]);
    expect(changedAction?.evidenceDigest).not.toBe(request?.evidenceDigest);

    const judgment = {
      disposition: "UNCERTAIN" as const,
      recommendedProbe: DAG_LOCAL_NO_PROBE,
    } as Parameters<typeof selectDagLocalProbe>[0];
    expect(selectDagLocalProbe(judgment, registry)).toEqual({
      status: "none", reason: "model-declined-probe",
    });
    const { recommendedProbe: _declined, ...undecided } = judgment;
    expect(selectDagLocalProbe(undecided, registry)).toMatchObject({
      status: "selected", source: "uncertainty-fallback", probe: { id: "check-revoked-membership" },
    });
    expect(selectDagLocalProbe({ ...judgment, disposition: "SATISFIED" }, registry)).toEqual({
      status: "none", reason: "satisfied",
    });
    expect(selectDagLocalProbe(undecided, [])).toEqual({ status: "none", reason: "no-registered-probe" });
    expect(selectDagLocalProbe({ ...judgment, recommendedProbe: "node arbitrary-command" }, registry)).toEqual({
      status: "none", reason: "no-registered-probe",
    });
    expect(selectDagLocalProbe({ ...judgment, recommendedProbe: "check-guest-access" }, registry)).toMatchObject({
      status: "selected", source: "jev", probe: { id: "check-guest-access", command: "node verify-guest.cjs" },
    });
    expect(MAX_DAG_LOCAL_PROBES_PER_EVIDENCE).toBe(1);
    const selected = selectDagLocalProbe({ ...judgment, recommendedProbe: "check-guest-access" }, registry);
    const graph = dagLocalProbeGraph(selected, "criterion-01", "a".repeat(64));
    expect(graph).toMatchObject({
      runId: expect.stringMatching(/^probe-[0-9a-f]{48}$/),
      graph: { parallel: false, nodes: [{ command: "node verify-guest.cjs", maxAttempts: 1, idempotent: false }] },
    });
    expect(dagLocalProbeGraph(selected, "criterion-01", "bad-digest")).toBeUndefined();
  });

  it("asks atomic Noul questions over one bounded criterion context and composes without probability multiplication", async () => {
    const { evidence: baseEvidence } = await satisfiedSetup("session-dag-local-atomic");
    const evidence = withCriterionAst({
      ...baseEvidence,
      criteria: baseEvidence.criteria.map((criterion) => criterion.id === "criterion-01"
        ? { ...criterion, criterionVerification: {
          ...criterion.criterionVerification!,
          observedResult: `${criterion.criterionVerification!.observedResult} output digest ${"a".repeat(64)} Authorization: Bearer locus_super_secret_token_value_1234567890`,
        } }
        : criterion),
    });
    const seenStates: Record<string, unknown>[] = [];
    const model = {
      name: "atomic-noul-test-double",
      async evaluate(input: Parameters<DecisionModel["evaluate"]>[0]) {
        seenStates.push(input.state as Record<string, unknown>);
        return {
          provider: "typesafe", model: "jev-1.14.0", questionHash: hashQuestions(input.questions),
          latency_ms: 5, usage: { input_tokens: 35, output_tokens: 6 },
          answers: {
            evidenceRelevance: { type: "noul", noul: 0.98 },
            requirementSatisfied: { type: "noul", noul: 0.97 },
            semanticMismatch: { type: "noul", noul: 0.02 },
          },
        };
      },
    } as unknown as DecisionModel;
    const judgments = await Promise.all(evidence.criteria.map((criterion) =>
      evaluateDagLocalAtomicCriterion(model, evidence, criterion.id),
    ));
    expect(hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 })).not.toBe(DAG_LOCAL_ATOMIC_QUESTION_HASH_V1);
    expect(DAG_LOCAL_ATOMIC_QUESTIONS_V1).toHaveProperty("evidenceRelevance.type", "noul");
    expect(seenStates[0]).toHaveProperty("requirement", evidence.criteria[0]!.statement);
    expect(seenStates[0]).toHaveProperty("observedVerifier.observation");
    expect(seenStates[0]).not.toHaveProperty("observedVerifier.detail");
    expect(seenStates[0]).not.toHaveProperty("claimedOutcome");
    expect(seenStates[0]).toHaveProperty("codeStructure.symbols");
    expect(JSON.stringify(seenStates[0])).not.toContain(evidence.objective);
    expect(JSON.stringify(seenStates[0])).not.toContain(evidence.criteria[1]!.statement);
    expect(seenStates[0]).not.toHaveProperty("missionRevision");
    expect(seenStates[0]).not.toHaveProperty("candidateDigest");
    expect(JSON.stringify(seenStates[0])).not.toContain(evidence.candidateDigest);
    expect(JSON.stringify(seenStates[0])).not.toMatch(/\b[0-9a-f]{32,64}\b/i);
    expect(JSON.stringify(seenStates[0])).not.toContain("locus_super_secret_token_value_1234567890");
    expect(JSON.stringify(seenStates[0])).toContain("[credential omitted]");
    expect(judgments[0]).toMatchObject({
      criterionId: "criterion-01", disposition: "SATISFIED", provider: "typesafe", model: "jev-1.14.0",
      questionHash: DAG_LOCAL_ATOMIC_QUESTION_HASH_V1,
    });
    expect(composeDagLocalAtomicDisposition({ evidenceRelevance: 0.99, requirementSatisfied: 0.99, semanticMismatch: 0.99 })).toBe("UNSATISFIED");
    expect(composeDagLocalAtomicDisposition({ evidenceRelevance: 0.5, requirementSatisfied: 0.99, semanticMismatch: 0.01 })).toBe("UNCERTAIN");

    const aggregate = aggregateDagLocalAtomicJudgments({
      evidence,
      judgments: judgments.filter((row): row is NonNullable<typeof row> => row !== undefined),
      expectedProvider: "typesafe", expectedModel: "jev-1.14.0", expectedQuestionHash: DAG_LOCAL_ATOMIC_QUESTION_HASH_V1,
    });
    expect(aggregate.semanticDisposition).toBe("FULFILLED");
    expect(aggregate.disposition).toBe("UNCERTAIN");
    expect(aggregate.policyQualified).toBe(false);
    expect(aggregate.terminalComplete).toBe(false);
  });

  it("preserves failed and unknown criterion states and never aggregates them to completion", async () => {
    const { evidence: baseEvidence } = await satisfiedSetup("session-dag-local-failures");
    const evidence = withCriterionAst(baseEvidence);
    const request = dagLocalCriterionRequest(evidence, "criterion-01")!;
    const judgment = {
      criterionId: "criterion-01", missionRevision: evidence.missionRevision, candidateDigest: evidence.candidateDigest!,
      evidenceDigest: request.evidenceDigest, graphRevision: request.graphRevision,
      contextHash: request.contextHash, graphNodeIds: request.graphNodeIds, verifierProvenance: {
        ...(request.verifier.verifierId === undefined ? {} : { verifierId: request.verifier.verifierId }),
        ...(request.verifier.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: request.verifier.receiptCorrelationId }),
        ...(request.verifier.evidenceRef === undefined ? {} : { evidenceRef: request.verifier.evidenceRef }),
        ...(request.verifier.adapterVersion === undefined ? {} : { adapterVersion: request.verifier.adapterVersion }),
      }, choice: "FULFILLED" as const, disposition: "SATISFIED" as const, confidence: 0.99,
      probabilities: { FULFILLED: 0.99, NOT_FULFILLED: 0.005, UNCERTAIN: 0.005 },
      provider: "typesafe", model: "jev-1.14.0", questionHash: hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 }),
      latencyMs: 1, inputTokens: 1, outputTokens: 1,
    };
    const failedEvidence = {
      ...evidence,
      criteria: evidence.criteria.map((criterion) => criterion.id === "criterion-01"
        ? { ...criterion, criterionVerification: { ...criterion.criterionVerification!, result: "failed" as const } }
        : criterion),
    };
    const failed = aggregateDagLocalCriterionJudgments({
      evidence: failedEvidence, judgments: [judgment], expectedProvider: "typesafe", expectedModel: "jev-1.14.0",
      expectedQuestionHash: judgment.questionHash,
    });
    expect(failed.disposition).toBe("NOT_FULFILLED");
    expect(failed.terminalComplete).toBe(false);

    for (const status of ["failed", "blocked", "skipped"] as const) {
      const statusEvidence = {
        ...evidence,
      graphRuns: (evidence.graphRuns ?? []).map((run) => ({ ...run, nodes: run.nodes.map((node) => ({ ...node, status })) })),
        criteria: evidence.criteria.map((entry) => entry.id === "criterion-01"
          ? { ...entry, graphEvidence: [{ ...entry.graphEvidence![0]!, state: "unhealthy" as const }] }
          : entry),
      };
      expect(dagLocalCriterionRequest(statusEvidence, "criterion-01")?.state.predecessorStates[0]?.status).toBe(status);
    }

    const unknownEvidence = {
      ...evidence,
      graphRuns: (evidence.graphRuns ?? []).map((run) => ({ ...run, nodes: run.nodes.map((node) => ({ ...node, status: "outcome_unknown" as const })) })),
      criteria: evidence.criteria.map((criterion) => criterion.id === "criterion-01"
        ? { ...criterion, graphEvidence: [{ ...criterion.graphEvidence![0]!, state: "unknown" as const }] }
        : criterion),
    };
    const unknownRequest = dagLocalCriterionRequest(unknownEvidence, "criterion-01")!;
    expect(unknownRequest.state.predecessorStates[0]?.status).toBe("outcome_unknown");
    expect(unknownRequest.state.predecessorStates[0]?.bindingState).toBe("unknown");
    const unknown = aggregateDagLocalCriterionJudgments({
      evidence: unknownEvidence,
      judgments: [{ ...judgment, evidenceDigest: unknownRequest.evidenceDigest, graphRevision: unknownRequest.graphRevision,
        contextHash: unknownRequest.contextHash, graphNodeIds: unknownRequest.graphNodeIds }],
      expectedProvider: "typesafe", expectedModel: "jev-1.14.0",
      expectedQuestionHash: judgment.questionHash,
    });
    expect(unknown.disposition).toBe("UNCERTAIN");
    expect(unknown.terminalComplete).toBe(false);

    const missingEvidence = {
      ...evidence,
      graphRuns: [],
      criteria: evidence.criteria.map((entry) => entry.id === "criterion-01" ? { ...entry, graphEvidence: [] } : entry),
    };
    expect(dagLocalCriterionRequest(missingEvidence, "criterion-01")?.state.predecessorStates[0]?.status).toBe("missing");
  });

  it("marks missing verifier observations and low-confidence criterion votes unqualified", async () => {
    const { evidence: baseEvidence } = await satisfiedSetup("session-dag-local-unqualified");
    const evidence = withCriterionAst(baseEvidence);
    const criterion = evidence.criteria[0]!;
    const missingObservation: MissionClosureEvidence = {
      ...evidence,
      criteria: evidence.criteria.map((entry) => entry.id === criterion.id
        ? { ...entry, criterionVerification: { result: "satisfied", verifierId: "host-verifier-1", detail: "generic status only" } }
        : entry),
    };
    const missingRequest = dagLocalCriterionRequest(missingObservation, criterion.id)!;
    expect(missingRequest.verifier.observationState).toBe("missing");
    const request = dagLocalCriterionRequest(evidence, criterion.id)!;
    const lowConfidence = {
      criterionId: criterion.id, missionRevision: evidence.missionRevision, candidateDigest: evidence.candidateDigest!,
      evidenceDigest: request.evidenceDigest, graphRevision: request.graphRevision,
      contextHash: request.contextHash, graphNodeIds: request.graphNodeIds, verifierProvenance: {
        ...(request.verifier.verifierId === undefined ? {} : { verifierId: request.verifier.verifierId }),
        ...(request.verifier.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: request.verifier.receiptCorrelationId }),
        ...(request.verifier.evidenceRef === undefined ? {} : { evidenceRef: request.verifier.evidenceRef }),
        ...(request.verifier.adapterVersion === undefined ? {} : { adapterVersion: request.verifier.adapterVersion }),
      }, choice: "FULFILLED" as const, disposition: "SATISFIED" as const, confidence: 0.89,
      probabilities: { FULFILLED: 0.89, NOT_FULFILLED: 0.06, UNCERTAIN: 0.05 },
      provider: "typesafe", model: "jev-1.14.0", questionHash: hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 }),
      latencyMs: 1, inputTokens: 1, outputTokens: 1,
    };
    const secondCriterion = evidence.criteria[1]!;
    const secondRequest = dagLocalCriterionRequest(evidence, secondCriterion.id)!;
    const secondLowConfidence = {
      ...lowConfidence,
      criterionId: secondCriterion.id,
      evidenceDigest: secondRequest.evidenceDigest,
      graphRevision: secondRequest.graphRevision,
      contextHash: secondRequest.contextHash,
      graphNodeIds: secondRequest.graphNodeIds,
      verifierProvenance: {
        ...(secondRequest.verifier.verifierId === undefined ? {} : { verifierId: secondRequest.verifier.verifierId }),
        ...(secondRequest.verifier.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: secondRequest.verifier.receiptCorrelationId }),
        ...(secondRequest.verifier.evidenceRef === undefined ? {} : { evidenceRef: secondRequest.verifier.evidenceRef }),
        ...(secondRequest.verifier.adapterVersion === undefined ? {} : { adapterVersion: secondRequest.verifier.adapterVersion }),
      },
    };
    const result = aggregateDagLocalCriterionJudgments({
      evidence, judgments: [lowConfidence, secondLowConfidence], expectedProvider: "typesafe", expectedModel: "jev-1.14.0",
      expectedQuestionHash: lowConfidence.questionHash,
    });
    expect(result.disposition).toBe("UNCERTAIN");
    expect(result.semanticDisposition).toBe("FULFILLED");
    expect(result.unqualifiedCriterionIds).toContain(criterion.id);
    expect(result.terminalComplete).toBe(false);
  });

  it("keeps partial, contradictory, and insufficient verifier evidence outside semantic scoring", async () => {
    const { evidence } = await satisfiedSetup("session-semantic-fail-closed");
    let calls = 0;
    const model = {
      async evaluate() { calls += 1; throw new Error("must not call Jev before preflight"); },
    } as unknown as DecisionModel;
    const failed = {
      ...evidence,
      criteria: evidence.criteria.map((criterion, index) => index === 0
        ? { ...criterion, verified: false, criterionVerification: { result: "failed" as const, detail: "host verifier observed 501" } }
        : criterion),
    };
    const incomplete = await scoreSemanticFulfillmentCandidate(
      model, failed, POLICY_SEMANTIC_FULFILLMENT, "NOT_FULFILLED",
    );
    expect(incomplete.status).toBe("preflight-stopped");

    const contradictory = {
      ...evidence,
      criteria: evidence.criteria.map((criterion, index) => index === 0
        ? { ...criterion, graphEvidence: [{ criterionId: criterion.id, runId: "run-1", nodeId: "build", state: "conflict" as const, detail: "fixture conflict" }] }
        : criterion),
    };
    const contradiction = await scoreSemanticFulfillmentCandidate(
      model, contradictory, POLICY_SEMANTIC_FULFILLMENT, "UNCERTAIN",
    );
    expect(contradiction.status).toBe("preflight-stopped");

    const insufficient = {
      ...evidence,
      criteria: evidence.criteria.map((criterion) => ({ ...criterion, criterionVerification: { result: "unresolved" as const, detail: "no independent receipt" } })),
    };
    const missingVerification = await scoreSemanticFulfillmentCandidate(
      model, insufficient, POLICY_SEMANTIC_FULFILLMENT, "UNCERTAIN",
    );
    expect(missingVerification.status).toBe("preflight-stopped");
    expect(calls).toBe(0);
  });

  it("2. succeeded-nodes-but-unsatisfied stays INCOMPLETE without independent verification", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-unsat", prompt, 100)!;
    store.updateSession("session-unsat", (state) => ({ ...state, mission_contract: contract }));
    writeJournal(join(dataDir, "graph-journals"), "session-unsat", "run-1", [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D }]);
    recordPassingTests(store, "session-unsat");
    attestBoth(store, "session-unsat", contract);

    // No criterion verifications at all — and the default empty allowlist
    // resolves everything to unresolved, fail closed.
    const evidence = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400, enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
    }).load("session-unsat", contract.missionId);
    expect(evidence.criteria[0]?.graphEvidence?.[0]?.state).toBe("bound");
    expect(evidence.criteria.every((criterion) => criterion.verified === false)).toBe(true);
    expect(evidence.criteria[0]?.criterionVerification?.result).toBe("unresolved");
    const preflight = preflightMissionClosure(evidence, POLICY_V2);
    expect(preflight.complete).toBe(false);
    expect(preflight.status).toBe("INCOMPLETE");
    let called = false;
    await decideMissionClosure(stubModel("COMPLETE", () => { called = true; }), evidence, POLICY_V2);
    expect(called).toBe(false);
  });

  it("3. success-then-regression invalidates the prior qualification", async () => {
    const { dataDir, store, contract, evidence: before } = await satisfiedSetup("session-regress");
    expect(before.criteria.every((criterion) => criterion.verified)).toBe(true);
    // A later failed run rotates the candidate: verifications bound to the
    // old candidate go stale even though the old binding still matches.
    writeJournal(join(dataDir, "graph-journals"), "session-regress", "run-2", [{ nodeId: "build", status: "failed", inputHash: E, outputDigest: F }]);
    const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load("session-regress", contract.missionId);
    const after = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
      criterionVerifications: [
        satisfiedVerification("criterion-01", contract.missionRevision, before.candidateDigest!),
        satisfiedVerification("criterion-02", contract.missionRevision, before.candidateDigest!),
      ],
      trustedVerifierIds: ["host-verifier-1"],
    }).load("session-regress", contract.missionId);
    expect(probe.candidateDigest).not.toBe(before.candidateDigest);
    expect(after.evidenceRevision).not.toBe(before.evidenceRevision);
    expect(after.criteria.every((criterion) => criterion.verified === false)).toBe(true);
    expect(after.criteria[0]?.criterionVerification?.result).toBe("unresolved");
    expect(preflightMissionClosure(after, POLICY_V2).complete).toBe(false);
  });

  it("4. failed-node-with-plausible-claims never satisfies", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-failed", prompt, 100)!;
    store.updateSession("session-failed", (state) => ({ ...state, mission_contract: contract }));
    writeJournal(join(dataDir, "graph-journals"), "session-failed", "run-1", [{ nodeId: "build", status: "failed", inputHash: C, outputDigest: D }]);
    recordPassingTests(store, "session-failed");
    const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load("session-failed", contract.missionId);
    // Plausible claims: user attestation says done AND an allowlisted
    // verifier says satisfied on this exact candidate. Execution failure
    // still blocks: unhealthy traceability, fail closed.
    attestBoth(store, "session-failed", contract);
    const evidence = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
      criterionVerifications: [
        satisfiedVerification("criterion-01", contract.missionRevision, probe.candidateDigest!),
        satisfiedVerification("criterion-02", contract.missionRevision, probe.candidateDigest!),
      ],
      trustedVerifierIds: ["host-verifier-1"],
    }).load("session-failed", contract.missionId);
    expect(evidence.criteria[0]?.graphEvidence?.[0]?.state).toBe("unhealthy");
    expect(evidence.criteria.every((criterion) => criterion.verified === false)).toBe(true);
    expect(evidence.operations.uncertain).toBeGreaterThanOrEqual(1);
    expect(preflightMissionClosure(evidence, POLICY_V2).complete).toBe(false);
  });

  it("5. interrupted and unknown execution never satisfies", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    // Pending: authorized but never started — no terminal record.
    const pendingContract = parseMissionContract("session-pending", prompt, 100)!;
    store.updateSession("session-pending", (state) => ({ ...state, mission_contract: pendingContract }));
    writeJournal(join(dataDir, "graph-journals"), "session-pending", "run-pending", [], { authorizedOnlyNode: "build" });
    const pending = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400, enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-pending"),
    }).load("session-pending", pendingContract.missionId);
    expect(pending.criteria[0]?.graphEvidence).toBeUndefined();
    expect(pending.operations.pending).toBeGreaterThanOrEqual(1);
    expect(preflightMissionClosure(pending, POLICY_V2).complete).toBe(false);

    // Unknown: outcome_unknown terminal with valid hashes.
    const unknownContract = parseMissionContract("session-unknown", prompt, 100)!;
    store.updateSession("session-unknown", (state) => ({ ...state, mission_contract: unknownContract }));
    writeJournal(join(dataDir, "graph-journals"), "session-unknown", "run-1", [{ nodeId: "build", status: "outcome_unknown", inputHash: C, outputDigest: D }]);
    const unknown = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400, enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
    }).load("session-unknown", unknownContract.missionId);
    expect(unknown.criteria[0]?.graphEvidence?.[0]?.state).toBe("unknown");
    expect(unknown.operations.uncertain).toBeGreaterThanOrEqual(1);
    expect(preflightMissionClosure(unknown, POLICY_V2).complete).toBe(false);
  });

  it("6. missing evidence and malformed verdicts fail closed", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-missing", prompt, 100)!;
    store.updateSession("session-missing", (state) => ({ ...state, mission_contract: contract }));
    // No journals at all: the producer emits no bindings (never a
    // placeholder), and even candidate-bound verdicts cannot qualify.
    recordPassingTests(store, "session-missing");
    const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load("session-missing", contract.missionId);
    attestBoth(store, "session-missing", contract);
    const malformed = [
      { ...satisfiedVerification("criterion-01", contract.missionRevision, probe.candidateDigest!), verifierId: "" },
      { ...satisfiedVerification("criterion-02", contract.missionRevision, probe.candidateDigest!), result: "maybe" },
      { ...satisfiedVerification("criterion-02", contract.missionRevision, probe.candidateDigest!), candidateDigest: "not-hex" },
    ] as unknown as MissionCriterionVerification[];
    const evidence = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
      criterionVerifications: malformed,
      trustedVerifierIds: ["host-verifier-1"],
    }).load("session-missing", contract.missionId);
    expect(evidence.criteria.every((criterion) => criterion.graphEvidence === undefined)).toBe(true);
    expect(evidence.criteria.every((criterion) => criterion.verified === false)).toBe(true);
    expect(evidence.criteria.every((criterion) => criterion.criterionVerification?.result === "unresolved")).toBe(true);
    expect(preflightMissionClosure(evidence, POLICY_V2).complete).toBe(false);

    // Malformed bindings are rejected as mismatched, never bound.
    const [garbage] = resolveCriterionGraphBindings({
      bindings: [{ criterionId: "", runId: "run-1", nodeId: "build", inputHash: C, outputDigest: D }],
      criteria: [{ id: "criterion-01" }],
      graphRuns: [{ runId: "run-1", nodes: [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D, declaredDependencies: [] }] }],
    });
    expect(garbage?.state).toBe("mismatched");
  });

  it("7. cross-session injection is ignored on the trusted path", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const mine = parseMissionContract("session-mine", prompt, 100)!;
    const theirs = parseMissionContract("session-theirs", prompt, 100)!;
    store.updateSession("session-mine", (state) => ({ ...state, mission_contract: mine }));
    store.updateSession("session-theirs", (state) => ({ ...state, mission_contract: theirs }));
    writeJournal(join(dataDir, "graph-journals"), "session-theirs", "run-foreign", [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D }]);
    // Forged external bindings naming the foreign run: the trusted path
    // ignores `criterionGraphBindings` entirely. Declared associations
    // naming the foreign run likewise match nothing: it is journaled under
    // another session, so the scoped projection is empty for session-mine.
    const evidence = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: [{ criterionId: "criterion-01", runId: "run-foreign", nodeId: "build" }],
      criterionGraphBindings: [{ criterionId: "criterion-01", runId: "run-foreign", nodeId: "build", graphHash: A, policyHash: B, inputHash: C, outputDigest: D, executionStatus: "succeeded" }],
    }).load("session-mine", mine.missionId);
    expect(evidence.graphRuns ?? []).toEqual([]);
    expect(evidence.criteria.every((criterion) => criterion.graphEvidence === undefined)).toBe(true);
    expect(evidence.criteria.every((criterion) => criterion.verified === false)).toBe(true);
    expect(preflightMissionClosure(evidence, POLICY_V2).complete).toBe(false);
  });

  it("8. stale candidate and stale revision verdicts do not count", async () => {
    const { dataDir, store, contract, evidence: before } = await satisfiedSetup("session-stale");
    expect(before.criteria.every((criterion) => criterion.verified)).toBe(true);
    // Rotate the candidate after the verdicts were issued.
    recordPassingTests(store, "session-stale");
    store.updateSession("session-stale", (state) => ({
      ...state,
      verification: { last: { kind: "test" as const, ok: true, ts: 500, command: "npm test --changed" }, edits_since: 0 },
    }));
    const staleCandidate = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
      criterionVerifications: [
        satisfiedVerification("criterion-01", contract.missionRevision, before.candidateDigest!),
        satisfiedVerification("criterion-02", contract.missionRevision, before.candidateDigest!),
      ],
      trustedVerifierIds: ["host-verifier-1"],
    }).load("session-stale", contract.missionId);
    expect(staleCandidate.evidenceRevision).not.toBe(before.evidenceRevision);
    expect(staleCandidate.criteria.every((criterion) => criterion.verified === false)).toBe(true);
    expect(staleCandidate.criteria[0]?.criterionVerification?.result).toBe("unresolved");

    // A verdict naming a foreign mission revision never counts either.
    const staleRevision = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
      criterionVerifications: [
        { ...satisfiedVerification("criterion-01", contract.missionRevision, staleCandidate.candidateDigest!), missionRevision: "0".repeat(64) },
      ],
      trustedVerifierIds: ["host-verifier-1"],
    }).load("session-stale", contract.missionId);
    expect(staleRevision.criteria[0]?.criterionVerification?.result).toBe("unresolved");
    expect(preflightMissionClosure(staleRevision, POLICY_V2).complete).toBe(false);
  });

  it("9. conflicting receipts and ambiguous duplicate verdicts never satisfy", async () => {
    // Resolver: a receipt contradicting the journaled node is conflict.
    const correlationId = "2".repeat(64);
    const [conflict] = resolveCriterionGraphBindings({
      bindings: [{
        criterionId: "criterion-01", runId: "run-1", nodeId: "build",
        inputHash: C, outputDigest: D, executionStatus: "succeeded", receiptCorrelationId: correlationId,
      }],
      criteria: [{ id: "criterion-01" }],
      graphRuns: [{ runId: "run-1", nodes: [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D, declaredDependencies: [] }] }],
      sessionId: "session-host",
      receipts: [validTerminalReceipt(correlationId, "session-host", F)],
      ledgerUnavailable: false,
    });
    expect(conflict?.state).toBe("conflict");

    // Verification: two satisfied verdicts with divergent receipt identity
    // are ambiguous — unresolved, never satisfied.
    const { assessments } = validateCriterionVerifications({
      verifications: [
        satisfiedVerification("criterion-01", A, B),
        { ...satisfiedVerification("criterion-01", A, B), receiptCorrelationId: "receipt-criterion-01-2" },
      ],
      criteria: [{ id: "criterion-01" }],
      missionRevision: A,
      candidateDigest: B,
      verifierAllowlist: ["host-verifier-1"],
    });
    expect(assessments[0]?.outcome).toBe("unresolved");

    // And satisfied-vs-failed contradiction fails the criterion outright.
    const contradicted = validateCriterionVerifications({
      verifications: [
        satisfiedVerification("criterion-01", A, B),
        { ...satisfiedVerification("criterion-01", A, B), result: "failed" },
      ],
      criteria: [{ id: "criterion-01" }],
      missionRevision: A,
      candidateDigest: B,
      verifierAllowlist: ["host-verifier-1"],
    });
    expect(contradicted.assessments[0]?.outcome).toBe("failed");
    const qualified = qualifyTrustedCriteria({
      criteria: [{ id: "criterion-01" }],
      attested: new Set(["criterion-01"]),
      graphStates: [{ criterionId: "criterion-01", runId: "run-1", nodeId: "build", state: "bound", detail: "ok" }],
      verificationAssessments: contradicted.assessments,
    });
    expect(qualified[0]?.qualified).toBe(false);
  });

  it("10. forged verifierId and empty allowlist resolve unresolved", async () => {
    const { dataDir, store, contract } = await satisfiedSetup("session-forged-setup");
    const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load("session-forged-setup", contract.missionId);
    // Forged: verifier outside the host allowlist.
    const forged = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
      criterionVerifications: [
        satisfiedVerification("criterion-01", contract.missionRevision, probe.candidateDigest!, "attacker-verifier"),
        satisfiedVerification("criterion-02", contract.missionRevision, probe.candidateDigest!, "attacker-verifier"),
      ],
      trustedVerifierIds: ["host-verifier-1"],
    }).load("session-forged-setup", contract.missionId);
    expect(forged.criteria.every((criterion) => criterion.verified === false)).toBe(true);
    expect(forged.criteria[0]?.criterionVerification?.result).toBe("unresolved");
    expect(preflightMissionClosure(forged, POLICY_V2).complete).toBe(false);

    // Default empty allowlist: even a well-formed verdict counts for nothing.
    const unlisted = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
      criterionVerifications: [
        satisfiedVerification("criterion-01", contract.missionRevision, probe.candidateDigest!),
      ],
    }).load("session-forged-setup", contract.missionId);
    expect(unlisted.criteria[0]?.criterionVerification?.result).toBe("unresolved");
  });

  it("11. valid-receipt-without-independent-verification traces but never satisfies", async () => {
    // A valid execution-observed receipt correlates: traceable, not satisfied.
    const correlationId = "3".repeat(64);
    const [bound] = resolveCriterionGraphBindings({
      bindings: [{
        criterionId: "criterion-01", runId: "run-1", nodeId: "build",
        inputHash: C, outputDigest: D, executionStatus: "succeeded", receiptCorrelationId: correlationId,
      }],
      criteria: [{ id: "criterion-01" }],
      graphRuns: [{ runId: "run-1", nodes: [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D, declaredDependencies: [] }] }],
      sessionId: "session-host",
      receipts: [validTerminalReceipt(correlationId, "session-host", D)],
      ledgerUnavailable: false,
    });
    expect(bound?.state).toBe("bound");

    // Session level: identical execution, no independent verdict → INCOMPLETE.
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-noindep", prompt, 100)!;
    store.updateSession("session-noindep", (state) => ({ ...state, mission_contract: contract }));
    writeJournal(join(dataDir, "graph-journals"), "session-noindep", "run-1", [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D }]);
    recordPassingTests(store, "session-noindep");
    attestBoth(store, "session-noindep", contract);
    const evidence = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400, enableTrustedGraphEvidence: true, trustedVerifierIds: ["host-verifier-1"],
      criterionProducerAssociations: bothCriteria("run-1"),
    }).load("session-noindep", contract.missionId);
    expect(evidence.criteria[0]?.graphEvidence?.[0]?.state).toBe("bound");
    expect(evidence.criteria.every((criterion) => criterion.verified === false)).toBe(true);
    expect(preflightMissionClosure(evidence, POLICY_V2).complete).toBe(false);
  });

  it("12. superseded-failure-with-verified-repair re-qualifies only on the new candidate", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-repair", prompt, 100)!;
    store.updateSession("session-repair", (state) => ({ ...state, mission_contract: contract }));
    const graphDir = join(dataDir, "graph-journals");
    writeJournal(graphDir, "session-repair", "run-1", [{ nodeId: "build", status: "failed", inputHash: C, outputDigest: D }]);
    recordPassingTests(store, "session-repair");
    const probe1 = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load("session-repair", contract.missionId);
    attestBoth(store, "session-repair", contract);
    const failedVerdict: MissionCriterionVerification = {
      criterionId: "criterion-01", verifierId: "host-verifier-1", missionRevision: contract.missionRevision,
      candidateDigest: probe1.candidateDigest!, result: "failed", receiptCorrelationId: "receipt-01-v1", verifiedAt: 400,
    };
    const failed = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
      criterionVerifications: [failedVerdict],
      trustedVerifierIds: ["host-verifier-1"],
    }).load("session-repair", contract.missionId);
    expect(failed.criteria[0]?.graphEvidence?.[0]?.state).toBe("unhealthy");
    expect(failed.criteria[0]?.criterionVerification?.result).toBe("failed");
    expect(preflightMissionClosure(failed, POLICY_V2).complete).toBe(false);

    // Repair: the node re-executes with new hashes; the candidate rotates.
    const journal = new FileJournal("run-1", graphDir, "session-repair");
    journal.record({ type: "node-terminal", runId: "run-1", ts: "2026-01-01T00:00:04.000Z", nodeId: "build", declaredDependencies: [], status: "succeeded", inputHash: E, outputDigest: F });
    const probe2 = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load("session-repair", contract.missionId);
    expect(probe2.candidateDigest).not.toBe(probe1.candidateDigest);
    const repaired = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
      criterionVerifications: [
        failedVerdict, // superseded: binds the old candidate, ignored.
        satisfiedVerification("criterion-01", contract.missionRevision, probe2.candidateDigest!),
        satisfiedVerification("criterion-02", contract.missionRevision, probe2.candidateDigest!),
      ],
      trustedVerifierIds: ["host-verifier-1"],
    }).load("session-repair", contract.missionId);
    expect(repaired.evidenceRevision).not.toBe(failed.evidenceRevision);
    expect(repaired.criteria[0]?.graphEvidence?.[0]?.state).toBe("bound");
    expect(repaired.criteria[0]?.criterionVerification?.result).toBe("satisfied");
  });

  it("13. multi-run→one-criterion: declared associations bind, undeclared runs never fan out", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-multirun", singlePrompt, 100)!;
    store.updateSession("session-multirun", (state) => ({ ...state, mission_contract: contract }));
    const graphDir = join(dataDir, "graph-journals");
    writeJournal(graphDir, "session-multirun", "run-1", [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D }]);
    writeJournal(graphDir, "session-multirun", "run-2", [{ nodeId: "build", status: "succeeded", inputHash: E, outputDigest: F }]);
    // One declared association traces run-1 only: the undeclared run-2
    // (an unrelated success) never produces a binding — no fan-out, no
    // spurious self-conflict.
    const evidence = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400, enableTrustedGraphEvidence: true,
      criterionProducerAssociations: [{ criterionId: "criterion-01", runId: "run-1", nodeId: "build" }],
    }).load("session-multirun", contract.missionId);
    expect(evidence.criteria[0]?.graphEvidence).toEqual([{
      criterionId: "criterion-01",
      runId: "run-1",
      nodeId: "build",
      dependencies: [],
      state: "bound",
      detail: expect.any(String),
      provenance: TRUSTED_GRAPH_BINDING_PROVENANCE,
    }]);

    // Two divergent host claims for one criterion still conflict.
    const states = resolveCriterionGraphBindings({
      bindings: [
        { criterionId: "criterion-01", runId: "run-1", nodeId: "build", inputHash: C, outputDigest: D },
        { criterionId: "criterion-01", runId: "run-2", nodeId: "build", inputHash: E, outputDigest: F },
      ],
      criteria: [{ id: "criterion-01" }],
      graphRuns: [
        { runId: "run-1", nodes: [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D, declaredDependencies: [] }] },
        { runId: "run-2", nodes: [{ nodeId: "build", status: "succeeded", inputHash: E, outputDigest: F, declaredDependencies: [] }] },
      ],
    });
    expect(states.map((state) => state.state)).toEqual(["conflict", "conflict"]);
  });

  it("14. one-run→many-criteria: every criterion traces the same node", async () => {
    const { evidence } = await satisfiedSetup("session-many");
    for (const criterion of evidence.criteria) {
      expect(criterion.graphEvidence?.[0]?.state).toBe("bound");
      expect(criterion.graphEvidence?.[0]?.runId).toBe("run-1");
      expect(criterion.graphEvidence?.[0]?.nodeId).toBe("build");
      expect(criterion.verified).toBe(true);
    }
    expect(preflightReachedReview(preflightMissionClosure(evidence, POLICY_V2))).toBe(true);
  });

  it("15. missing-artifact invalidates the qualification", async () => {
    const { dataDir, store, contract, evidence: before } = await satisfiedSetup("session-artifact");
    expect(before.criteria.every((criterion) => criterion.verified)).toBe(true);
    // The journal artifact disappears: no runs project, the candidate
    // rotates, and candidate-bound verdicts go stale.
    rmSync(join(dataDir, "graph-journals", "jeverb-graph-run-1.jsonl"), { force: true });
    const after = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
      criterionVerifications: [
        satisfiedVerification("criterion-01", contract.missionRevision, before.candidateDigest!),
        satisfiedVerification("criterion-02", contract.missionRevision, before.candidateDigest!),
      ],
      trustedVerifierIds: ["host-verifier-1"],
    }).load("session-artifact", contract.missionId);
    expect(after.graphRuns ?? []).toEqual([]);
    expect(after.evidenceRevision).not.toBe(before.evidenceRevision);
    expect(after.criteria.every((criterion) => criterion.verified === false)).toBe(true);
    expect(preflightMissionClosure(after, POLICY_V2).complete).toBe(false);
  });

  it("16. disabled-feature snapshot is bit-identical and ignores trusted args", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-disabled", prompt, 100)!;
    store.updateSession("session-disabled", (state) => ({ ...state, mission_contract: contract }));
    writeJournal(join(dataDir, "graph-journals"), "session-disabled", "run-1", [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D }]);
    recordPassingTests(store, "session-disabled");
    const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load("session-disabled", contract.missionId);

    const plain = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 })
      .load("session-disabled", contract.missionId);
    const withTrustedArgs = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: false,
      criterionVerifications: [satisfiedVerification("criterion-01", contract.missionRevision, probe.candidateDigest!)],
      trustedVerifierIds: ["host-verifier-1"],
    }).load("session-disabled", contract.missionId);
    expect(withTrustedArgs).toEqual(plain);
    for (const criterion of withTrustedArgs.criteria) {
      expect("graphEvidence" in criterion).toBe(false);
      expect("criterionVerification" in criterion).toBe(false);
    }
    expect("requestProfile" in withTrustedArgs).toBe(false);

    // The disabled wire shape is exactly the historical v1 shape.
    const request = affirmativeRequest(withTrustedArgs);
    expect(request.state.requestProfile).toBeUndefined();
    expect(request.state.criterionEvidence).toBeUndefined();
    expect(hashQuestions(request.questions)).toBe(V1_HASH);
    expect(JSON.parse(JSON.stringify(request))).toEqual(JSON.parse(JSON.stringify(affirmativeRequest(plain))));
  });
});

describe("trusted producer and request-profile boundaries", () => {
  it("builds bindings only from declared associations against host-owned evidence", () => {
    const missionRevision = "9".repeat(64);
    const runs = [
      { runId: "run-b", nodes: [{ nodeId: "zeta", status: "succeeded" as const, inputHash: C, outputDigest: D, declaredDependencies: [] }] },
      { runId: "run-a", nodes: [{ nodeId: "build", status: "succeeded" as const, inputHash: E, outputDigest: F, declaredDependencies: [], attemptIds: ["build/7"] }] },
    ];
    const associations: CriterionProducerAssociation[] = [
      { criterionId: "criterion-02", runId: "run-a", nodeId: "build", attemptId: "build/7" },
      { criterionId: "criterion-01", runId: "run-a", nodeId: "build" },
      // Duplicates collapse; undeclared runs, unknown criteria, missing
      // nodes, and superseded attempts never produce bindings.
      { criterionId: "criterion-01", runId: "run-a", nodeId: "build" },
      { criterionId: "criterion-01", runId: "run-b", nodeId: "zeta" },
      { criterionId: "no-such-criterion", runId: "run-a", nodeId: "build" },
      { criterionId: "criterion-01", runId: "run-missing", nodeId: "build" },
      { criterionId: "criterion-02", runId: "run-a", nodeId: "build", attemptId: "build/superseded" },
    ];
    const args = {
      criteria: [{ id: "criterion-02" }, { id: "criterion-01" }],
      associations,
      graphRuns: runs,
      missionRevision,
      candidateDigest: A,
    };
    const first = buildCriterionGraphBindings(args);
    const second = buildCriterionGraphBindings({ ...args, associations: [...associations].reverse() });
    expect(first).toEqual(second);
    // criterion-01 names two divergent producer nodes: both bind, and the
    // resolver marks the pair conflict. The producer never picks a winner.
    expect(first).toHaveLength(3);
    for (const binding of first) {
      expect(binding.provenance).toBe(TRUSTED_GRAPH_BINDING_PROVENANCE);
      expect(binding.missionRevision).toBe(missionRevision);
      expect(binding.candidateDigest).toBe(A);
      expect(binding.receiptCorrelationId).toBeUndefined();
    }
    expect(first.map((binding) => [binding.criterionId, binding.runId, binding.nodeId])).toEqual([
      ["criterion-01", "run-a", "build"],
      ["criterion-01", "run-b", "zeta"],
      ["criterion-02", "run-a", "build"],
    ]);
    expect(first.find((binding) => binding.criterionId === "criterion-02")?.attemptId).toBe("build/7");
    expect(first.find((binding) => binding.criterionId === "criterion-01" && binding.runId === "run-a")?.attemptId).toBeUndefined();
    // No eligible nodes → no bindings, never a placeholder.
    expect(buildCriterionGraphBindings({ criteria: [{ id: "criterion-01" }], associations: [], graphRuns: [], missionRevision })).toEqual([]);
  });

  it("v1 policy pins cannot silently validate a v2 request", async () => {
    const { evidence } = await satisfiedSetup("session-pin");
    expect(hashQuestions(affirmativeRequest(evidence).questions)).toBe(V2_HASH);
    // The old calibration (v1 question hash) against v2 evidence: preflight
    // passes, but the semantic vote is unbound — never COMPLETE.
    let called = false;
    const result = await decideMissionClosure(stubModel("COMPLETE", () => { called = true; }), evidence, POLICY_V1);
    expect(called).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.status).not.toBe("COMPLETE");
    expect(result.reasons.join(" ")).toContain("binding did not match");
  });

  it("v2 projection carries allowlisted fields with size caps, no raw artifact text", () => {
    const evidence = {
      missionId: "m",
      objective: "o",
      missionRevision: "r",
      evidenceRevision: "e",
      candidateDigest: "c".repeat(64),
      criteria: [{
        id: "criterion-01",
        statement: "requirement text",
        verified: true,
        outcome: "claimed outcome",
        missionRevision: "r",
        evidenceRevision: "e",
        graphEvidence: Array.from({ length: 20 }, (_, index) => ({
          criterionId: "criterion-01",
          runId: `run-${index}`,
          nodeId: "build",
          state: "bound" as const,
          detail: "match",
        })),
        criterionVerification: { result: "satisfied" as const, detail: "counted" },
      }],
      tests: { passed: true, independent: true, revision: "e" },
      operations: { pending: 0, uncertain: 0 },
      blockers: [],
      requestProfile: MISSION_CLOSURE_REQUEST_PROFILE_V2,
    } as unknown as MissionClosureEvidence;
    const [entry] = projectCriterionEvidenceForRequest(evidence);
    expect(Object.keys(entry!).sort()).toEqual(
      ["contradiction", "id", "observedGraphState", "requirement", "claimedOutcome", "unresolved", "verificationResult", "verificationScope"].sort(),
    );
    expect(entry!.observedGraphState).toHaveLength(8);
    for (const row of entry!.observedGraphState) {
      expect(Object.keys(row).sort()).toEqual(["nodeId", "runId", "state"]);
    }
    expect(JSON.stringify(entry)).not.toContain("outputDigest");
  });

  it("closes durably through the gate on the trusted path (terminalComplete + receipt)", async () => {
    const { dataDir, store, contract, evidence } = await satisfiedSetup("session-gate");
    expect(preflightReachedReview(preflightMissionClosure(evidence, POLICY_V2))).toBe(true);
    const ledger = testLedger(dataDir);
    const source = createSessionMissionClosureSource({
      store, dataDir, now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: bothCriteria("run-1"),
      criterionVerifications: [
        satisfiedVerification("criterion-01", contract.missionRevision, evidence.candidateDigest!),
        satisfiedVerification("criterion-02", contract.missionRevision, evidence.candidateDigest!),
      ],
      trustedVerifierIds: ["host-verifier-1"],
    });
    const gate = new MissionClosureGate(stubModel("COMPLETE"), POLICY_V2, source, ledger, 1500);
    const result = await gate.close("session-gate", contract.missionId);
    expect(result.terminalComplete).toBe(true);
    expect(result.decision.status).toBe("COMPLETE");
    expect(result.decision.complete).toBe(true);
    expect(result.receipt.status === "appended" || result.receipt.status === "duplicate").toBe(true);
    const records = ledger.read().records.filter((record) => record.event === "MissionClosure" && record.missionClosure?.complete === true);
    expect(records.length).toBeGreaterThanOrEqual(1);
  });
});
