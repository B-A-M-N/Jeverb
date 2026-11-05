/**
 * Adversarial closure (Jev B): question builders, finding validation, and
 * gap-distribution checks.
 *
 * Leaf module: only type references to `closure.ts` (erased at runtime), so
 * the runtime direction stays one-way (`closure.ts` imports values from
 * here). `closure.ts` re-exports these symbols so existing
 * `mission/closure.js` importers keep working.
 */

import type { MissionClosureEvidence, MissionClosureStatus } from "./closure.js";

/** Compact adversarial outcome persisted on the closure decision and receipt. */
export interface AdversarialClosureSummary {
  state: AdversarialClosureState;
  gap: AdversarialGap;
  /** Criterion ids with a supported gap finding. */
  targets: string[];
  conflictingFindings: AdversarialFinding[];
  repairCriterion?: string;
  priorChallengeRepeated: boolean;
  model?: string;
  modelVersion?: string;
  provider?: string;
  providerRequestId?: string;
  questionHash?: string;
  calibrationVersion?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

/** Final controller states for the adversarial closure pair. */
export const ADVERSARIAL_CLOSURE_STATES = ["ACCEPT", "REPAIR", "GATHER_EVIDENCE", "BLOCKED"] as const;
export type AdversarialClosureState = (typeof ADVERSARIAL_CLOSURE_STATES)[number];

export const ADVERSARIAL_GAP_CHOICES = ["SUPPORTED_GAP", "NO_GAP_FOUND", "UNKNOWN"] as const;
export type AdversarialGap = (typeof ADVERSARIAL_GAP_CHOICES)[number];

export const CRITERION_GAP_CHOICES = ["GAP", "NO_GAP", "UNKNOWN"] as const;
export type CriterionGap = (typeof CRITERION_GAP_CHOICES)[number];

/** A concrete defect identified by the adversarial judge. */
export interface AdversarialFinding {
  criterionId: string;
  kind: "omission" | "contradiction" | "unsupported-claim" | "unresolved-requirement";
  evidence: string;
}

/**
 * Bounded repair task: one criterion, one evidence demand, one revision.
 * Carries the full corrective-action shape so a host controller can direct
 * the repair without re-interpreting prose: defect kind, evidence
 * references, required outcome, challenged candidate, and attempt budget.
 */
export interface AdversarialRepairTask {
  criterionId: string;
  /** What the adversarial judge found wrong, with the supporting evidence reference. */
  finding: string;
  /** The exact evidence that would resolve it (a test, receipt, or attestation to produce). */
  requiredEvidence: string;
  /** The evidence revision the challenge was raised against; repair must advance it. */
  evidenceRevision: string;
  /** Classified defect kind; a semantic label only, never proof by itself. */
  defectKind: "omission" | "contradiction" | "unsupported-claim" | "unresolved-requirement";
  /** Evidence references supporting the defect (criterion refs, verifier receipts). */
  evidenceRefs: string[];
  /** The candidate challenged; undefined when no candidate is established. */
  baseCandidateDigest?: string;
  /** Attempts allowed before the approach must change. */
  maxAttempts: number;
}

/** Attempts allowed at one adversarial repair before the approach must change. */
export const MAX_ADVERSARIAL_REPAIR_ATTEMPTS = 3;

/** The adversarial judge's typed result over the same revision-bound snapshot. */
export interface AdversarialJudgeResult {
  gap: AdversarialGap;
  perCriterion: Record<string, CriterionGap>;
  findings: AdversarialFinding[];
  model?: string;
  modelVersion?: string;
  provider?: string;
  providerRequestId?: string;
  questionHash?: string;
  calibrationVersion?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

/** Both judges' results plus the controller's verdict. Unanimous approval is necessary, never sufficient. */
export interface AdversarialClosureDecision {
  state: AdversarialClosureState;
  /** Jev A: does the verified evidence establish the objective is fulfilled? */
  affirmative: MissionClosureStatus;
  /** Jev B: is there a material omission, contradiction, unsupported claim, or unresolved requirement? */
  adversarial: AdversarialJudgeResult;
  conflictingFindings: AdversarialFinding[];
  repairTask?: AdversarialRepairTask;
  priorChallengeRepeated: boolean;
  reasons: string[];
}

/** A previously recorded challenge, used to bound repetition on unchanged evidence. */
export interface PriorAdversarialChallenge {
  criterionId: string;
  evidenceRevision: string;
}

export const PROBABILITY_TOLERANCE = 1e-6;

/**
 * Jev B asks a different hypothesis than Jev A: not "is the objective met?"
 * but "is there a material defect in the evidence for it?" A finding only
 * counts when it names the affected criterion and supporting evidence;
 * speculation without a target is uncertainty, never a veto.
 */
export const MISSION_ADVERSARIAL_QUESTION = {
  type: "choice" as const,
  instructions:
    "Inspect the supplied verified outcomes for a material defect: an omitted requirement, a contradiction between claimed outcome and evidence, an outcome the evidence does not support, or an unresolved requirement. SUPPORTED_GAP means you found such a defect tied to a specific acceptance criterion. NO_GAP_FOUND means the evidence for every criterion holds together. UNKNOWN means the evidence is too thin to judge either way.",
  criteria: {
    SUPPORTED_GAP: "A specific acceptance criterion has a material omission, contradiction, unsupported claim, or unresolved requirement backed by the supplied evidence.",
    NO_GAP_FOUND: "The verified outcomes for every acceptance criterion hold together with no material defect.",
    UNKNOWN: "The evidence is too thin to confirm or rule out a material defect.",
  },
};

function criterionGapQuestion(criterionId: string, statement: string) {
  return {
    type: "choice" as const,
    instructions:
      `For acceptance criterion ${criterionId} (${statement}), does its verified outcome and evidence reference hold together, or is there a material omission, contradiction, or unsupported claim? GAP means a concrete defect in this criterion's evidence. NO_GAP means it holds. UNKNOWN means it cannot be judged from the supplied evidence.`,
    criteria: {
      GAP: `Criterion ${criterionId} has a concrete, evidence-backed defect.`,
      NO_GAP: `Criterion ${criterionId} holds together.`,
      UNKNOWN: `Criterion ${criterionId} cannot be judged from the supplied evidence.`,
    },
  };
}

/** The full Jev B question set: one overall gap hypothesis plus one per criterion. */
export function adversarialQuestionsFor(evidence: MissionClosureEvidence): Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> {
  const questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> = {
    gap: MISSION_ADVERSARIAL_QUESTION,
  };
  for (const criterion of evidence.criteria) {
    questions[`gap_${criterion.id}`] = criterionGapQuestion(criterion.id, criterion.statement);
  }
  return questions;
}

export function validGapDistribution(
  choice: string,
  confidence: number,
  probabilities: Record<string, number>,
): boolean {
  const keys = Object.keys(probabilities).sort();
  const expected = [...ADVERSARIAL_GAP_CHOICES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  const values = Object.values(probabilities);
  if (!values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return false;
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > PROBABILITY_TOLERANCE) return false;
  const selected = probabilities[choice];
  return selected !== undefined && selected + PROBABILITY_TOLERANCE >= Math.max(...values) &&
    Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 &&
    (confidence < 1 - PROBABILITY_TOLERANCE || selected >= 1 - PROBABILITY_TOLERANCE);
}

export function validCriterionGap(choice: unknown): choice is CriterionGap {
  return choice === "GAP" || choice === "NO_GAP" || choice === "UNKNOWN";
}

/**
 * Host-side validation of a single criterion-level GAP before it may become
 * a mandatory corrective action. A model GAP verdict is a proposal, not
 * proof: it is corroborated only when the deterministic evidence itself shows
 * the defect — an unattested criterion (omission), a stale attestation, an
 * attestation with no recorded outcome or reference, or an attestation that
 * contradicts failing tests. A GAP against a fully attested criterion with
 * current revisions and passing tests is uncorroborated: it routes to
 * targeted independent verification, never to a mandatory REPAIR.
 */
export type AdversarialFindingValidation =
  | { status: "corroborated"; defectKind: AdversarialFinding["kind"]; detail: string }
  | { status: "uncorroborated"; detail: string };

export function validateAdversarialFinding(
  evidence: MissionClosureEvidence,
  criterionId: string,
): AdversarialFindingValidation {
  const criterion = evidence.criteria.find((item) => item.id === criterionId);
  if (criterion === undefined) {
    return { status: "uncorroborated", detail: `criterion ${criterionId} is not part of the current evidence` };
  }
  if (!criterion.verified) {
    return { status: "corroborated", defectKind: "omission", detail: `criterion ${criterionId} is not attested as done` };
  }
  if (criterion.evidenceRevision !== evidence.evidenceRevision || criterion.missionRevision !== evidence.missionRevision) {
    return {
      status: "corroborated",
      defectKind: "contradiction",
      detail: `criterion ${criterionId} is attested at a superseded revision (mission ${criterion.missionRevision}, evidence ${criterion.evidenceRevision})`,
    };
  }
  if (criterion.outcome === undefined) {
    return { status: "corroborated", defectKind: "unsupported-claim", detail: `criterion ${criterionId} is attested with no recorded outcome` };
  }
  if (criterion.evidenceRef === undefined) {
    return { status: "corroborated", defectKind: "unsupported-claim", detail: `criterion ${criterionId} is attested with no evidence reference` };
  }
  if (!evidence.tests.passed) {
    return {
      status: "corroborated",
      defectKind: "contradiction",
      detail: `criterion ${criterionId} is attested yet the test record fails on the current candidate`,
    };
  }
  return {
    status: "uncorroborated",
    detail: `criterion ${criterionId} is attested with a recorded outcome, an evidence reference at the current revision, and passing tests; the gap assertion has no deterministic corroboration`,
  };
}
