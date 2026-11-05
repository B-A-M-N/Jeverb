import { describe, expect, it } from "vitest";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionModel } from "../../src/decision/types.js";
import { hashQuestions } from "../../src/decision/provenance.js";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import {
  AdversarialClosureGate,
  decideAdversarialClosure,
  resolveAdversarialClosure,
  validateAdversarialFinding,
  MISSION_CLOSURE_QUESTION,
  type AdversarialJudgeResult,
  type MissionClosureDecision,
  type MissionClosureEvidence,
  type MissionClosurePolicy,
} from "../../src/mission/closure.js";
import { persistMissionClosureReceipt } from "../../src/mission/receipt.js";
import { buildMissionProofObligation } from "../../src/mission/proof-obligations.js";
import { testLedgerForFile } from "../helpers/control-state.js";

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
  adversarialCalibrationVersion: "fixture-adversarial-calibration-1",
};

function concentrated(choices: string[], selected: string): Record<string, number> {
  return Object.fromEntries(choices.map((option) => [option, option === selected ? 1 : 0]));
}

/** Stub answering Jev A (`closure`) and Jev B (`gap`, `gap_<id>`) from separate scripts. */
function pairModel(answers: {
  affirmative: string;
  gap: string;
  perCriterion?: Record<string, string>;
}): DecisionModel & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    name: "jev-1.14.0",
    calls,
    evaluate: async (input) => {
      calls.push(input);
      const questions = input.questions as Record<string, { type: string }>;
      if ("closure" in questions) {
        return ({
          model: "jev-1.14.0",
          provider: "typesafe",
          questionHash: policy.questionHash,
          answers: {
            closure: {
              type: "choice",
              choice: answers.affirmative,
              confidence: 1,
              probabilities: concentrated(["COMPLETE", "INCOMPLETE", "BLOCKED", "INSUFFICIENT_EVIDENCE"], answers.affirmative),
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
          latency_ms: 1,
        }) as never;
      }
      const perCriterion: Record<string, unknown> = {};
      for (const criterion of evidence.criteria) {
        const verdict = answers.perCriterion?.[criterion.id] ?? "NO_GAP";
        perCriterion[`gap_${criterion.id}`] = {
          type: "choice",
          choice: verdict,
          confidence: 1,
          probabilities: concentrated(["GAP", "NO_GAP", "UNKNOWN"], verdict),
        };
      }
      return ({
        model: "jev-1.14.0",
        provider: "typesafe",
        questionHash: hashQuestions(input.questions as Record<string, import("../../src/decision/types.js").Question>),
        answers: {
          gap: {
            type: "choice",
            choice: answers.gap,
            confidence: 1,
            probabilities: concentrated(["SUPPORTED_GAP", "NO_GAP_FOUND", "UNKNOWN"], answers.gap),
          },
          ...perCriterion,
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

function ledger() {
  return testLedgerForFile(join(mkdtempSync(join(tmpdir(), "jeverb-adv-")), "evidence.log"));
}

const source = {
  load: async () => evidence,
  isCurrent: async () => true,
};

describe("adversarial closure pair", () => {
  it("accepts only when deterministic gates, Jev A, and Jev B agree", async () => {
    const model = pairModel({ affirmative: "COMPLETE", gap: "NO_GAP_FOUND" });
    const gate = new AdversarialClosureGate(model, policy, source, ledger());
    const result = await gate.close("session-1", "mission-1");
    expect(result.decision.status).toBe("COMPLETE");
    expect(result.decision.complete).toBe(true);
    expect(result.terminalComplete).toBe(true);
    expect(result.decision.adversarial).toMatchObject({ state: "ACCEPT", gap: "NO_GAP_FOUND" });
    // Both hypotheses were judged: the closure question and the gap set.
    expect(model.calls).toHaveLength(2);
  });

  it("invalidates a cached terminal verdict when evidence moves before publication", async () => {
    const model = pairModel({ affirmative: "COMPLETE", gap: "NO_GAP_FOUND" });
    let fresh = true;
    const movingSource = { load: async () => evidence, isCurrent: async () => fresh };
    const gate = new AdversarialClosureGate(model, policy, movingSource, ledger());
    const first = await gate.close("session-1", "mission-1");
    expect(first.terminalComplete).toBe(true);
    expect(model.calls).toHaveLength(2);
    // Evidence moves after loading: the second close hits the cache but
    // must not publish the stale terminal verdict.
    fresh = false;
    const second = await gate.close("session-1", "mission-1");
    expect(second.decision.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(second.decision.complete).toBe(false);
    expect(second.terminalComplete).toBe(false);
    expect(second.decision.reasons.join(" ")).toContain("cached verdict");
    expect(model.calls).toHaveLength(2);
  });

  it("routes an uncorroborated gap to targeted verification, never a mandatory repair", async () => {
    // Fixture evidence is fully attested (verified, outcome recorded, current
    // revisions, passing tests), so the GAP has no deterministic corroboration.
    const model = pairModel({ affirmative: "COMPLETE", gap: "SUPPORTED_GAP", perCriterion: { feature: "GAP" } });
    const gate = new AdversarialClosureGate(model, policy, source, ledger());
    const result = await gate.close("session-1", "mission-1");
    expect(result.decision.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
    expect(result.decision.repairTask).toMatchObject({
      criterionId: "feature",
      evidenceRevision: "evidence-r12",
      defectKind: "unsupported-claim",
      maxAttempts: 3,
    });
    expect(result.decision.repairTask?.evidenceRefs.length).toBeGreaterThan(0);
    expect(result.decision.repairTask?.requiredEvidence).toContain("independent verification");
    expect(result.decision.adversarial).toMatchObject({ state: "GATHER_EVIDENCE", targets: ["feature"] });
  });

  function completeAffirmative(): MissionClosureDecision {
    return {
      status: "COMPLETE",
      complete: true,
      missionId: "mission-1",
      missionRevision: "mission-r7",
      evidenceRevision: "evidence-r12",
      policyVersion: "mission-closure/1",
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
      reasons: [],
      confidenceIsProof: false as const,
    };
  }

  function supportedGap(): AdversarialJudgeResult {
    return { gap: "SUPPORTED_GAP", perCriterion: { feature: "GAP" }, findings: [] };
  }

  it("validates findings against deterministic evidence", () => {
    expect(validateAdversarialFinding(evidence, "feature").status).toBe("uncorroborated");
    expect(validateAdversarialFinding(evidence, "missing").status).toBe("uncorroborated");
    const { outcome: _o, ...rest } = evidence.criteria[0]!;
    void _o;
    expect(
      validateAdversarialFinding({ ...evidence, criteria: [{ ...rest }] }, "feature"),
    ).toMatchObject({ status: "corroborated", defectKind: "unsupported-claim" });
  });

  it("repairs a gap corroborated by an unattested criterion", async () => {
    const { outcome: _outcome, evidenceRef: _ref, ...rest } = evidence.criteria[0]!;
    void _outcome;
    void _ref;
    const unattested: MissionClosureEvidence = {
      ...evidence,
      criteria: [{ ...rest, verified: false }],
    };
    const pair = resolveAdversarialClosure(completeAffirmative(), supportedGap(), unattested);
    expect(pair.state).toBe("REPAIR");
    expect(pair.repairTask).toMatchObject({ criterionId: "feature", defectKind: "omission" });
  });

  it("repairs a gap corroborated by failing tests against an attested criterion", async () => {
    const contradicted: MissionClosureEvidence = {
      ...evidence,
      tests: { ...evidence.tests, passed: false },
    };
    const pair = resolveAdversarialClosure(completeAffirmative(), supportedGap(), contradicted);
    expect(pair.state).toBe("REPAIR");
    expect(pair.repairTask).toMatchObject({ criterionId: "feature", defectKind: "contradiction" });
  });

  it("repairs a gap corroborated by a superseded attestation revision", async () => {
    const stale: MissionClosureEvidence = {
      ...evidence,
      criteria: [{ ...evidence.criteria[0]!, evidenceRevision: "evidence-r11" }],
    };
    const pair = resolveAdversarialClosure(completeAffirmative(), supportedGap(), stale);
    expect(pair.state).toBe("REPAIR");
    expect(pair.repairTask).toMatchObject({ criterionId: "feature", defectKind: "contradiction" });
  });

  it("repairs a gap corroborated by an attestation with no recorded outcome", async () => {
    const { outcome: _outcome, ...rest } = evidence.criteria[0]!;
    void _outcome;
    const empty: MissionClosureEvidence = {
      ...evidence,
      criteria: [{ ...rest }],
    };
    const pair = resolveAdversarialClosure(completeAffirmative(), supportedGap(), empty);
    expect(pair.state).toBe("REPAIR");
    expect(pair.repairTask).toMatchObject({ criterionId: "feature", defectKind: "unsupported-claim" });
  });

  it("refuses the pair verdict before judging when mechanical evidence already fails", async () => {
    // An unattested criterion would corroborate any GAP — but preflight
    // refuses first, so neither judge is consulted and REPAIR stays
    // unreachable through this pipeline (it remains available to direct
    // resolveAdversarialClosure callers as defense in depth).
    const unattested: MissionClosureEvidence = {
      ...evidence,
      criteria: [{ ...evidence.criteria[0]!, verified: false }],
    };
    const model = pairModel({ affirmative: "COMPLETE", gap: "SUPPORTED_GAP", perCriterion: { feature: "GAP" } });
    const { affirmative, adversarial, pair } = await decideAdversarialClosure(model, unattested, policy);
    expect(model.calls).toHaveLength(0);
    expect(affirmative.status).toBe("INCOMPLETE");
    expect(adversarial).toBeUndefined();
    expect(pair.state).toBe("GATHER_EVIDENCE");
  });

  it("gathers evidence when Jev A is incomplete and no gap explains it", async () => {
    const model = pairModel({ affirmative: "INCOMPLETE", gap: "NO_GAP_FOUND" });
    const { pair } = await decideAdversarialClosure(model, evidence, policy);
    expect(pair.state).toBe("GATHER_EVIDENCE");
    expect(pair.affirmative).toBe("INCOMPLETE");
  });

  it("treats an uncertain adversarial judgment as a targeted check, not a veto", async () => {
    const model = pairModel({ affirmative: "COMPLETE", gap: "UNKNOWN" });
    const { pair } = await decideAdversarialClosure(model, evidence, policy);
    expect(pair.state).toBe("GATHER_EVIDENCE");
    expect(pair.repairTask?.criterionId).toBe("feature");
  });

  it("never lets an overall NO_GAP_FOUND override a criterion-level GAP", async () => {
    const model = pairModel({ affirmative: "COMPLETE", gap: "NO_GAP_FOUND", perCriterion: { feature: "GAP" } });
    const { pair } = await decideAdversarialClosure(model, evidence, policy);
    // The criterion judgment governs acceptance — no ACCEPT — but without
    // deterministic corroboration it orders verification, not repair.
    expect(pair.state).toBe("GATHER_EVIDENCE");
    expect(pair.reasons.join("\n")).toContain("never overridden");
    const gate = new AdversarialClosureGate(model, policy, source, ledger());
    const result = await gate.close("session-1", "mission-1");
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
  });

  it("does not accept completion while a criterion judgment is UNKNOWN", async () => {
    const model = pairModel({ affirmative: "COMPLETE", gap: "NO_GAP_FOUND", perCriterion: { feature: "UNKNOWN" } });
    const { pair } = await decideAdversarialClosure(model, evidence, policy);
    expect(pair.state).toBe("GATHER_EVIDENCE");
    expect(pair.reasons.join("\n")).toContain("feature");
  });

  it("does not let a gap claim without a target veto completion", async () => {
    const model = pairModel({ affirmative: "COMPLETE", gap: "SUPPORTED_GAP" });
    const { pair } = await decideAdversarialClosure(model, evidence, policy);
    expect(pair.state).toBe("GATHER_EVIDENCE");
    expect(pair.reasons.join("\n")).toContain("no affected criterion");
  });

  it("terminates as BLOCKED when a challenge produces no new evidence", async () => {
    const model = pairModel({ affirmative: "COMPLETE", gap: "SUPPORTED_GAP", perCriterion: { feature: "GAP" } });
    const gate = new AdversarialClosureGate(model, policy, source, ledger());
    const first = await gate.close("session-1", "mission-1");
    expect(first.decision.status).toBe("INSUFFICIENT_EVIDENCE");
    const second = await gate.close("session-1", "mission-1");
    expect(second.decision.status).toBe("BLOCKED");
    expect(second.decision.adversarial).toMatchObject({ priorChallengeRepeated: true });
    // The repeat challenge cost no new inference: the cached pair was re-resolved.
    expect(model.calls).toHaveLength(2);
  });

  it("does not re-judge unchanged evidence", async () => {
    const model = pairModel({ affirmative: "COMPLETE", gap: "NO_GAP_FOUND" });
    const gate = new AdversarialClosureGate(model, policy, source, ledger());
    await gate.close("session-1", "mission-1");
    await gate.close("session-1", "mission-1");
    expect(model.calls).toHaveLength(2);
  });

  it("gathers evidence when the adversarial contract is uncalibrated", async () => {
    const model = pairModel({ affirmative: "COMPLETE", gap: "NO_GAP_FOUND" });
    const { adversarialCalibrationVersion: _dropped, ...uncalibrated } = policy;
    void _dropped;
    const { pair } = await decideAdversarialClosure(model, evidence, uncalibrated);
    expect(pair.state).toBe("GATHER_EVIDENCE");
  });

  it("refuses to persist COMPLETE with a recorded adversarial gap", () => {
    const decision = {
      status: "COMPLETE" as const,
      complete: true,
      missionId: "mission-1",
      missionRevision: "mission-r7",
      evidenceRevision: "evidence-r12",
      policyVersion: "mission-closure/1",
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
      reasons: [],
      model: "jev-1.14.0",
      modelVersion: "jev-1.14.0",
      provider: "typesafe",
      questionHash: policy.questionHash,
      calibrationVersion: "fixture-calibration-1",
      confidence: 1,
      probabilities: concentrated(["COMPLETE", "INCOMPLETE", "BLOCKED", "INSUFFICIENT_EVIDENCE"], "COMPLETE"),
      confidenceIsProof: false as const,
      adversarial: {
        state: "REPAIR" as const,
        gap: "SUPPORTED_GAP" as const,
        targets: ["feature"],
        conflictingFindings: [],
        repairCriterion: "feature",
        priorChallengeRepeated: false,
      },
    };
    const receipt = persistMissionClosureReceipt(ledger(), "session-1", decision);
    expect(receipt.status).toBe("unavailable");
  });

  it("downgrades a complete pair verdict that conflicts with a recorded verdict", async () => {
    const shared = ledger();
    const first = new AdversarialClosureGate(
      pairModel({ affirmative: "COMPLETE", gap: "NO_GAP_FOUND" }),
      policy,
      source,
      shared,
    );
    const won = await first.close("session-1", "mission-1");
    expect(won.terminalComplete).toBe(true);
    // Same mission/evidence revisions but a different candidate: the recorded
    // verdict governs, so the new COMPLETE must not stand.
    const moved = structuredClone(evidence);
    moved.candidateDigest = "d".repeat(64);
    const second = new AdversarialClosureGate(
      pairModel({ affirmative: "COMPLETE", gap: "NO_GAP_FOUND" }),
      policy,
      { load: async () => moved, isCurrent: async () => true },
      shared,
    );
    const lost = await second.close("session-1", "mission-1");
    expect(lost.receipt.status).toBe("conflict");
    expect(lost.terminalComplete).toBe(false);
    expect(lost.decision.complete).toBe(false);
    expect(lost.decision.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(lost.decision.reasons.join(" ")).toContain("could not be durably recorded");
  });
});
