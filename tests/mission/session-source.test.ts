import { createHash } from "node:crypto";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileJournal } from "../../src/graph/journal.js";
import { addMissionAttestations, parseMissionAttestation, parseMissionContract } from "../../src/mission/contract.js";
import { mergeServiceAttestations } from "../../src/control/attestations.js";
import { createSessionMissionClosureSource } from "../../src/mission/session-source.js";
import { MISSION_CLOSURE_QUESTION, MissionClosureGate } from "../../src/mission/closure.js";
import { hashQuestions } from "../../src/decision/provenance.js";
import type { DecisionModel } from "../../src/decision/types.js";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import { testStore } from "../helpers/control-state.js";
import { testLedgerForFile } from "../helpers/control-state.js";
import { enforceEvidenceRetention } from "../../src/hooks/maintenance.js";
import { produceHostVerificationInputs } from "../../src/mission/runtime.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jeverb-mission-source-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const prompt = `Implement graph recovery.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- Interrupted effects remain uncertain until reconciled.\n- The tests prove retry safety.`;

describe("session-backed mission closure evidence", () => {
  it("projects legacy contracts without the explicit objective coverage declaration as missing", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const legacyPrompt = prompt.replace("Objective coverage: exhaustive\n\n", "");
    const contract = parseMissionContract("session-legacy-coverage", legacyPrompt, 100)!;
    store.updateSession("session-legacy-coverage", (state) => ({ ...state, mission_contract: contract }));
    const evidence = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 })
      .load("session-legacy-coverage", contract.missionId);
    expect(evidence.objectiveCoverage).toEqual({ status: "missing" });
  });

  it("joins user criterion attestations and a current host-observed test to the mission", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-1", prompt, 100)!;
    const userPrompt = `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\nverified:\n- criterion-01: interrupted effects remain uncertain until reconciled\n- criterion-02: regression tests cover retry safety`;
    const attestations = parseMissionAttestation("session-1", userPrompt, contract, 200)!;
    store.updateSession("session-1", (state) => ({
      ...state,
      mission_contract: addMissionAttestations(contract, attestations),
      verification: { last: { kind: "test", ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
    }));
    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const evidence = await source.load("session-1", contract.missionId);

    expect(evidence.missionRevision).toBe(contract.missionRevision);
    expect(evidence.criteria.every((criterion) => criterion.verified && criterion.evidenceRef !== undefined)).toBe(true);
    expect(evidence.criteria.map((criterion) => criterion.outcome)).toEqual([
      "interrupted effects remain uncertain until reconciled",
      "regression tests cover retry safety",
    ]);
    // A locally observed passing test is execution success, not independence.
    expect(evidence.tests).toMatchObject({ passed: true, independent: false, revision: evidence.evidenceRevision });
    expect(await source.isCurrent("session-1", contract.missionId, contract.missionRevision, evidence.evidenceRevision)).toBe(true);
  });

  it("rejects an unrelated verifier receipt as independent evidence", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-4", prompt, 100)!;
    store.updateSession("session-4", (state) => ({
      ...state,
      mission_contract: {
        ...contract,
        independentVerifications: [{
          verifierId: "veyrict-qualifier-1",
          missionRevision: contract.missionRevision,
          evidenceRevision: "snapshot-does-not-matter",
          candidate: "worktree-abc123",
          verificationResult: "pass",
          receiptCorrelationId: "verifier-receipt-001",
          verifiedAt: 350,
        }],
      },
      verification: { last: { kind: "test", ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
    }));
    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const evidence = await source.load("session-4", contract.missionId);
    expect(evidence.tests).toMatchObject({ passed: true, independent: false });
  });

  it("accepts a verifier receipt bound to the exact candidate revision", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-5", prompt, 100)!;
    store.updateSession("session-5", (state) => ({
      ...state,
      mission_contract: contract,
      verification: { last: { kind: "test", ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
    }));
    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const probe = await source.load("session-5", contract.missionId);
    store.updateSession("session-5", (state) => ({
      ...state,
      mission_contract: {
        ...contract,
        independentVerifications: [{
          verifierId: "veyrict-qualifier-1",
          missionRevision: contract.missionRevision,
          evidenceRevision: probe.candidateRevision!,
          candidate: probe.candidateDigest!,
          verificationResult: "pass",
          receiptCorrelationId: "verifier-receipt-002",
          verifiedAt: 350,
        }],
      },
    }));
    const evidence = await source.load("session-5", contract.missionId);
    expect(evidence.tests).toMatchObject({
      passed: true,
      independent: true,
      evidenceRef: "verifier:veyrict-qualifier-1:verifier-receipt-002",
    });
  });

  it("keeps mission-level operator attestation from substituting for per-criterion independent verification", async () => {
    // End-to-end of the operator path up to the evidence layer: a service-shaped
    // attestation flows through the real merge into the contract, and the
    // session source binds it to the exact candidate revision.
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-7", prompt, 100)!;
    const userPrompt = `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\nverified:\n- criterion-01: interrupted effects remain uncertain until reconciled\n- criterion-02: regression tests cover retry safety`;
    const attestations = parseMissionAttestation("session-7", userPrompt, contract, 200)!;
    const withUser = addMissionAttestations(contract, attestations);
    store.updateSession("session-7", (state) => ({
      ...state,
      mission_contract: withUser,
      verification: { last: { kind: "test", ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
    }));
    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const probe = await source.load("session-7", contract.missionId);
    const merged = mergeServiceAttestations(withUser, [{
      missionId: contract.missionId,
      missionRevision: contract.missionRevision,
      evidenceRevision: probe.candidateRevision!,
      candidate: probe.candidateDigest!,
      result: "pass",
      receiptCorrelationId: "b".repeat(32),
      verifiedAt: 350,
      verifierUid: 0,
    }]);
    expect(merged).not.toBeUndefined();
    store.updateSession("session-7", (state) => ({ ...state, mission_contract: merged! }));
    const evidence = await source.load("session-7", contract.missionId);
    expect(evidence.tests).toMatchObject({
      passed: true,
      independent: true,
      evidenceRef: "verifier:operator-control-service:" + "b".repeat(32),
    });
    expect(await source.isCurrent("session-7", contract.missionId, contract.missionRevision, evidence.evidenceRevision)).toBe(true);
    // A mission-level verifier receipt cannot stand in for a separate
    // independent verdict and graph lineage for each mandatory criterion.
    const closing: DecisionModel = {
      name: "jev-1.14.0",
      evaluate: async () => ({
        model: "jev-1.14.0",
        provider: "typesafe",
        questionHash: hashQuestions({ closure: MISSION_CLOSURE_QUESTION }),
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
    const ledgerDir = tempDir();
    const gate = new MissionClosureGate(
      closing,
      {
        policyVersion: "mission-closure/1",
        minConfidence: 0.8,
        calibrated: true,
        backend: "typesafe",
        model: "jev-1.14.0",
        modelVersion: "jev-1.14.0",
        questionHash: hashQuestions({ closure: MISSION_CLOSURE_QUESTION }),
        calibrationVersion: "operator-attestation-qualification-1",
      },
      source,
      testLedgerForFile(join(ledgerDir, "evidence.log")),
    );
    const result = await gate.close("session-7", contract.missionId);
    expect(result.terminalComplete).toBe(false);
    expect(result.decision.complete).toBe(false);
    expect(result.decision.checks.allCriteriaVerified).toBe(false);
  });

  it("projects supplemental probe receipts without qualifying a mandatory criterion", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const ledger = testLedgerForFile(join(dataDir, "evidence.log"));
    const contract = parseMissionContract("session-supplemental-probe", prompt, 100)!;
    store.updateSession("session-supplemental-probe", (state) => ({ ...state, mission_contract: contract }));
    await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load(
      "session-supplemental-probe", contract.missionId,
    );
    const evidence = await produceHostVerificationInputs({
      store, dataDir, sessionId: "session-supplemental-probe", missionId: contract.missionId,
      ledger, evidenceRoot: dataDir, now: () => 500,
      specs: [{
        criterionId: "criterion-01", producers: [],
        test: {
          kind: "host-command", command: "approved-read-only-probe", exitCode: 0,
          outputDigest: createHash("sha256").update("observed probe output").digest("hex"),
          observedBehavior: "host observed an allow/deny response for the targeted membership case",
        },
      }],
    });
    const snapshot = await createSessionMissionClosureSource({
      store, dataDir, now: () => 600, ledger, enableTrustedGraphEvidence: true,
      criterionSupplementalVerifications: evidence.verifications,
      trustedVerifierIds: ["test-execution"],
    }).load("session-supplemental-probe", contract.missionId);
    const criterion = snapshot.criteria.find(({ id }) => id === "criterion-01");
    expect(criterion?.supplementalVerifications?.[0]).toMatchObject({
      result: "satisfied", verifierId: "test-execution", receiptCorrelationId: evidence.verifications[0]?.receiptCorrelationId,
    });
    expect(criterion?.criterionVerification?.result ?? "unresolved").toBe("unresolved");
    expect(criterion?.verified).toBe(false);
  });

  it("invalidates a bound verifier receipt after the candidate changes", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-6", prompt, 100)!;
    store.updateSession("session-6", (state) => ({
      ...state,
      mission_contract: contract,
      verification: { last: { kind: "test", ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
    }));
    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const probe = await source.load("session-6", contract.missionId);
    store.updateSession("session-6", (state) => ({
      ...state,
      mission_contract: {
        ...contract,
        independentVerifications: [{
          verifierId: "veyrict-qualifier-1",
          missionRevision: contract.missionRevision,
          evidenceRevision: probe.candidateRevision!,
          candidate: probe.candidateDigest!,
          verificationResult: "pass",
          receiptCorrelationId: "verifier-receipt-003",
          verifiedAt: 350,
        }],
      },
    }));
    expect((await source.load("session-6", contract.missionId)).tests.independent).toBe(true);
    // A code change after the verifier PASS moves the candidate: the old
    // receipt must never satisfy completion for the new revision.
    store.updateSession("session-6", (state) => ({
      ...state,
      verification: { last: { kind: "test", ok: true, ts: 300, command: "npm test" }, edits_since: 1 },
    }));
    const stale = await source.load("session-6", contract.missionId);
    expect(stale.tests).toMatchObject({ passed: false, independent: false });
  });

  it("retains a passing test across a later unrelated passing check", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-7", prompt, 100)!;
    store.updateSession("session-7", (state) => ({
      ...state,
      mission_contract: contract,
      verification: {
        last: { kind: "build", ok: true, ts: 310, command: "npm run build" },
        edits_since: 0,
        byKind: {
          test: { kind: "test", ok: true, ts: 300, command: "npm test" },
          build: { kind: "build", ok: true, ts: 310, command: "npm run build" },
        },
        editsSinceByKind: { test: 0, build: 0 },
      },
    }));
    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const evidence = await source.load("session-7", contract.missionId);
    expect(evidence.tests).toMatchObject({ passed: true });
  });

  it("does not hide a failed required test behind a later passing build", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-8", prompt, 100)!;
    store.updateSession("session-8", (state) => ({
      ...state,
      mission_contract: contract,
      verification: {
        last: { kind: "build", ok: true, ts: 310, command: "npm run build" },
        edits_since: 0,
        byKind: {
          test: { kind: "test", ok: false, ts: 300, command: "npm test" },
          build: { kind: "build", ok: true, ts: 310, command: "npm run build" },
        },
        editsSinceByKind: { test: 0, build: 0 },
      },
    }));
    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const evidence = await source.load("session-8", contract.missionId);
    expect(evidence.tests).toMatchObject({ passed: false });
  });

  it("invalidates evidence after a new edit and reports session-scoped interrupted graph effects", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-2", prompt, 100)!;
    const attestation = parseMissionAttestation(
      "session-2",
      `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\nverified:\n- criterion-01: interrupted effects remain uncertain until reconciled`,
      contract,
      200,
    )!;
    store.updateSession("session-2", (state) => ({ ...state, mission_contract: addMissionAttestations(contract, attestation) }));
    expect(store.shouldRetainGraphHistory("session-2")).toBe(true);
    expect(store.shouldRetainGraphHistory("never-created")).toBe(false);
    let removed = false;
    expect(store.withInactiveMissionSession("session-2", () => { removed = true; return true; })).toBe(false);
    expect(removed).toBe(false);
    expect(store.withInactiveMissionSession("never-created", () => true)).toBe(true);
    const graphDir = join(dataDir, "graph-journals");
    mkdirSync(graphDir, { recursive: true, mode: 0o700 });
    const journal = new FileJournal("run-uncertain", graphDir, "session-2");
    journal.record({ type: "run-started", runId: "run-uncertain", ts: "2026-01-01T00:00:00.000Z" });
    journal.record({ type: "node-running", runId: "run-uncertain", nodeId: "write", attemptId: "attempt-1", ts: "2026-01-01T00:00:01.000Z" });

    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const evidence = await source.load("session-2", contract.missionId);
    expect(evidence.operations.uncertain).toBe(1);

    // A long-running mission can still need its old journal. Retention must
    // not make an unresolved operation disappear from the closure snapshot.
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    utimesSync(journal.path, old, old);
    enforceEvidenceRetention({
      dataDir,
      retentionDays: 365,
      maxRecords: 100_000,
      removeGraphJournalIfMissionInactive: (id, remove) => store.withInactiveMissionSession(id, remove),
    });
    expect(await source.load("session-2", contract.missionId)).toMatchObject({
      operations: { uncertain: 1 },
    });

    store.updateSession("session-2", (state) => ({
      ...state,
      verification: { last: { kind: "test", ok: true, ts: 300, command: "npm test" }, edits_since: 1 },
    }));
    expect(await source.isCurrent("session-2", contract.missionId, contract.missionRevision, evidence.evidenceRevision)).toBe(false);

    // A corrupt owner record cannot prove the mission is inactive.
    writeFileSync(join(dataDir, "sessions", "session-2.json"), "{truncated");
    expect(store.shouldRetainGraphHistory("session-2")).toBe(true);
    expect(store.withInactiveMissionSession("session-2", () => true)).toBe(false);
  });

  it("fails closed when the graph journal scan exceeds its file bound", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-3", prompt, 100)!;
    store.updateSession("session-3", (state) => ({ ...state, mission_contract: contract }));
    const graphDir = join(dataDir, "graph-journals");
    mkdirSync(graphDir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < 257; i += 1) {
      writeFileSync(join(graphDir, `jeverb-graph-run-${String(i).padStart(3, "0")}.jsonl`), "", { mode: 0o600 });
    }

    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const evidence = await source.load("session-3", contract.missionId);
    expect(evidence.operations.uncertain).toBe(1);
  });

  it("binds terminal graph outcomes into semantic evidence and invalidates stale snapshots", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-graph-evidence", prompt, 100)!;
    store.updateSession("session-graph-evidence", (state) => ({ ...state, mission_contract: contract }));
    const graphDir = join(dataDir, "graph-journals");
    mkdirSync(graphDir, { recursive: true, mode: 0o700 });
    const journal = new FileJournal("run-complete", graphDir, "session-graph-evidence");
    journal.record({ type: "run-started", runId: "run-complete", ts: "2026-01-01T00:00:00.000Z", graphHash: "a".repeat(64), policyHash: "b".repeat(64) });
    journal.record({ type: "node-authorized", runId: "run-complete", ts: "2026-01-01T00:00:01.000Z", nodeId: "verify-retry-safety", attemptId: "verify/1", allowed: true, inputHash: "c".repeat(64) });
    journal.record({ type: "node-running", runId: "run-complete", ts: "2026-01-01T00:00:02.000Z", nodeId: "verify-retry-safety", attemptId: "verify/1", inputHash: "c".repeat(64) });
    journal.record({ type: "node-terminal", runId: "run-complete", ts: "2026-01-01T00:00:03.000Z", nodeId: "verify-retry-safety", declaredDependencies: [], status: "succeeded", inputHash: "c".repeat(64), outputDigest: "d".repeat(64) });

    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const snapshot = await source.load("session-graph-evidence", contract.missionId);
    expect(snapshot.graphRuns).toEqual([{
      runId: "run-complete",
      graphHash: "a".repeat(64),
      policyHash: "b".repeat(64),
      nodes: [{
        nodeId: "verify-retry-safety",
        status: "succeeded",
        inputHash: "c".repeat(64),
        outputDigest: "d".repeat(64),
        declaredDependencies: [],
        attemptIds: ["verify/1", "verify/1"],
      }],
    }]);
    expect(snapshot.evidenceRevision).toBeTruthy();
    expect(await source.isCurrent("session-graph-evidence", contract.missionId, snapshot.missionRevision, snapshot.evidenceRevision)).toBe(true);

    journal.record({ type: "node-terminal", runId: "run-complete", ts: "2026-01-01T00:00:04.000Z", nodeId: "verify-retry-safety", declaredDependencies: [], status: "failed", inputHash: "c".repeat(64), outputDigest: "e".repeat(64) });
    expect(await source.isCurrent("session-graph-evidence", contract.missionId, snapshot.missionRevision, snapshot.evidenceRevision)).toBe(false);
  });

  it("does not import another session's uncertain graph effects", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-a", prompt, 100)!;
    const foreignContract = parseMissionContract("session-b", prompt, 100)!;
    store.updateSession("session-a", (state) => ({ ...state, mission_contract: contract }));
    store.updateSession("session-b", (state) => ({ ...state, mission_contract: foreignContract }));
    const graphDir = join(dataDir, "graph-journals");
    mkdirSync(graphDir, { recursive: true, mode: 0o700 });

    const owned = new FileJournal("run-owned", graphDir, "session-a");
    owned.record({ type: "run-started", runId: "run-owned", ts: "2026-01-01T00:00:00.000Z", graphHash: "a".repeat(64), policyHash: "b".repeat(64) });
    owned.record({ type: "node-authorized", runId: "run-owned", ts: "2026-01-01T00:00:01.000Z", nodeId: "owned", attemptId: "owned/1", allowed: true, inputHash: "c".repeat(64) });
    owned.record({ type: "node-running", runId: "run-owned", ts: "2026-01-01T00:00:02.000Z", nodeId: "owned", attemptId: "owned/1", inputHash: "c".repeat(64) });
    owned.record({ type: "node-terminal", runId: "run-owned", ts: "2026-01-01T00:00:03.000Z", nodeId: "owned", attemptId: "owned/1", declaredDependencies: [], status: "succeeded", inputHash: "c".repeat(64), outputDigest: "d".repeat(64) });

    const foreign = new FileJournal("run-foreign", graphDir, "session-b");
    foreign.record({ type: "run-started", runId: "run-foreign", ts: "2026-01-01T00:00:00.000Z", graphHash: "e".repeat(64), policyHash: "f".repeat(64) });
    foreign.record({ type: "node-authorized", runId: "run-foreign", ts: "2026-01-01T00:00:01.000Z", nodeId: "foreign", attemptId: "foreign/1", allowed: true, inputHash: "1".repeat(64) });
    foreign.record({ type: "node-running", runId: "run-foreign", ts: "2026-01-01T00:00:02.000Z", nodeId: "foreign", attemptId: "foreign/1", inputHash: "1".repeat(64) });
    foreign.record({ type: "node-terminal", runId: "run-foreign", ts: "2026-01-01T00:00:03.000Z", nodeId: "foreign", attemptId: "foreign/1", status: "outcome_unknown", inputHash: "1".repeat(64) });

    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const evidenceA = await source.load("session-a", contract.missionId);
    const evidenceB = await source.load("session-b", foreignContract.missionId);

    expect(evidenceA.graphRuns?.map((run) => run.runId) ?? []).toEqual(["run-owned"]);
    expect(evidenceA.operations.uncertain).toBe(0);
    expect(evidenceB.graphRuns?.map((run) => run.runId) ?? []).toContain("run-foreign");
    expect(evidenceB.operations.uncertain).toBe(1);
  });

  it("counts an interrupted authorization as pending until execution starts, then uncertain", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-pending-auth", prompt, 100)!;
    store.updateSession("session-pending-auth", (state) => ({ ...state, mission_contract: contract }));
    const graphDir = join(dataDir, "graph-journals");
    mkdirSync(graphDir, { recursive: true, mode: 0o700 });
    const journal = new FileJournal("run-pending", graphDir, "session-pending-auth");
    journal.record({ type: "run-started", runId: "run-pending", ts: "2026-01-01T00:00:00.000Z" });
    journal.record({ type: "node-authorized", runId: "run-pending", ts: "2026-01-01T00:00:01.000Z", nodeId: "write", attemptId: "write/1", allowed: true });
    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });

    const authorized = await source.load("session-pending-auth", contract.missionId);
    expect(authorized.operations).toMatchObject({ pending: 1, uncertain: 0 });

    journal.record({ type: "node-running", runId: "run-pending", ts: "2026-01-01T00:00:02.000Z", nodeId: "write", attemptId: "write/1" });
    const running = await source.load("session-pending-auth", contract.missionId);
    expect(running.operations).toMatchObject({ pending: 0, uncertain: 1 });
  });
});
