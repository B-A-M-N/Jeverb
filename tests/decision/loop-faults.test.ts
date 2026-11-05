/**
 * Fault-injection outcome replay through the host-owned control loop.
 * Each scenario drives `directMissionControl` — the real decision path,
 * not an isolated controller unit — with hostile or degraded inputs and
 * asserts the system-level disposition: never COMPLETE without current
 * proof, never a repeated correction, never an exception.
 */
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import type { VerificationLedger } from "../../src/hooks/verification.js";
import { persistMissionClosureReceipt } from "../../src/mission/receipt.js";
import type {
  MissionClosureEvidence,
  MissionClosureEvidenceSource,
} from "../../src/mission/closure.js";
import { setTestSwitch, testLedgerForFile } from "../helpers/control-state.js";
import {
  directMissionControl,
  type MissionControlOptions,
} from "../../src/decision/loop.js";

const MISSION = "mission-faults";
const MISSION_REV = "mission-rev-1";
const EVIDENCE_REV = "evidence-rev-1";
const CANDIDATE_A = "candidate-a";
const CANDIDATE_B = "candidate-b";

function evidence(overrides: Partial<MissionClosureEvidence> = {}): MissionClosureEvidence {
  return {
    missionId: MISSION,
    objective: "Ship the requested fix",
    missionRevision: MISSION_REV,
    evidenceRevision: EVIDENCE_REV,
    candidateDigest: CANDIDATE_A,
    candidateRevision: "candidate-rev-1",
    criteria: [{
      id: "fix",
      statement: "The bug is fixed",
      verified: true,
      outcome: "passing test",
      evidenceRef: "verifier:test:300",
      missionRevision: MISSION_REV,
      evidenceRevision: EVIDENCE_REV,
    }],
    tests: { passed: true, independent: true, evidenceRef: "verifier:test:300", revision: EVIDENCE_REV },
    operations: { pending: 0, uncertain: 0 },
    blockers: [],
    ...overrides,
  };
}

function verification(editsSince = 0, ok = true): VerificationLedger {
  return {
    last: { kind: "test", ok, ts: 300, command: "npm test" },
    edits_since: editsSince,
    byKind: { test: { kind: "test", ok, ts: 300, command: "npm test" } },
    editsSinceByKind: { test: editsSince },
  };
}

function ledger(): EvidenceLedger {
  return testLedgerForFile(join(mkdtempSync(join(tmpdir(), "jev-faults-")), "evidence.log"));
}

function source(current: MissionClosureEvidence): MissionClosureEvidenceSource {
  return { load: async () => current, isCurrent: async () => true };
}

function step(led: EvidenceLedger, current: MissionClosureEvidence, extra: Partial<MissionControlOptions> = {}): MissionControlOptions {
  return {
    ledger: led,
    sessionId: "session-1",
    source: source(current),
    missionId: MISSION,
    verification: verification(),
    ...extra,
  };
}

describe("control loop fault injection", () => {
  it("a verifier pass on candidate A never completes candidate B after edits", async () => {
    const led = ledger();
    const moved = evidence({
      candidateDigest: CANDIDATE_B,
      candidateRevision: "candidate-rev-2",
      tests: { passed: false, independent: false, revision: "evidence-rev-0" },
    });
    // The agent edited the code (new candidate) without re-running tests.
    const result = await directMissionControl(step(led, moved, { verification: verification(2) }));
    expect(result.decision.complete).toBe(false);
    expect(result.decision.action).toBe("VERIFY");
    expect(result.decision.correction?.baseEvidenceRevision).toBe(EVIDENCE_REV);
  });

  it("a durable receipt for candidate A does not authorize candidate B", async () => {
    const led = ledger();
    const forA = evidence();
    const receiptPersisted = persistMissionClosureReceipt(led, "session-1", {
      status: "COMPLETE",
      complete: true,
      missionId: MISSION,
      missionRevision: MISSION_REV,
      evidenceRevision: EVIDENCE_REV,
      candidateDigest: CANDIDATE_A,
      policyVersion: "policy/1",
      checks: {
        objectivePresent: true, objectiveCoverageEstablished: true, revisionsMatch: true, criteriaPresent: true,
        allCriteriaVerified: true, testsPassed: true, independentVerificationPassed: true,
        noPendingOperations: true, noUncertainOperations: true, noUnresolvedBlockers: true,
        calibrationBound: true,
      },
      reasons: ["verified"],
      model: "jev-test", modelVersion: "jev-test", provider: "typesafe",
      questionHash: "0".repeat(64), calibrationVersion: "cal/1", confidence: 0.9,
      probabilities: { COMPLETE: 0.9, INCOMPLETE: 0.05, BLOCKED: 0.03, INSUFFICIENT_EVIDENCE: 0.02 },
      confidenceIsProof: false,
    });
    expect(receiptPersisted.status).toBe("appended");
    const moved = evidence({
      evidenceRevision: "evidence-rev-2",
      candidateDigest: CANDIDATE_B,
      candidateRevision: "candidate-rev-2",
      criteria: [{
        id: "fix", statement: "The bug is fixed", verified: false,
        missionRevision: MISSION_REV, evidenceRevision: "evidence-rev-2",
      }],
      tests: { passed: false, independent: false, revision: "evidence-rev-0" },
    });
    const result = await directMissionControl(step(led, moved, { verification: verification(1) }));
    expect(result.decision.action).not.toBe("COMPLETE");
    expect(result.decision.complete).toBe(false);
  });

  it("a transient failure retries once, then stalls instead of looping forever", async () => {
    const led = ledger();
    const incomplete = evidence({
      criteria: [{
        id: "fix", statement: "The bug is fixed", verified: false,
        missionRevision: MISSION_REV, evidenceRevision: EVIDENCE_REV,
      }],
      tests: { passed: false, independent: false, revision: "evidence-rev-0" },
    });
    const first = await directMissionControl(step(led, incomplete, { transientFailure: true, attempts: 0 }));
    expect(first.decision.action).toBe("RETRY");
    const second = await directMissionControl(step(led, incomplete, { transientFailure: true, attempts: 0 }));
    expect(second.decision.action).toBe("INSUFFICIENT_EVIDENCE");
    expect(second.decision.complete).toBe(false);
  });

  it("repeated transient failures at the cap change approach", async () => {
    const led = ledger();
    const incomplete = evidence({
      criteria: [{
        id: "fix", statement: "The bug is fixed", verified: false,
        missionRevision: MISSION_REV, evidenceRevision: EVIDENCE_REV,
      }],
      tests: { passed: false, independent: false, revision: "evidence-rev-0" },
    });
    const result = await directMissionControl(step(led, incomplete, { transientFailure: true, attempts: 3 }));
    expect(result.decision.action).toBe("CHANGE_APPROACH");
  });

  it("an authorization blocker is BLOCKED with operator action even when the last failure looks transient", async () => {
    const led = ledger();
    const blocked = evidence({
      blockers: [{ id: "credentials", unresolved: true }],
    });
    const result = await directMissionControl(step(led, blocked, { transientFailure: true, attempts: 0 }));
    expect(result.decision.action).toBe("BLOCKED");
    expect(result.decision.complete).toBe(false);
    expect(result.decision.correction?.action).toBe("REQUEST_INPUT");
    expect(result.decision.correction?.requiredOutcome).toContain("operator");
  });

  it("a confident done hint never completes an unverified criterion", async () => {
    const led = ledger();
    const incomplete = evidence({
      criteria: [{
        id: "fix", statement: "The bug is fixed", verified: false,
        missionRevision: MISSION_REV, evidenceRevision: EVIDENCE_REV,
      }],
    });
    const result = await directMissionControl(step(led, incomplete, {
      modelHint: { suggestion: "done", confident: true },
    }));
    expect(result.decision.action).not.toBe("COMPLETE");
    expect(result.decision.correction?.criterionId).toBe("fix");
  });

  it("a confident done hint does not disturb a genuinely complete mission", async () => {
    const led = ledger();
    const result = await directMissionControl(step(led, evidence(), {
      modelHint: { suggestion: "done", confident: true },
    }));
    expect(result.decision.action).toBe("READY_FOR_CLOSURE");
    // Ready-for-closure, not terminal: only the receipt-bound shortcut stops the loop.
    expect(result.decision.complete).toBe(false);
  });

  it("evidence source failure is a typed unavailable disposition, never an exception", async () => {
    const led = ledger();
    const failing: MissionClosureEvidenceSource = {
      load: async () => { throw new Error("model unavailable mid-closure"); },
      isCurrent: async () => false,
    };
    const result = await directMissionControl({
      ledger: led,
      sessionId: "session-1",
      source: failing,
      missionId: MISSION,
      verification: verification(),
    });
    expect(result.decision.action).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.decision.complete).toBe(false);
    expect(result.persisted).toBe("unavailable");
    expect(led.read().records.filter((r) => r.event === "ControlAction")).toHaveLength(0);
  });

  it("stale evidence after loading authorizes nothing and records nothing", async () => {
    const led = ledger();
    const stale: MissionClosureEvidenceSource = {
      load: async () => evidence(),
      isCurrent: async () => false,
    };
    const result = await directMissionControl({
      ledger: led,
      sessionId: "session-1",
      source: stale,
      missionId: MISSION,
      verification: verification(),
    });
    expect(result.decision.action).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.decision.complete).toBe(false);
    expect(result.persisted).toBe("unavailable");
    expect(led.read().records).toHaveLength(0);
  });

  it("a corrupt ledger authorizes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-corrupt-"));
    writeFileSync(join(dir, "evidence.log"), "this is not a receipt\n");
    const led = testLedgerForFile(join(dir, "evidence.log"));
    expect(led.read().corrupt).toBeDefined();
    const result = await directMissionControl({
      ledger: led,
      sessionId: "session-1",
      source: source(evidence()),
      missionId: MISSION,
      verification: verification(),
    });
    expect(result.decision.action).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.decision.complete).toBe(false);
    expect(result.persisted).toBe("unavailable");
  });

  it("a failed write downgrades the decision instead of authorizing unrecorded work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-off-"));
    // The install-wide OFF control state suppresses receipt writes; reads
    // still work. (A bare marker file no longer suppresses anything.)
    setTestSwitch(dir, "OFF");
    const led = testLedgerForFile(join(dir, "evidence.log"));
    const result = await directMissionControl({
      ledger: led,
      sessionId: "session-1",
      source: source(evidence()),
      missionId: MISSION,
      verification: verification(),
    });
    expect(result.decision.action).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.decision.complete).toBe(false);
    expect(result.persisted).toBe("unavailable");
    expect(result.decision.reasons.join(" ")).toContain("no action is authorized without a durable record");
  });

  it("a persisted terminal receipt survives loop restart and dominates redispatch", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "jev-restart-")), "evidence.log");
    const first = testLedgerForFile(path);
    const current = evidence();
    const middle = await directMissionControl({
      ledger: first, sessionId: "session-1", source: source(current),
      missionId: MISSION, verification: verification(),
    });
    expect(middle.decision.action).toBe("READY_FOR_CLOSURE");
    // Ready-for-closure only: the durable gate receipt below is what
    // authorises terminal state after the restart.
    expect(middle.decision.complete).toBe(false);
    const receiptPersisted = persistMissionClosureReceipt(first, "session-1", {
      status: "COMPLETE",
      complete: true,
      missionId: MISSION,
      missionRevision: MISSION_REV,
      evidenceRevision: EVIDENCE_REV,
      candidateDigest: CANDIDATE_A,
      policyVersion: "policy/1",
      checks: {
        objectivePresent: true, objectiveCoverageEstablished: true, revisionsMatch: true, criteriaPresent: true,
        allCriteriaVerified: true, testsPassed: true, independentVerificationPassed: true,
        noPendingOperations: true, noUncertainOperations: true, noUnresolvedBlockers: true,
        calibrationBound: true,
      },
      reasons: ["verified"],
      model: "jev-test", modelVersion: "jev-test", provider: "typesafe",
      questionHash: "0".repeat(64), calibrationVersion: "cal/1", confidence: 0.9,
      probabilities: { COMPLETE: 0.9, INCOMPLETE: 0.05, BLOCKED: 0.03, INSUFFICIENT_EVIDENCE: 0.02 },
      confidenceIsProof: false,
    });
    expect(receiptPersisted.status).toBe("appended");
    // Host restarts: a fresh ledger handle over the same file must still
    // honor the terminal receipt instead of authorizing new work.
    const restarted = testLedgerForFile(path);
    const after = await directMissionControl({
      ledger: restarted, sessionId: "session-1", source: source(current),
      missionId: MISSION, verification: verification(),
    });
    expect(after.decision.action).toBe("COMPLETE");
    expect(after.decision.complete).toBe(true);
    expect(after.decision.correction).toBeUndefined();
  });
});
