/**
 * Verified-completion qualification gates + trusted-path wiring (Phase 4/5).
 *
 * - `trustedEvidenceReadiness` reports the snapshot-internal gates; it
 *   never verifies and never authorizes.
 * - `resolveTrustedRunnerOptions` defaults to a fully-OFF trusted profile;
 *   only explicit operator input enables it.
 * - `createSessionMissionClosureRunner` keeps the trusted path default-OFF
 *   (trusted args without the flag change nothing) and, when explicitly
 *   enabled, qualifies end to end: explicit associations + persisted
 *   verifier receipts + allowlisted verifiers → COMPLETE with a durable
 *   receipt; phantom (never-persisted) verdicts → INCOMPLETE, fail closed.
 *
 * Stub models only, real local persistence (Store, FileJournal,
 * EvidenceLedger on temp dirs). No metered inference, no network.
 */
import { mkdirSync, rmSync } from "node:fs";
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
  MISSION_CLOSURE_QUESTION_V2,
  trustedEvidenceReadiness,
  type MissionClosureEvidence,
  type MissionClosurePolicy,
} from "../../src/mission/closure.js";
import { createSessionMissionClosureSource } from "../../src/mission/session-source.js";
import { createSessionMissionClosureRunner, resolveTrustedRunnerOptions } from "../../src/mission/runtime.js";
import {
  findingToVerification,
  persistVerifierFinding,
  verifyTestExecution,
} from "../../src/mission/verifiers.js";
import { testLedger, testStore } from "../helpers/control-state.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jeverb-verified-completion-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const prompt = `Ship the parser change.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- Parser handles the new syntax.\n- The tests prove retry safety.`;

const C = "c".repeat(64);
const D = "d".repeat(64);
const V2_HASH = hashQuestions({ closure: MISSION_CLOSURE_QUESTION_V2 });
const POLICY_V2: MissionClosurePolicy = {
  policyVersion: "mission-closure/1",
  minConfidence: 0.8,
  calibrated: true,
  backend: "typesafe",
  model: "jev-1.14.0",
  modelVersion: "jev-1.14.0",
  questionHash: V2_HASH,
  calibrationVersion: "gates-fixture-1",
};

function stubComplete(): DecisionModel {
  return {
    evaluate: async (input: Parameters<DecisionModel["evaluate"]>[0]) => ({
      provider: "typesafe",
      model: "jev-1.14.0",
      questionHash: hashQuestions(input.questions),
      answers: {
        closure: {
          type: "choice",
          choice: "COMPLETE",
          confidence: 1,
          probabilities: { COMPLETE: 1, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
        },
      },
    }),
  } as unknown as DecisionModel;
}

function writeJournal(graphDir: string, sessionId: string, runId: string): void {
  mkdirSync(graphDir, { recursive: true, mode: 0o700 });
  const journal = new FileJournal(runId, graphDir, sessionId);
  journal.record({ type: "run-started", runId, ts: "2026-01-01T00:00:00.000Z", graphHash: "a".repeat(64), policyHash: "b".repeat(64) });
  journal.record({ type: "node-authorized", runId, ts: "2026-01-01T00:00:01.000Z", nodeId: "build", attemptId: "build/1", allowed: true, inputHash: C });
  journal.record({ type: "node-running", runId, ts: "2026-01-01T00:00:02.000Z", nodeId: "build", attemptId: "build/1", inputHash: C });
  journal.record({ type: "node-terminal", runId, ts: "2026-01-01T00:00:03.000Z", nodeId: "build", attemptId: "build/1", declaredDependencies: [], status: "succeeded", inputHash: C, outputDigest: D });
}

function attestBoth(store: ReturnType<typeof testStore>, sessionId: string, contract: NonNullable<ReturnType<typeof parseMissionContract>>): void {
  const userPrompt =
    `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\nverified:\n` +
    `- criterion-01: parser handles the new syntax\n- criterion-02: regression tests cover retry safety`;
  const attestations = parseMissionAttestation(sessionId, userPrompt, contract, 200);
  if (attestations === undefined) throw new Error("attestation fixture failed to parse");
  store.updateSession(sessionId, (state) => ({ ...state, mission_contract: addMissionAttestations(contract, attestations) }));
}

/** Full trusted fixture with REAL persisted verifier receipts. */
async function trustedSetup(sessionId: string, opts: { persistReceipts: boolean }): Promise<{
  dataDir: string;
  store: ReturnType<typeof testStore>;
  contract: NonNullable<ReturnType<typeof parseMissionContract>>;
  candidateDigest: string;
  verifications: ReturnType<typeof findingToVerification>[];
}> {
  const dataDir = tempDir();
  const store = testStore(dataDir);
  const ledger = testLedger(dataDir);
  const contract = parseMissionContract(sessionId, prompt, 100);
  if (contract === undefined) throw new Error("contract fixture failed to parse");
  store.updateSession(sessionId, (state) => ({ ...state, mission_contract: contract }));
  writeJournal(join(dataDir, "graph-journals"), sessionId, "run-1");
  store.updateSession(sessionId, (state) => ({
    ...state,
    verification: { last: { kind: "test" as const, ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
  }));
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
  const verifications = ["criterion-01", "criterion-02"].map((criterionId) => {
    const finding = verifyTestExecution({
      criterionId,
      missionRevision: contract.missionRevision,
      candidateDigest: probe.candidateDigest as string,
      graphNodes: [{ runId: "run-1", nodeId: "build", attemptId: "build/1" }],
      evidenceRef: "suite:unit",
      passed: true,
      verifiedAt: 400,
    });
    if (opts.persistReceipts) {
      const persisted = persistVerifierFinding(ledger, sessionId, finding);
      if (persisted.status !== "appended" && persisted.status !== "duplicate") {
        throw new Error(`verifier receipt did not persist: ${persisted.status}`);
      }
      return findingToVerification(finding, persisted.correlationId);
    }
    return findingToVerification(finding, "f".repeat(64));
  });
  return { dataDir, store, contract, candidateDigest: probe.candidateDigest, verifications };
}

describe("resolveTrustedRunnerOptions", () => {
  it("defaults to fully OFF and enables only on explicit opt-in", () => {
    expect(resolveTrustedRunnerOptions({})).toEqual({});
    expect(resolveTrustedRunnerOptions({ JEVERB_TRUSTED_GRAPH_EVIDENCE: "0" })).toEqual({});
    expect(resolveTrustedRunnerOptions({ JEVERB_TRUSTED_GRAPH_EVIDENCE: "yes" })).toEqual({});
    expect(resolveTrustedRunnerOptions({ JEVERB_TRUSTED_GRAPH_EVIDENCE: "1" })).toEqual({ enableTrustedGraphEvidence: true });
    expect(
      resolveTrustedRunnerOptions({ JEVERB_TRUSTED_GRAPH_EVIDENCE: "1", JEVERB_TRUSTED_VERIFIER_IDS: " a,,b , " }),
    ).toEqual({ enableTrustedGraphEvidence: true, trustedVerifierIds: ["a", "b"] });
    // An allowlist without the master switch enables nothing.
    expect(resolveTrustedRunnerOptions({ JEVERB_TRUSTED_VERIFIER_IDS: "a" })).toEqual({});
  });
});

describe("trustedEvidenceReadiness", () => {
  it("reports ready only when every gate holds", () => {
    const ready: MissionClosureEvidence = {
      missionId: "m",
      objective: "o",
      missionRevision: "r",
      evidenceRevision: "e",
      candidateDigest: "c".repeat(64),
      criteria: [{
        id: "criterion-01",
        statement: "s",
        verified: true,
        outcome: "done",
        evidenceRef: "user-prompt:x",
        missionRevision: "r",
        evidenceRevision: "e",
        graphEvidence: [{ criterionId: "criterion-01", runId: "run-1", nodeId: "build", state: "bound", detail: "ok" }],
        criterionVerification: { result: "satisfied", detail: "counted" },
      }],
      tests: { passed: true, independent: true, evidenceRef: "v:1", revision: "e" },
      operations: { pending: 0, uncertain: 0 },
      blockers: [],
      requestProfile: "mission-closure/v2-graph-evidence",
    };
    expect(trustedEvidenceReadiness(ready)).toEqual({
      currentShape: true,
      traceableEvidence: true,
      independentOutcomes: true,
      zeroUncertainty: true,
      trustedProfile: true,
      ready: true,
    });
    // Each gate fails independently; readiness never authorizes by itself.
    const { requestProfile: _profile, ...withoutProfile } = ready;
    expect(trustedEvidenceReadiness(withoutProfile).ready).toBe(false);
    expect(trustedEvidenceReadiness({ ...ready, operations: { pending: 0, uncertain: 1 } }).ready).toBe(false);
    expect(trustedEvidenceReadiness({
      ...ready,
      criteria: [{ ...ready.criteria[0]!, criterionVerification: { result: "unresolved", detail: "none" } }],
    }).ready).toBe(false);
    expect(trustedEvidenceReadiness({
      ...ready,
      criteria: [{ ...ready.criteria[0]!, graphEvidence: [{ criterionId: "criterion-01", runId: "run-1", nodeId: "build", state: "unhealthy", detail: "failed" }] }],
    }).ready).toBe(false);
  });
});

describe("runner trusted-path wiring", () => {
  it("stays default-OFF: trusted args without the flag change nothing", async () => {
    const { dataDir, store, contract } = await trustedSetup("session-off", { persistReceipts: true });
    const runner = createSessionMissionClosureRunner({
      model: stubComplete(),
      config: { dataDir, missionClosurePolicy: POLICY_V2, timeoutMs: 1500 },
      store,
      ledger: testLedger(dataDir),
      now: () => 400,
      // Flag absent: trusted args are ignored, exactly like the historical path.
      criterionVerifications: [],
      trustedVerifierIds: ["test-execution"],
    });
    const result = await runner("session-off");
    expect("outcome" in result).toBe(false);
    if ("outcome" in result) throw new Error("unreachable");
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
  });

  it("completes end to end on the explicitly enabled trusted path with durable receipts", async () => {
    const sessionId = "session-trusted-e2e";
    const { dataDir, store, contract, verifications } = await trustedSetup(sessionId, { persistReceipts: true });
    const associations = [
      { criterionId: "criterion-01", runId: "run-1", nodeId: "build" },
      { criterionId: "criterion-02", runId: "run-1", nodeId: "build" },
    ];
    const ledger = testLedger(dataDir);
    const source = createSessionMissionClosureSource({
      store,
      dataDir,
      now: () => 400,
      ledger,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: associations,
      criterionVerifications: verifications,
      trustedVerifierIds: ["test-execution"],
    });
    const snapshot = await source.load(sessionId, contract.missionId);
    expect(snapshot.criteria.every((criterion) => criterion.verified)).toBe(true);
    expect(trustedEvidenceReadiness(snapshot).ready).toBe(true);
    expect(snapshot.criteria[0]?.graphEvidence?.[0]?.state).toBe("bound");

    const runner = createSessionMissionClosureRunner({
      model: stubComplete(),
      config: { dataDir, missionClosurePolicy: POLICY_V2, timeoutMs: 1500 },
      store,
      ledger,
      now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: associations,
      criterionVerifications: verifications,
      trustedVerifierIds: ["test-execution"],
    });
    const result = await runner(sessionId);
    expect("outcome" in result).toBe(false);
    if ("outcome" in result) throw new Error("unreachable");
    expect(result.decision.status).toBe("COMPLETE");
    expect(result.decision.complete).toBe(true);
    expect(result.terminalComplete).toBe(true);
    expect(result.receipt.status === "appended" || result.receipt.status === "duplicate").toBe(true);
  });

  it("fails closed when verdicts name receipts that were never durably persisted", async () => {
    const sessionId = "session-phantom";
    const { dataDir, store, contract, verifications } = await trustedSetup(sessionId, { persistReceipts: false });
    const associations = [
      { criterionId: "criterion-01", runId: "run-1", nodeId: "build" },
      { criterionId: "criterion-02", runId: "run-1", nodeId: "build" },
    ];
    const ledger = testLedger(dataDir);
    const runner = createSessionMissionClosureRunner({
      model: stubComplete(),
      config: { dataDir, missionClosurePolicy: POLICY_V2, timeoutMs: 1500 },
      store,
      ledger,
      now: () => 400,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: associations,
      criterionVerifications: verifications,
      trustedVerifierIds: ["test-execution"],
    });
    const result = await runner(sessionId);
    expect("outcome" in result).toBe(false);
    if ("outcome" in result) throw new Error("unreachable");
    // Execution-observed rows trace fine, but nothing independently verifies:
    // phantom receipts fail closed to unresolved, never COMPLETE.
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
  });
});
