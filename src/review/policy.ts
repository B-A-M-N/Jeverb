import type { DetectorResult } from "./detectors.js";

export type ReviewLane = "BLOCK" | "SECURITY REVIEW" | "NITS" | "MERGE" | "UNAVAILABLE";

export interface PolicyConfig {
  policy_version: string;
  thresholds: { block: number; security_review: number };
  /**
   * Calibration provenance. Thresholds are only meaningful for the
   * backend+model they were measured on; `calibrated` must be set
   * explicitly after a real bench run, never assumed.
   */
  provenance?: {
    backend?: string;
    model?: string;
    calibrated?: boolean;
    note?: string;
    /** Exact question-set hash thresholds were measured against. */
    questionHash?: string;
    /** Benchmark revision the thresholds were measured at. */
    calibrationVersion?: string;
    /** Immutable revision of the independently labeled calibration dataset. */
    datasetRevision?: string;
    /** sha256 of the recorded evaluation results and criteria. */
    evaluationHash?: string;
    /** Pinned model version thresholds were measured on. */
    modelVersion?: string;
    /**
     * Optional path to a qualification manifest (resolved against the
     * policy file directory). When set, the loader re-verifies the
     * manifest against the active deployment identity and recomputed
     * artifacts before honoring `calibrated`.
     */
    qualificationManifest?: string;
  };
}

/**
 * Calibration pin attached to every review result. A protected operation
 * may proceed only when `calibrated === true && advisory === false` for
 * the exact backend/model/question-hash in use — see
 * `isProtectedReviewSatisfied`. OpenRouter chat-generated estimates are
 * always `calibrated: false, advisory: true` and never satisfy the gate.
 */
export interface ReviewCalibrationPin {
  /** Backend that produced the probabilities (`typesafe` or `openrouter`). */
  provider: string;
  /** Model id that answered (or was expected to answer). */
  model: string;
  /** Pinned model version; defaults to the model id when unversioned. */
  modelVersion: string;
  /** sha256 over the canonical question set actually judged. */
  questionHash: string;
  /** Benchmark revision, or the policy version when unrecorded. */
  calibrationVersion: string;
  /** True only for a measured backend/model/question-hash triple. */
  calibrated: boolean;
  /** True when the numbers are advisory only (never gate-satisfying). */
  advisory: boolean;
  /** Machine-readable reason when not gate-satisfying. */
  reason?: string;
}

/** Machine-readable reasons a review cannot satisfy a protected gate. */
export const PROTECTED_GATE_REASONS = {
  missingCalibration: "review-unavailable:missing-calibration",
  uncalibrated: "review-unavailable:uncalibrated",
  advisoryProvider: "review-unavailable:openrouter-advisory",
  modelMismatch: "review-unavailable:model-mismatch",
  modelVersionMismatch: "review-unavailable:model-version-mismatch",
  calibrationVersionMismatch: "review-unavailable:calibration-version-mismatch",
  questionHashMismatch: "review-unavailable:question-hash-mismatch",
  laneUnavailable: "review-unavailable:lane-unavailable",
} as const;

/**
 * Protected-operation gate. Returns `{ ok: true }` only when the result
 * carries a calibration pin with `calibrated === true`, `advisory === false`,
 * a non-OpenRouter provider, and — when `expected` is given — an exact
 * backend/model/question-hash match. Everything else fails closed with a
 * machine-readable `reason`. A MERGE lane alone is never sufficient.
 */
export function isProtectedReviewSatisfied(
  result: ReviewResult,
  expected?: { backend?: string; model?: string; questionHash?: string },
): { ok: true } | { ok: false; reason: string } {
  const pin = result.calibration;
  if (pin === undefined) return { ok: false, reason: PROTECTED_GATE_REASONS.missingCalibration };
  // Advisory-provider reason first: an OpenRouter UNAVAILABLE is unavailable
  // *because* it is advisory, and the caller needs that reason, not the lane.
  if (pin.provider === "openrouter" || pin.advisory) {
    return { ok: false, reason: pin.reason ?? PROTECTED_GATE_REASONS.advisoryProvider };
  }
  if (!pin.calibrated) return { ok: false, reason: pin.reason ?? PROTECTED_GATE_REASONS.uncalibrated };
  if (result.lane === "UNAVAILABLE") return { ok: false, reason: PROTECTED_GATE_REASONS.laneUnavailable };
  if (expected?.backend !== undefined && pin.provider !== expected.backend) {
    return { ok: false, reason: PROTECTED_GATE_REASONS.modelMismatch };
  }
  if (expected?.model !== undefined && pin.model !== expected.model) {
    return { ok: false, reason: PROTECTED_GATE_REASONS.modelMismatch };
  }
  if (
    expected?.questionHash !== undefined &&
    pin.questionHash !== expected.questionHash
  ) {
    return { ok: false, reason: PROTECTED_GATE_REASONS.questionHashMismatch };
  }
  return { ok: true };
}

export interface JudgedChunk {
  probabilities: Record<string, number>;
}

export interface ReviewResult {
  lane: ReviewLane;
  source: "deterministic" | "jev" | "combined";
  findings: Array<{ id: string; severity: string; message: string; path?: string; line?: number }>;
  probabilities?: Record<string, number>;
  policyVersion: string;
  /**
   * Calibration pinning: provider, model, modelVersion, questionHash,
   * calibrationVersion, and whether this result may satisfy a protected
   * gate. Absent only on results built outside the review service.
   */
  calibration?: ReviewCalibrationPin;
  /**
   * Per-check provenance for judged reviews: the maximum probability seen
   * for each check and how many chunks contributed. Absent for purely
   * deterministic outcomes. Preserved so a collapsed maximum can always
   * be traced back to its contributing judgments.
   */
  judged?: { chunks: number; checks: Record<string, { p: number; chunks: number }> };
}

const FALLBACK_POLICY: PolicyConfig = {
  policy_version: "1",
  thresholds: { block: 0.85, security_review: 0.6 },
};

export function applyReviewPolicy(args: {
  deterministic: DetectorResult;
  judged: JudgedChunk[];
  policy?: PolicyConfig;
}): ReviewResult {
  const policy = args.policy ?? FALLBACK_POLICY;
  if (args.deterministic.hardBlock.length > 0) {
    return { lane: "BLOCK", source: "deterministic", findings: args.deterministic.hardBlock, policyVersion: policy.policy_version };
  }
  const maxProb = (id: string): number =>
    args.judged.reduce((m, j) => Math.max(m, j.probabilities[id] ?? 0), 0);
  const securityIds = ["security-permissions", "security-secrets", "security-obfuscation", "security"];
  const topSecurity = Math.max(0, ...securityIds.map(maxProb));
  const topAny = args.judged.reduce((m, j) => Math.max(m, ...Object.values(j.probabilities)), 0);
  if (topSecurity >= policy.thresholds.block || topAny >= policy.thresholds.block) {
    return {
      lane: "BLOCK",
      source: "jev",
      findings: args.deterministic.review,
      probabilities: { security: topSecurity },
      policyVersion: policy.policy_version,
    };
  }
  if (topSecurity >= policy.thresholds.security_review) {
    return {
      lane: "SECURITY REVIEW",
      source: args.deterministic.review.length > 0 ? "combined" : "jev",
      findings: args.deterministic.review,
      probabilities: { security: topSecurity },
      policyVersion: policy.policy_version,
    };
  }
  if (args.deterministic.review.length > 0 || args.deterministic.notes.length > 0) {
    return {
      lane: "NITS",
      source: args.judged.length > 0 ? "combined" : "deterministic",
      findings: [...args.deterministic.review, ...args.deterministic.notes],
      policyVersion: policy.policy_version,
    };
  }
  return { lane: "MERGE", source: args.judged.length > 0 ? "jev" : "deterministic", findings: [], policyVersion: policy.policy_version };
}
