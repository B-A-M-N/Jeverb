/**
 * Non-authoritative graph-to-criterion evidence bridge.
 *
 * Pins the execution-vs-satisfaction boundary: bindings resolve to
 * traceability states (bound/missing/mismatched/stale/foreign/conflict/
 * unavailable/unknown) against persisted host-owned journals and receipts,
 * and NEVER verify a criterion. Preflight must stay INCOMPLETE on
 * execution evidence alone (success-without-satisfaction), fail closed on
 * unhealthy bindings, and stay bit-identical when no bindings exist.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileJournal } from "../../src/graph/journal.js";
import { persistGraphNodeReceipt } from "../../src/graph/receipt.js";
import { hashQuestions } from "../../src/decision/provenance.js";
import type { DecisionModel } from "../../src/decision/types.js";
import {
  addMissionAttestations,
  parseMissionAttestation,
  parseMissionContract,
} from "../../src/mission/contract.js";
import {
  affirmativeRequest,
  decideMissionClosure,
  MISSION_CLOSURE_QUESTION,
  preflightMissionClosure,
  preflightReachedReview,
  type MissionClosureEvidence,
  type MissionClosurePolicy,
  type MissionCriterionGraphBinding,
} from "../../src/mission/closure.js";
import { resolveCriterionGraphBindings } from "../../src/mission/graph-binding.js";
import { createSessionMissionClosureSource } from "../../src/mission/session-source.js";
import { testLedger, testStore } from "../helpers/control-state.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "..", "bench", "datasets", "mission-completion-graph-evidence-v1.jsonl");

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jeverb-criterion-graph-binding-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const prompt = `Implement graph recovery.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- Interrupted effects remain uncertain until reconciled.\n- The tests prove retry safety.`;

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

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

function stubModel(choice: "COMPLETE" | "INCOMPLETE", onCall: () => void): DecisionModel {
  return {
    evaluate: async (input: Parameters<DecisionModel["evaluate"]>[0]) => {
      onCall();
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

function writeSucceededJournal(graphDir: string, sessionId: string, runId: string): void {
  mkdirSync(graphDir, { recursive: true, mode: 0o700 });
  const journal = new FileJournal(runId, graphDir, sessionId);
  journal.record({ type: "run-started", runId, ts: "2026-01-01T00:00:00.000Z", graphHash: A, policyHash: B });
  journal.record({ type: "node-authorized", runId, ts: "2026-01-01T00:00:01.000Z", nodeId: "build", attemptId: "build/1", allowed: true, inputHash: C });
  journal.record({ type: "node-running", runId, ts: "2026-01-01T00:00:02.000Z", nodeId: "build", attemptId: "build/1", inputHash: C });
  journal.record({ type: "node-terminal", runId, ts: "2026-01-01T00:00:03.000Z", nodeId: "build", attemptId: "build/1", declaredDependencies: [], status: "succeeded", inputHash: C, outputDigest: D });
}

function writeFailedJournal(graphDir: string, sessionId: string, runId: string): void {
  mkdirSync(graphDir, { recursive: true, mode: 0o700 });
  const journal = new FileJournal(runId, graphDir, sessionId);
  journal.record({ type: "run-started", runId, ts: "2026-01-01T00:00:00.000Z", graphHash: A, policyHash: B });
  journal.record({ type: "node-authorized", runId, ts: "2026-01-01T00:00:01.000Z", nodeId: "build", attemptId: "build/1", allowed: true, inputHash: C });
  journal.record({ type: "node-running", runId, ts: "2026-01-01T00:00:02.000Z", nodeId: "build", attemptId: "build/1", inputHash: C });
  journal.record({ type: "node-terminal", runId, ts: "2026-01-01T00:00:03.000Z", nodeId: "build", attemptId: "build/1", declaredDependencies: [], status: "failed", inputHash: C, outputDigest: D });
}

function bindingFor(runId = "run-1"): MissionCriterionGraphBinding {
  return {
    criterionId: "criterion-01",
    runId,
    nodeId: "build",
    graphHash: A,
    policyHash: B,
    inputHash: C,
    outputDigest: D,
    executionStatus: "succeeded",
  };
}

describe("criterion graph binding fixtures", () => {
  it("resolves every synthetic row to its expected state", () => {
    const lines = readFileSync(fixturePath, "utf8").split("\n").filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const line of lines) {
      const row = JSON.parse(line) as {
        id: string;
        criteria: string[];
        candidateDigest?: string;
        sessionId?: string;
        graphRuns: Parameters<typeof resolveCriterionGraphBindings>[0]["graphRuns"];
        unscopedRunIds?: string[];
        receipts?: Parameters<typeof resolveCriterionGraphBindings>[0]["receipts"];
        ledgerUnavailable?: boolean;
        bindings: MissionCriterionGraphBinding[];
        expected: string[];
      };
      expect(seen.has(row.id), `duplicate fixture row ${row.id}`).toBe(false);
      seen.add(row.id);
      const states = resolveCriterionGraphBindings({
        bindings: row.bindings,
        criteria: row.criteria.map((id) => ({ id })),
        graphRuns: row.graphRuns,
        ...(row.unscopedRunIds === undefined ? {} : { unscopedRunIds: row.unscopedRunIds }),
        ...(row.candidateDigest === undefined ? {} : { candidateDigest: row.candidateDigest }),
        ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
        ...(row.receipts === undefined ? {} : { receipts: row.receipts }),
        ...(row.ledgerUnavailable === undefined ? {} : { ledgerUnavailable: row.ledgerUnavailable }),
      });
      // Frozen v1 receipts predate dependency capture. A formerly bound
      // success (and conflicts that depended on such rows binding) is now
      // unresolved because an empty predecessor list cannot be distinguished
      // from missing journal metadata; labels remain unchanged in the artifact.
      const legacyBindingIndexes = new Set(row.bindings.flatMap((binding, index) => {
        const node = row.graphRuns.find((run) => run.runId === binding.runId)?.nodes.find((entry) => entry.nodeId === binding.nodeId);
        return node !== undefined && !Array.isArray(node.declaredDependencies) ? [index] : [];
      }));
      const expected = row.expected.map((state, index) => {
        if (!legacyBindingIndexes.has(index)) return state;
        const binding = row.bindings[index];
        const node = row.graphRuns.find((run) => run.runId === binding?.runId)?.nodes.find((entry) => entry.nodeId === binding?.nodeId);
        const dependsOnLegacyBinding = state === "bound" || (state === "conflict" && row.bindings.length > 1);
        return dependsOnLegacyBinding && node?.status === "succeeded" ? "unknown" : state;
      });
      expect(states.map((state) => state.state), `row ${row.id}`).toEqual(expected);
    }
    // The fixture must carry both directions: bound rows and rejections.
    const all = lines.map((line) => (JSON.parse(line) as { expected: string[] }).expected).flat();
    expect(all).toContain("bound");
    for (const state of ["missing", "mismatched", "stale", "foreign", "conflict", "unavailable", "unknown"]) {
      expect(all, `fixture lacks ${state}`).toContain(state);
    }
  });
});

describe("criterion graph binding resolver", () => {
  const runs = [{
    runId: "run-1",
    graphHash: A,
    policyHash: B,
    nodes: [{ nodeId: "build", status: "succeeded" as const, inputHash: C, outputDigest: D, declaredDependencies: [] }],
  }];

  it("ignores non-evidence claims stapled to a binding", () => {
    const junk = {
      ...bindingFor(),
      outcome: "the user says this criterion is done",
      lane: "approved",
      observation: "looks complete to me",
    } as unknown as MissionCriterionGraphBinding;
    const [state] = resolveCriterionGraphBindings({
      bindings: [junk],
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs,
      candidateDigest: "c1".repeat(32),
    });
    // Extra claim fields neither verify nor disturb traceability.
    expect(state?.state).toBe("bound");
  });

  it("binds only when every journaled predecessor succeeded", () => {
    const binding = bindingFor();
    const base = {
      bindings: [binding],
      criteria: [{ id: "criterion-01" }],
      graphRuns: [{
        runId: "run-1",
        graphHash: A,
        policyHash: B,
        nodes: [
          { nodeId: "build", status: "succeeded" as const, inputHash: C, outputDigest: D, declaredDependencies: [] },
          { nodeId: "verify", status: "succeeded" as const, inputHash: C, outputDigest: D, declaredDependencies: ["build"] },
        ],
      }],
    };
    const bound = resolveCriterionGraphBindings({ ...base, bindings: [{ ...binding, nodeId: "verify" }] });
    expect(bound[0]).toMatchObject({ state: "bound", dependencies: [{ nodeId: "build", state: "succeeded" }] });

    for (const state of ["failed", "blocked", "skipped", "cancelled", "outcome_unknown"] as const) {
      const rejected = resolveCriterionGraphBindings({
        ...base,
        bindings: [{ ...binding, nodeId: "verify" }],
        graphRuns: [{
          runId: "run-1",
          graphHash: A,
          policyHash: B,
          nodes: [
            { nodeId: "build", status: state, inputHash: C, outputDigest: D, declaredDependencies: [] },
            { nodeId: "verify", status: "succeeded" as const, inputHash: C, outputDigest: D, declaredDependencies: ["build"] },
          ],
        }],
      });
      expect(rejected[0]?.state).not.toBe("bound");
      expect(rejected[0]?.dependencies?.[0]?.state).toBe(state);
    }

    const missing = resolveCriterionGraphBindings({
      ...base,
      bindings: [{ ...binding, nodeId: "verify" }],
      graphRuns: [{ runId: "run-1", graphHash: A, policyHash: B, nodes: [{ nodeId: "verify", status: "succeeded", inputHash: C, outputDigest: D, declaredDependencies: ["build"] }] }],
    });
    expect(missing[0]?.state).toBe("unhealthy");
    expect(missing[0]?.dependencies?.[0]?.state).toBe("missing");
  });

  it("collapses overflow past the binding bound to one bounded row", () => {
    const many = Array.from({ length: 70 }, () => bindingFor());
    const states = resolveCriterionGraphBindings({
      bindings: many,
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs,
    });
    // 64 evaluated plus ONE bounded overflow row — never one row per
    // excess binding, so adversarial input size cannot inflate the bundle.
    expect(states).toHaveLength(65);
    // Identical bindings share one identity, so no conflict; the overflow
    // past the bound is unevaluated, never silently bound.
    expect(states[0]?.state).toBe("bound");
    const tail = states[states.length - 1];
    expect(tail?.state).toBe("unavailable");
    expect(tail?.criterionId).toBe("");
    expect(tail?.runId).toBe("");
    expect(tail?.nodeId).toBe("");
    expect(tail?.detail).toContain("6 bindings beyond the bound of 64");
  });

  it("never resolves a non-success node healthy, however exact the match", () => {
    for (const status of ["failed", "skipped", "blocked", "cancelled"] as const) {
      const terminal = [{
        runId: "run-1",
        graphHash: A,
        policyHash: B,
        nodes: [{ nodeId: "build", status, inputHash: C, outputDigest: D, declaredDependencies: [] }],
      }] as Parameters<typeof resolveCriterionGraphBindings>[0]["graphRuns"];
      // A fully matching binding — every hash and even the claimed status
      // agrees with the journal — still resolves unhealthy, never bound.
      const [exact] = resolveCriterionGraphBindings({
        bindings: [{ ...bindingFor(), executionStatus: status }],
        criteria: [{ id: "criterion-01" }],
        graphRuns: terminal,
        candidateDigest: "c1".repeat(32),
      });
      expect(exact?.state, `journaled ${status} with matching claim`).toBe("unhealthy");
      // And without any claimed status at all.
      const [bare] = resolveCriterionGraphBindings({
        bindings: [bindingFor()],
        criteria: [{ id: "criterion-01" }],
        graphRuns: terminal,
        candidateDigest: "c1".repeat(32),
      });
      expect(bare?.state, `journaled ${status} without claim`).toBe("unhealthy");
    }
    // The succeeded control still binds.
    const [healthy] = resolveCriterionGraphBindings({
      bindings: [bindingFor()],
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs,
      candidateDigest: "c1".repeat(32),
    });
    expect(healthy?.state).toBe("bound");
  });

  it("keeps interrupted, pending-claimed, and superseded bindings out of bound", () => {
    const interrupted = [{
      runId: "run-1",
      graphHash: A,
      policyHash: B,
      nodes: [{ nodeId: "build", status: "outcome_unknown" as const, inputHash: C, outputDigest: D, declaredDependencies: [] }],
    }];
    const [unknown] = resolveCriterionGraphBindings({
      bindings: [bindingFor()],
      criteria: [{ id: "criterion-01" }],
      graphRuns: interrupted,
    });
    expect(unknown?.state).toBe("unknown");

    // A binding that claims a pending authorization never infers success.
    const [pending] = resolveCriterionGraphBindings({
      bindings: [{ ...bindingFor(), executionStatus: "pending" as const }],
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs,
    });
    expect(pending?.state).toBe("unknown");

    // An explicitly superseded binding (input hash rotated by a repair or
    // edit) mismatches instead of tracing the stale row.
    const [superseded] = resolveCriterionGraphBindings({
      bindings: [{ ...bindingFor(), inputHash: "e".repeat(64) }],
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs,
    });
    expect(superseded?.state).toBe("mismatched");
  });

  it("rejects receipt-bearing bindings without a trusted host session id", () => {
    const correlationId = "1".repeat(64);
    const receipt = {
      schema: 1,
      id: "rcpt-session-identity",
      ts: "2026-01-01T00:00:00.000Z",
      sessionId: "session-host",
      event: "GraphNodeTerminal",
      subjectHash: "ab12cd34ab12cd34ab12cd34ab12cd34",
      policyVersion: "graph-execution/1",
      deterministicFindings: ["node_status=succeeded"],
      enforcement: "execution_succeeded",
      reasons: ["terminal graph status recorded; output text excluded"],
      latencyMs: 0,
      correlationId,
      outcome: "execution-observed",
      outputDigest: D,
    };
    const binding: MissionCriterionGraphBinding = { ...bindingFor(), receiptCorrelationId: correlationId };
    const base = {
      bindings: [binding],
      criteria: [{ id: "criterion-01" }],
      graphRuns: runs,
      receipts: [receipt],
      ledgerUnavailable: false,
    } as Parameters<typeof resolveCriterionGraphBindings>[0];
    // No trusted session id: fail closed, even though the receipt is
    // otherwise valid. Never correlate receipts anonymously.
    const [anonymous] = resolveCriterionGraphBindings(base);
    expect(anonymous?.state).toBe("unavailable");
    // The legitimate host always supplies its session id (session-source
    // does), so the same receipt then correlates.
    const [scoped] = resolveCriterionGraphBindings({ ...base, sessionId: "session-host" });
    expect(scoped?.state).toBe("bound");
    // The mcp-run:<runId> scope stays valid when explicitly scoped.
    const [mcp] = resolveCriterionGraphBindings({
      ...base,
      sessionId: "session-host",
      receipts: [{ ...receipt, sessionId: "mcp-run:run-1" }],
    });
    expect(mcp?.state).toBe("bound");
  });

  it("projects graph runs to an allowlisted shape at the affirmative boundary", () => {
    const evidence = {
      missionId: "mission-projection",
      objective: "projection probe",
      missionRevision: "rev-1",
      evidenceRevision: "ev-1",
      criteria: [],
      tests: { passed: false, independent: false, revision: "ev-1" },
      operations: { pending: 0, uncertain: 0 },
      blockers: [],
      graphRuns: [{
        runId: "run-1",
        graphHash: A,
        policyHash: B,
        nodes: [{
          nodeId: "build",
          status: "succeeded",
          inputHash: C,
          outputDigest: D,
          declaredDependencies: [],
          output: "future output text must never reach the judge",
          metadata: { attempt: 3 },
        }],
      }],
    } as unknown as MissionClosureEvidence;
    const { state } = affirmativeRequest(evidence);
    // Extra node fields are dropped; the allowlisted shape survives.
    expect(state.graphRuns).toEqual([{
      runId: "run-1",
      graphHash: A,
      policyHash: B,
      nodes: [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D, declaredDependencies: [] }],
    }]);
    // And the wire shape is identical today for already-clean evidence.
    const cleanRuns = [{
      runId: "run-1",
      graphHash: A,
      policyHash: B,
      nodes: [{ nodeId: "build", status: "succeeded", inputHash: C, outputDigest: D, declaredDependencies: [] }],
    }];
    const clean = { ...evidence, graphRuns: cleanRuns };
    expect(affirmativeRequest(clean as unknown as MissionClosureEvidence).state.graphRuns)
      .toEqual(JSON.parse(JSON.stringify(cleanRuns)));
  });
});

describe("criterion graph evidence in the session snapshot", () => {
  it("is bit-identical by default: no bindings, no graphEvidence, no new uncertainty", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-default", prompt, 100)!;
    store.updateSession("session-default", (state) => ({ ...state, mission_contract: contract }));
    writeSucceededJournal(join(dataDir, "graph-journals"), "session-default", "run-1");

    const source = createSessionMissionClosureSource({ store, dataDir, now: () => 400 });
    const first = await source.load("session-default", contract.missionId);
    const second = await source.load("session-default", contract.missionId);
    expect(first).toEqual(second);
    for (const criterion of first.criteria) {
      expect("graphEvidence" in criterion).toBe(false);
    }
    expect(first.operations).toEqual({ pending: 0, uncertain: 0 });
  });

  it("valid binding resolves bound yet preflight stays INCOMPLETE without attestation", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-bound", prompt, 100)!;
    store.updateSession("session-bound", (state) => ({ ...state, mission_contract: contract }));
    writeSucceededJournal(join(dataDir, "graph-journals"), "session-bound", "run-1");

    const source = createSessionMissionClosureSource({
      store,
      dataDir,
      now: () => 400,
      criterionGraphBindings: [bindingFor()],
    });
    const evidence = await source.load("session-bound", contract.missionId);
    expect(evidence.criteria[0]?.graphEvidence).toEqual([{
      criterionId: "criterion-01",
      runId: "run-1",
      nodeId: "build",
      dependencies: [],
      state: "bound",
      detail: expect.any(String),
    }]);
    // Success without satisfaction: the node ran, nothing is verified.
    expect(evidence.criteria.every((criterion) => criterion.verified === false)).toBe(true);
    const preflight = preflightMissionClosure(evidence, policy);
    expect(preflight.complete).toBe(false);
    expect(preflight.status).toBe("INCOMPLETE");

    // The semantic judge is never even consulted: preflight blocks first.
    let called = false;
    const result = await decideMissionClosure(stubModel("COMPLETE", () => { called = true; }), evidence, policy);
    expect(called).toBe(false);
    expect(result.status).toBe("INCOMPLETE");
  });

  it("succeeded nodes, receipts, and outcome strings never verify on their own", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-exec", prompt, 100)!;
    store.updateSession("session-exec", (state) => ({ ...state, mission_contract: contract }));
    writeSucceededJournal(join(dataDir, "graph-journals"), "session-exec", "run-1");

    const ledger = testLedger(dataDir);
    const receipt = persistGraphNodeReceipt({
      ledger,
      runId: "run-1",
      graphHash: A,
      policyHash: B,
      result: {
        nodeId: "build",
        ok: true,
        output: "done",
        attempts: 1,
        status: "succeeded",
        inputHash: C,
        outputHash: D,
        outputDigest: D,
      },
      museSessionId: "session-exec",
    });
    expect(receipt.status).toBe("appended");
    const correlationId = receipt.status === "appended" || receipt.status === "duplicate" ? receipt.correlationId : "";

    const source = createSessionMissionClosureSource({
      store,
      dataDir,
      now: () => 400,
      criterionGraphBindings: [{ ...bindingFor(), ...(correlationId === "" ? {} : { receiptCorrelationId: correlationId }) }],
      ledger,
    });
    const evidence = await source.load("session-exec", contract.missionId);
    expect(evidence.criteria[0]?.graphEvidence?.[0]?.state).toBe("bound");
    // Execution-observed rows trace; they do not satisfy.
    expect(evidence.criteria[0]?.verified).toBe(false);
    expect(preflightMissionClosure(evidence, policy).complete).toBe(false);
  });

  it("keeps graph traceability from substituting for independent per-criterion verification", async () => {
    const setup = async (sessionId: string, bindings: MissionCriterionGraphBinding[], allowGraphPromotion = false) => {
      const dataDir = tempDir();
      const store = testStore(dataDir);
      const contract = parseMissionContract(sessionId, prompt, 100)!;
      store.updateSession(sessionId, (state) => ({ ...state, mission_contract: contract }));
      writeSucceededJournal(join(dataDir, "graph-journals"), sessionId, "run-1");
      // The test-verification record feeds the candidate digest, so it must
      // land before the probe the verifier attestation binds to.
      // Attestations rotate the evidence revision, not the candidate.
      store.updateSession(sessionId, (state) => ({
        ...state,
        verification: { last: { kind: "test" as const, ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
      }));
      const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 })
        .load(sessionId, contract.missionId);
      const userPrompt =
        `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\nverified:\n` +
        `- criterion-01: interrupted effects remain uncertain until reconciled\n` +
        `- criterion-02: regression tests cover retry safety`;
      const attestations = parseMissionAttestation(sessionId, userPrompt, contract, 200)!;
      store.updateSession(sessionId, (state) => ({
        ...state,
        mission_contract: {
          ...addMissionAttestations(contract, attestations),
          independentVerifications: [{
            verifierId: "veyrict-qualifier-1",
            missionRevision: contract.missionRevision,
            evidenceRevision: probe.candidateRevision!,
            candidate: probe.candidateDigest!,
            verificationResult: "pass" as const,
            receiptCorrelationId: "verifier-receipt-002",
            verifiedAt: 350,
          }],
        },
      }));
      const source = createSessionMissionClosureSource({
        store, dataDir, now: () => 400, criterionGraphBindings: bindings, allowGraphPromotion,
      });
      return source.load(sessionId, contract.missionId);
    };

    const healthy = await setup("session-failclose-ok", [bindingFor()]);
    expect(healthy.operations.uncertain).toBe(0);
    expect(preflightReachedReview(preflightMissionClosure(healthy, policy))).toBe(false);
    expect(preflightMissionClosure(healthy, policy).checks.allCriteriaVerified).toBe(false);

    const repaired: MissionCriterionGraphBinding = { ...bindingFor(), inputHash: "e".repeat(64) };
    for (const allowGraphPromotion of [false, true]) {
      const evidence = await setup(`session-failclose-bad-${allowGraphPromotion}`, [repaired], allowGraphPromotion);
      expect(evidence.criteria[0]?.graphEvidence?.[0]?.state).toBe("mismatched");
      expect(evidence.operations.uncertain).toBeGreaterThanOrEqual(1);
      const preflight = preflightMissionClosure(evidence, policy);
      expect(preflight.complete).toBe(false);
      expect(preflight.status).toBe("INCOMPLETE");
      expect(preflight.reasons).toContain("acceptance criteria, tests, or independent verification are not all satisfied");
    }
  });

  it("a correctly bound failed node can never leave operations.uncertain at zero", async () => {
    for (const allowGraphPromotion of [false, true]) {
      const dataDir = tempDir();
      const store = testStore(dataDir);
      const sessionId = `session-failed-bound-${allowGraphPromotion}`;
      const contract = parseMissionContract(sessionId, prompt, 100)!;
      store.updateSession(sessionId, (state) => ({ ...state, mission_contract: contract }));
      writeFailedJournal(join(dataDir, "graph-journals"), sessionId, "run-1");

      // Every hash matches the journaled failed node, and the claimed
      // status agrees with it: still unhealthy, never bound.
      const source = createSessionMissionClosureSource({
        store, dataDir, now: () => 400,
        criterionGraphBindings: [{ ...bindingFor(), executionStatus: "failed" }],
        allowGraphPromotion,
      });
      const evidence = await source.load(sessionId, contract.missionId);
      expect(evidence.criteria[0]?.graphEvidence).toEqual([{
        criterionId: "criterion-01",
        runId: "run-1",
        nodeId: "build",
        state: "unhealthy",
        detail: expect.any(String),
      }]);
      expect(evidence.criteria.every((criterion) => criterion.verified === false)).toBe(true);
      expect(evidence.operations.uncertain).toBeGreaterThanOrEqual(1);
      const preflight = preflightMissionClosure(evidence, policy);
      expect(preflight.complete).toBe(false);
      expect(preflight.status).toBe("INCOMPLETE");
    }
  });

  it("marks bindings stale after the evidence revision moves on", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-stale", prompt, 100)!;
    store.updateSession("session-stale", (state) => ({ ...state, mission_contract: contract }));
    writeSucceededJournal(join(dataDir, "graph-journals"), "session-stale", "run-1");

    const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 })
      .load("session-stale", contract.missionId);
    const staleBinding: MissionCriterionGraphBinding = { ...bindingFor(), candidateDigest: probe.candidateDigest! };
    // A later test-verification record rotates the candidate: the earlier
    // binding names a superseded candidate even though the journal matches.
    store.updateSession("session-stale", (state) => ({
      ...state,
      verification: { last: { kind: "test" as const, ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
    }));

    const source = createSessionMissionClosureSource({
      store, dataDir, now: () => 400, criterionGraphBindings: [staleBinding],
    });
    const evidence = await source.load("session-stale", contract.missionId);
    expect(evidence.evidenceRevision).not.toBe(probe.evidenceRevision);
    expect(evidence.criteria[0]?.graphEvidence?.[0]?.state).toBe("stale");
    expect(evidence.operations.uncertain).toBeGreaterThanOrEqual(1);
    expect(preflightMissionClosure(evidence, policy).complete).toBe(false);
  });

  it("ignores foreign-session journals and repairs that change the input hash", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-mine", prompt, 100)!;
    const foreignContract = parseMissionContract("session-theirs", prompt, 100)!;
    store.updateSession("session-mine", (state) => ({ ...state, mission_contract: contract }));
    store.updateSession("session-theirs", (state) => ({ ...state, mission_contract: foreignContract }));
    const graphDir = join(dataDir, "graph-journals");
    writeSucceededJournal(graphDir, "session-theirs", "run-foreign");

    const source = createSessionMissionClosureSource({
      store, dataDir, now: () => 400, criterionGraphBindings: [bindingFor("run-foreign")],
    });
    const evidence = await source.load("session-mine", contract.missionId);
    expect(evidence.graphRuns ?? []).toEqual([]);
    expect(evidence.criteria[0]?.graphEvidence?.[0]?.state).toBe("foreign");
    expect(evidence.operations.uncertain).toBeGreaterThanOrEqual(1);

    // A repair that re-executes the node supersedes the prior binding: the
    // old input hash no longer matches, so the binding mismatches.
    writeSucceededJournal(graphDir, "session-mine", "run-1");
    const journal = new FileJournal("run-1", graphDir, "session-mine");
    journal.record({ type: "node-terminal", runId: "run-1", ts: "2026-01-01T00:00:04.000Z", nodeId: "build", declaredDependencies: [], status: "succeeded", inputHash: "e".repeat(64), outputDigest: "f".repeat(64) });
    const repaired = await createSessionMissionClosureSource({
      store, dataDir, now: () => 400, criterionGraphBindings: [bindingFor("run-1")],
    }).load("session-mine", contract.missionId);
    expect(repaired.criteria[0]?.graphEvidence?.[0]?.state).toBe("mismatched");
  });

  it("blocks on interrupted outcome_unknown and pending references", async () => {
    const dataDir = tempDir();
    const store = testStore(dataDir);
    const contract = parseMissionContract("session-interrupted", prompt, 100)!;
    store.updateSession("session-interrupted", (state) => ({ ...state, mission_contract: contract }));
    const graphDir = join(dataDir, "graph-journals");
    mkdirSync(graphDir, { recursive: true, mode: 0o700 });
    const journal = new FileJournal("run-1", graphDir, "session-interrupted");
    journal.record({ type: "run-started", runId: "run-1", ts: "2026-01-01T00:00:00.000Z", graphHash: A, policyHash: B });
    journal.record({ type: "node-authorized", runId: "run-1", ts: "2026-01-01T00:00:01.000Z", nodeId: "build", attemptId: "build/1", allowed: true, inputHash: C });
    journal.record({ type: "node-running", runId: "run-1", ts: "2026-01-01T00:00:02.000Z", nodeId: "build", attemptId: "build/1", inputHash: C });

    const source = createSessionMissionClosureSource({
      store, dataDir, now: () => 400, criterionGraphBindings: [bindingFor()],
    });
    const evidence = await source.load("session-interrupted", contract.missionId);
    expect(evidence.criteria[0]?.graphEvidence?.[0]?.state).toBe("unknown");
    expect(evidence.operations.uncertain).toBeGreaterThanOrEqual(2);
    expect(preflightMissionClosure(evidence, policy).complete).toBe(false);

    // An authorized-but-never-started node is pending, not evidence: the
    // binding names a node with no terminal record.
    const pendingContract = parseMissionContract("session-pending", prompt, 100)!;
    store.updateSession("session-pending", (state) => ({ ...state, mission_contract: pendingContract }));
    const pendingJournal = new FileJournal("run-pending", graphDir, "session-pending");
    pendingJournal.record({ type: "run-started", runId: "run-pending", ts: "2026-01-01T00:00:00.000Z", graphHash: A, policyHash: B });
    pendingJournal.record({ type: "node-authorized", runId: "run-pending", ts: "2026-01-01T00:00:01.000Z", nodeId: "build", attemptId: "build/1", allowed: true, inputHash: C });
    const pendingSource = createSessionMissionClosureSource({
      store, dataDir, now: () => 400, criterionGraphBindings: [{ ...bindingFor(), runId: "run-pending" }],
    });
    const pendingEvidence = await pendingSource.load("session-pending", pendingContract.missionId);
    expect(pendingEvidence.criteria[0]?.graphEvidence?.[0]?.state).toBe("missing");
    expect(pendingEvidence.operations.pending).toBeGreaterThanOrEqual(1);
    expect(preflightMissionClosure(pendingEvidence, policy).complete).toBe(false);
  });
});
