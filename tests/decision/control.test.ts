import { describe, expect, it } from "vitest";
import type { VerificationLedger } from "../../src/hooks/verification.js";
import type { MissionClosureEvidence } from "../../src/mission/closure.js";
import {
  decideControlAction,
  MAX_CONTROL_ATTEMPTS,
  type ControllerInput,
} from "../../src/decision/control.js";

const REVISION = "evidence-r12";
const CANDIDATE = "candidate-r7";

function evidence(overrides: Partial<MissionClosureEvidence> = {}): MissionClosureEvidence {
  return {
    missionId: "mission-1",
    objective: "Deliver the requested feature",
    missionRevision: "mission-r7",
    evidenceRevision: REVISION,
    candidateDigest: CANDIDATE,
    candidateRevision: "candidate-rev-7",
    criteria: [{
      id: "feature",
      statement: "The feature works",
      verified: true,
      outcome: "implemented and covered",
      evidenceRef: "user-prompt:abc",
      missionRevision: "mission-r7",
      evidenceRevision: REVISION,
    }],
    tests: { passed: true, independent: true, evidenceRef: "verifier:v:r", revision: REVISION },
    operations: { pending: 0, uncertain: 0 },
    blockers: [],
    ...overrides,
  };
}

function ledger(): VerificationLedger {
  return {
    last: { kind: "test", ok: true, ts: 300, command: "npm test" },
    edits_since: 0,
    byKind: { test: { kind: "test", ok: true, ts: 300, command: "npm test" } },
    editsSinceByKind: { test: 0 },
  };
}

function input(overrides: Partial<ControllerInput> = {}): ControllerInput {
  return {
    evidence: evidence(),
    verification: ledger(),
    prior: [],
    attempts: 0,
    transientFailure: false,
    ...overrides,
  };
}

describe("host-owned control pathway", () => {
  it("reports ready-for-closure, not terminal completion, when every deterministic gate passes", () => {
    const decision = decideControlAction(input({
      modelHint: { suggestion: "done", confident: true },
    }));
    expect(decision.action).toBe("READY_FOR_CLOSURE");
    // Terminal authorization requires the durable closure receipt; the
    // deterministic gates alone only request authoritative closure.
    expect(decision.complete).toBe(false);
    expect(decision.reasons.join(" ")).toContain("request authoritative semantic closure");
  });

  it("refuses done on a convincing hint when a criterion is unverified", () => {
    const decision = decideControlAction(input({
      evidence: evidence({ criteria: [{
        id: "feature",
        statement: "The feature works",
        verified: false,
        missionRevision: "mission-r7",
        evidenceRevision: REVISION,
      }] }),
      modelHint: { suggestion: "done", confident: true },
    }));
    expect(decision.action).not.toBe("COMPLETE");
    expect(decision.complete).toBe(false);
    expect(decision.correction?.criterionId).toBe("feature");
    expect(decision.correction?.baseEvidenceRevision).toBe(REVISION);
  });

  it("repairs a currently failing check with an actionable correction", () => {
    const failed: VerificationLedger = {
      last: { kind: "test", ok: false, ts: 300, command: "npm test" },
      edits_since: 0,
      byKind: { test: { kind: "test", ok: false, ts: 300, command: "npm test" } },
      editsSinceByKind: { test: 0 },
    };
    const decision = decideControlAction(input({ verification: failed }));
    expect(decision.action).toBe("REPAIR");
    expect(decision.correction).toMatchObject({
      criterionId: "feature",
      action: "REPAIR",
      baseEvidenceRevision: REVISION,
      baseCandidateDigest: CANDIDATE,
      maxAttempts: MAX_CONTROL_ATTEMPTS,
    });
    expect(decision.correction?.evidenceRefs.length).toBeGreaterThan(0);
    expect(decision.correction?.requiredOutcome.length).toBeGreaterThan(0);
  });

  it("verifies when the passing test is stale", () => {
    const stale: VerificationLedger = {
      last: { kind: "test", ok: true, ts: 300, command: "npm test" },
      edits_since: 2,
      byKind: { test: { kind: "test", ok: true, ts: 300, command: "npm test" } },
      editsSinceByKind: { test: 2 },
    };
    const decision = decideControlAction(input({ verification: stale }));
    expect(decision.action).toBe("VERIFY");
    expect(decision.correction?.action).toBe("VERIFY");
  });

  it("reconciles outstanding operations before judging completion", () => {
    const decision = decideControlAction(input({
      evidence: evidence({ operations: { pending: 2, uncertain: 0 } }),
    }));
    expect(decision.action).toBe("VERIFY");
    expect(decision.correction?.requiredOutcome).toContain("no pending");
  });

  it("blocks on an unresolved dependency without claiming success", () => {
    const decision = decideControlAction(input({
      evidence: evidence({ blockers: [{ id: "trip:cred", unresolved: true }] }),
    }));
    expect(decision.action).toBe("BLOCKED");
    expect(decision.complete).toBe(false);
    expect(decision.correction?.action).toBe("REQUEST_INPUT");
    expect(decision.reasons.join("\n")).toContain("trip:cred");
  });

  it("retries only with a credible transient signal inside the budget", () => {
    const failed: VerificationLedger = {
      last: { kind: "test", ok: false, ts: 300, command: "npm test" },
      edits_since: 0,
      byKind: { test: { kind: "test", ok: false, ts: 300, command: "npm test" } },
      editsSinceByKind: { test: 0 },
    };
    const retry = decideControlAction(input({ verification: failed, transientFailure: true, attempts: 1 }));
    expect(retry.action).toBe("RETRY");
    const exhausted = decideControlAction(
      input({ verification: failed, transientFailure: true, attempts: MAX_CONTROL_ATTEMPTS }),
    );
    expect(exhausted.action).toBe("CHANGE_APPROACH");
  });

  it("never retries a deterministic failure", () => {
    const failed: VerificationLedger = {
      last: { kind: "test", ok: false, ts: 300, command: "npm test" },
      edits_since: 0,
      byKind: { test: { kind: "test", ok: false, ts: 300, command: "npm test" } },
      editsSinceByKind: { test: 0 },
    };
    const decision = decideControlAction(
      input({ verification: failed, transientFailure: false, attempts: 0 }),
    );
    expect(decision.action).toBe("REPAIR");
  });

  it("stops the loop when a correction produced no new evidence", () => {
    const decision = decideControlAction(input({
      evidence: evidence({ tests: { passed: true, independent: false, revision: REVISION } }),
      prior: [{ action: "VERIFY", criterionId: "feature", baseEvidenceRevision: REVISION, attempts: 1 }],
    }));
    expect(decision.action).toBe("INSUFFICIENT_EVIDENCE");
    expect(decision.reasons.join("\n")).toContain("no new evidence");
  });

  it("reassesses when the correction advanced the evidence revision", () => {
    const decision = decideControlAction(input({
      prior: [{ action: "REPAIR", criterionId: "feature", baseEvidenceRevision: "evidence-r11", attempts: 1 }],
    }));
    expect(decision.action).toBe("READY_FOR_CLOSURE");
  });

  it("uses a revision-bound adversarial repair hint, and ignores a stale one", () => {
    const bound = decideControlAction(input({
      evidence: evidence({ tests: { passed: false, independent: false, revision: REVISION } }),
      verification: undefined,
      modelHint: {
        suggestion: "continue",
        confident: false,
        repair: {
          criterionId: "feature",
          finding: "missing regression test",
          requiredEvidence: "a passing regression test on the current candidate",
          evidenceRevision: REVISION,
        },
      },
    }));
    expect(bound.action).toBe("REPAIR");
    expect(bound.correction?.requiredOutcome).toContain("regression test");

    const stale = decideControlAction(input({
      modelHint: {
        suggestion: "continue",
        confident: true,
        repair: {
          criterionId: "feature",
          finding: "old finding",
          requiredEvidence: "old evidence",
          evidenceRevision: "evidence-r11",
        },
      },
    }));
    // A stale hint is speculation, not an instruction: the deterministic
    // gates hold, so the mission still completes.
    expect(stale.action).toBe("READY_FOR_CLOSURE");
  });

  it("never answers uncertainty by interrupting the user", () => {
    const decision = decideControlAction(input({
      evidence: evidence({ tests: { passed: true, independent: false, revision: REVISION } }),
      modelHint: { suggestion: "ask_user", confident: false },
    }));
    expect(decision.action).not.toBe("COMPLETE");
    expect(decision.correction?.action).not.toBe("REQUEST_INPUT");
    expect(decision.action).toBe("VERIFY");
  });

  it("treats complete as terminal and idempotent, not a continuation", () => {
    const decision = decideControlAction(input({
      evidence: evidence({ tests: { passed: false, independent: false, revision: REVISION } }),
      verification: undefined,
      prior: [{
        action: "COMPLETE",
        baseEvidenceRevision: REVISION,
        attempts: 0,
        missionId: "mission-1",
        missionRevision: "mission-r7",
        baseCandidateDigest: CANDIDATE,
      }],
      terminalReceipt: {
        missionId: "mission-1",
        missionRevision: "mission-r7",
        evidenceRevision: REVISION,
        candidateDigest: CANDIDATE,
      },
    }));
    expect(decision.action).toBe("COMPLETE");
    expect(decision.complete).toBe(true);
  });

  it("refuses terminal state from a history entry without a durable receipt", () => {
    const decision = decideControlAction(input({
      evidence: evidence({ tests: { passed: false, independent: false, revision: REVISION } }),
      verification: undefined,
      prior: [{
        action: "COMPLETE",
        baseEvidenceRevision: REVISION,
        attempts: 0,
        missionId: "mission-1",
        missionRevision: "mission-r7",
        baseCandidateDigest: CANDIDATE,
      }],
    }));
    expect(decision.action).not.toBe("COMPLETE");
    expect(decision.complete).toBe(false);
  });

  it("a matching closure receipt remains authoritative despite unrelated prior actions", () => {
    for (const prior of [
      {
        action: "COMPLETE" as const,
        baseEvidenceRevision: REVISION,
        attempts: 0,
        missionId: "mission-2",
        missionRevision: "mission-r7",
        baseCandidateDigest: CANDIDATE,
      },
      {
        action: "COMPLETE" as const,
        baseEvidenceRevision: REVISION,
        attempts: 0,
        missionId: "mission-1",
        missionRevision: "mission-r7",
        baseCandidateDigest: "candidate-other",
      },
    ]) {
      const decision = decideControlAction(input({
        evidence: evidence({ tests: { passed: false, independent: false, revision: REVISION } }),
        verification: undefined,
        prior: [prior],
        terminalReceipt: {
          missionId: "mission-1",
          missionRevision: "mission-r7",
          evidenceRevision: REVISION,
          candidateDigest: CANDIDATE,
        },
      }));
      expect(decision.action).toBe("COMPLETE");
      expect(decision.complete).toBe(true);
    }
  });

  it("rejects a closure receipt bound to another mission, revision, or candidate", () => {
    for (const terminalReceipt of [
      { missionId: "mission-other", missionRevision: "mission-r7", evidenceRevision: REVISION, candidateDigest: CANDIDATE },
      { missionId: "mission-1", missionRevision: "mission-other", evidenceRevision: REVISION, candidateDigest: CANDIDATE },
      { missionId: "mission-1", missionRevision: "mission-r7", evidenceRevision: "evidence-other", candidateDigest: CANDIDATE },
      { missionId: "mission-1", missionRevision: "mission-r7", evidenceRevision: REVISION, candidateDigest: "candidate-other" },
    ]) {
      const decision = decideControlAction(input({ terminalReceipt }));
      expect(decision.action).toBe("READY_FOR_CLOSURE");
      expect(decision.complete).toBe(false);
    }
  });
});
