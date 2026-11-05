import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import type { VerificationLedger } from "../../src/hooks/verification.js";
import { persistMissionClosureReceipt } from "../../src/mission/receipt.js";
import type {
  MissionClosureDecision,
  MissionClosureEvidence,
  MissionClosureEvidenceSource,
} from "../../src/mission/closure.js";
import { testLedgerForFile } from "../helpers/control-state.js";
import {
  directMissionControl,
  findPriorControlActions,
  findTerminalCompletionReceipt,
  type MissionControlOptions,
} from "../../src/decision/loop.js";

const MISSION = "mission-loop";
const MISSION_REV = "mission-rev-3";
const EVIDENCE_REV = "evidence-rev-9";
const CANDIDATE = "candidate-digest-9";

function evidence(overrides: Partial<MissionClosureEvidence> = {}): MissionClosureEvidence {
  return {
    missionId: MISSION,
    objective: "Ship the requested fix",
    missionRevision: MISSION_REV,
    evidenceRevision: EVIDENCE_REV,
    candidateDigest: CANDIDATE,
    candidateRevision: "candidate-rev-9",
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

function verification(): VerificationLedger {
  return {
    last: { kind: "test", ok: true, ts: 300, command: "npm test" },
    edits_since: 0,
    byKind: { test: { kind: "test", ok: true, ts: 300, command: "npm test" } },
    editsSinceByKind: { test: 0 },
  };
}

function source(current: MissionClosureEvidence): MissionClosureEvidenceSource {
  return {
    load: async () => current,
    isCurrent: async () => true,
  };
}

function ledger(): EvidenceLedger {
  return testLedgerForFile(join(mkdtempSync(join(tmpdir(), "jev-loop-")), "evidence.log"));
}

function completeDecision(current: MissionClosureEvidence): MissionClosureDecision {
  return {
    status: "COMPLETE",
    complete: true,
    missionId: current.missionId,
    missionRevision: current.missionRevision,
    evidenceRevision: current.evidenceRevision,
    ...(current.candidateDigest === undefined ? {} : { candidateDigest: current.candidateDigest }),
    policyVersion: "policy/1",
    checks: {
      objectivePresent: true,
      objectiveCoverageEstablished: true,
      revisionsMatch: true,
      criteriaPresent: true,
      allCriteriaVerified: true,
      testsPassed: true,
      independentVerificationPassed: true,
      noPendingOperations: true,
      noUncertainOperations: true,
      noUnresolvedBlockers: true,
      calibrationBound: true,
    },
    reasons: ["verified"],
    model: "jev-test",
    modelVersion: "jev-test",
    provider: "typesafe",
    questionHash: "0".repeat(64),
    calibrationVersion: "cal/1",
    confidence: 0.9,
    probabilities: { COMPLETE: 0.9, INCOMPLETE: 0.05, BLOCKED: 0.03, INSUFFICIENT_EVIDENCE: 0.02 },
    confidenceIsProof: false,
  };
}

describe("host-owned mission control loop", () => {
  it("issues a correction for incomplete evidence and persists it with the targeted revision", async () => {
    const led = ledger();
    const current = evidence({
      criteria: [{
        id: "fix",
        statement: "The bug is fixed",
        verified: false,
        missionRevision: MISSION_REV,
        evidenceRevision: EVIDENCE_REV,
      }],
      tests: { passed: false, independent: false, revision: "evidence-rev-0" },
    });
    const result = await directMissionControl({
      ledger: led,
      sessionId: "session-1",
      source: source(current),
      missionId: MISSION,
      verification: verification(),
    });
    expect(result.persisted).toBe("appended");
    expect(result.decision.complete).toBe(false);
    expect(result.decision.correction?.baseEvidenceRevision).toBe(EVIDENCE_REV);
    const prior = findPriorControlActions(led, MISSION, MISSION_REV);
    expect(prior.length).toBe(1);
    expect(prior[0]?.baseEvidenceRevision).toBe(EVIDENCE_REV);
  });

  it("repeating the loop against unchanged evidence stalls instead of re-issuing the correction", async () => {
    const led = ledger();
    const current = evidence({
      criteria: [{
        id: "fix",
        statement: "The bug is fixed",
        verified: false,
        missionRevision: MISSION_REV,
        evidenceRevision: EVIDENCE_REV,
      }],
      tests: { passed: false, independent: false, revision: "evidence-rev-0" },
    });
    const first = await directMissionControl({
      ledger: led,
      sessionId: "session-1",
      source: source(current),
      missionId: MISSION,
      verification: verification(),
    });
    expect(first.decision.action).not.toBe("INSUFFICIENT_EVIDENCE");
    const second = await directMissionControl({
      ledger: led,
      sessionId: "session-1",
      source: source(current),
      missionId: MISSION,
      verification: verification(),
    });
    expect(second.decision.action).toBe("INSUFFICIENT_EVIDENCE");
    expect(second.decision.complete).toBe(false);
    expect(second.decision.reasons.join(" ")).toContain("no new evidence");
  });

  it("a genuinely changed evidence revision reassesses instead of stalling", async () => {
    const led = ledger();
    const before = evidence({
      criteria: [{
        id: "fix",
        statement: "The bug is fixed",
        verified: false,
        missionRevision: MISSION_REV,
        evidenceRevision: EVIDENCE_REV,
      }],
      tests: { passed: false, independent: false, revision: "evidence-rev-0" },
    });
    await directMissionControl({
      ledger: led,
      sessionId: "session-1",
      source: source(before),
      missionId: MISSION,
      verification: verification(),
    });
    const after = evidence({
      evidenceRevision: "evidence-rev-10",
      candidateDigest: "candidate-digest-10",
      candidateRevision: "candidate-rev-10",
      criteria: [{
        id: "fix",
        statement: "The bug is fixed",
        verified: false,
        missionRevision: MISSION_REV,
        evidenceRevision: "evidence-rev-10",
      }],
      tests: { passed: false, independent: false, revision: "evidence-rev-0" },
    });
    const second = await directMissionControl({
      ledger: led,
      sessionId: "session-1",
      source: source(after),
      missionId: MISSION,
      verification: verification(),
    });
    expect(second.decision.action).not.toBe("INSUFFICIENT_EVIDENCE");
    expect(second.decision.correction?.baseEvidenceRevision).toBe("evidence-rev-10");
  });

  it("a matching durable completion receipt is terminal before a COMPLETE action record", async () => {
    const led = ledger();
    const current = evidence();
    const persisted = persistMissionClosureReceipt(led, "session-1", completeDecision(current));
    expect(persisted.status).toBe("appended");
    const receipt = findTerminalCompletionReceipt(led, MISSION, MISSION_REV, EVIDENCE_REV, CANDIDATE);
    expect(receipt?.candidateDigest).toBe(CANDIDATE);
    // The receipt is already durable, so the first loop step is terminal.
    const first = await directMissionControl({
      ledger: led,
      sessionId: "session-1",
      source: source(current),
      missionId: MISSION,
      verification: verification(),
    });
    expect(first.decision.action).toBe("COMPLETE");
    expect(first.decision.complete).toBe(true);
    // The second step remains idempotently terminal.
    const second = await directMissionControl({
      ledger: led,
      sessionId: "session-1",
      source: source(current),
      missionId: MISSION,
      verification: verification(),
    });
    expect(second.decision.action).toBe("COMPLETE");
    expect(second.persisted).toBe("duplicate");
    expect(second.decision.reasons.join(" ")).toContain("no further work is authorised");
  });

  it("a receipt for a different candidate never authorises completion", async () => {
    const led = ledger();
    const current = evidence();
    const persisted = persistMissionClosureReceipt(led, "session-1", completeDecision(current));
    expect(persisted.status).toBe("appended");
    expect(
      findTerminalCompletionReceipt(led, MISSION, MISSION_REV, EVIDENCE_REV, "other-candidate"),
    ).toBeUndefined();
    expect(
      findTerminalCompletionReceipt(led, MISSION, MISSION_REV, "other-evidence", CANDIDATE),
    ).toBeUndefined();
  });

  it("replays a full session: correction, new evidence, completion, terminal dominance", async () => {
    const led = ledger();
    const incomplete = evidence({
      criteria: [{
        id: "fix",
        statement: "The bug is fixed",
        verified: false,
        missionRevision: MISSION_REV,
        evidenceRevision: EVIDENCE_REV,
      }],
      tests: { passed: false, independent: false, revision: "evidence-rev-0" },
    });
    const repaired = evidence({
      evidenceRevision: "evidence-rev-10",
      candidateDigest: "candidate-digest-10",
      candidateRevision: "candidate-rev-10",
      criteria: [{
        id: "fix",
        statement: "The bug is fixed",
        verified: true,
        outcome: "passing test",
        evidenceRef: "verifier:test:300",
        missionRevision: MISSION_REV,
        evidenceRevision: "evidence-rev-10",
      }],
      tests: { passed: true, independent: true, evidenceRef: "verifier:test:300", revision: "evidence-rev-10" },
    });
    const calls = [incomplete, repaired, repaired];
    let call = 0;
    const scripted: MissionClosureEvidenceSource = {
      load: async () => calls[Math.min(call++, calls.length - 1)]!,
      isCurrent: async () => true,
    };
    const step = (): MissionControlOptions => ({
      ledger: led,
      sessionId: "session-1",
      source: scripted,
      missionId: MISSION,
      verification: verification(),
    });
    // Step 1: incomplete work draws a targeted correction, not completion.
    const first = await directMissionControl(step());
    expect(first.decision.action).toBe("VERIFY");
    expect(first.decision.complete).toBe(false);
    // Step 2: the repair produced a new evidence revision, so the loop
    // reassesses and reports ready-for-closure instead of stalling.
    const second = await directMissionControl(step());
    expect(second.decision.action).toBe("READY_FOR_CLOSURE");
    expect(second.decision.complete).toBe(false);
    // The host gate persists the durable terminal receipt; step 3 is
    // authorized by that receipt even though the evidence is unchanged.
    const receiptPersisted = persistMissionClosureReceipt(
      led,
      "session-1",
      completeDecision({ ...repaired, candidateDigest: "candidate-digest-10" }),
    );
    expect(receiptPersisted.status).toBe("appended");
    const third = await directMissionControl(step());
    expect(third.decision.action).toBe("COMPLETE");
    expect(third.decision.complete).toBe(true);
    expect(third.persisted).toBe("appended");
  });

  it("repeating an identical stalled step dedupes at the ledger instead of duplicating", async () => {
    const led = ledger();
    const current = evidence({
      criteria: [{
        id: "fix",
        statement: "The bug is fixed",
        verified: false,
        missionRevision: MISSION_REV,
        evidenceRevision: EVIDENCE_REV,
      }],
      tests: { passed: false, independent: false, revision: "evidence-rev-0" },
    });
    const options = {
      ledger: led,
      sessionId: "session-1",
      source: source(current),
      missionId: MISSION,
      verification: verification(),
    };
    const first = await directMissionControl(options);
    expect(first.persisted).toBe("appended");
    const second = await directMissionControl(options);
    expect(second.decision.action).toBe("INSUFFICIENT_EVIDENCE");
    expect(second.persisted).toBe("appended");
    // The third identical step replays the same stalled decision against
    // the same revision: the idempotency key must collapse it.
    const third = await directMissionControl(options);
    expect(third.decision.action).toBe("INSUFFICIENT_EVIDENCE");
    expect(third.persisted).toBe("duplicate");
  });
});
