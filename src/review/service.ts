import type { DecisionModel } from "../decision/types.js";
import { chunkDiff, type DiffChunk } from "./chunk.js";
import { redactSecretsForModel, type DetectorResult, runDetectors, type ReviewInput } from "./detectors.js";
import {
  applyReviewPolicy,
  isProtectedReviewSatisfied,
  type JudgedChunk,
  type PolicyConfig,
  PROTECTED_GATE_REASONS,
  type ReviewCalibrationPin,
  type ReviewResult,
} from "./policy.js";
import { buildReviewQuestions, type CheckDef } from "./questions.js";
import { hashReviewChecks } from "./load-config.js";

export { isProtectedReviewSatisfied, PROTECTED_GATE_REASONS };

/**
 * Redact live-secret-looking literals before a diff reaches an external
 * inference provider. Deterministic detectors already hard-block on these,
 * so redaction is defense in depth — never the primary control. Kept for
 * existing callers; new code should use `redactSecretsForModel` directly.
 */
export function redactForModel(text: string): string {
  return redactSecretsForModel(text);
}

/** Collapse judged chunks into per-check provenance without losing attribution. */
function provenanceOf(judged: JudgedChunk[]): NonNullable<ReviewResult["judged"]> {
  const checks: Record<string, { p: number; chunks: number }> = {};
  for (const chunk of judged) {
    for (const [id, p] of Object.entries(chunk.probabilities)) {
      const seen = checks[id];
      if (seen === undefined) checks[id] = { p, chunks: 1 };
      else {
        seen.p = Math.max(seen.p, p);
        seen.chunks += 1;
      }
    }
  }
  return { chunks: judged.length, checks };
}

export type ReviewConfigStatus = "ready" | "absent" | "partial" | "invalid" | "uncalibrated";

export interface ReviewConfig {
  checks: CheckDef[];
  policy: PolicyConfig;
  chunking?: number;
  /**
   * Maximum concurrent model evaluations. Bounds inference cost and
   * provider load; defaults to 4.
   */
  maxConcurrency?: number;
  /**
   * Maximum chunks judged per review. A diff that chunks beyond this is
   * refused (UNAVAILABLE) rather than partially judged: a partial review
   * must never be represented as a completed one. Defaults to 32.
   */
  maxChunks?: number;
  /**
   * Loader status. Absent for hand-built configs (treated as ready).
   * absent/partial/invalid fail closed; uncalibrated degrades to
   * UNAVAILABLE unless the caller binds an explicit calibration.
   */
  status?: ReviewConfigStatus;
  /**
   * Set when review configuration was found but unusable. A protected
   * operation gated on this review must fail closed, never fall back to
   * an uncalibrated default policy.
   */
  invalid?: string;
  /**
   * The backend+model the caller is actually judging with. When the loaded
   * policy is not marked calibrated for exactly this pair, the review is
   * UNAVAILABLE: unmeasured thresholds must never auto-pass a protected
   * operation. Omit only for explicitly advisory-only use.
   *
   * `questionHash`, when given, pins the exact question set the thresholds
   * were measured against; a mismatch fails closed. `modelVersion` and
   * `calibrationVersion` are recorded on the result pin when supplied.
   */
  expectedCalibration?: {
    backend: string;
    model: string;
    questionHash?: string;
    modelVersion?: string;
    calibrationVersion?: string;
    datasetRevision?: string;
    evaluationHash?: string;
  };
}

export type { ReviewInput, ReviewResult, DetectorResult };

export class ReviewService {
  constructor(
    private readonly model: DecisionModel | null,
    private readonly config: ReviewConfig,
  ) {}

  private localQuestionHash(): string {
    return hashReviewChecks(this.config.checks);
  }

  private calibrationBound(observed?: { provider?: string; model?: string }): boolean {
    if (this.config.status === "uncalibrated") return false;
    const expected = this.config.expectedCalibration;
    if (expected === undefined) return true;
    // OpenRouter chat-generated estimates are advisory only: they can
    // never be calibration-bound, even if a policy claimed otherwise.
    if (expected.backend === "openrouter") return false;
    const provenance = this.config.policy.provenance;
    if (!(provenance?.calibrated === true && provenance.backend === expected.backend && provenance.model === expected.model)) {
      return false;
    }
    // `calibrated: true` is only a claim. Enforcement eligibility requires
    // the exact decision questions, model pins, dataset revision, and a
    // content hash for the recorded evaluation results.
    const questionHash = this.localQuestionHash();
    if (typeof provenance.questionHash !== "string" || provenance.questionHash !== questionHash) return false;
    if (typeof provenance.modelVersion !== "string" || provenance.modelVersion.length === 0) return false;
    if (typeof provenance.calibrationVersion !== "string" || provenance.calibrationVersion.length === 0) return false;
    if (typeof provenance.datasetRevision !== "string" || provenance.datasetRevision.length === 0) return false;
    if (typeof provenance.evaluationHash !== "string" || !/^[0-9a-f]{64}$/.test(provenance.evaluationHash)) return false;
    if (expected.modelVersion !== undefined && provenance.modelVersion !== expected.modelVersion) return false;
    if (expected.calibrationVersion !== undefined && provenance.calibrationVersion !== expected.calibrationVersion) return false;
    if (expected.datasetRevision !== undefined && provenance.datasetRevision !== expected.datasetRevision) return false;
    if (expected.evaluationHash !== undefined && provenance.evaluationHash !== expected.evaluationHash) return false;
    if (observed?.provider !== undefined && observed.provider !== expected.backend) return false;
    if (observed?.model !== undefined && observed.model !== expected.model) return false;
    // When the caller pins the measured question set, the checks in use
    // must hash to exactly that — and to the recorded hash when the
    // policy carries one. Edited questions invalidate calibration.
    if (expected.questionHash !== undefined && questionHash !== expected.questionHash) return false;
    return true;
  }

  private calibrationDetail(): string {
    const provenance = this.config.policy.provenance;
    const expected = this.config.expectedCalibration;
    const have = `calibrated=${String(provenance?.calibrated === true)} backend=${provenance?.backend ?? "?"} model=${provenance?.model ?? "?"} questionHash=${this.localQuestionHash().slice(0, 12)}`;
    return expected === undefined ? have : `${have}; expected backend=${expected.backend} model=${expected.model}`;
  }

  /**
   * Build the calibration pin attached to every result. `observed` carries
   * the provider/model/questionHash reported by the inference call when
   * present; otherwise the expected binding and local question hash apply.
   * OpenRouter output is always uncalibrated/advisory.
   */
  private pin(observed?: { provider?: string; model?: string; questionHash?: string }): ReviewCalibrationPin {
    const provenance = this.config.policy.provenance;
    const expected = this.config.expectedCalibration;
    const provider = observed?.provider ?? expected?.backend ?? provenance?.backend ?? "unknown";
    const model = observed?.model ?? expected?.model ?? provenance?.model ?? "unknown";
    const questionHash = observed?.questionHash ?? this.localQuestionHash();
    // Pins describe recorded calibration provenance; expected values must
    // never be echoed as if they had been measured.
    const modelVersion = provenance?.modelVersion ?? model;
    const calibrationVersion = provenance?.calibrationVersion ?? this.config.policy.policy_version;
    const questionMatches =
      (expected?.questionHash === undefined || questionHash === expected.questionHash) &&
      (provenance?.questionHash === undefined || questionHash === provenance.questionHash);
    if (provider === "openrouter") {
      return {
        provider,
        model,
        modelVersion,
        questionHash,
        calibrationVersion,
        calibrated: false,
        advisory: true,
        reason: PROTECTED_GATE_REASONS.advisoryProvider,
      };
    }
    if (!questionMatches) {
      return {
        provider,
        model,
        modelVersion,
        questionHash,
        calibrationVersion,
        calibrated: false,
        advisory: true,
        reason: PROTECTED_GATE_REASONS.questionHashMismatch,
      };
    }
    const bound = this.calibrationBound(observed) && observed?.provider !== "openrouter";
    if (!bound) {
      const modelVersionMismatch =
        expected?.modelVersion !== undefined && provenance?.modelVersion !== expected.modelVersion;
      const calibrationVersionMismatch =
        expected?.calibrationVersion !== undefined && provenance?.calibrationVersion !== expected.calibrationVersion;
      const modelMismatch =
        (observed?.provider !== undefined && expected?.backend !== undefined && observed.provider !== expected.backend) ||
        (observed?.model !== undefined && expected?.model !== undefined && observed.model !== expected.model) ||
        (provenance?.backend !== undefined && expected?.backend !== undefined && provenance.backend !== expected.backend) ||
        (provenance?.model !== undefined && expected?.model !== undefined && provenance.model !== expected.model);
      const reason = modelVersionMismatch
        ? PROTECTED_GATE_REASONS.modelVersionMismatch
        : calibrationVersionMismatch
          ? PROTECTED_GATE_REASONS.calibrationVersionMismatch
          : modelMismatch
            ? PROTECTED_GATE_REASONS.modelMismatch
            : PROTECTED_GATE_REASONS.uncalibrated;
      return {
        provider,
        model,
        modelVersion,
        questionHash,
        calibrationVersion,
        calibrated: false,
        advisory: true,
        reason,
      };
    }
    return { provider, model, modelVersion, questionHash, calibrationVersion, calibrated: true, advisory: false };
  }

  private pinned(base: ReviewResult, observed?: { provider?: string; model?: string; questionHash?: string }): ReviewResult {
    return { ...base, calibration: this.pin(observed) };
  }

  /**
   * Judge every chunk with bounded concurrency. A chunk that throws or
   * returns no usable judgments fails the whole review (undefined) rather
   * than letting the remaining chunks masquerade as a complete review.
   */
  private async judgeChunks(
    model: DecisionModel,
    chunks: DiffChunk[],
    input: ReviewInput,
  ): Promise<{ judged: JudgedChunk[]; provider?: string; model?: string; questionHash?: string } | { redactionFailed: true } | undefined> {
    // A model with no checks to answer cannot produce a review: judging
    // zero questions and calling the result MERGE would be fabrication.
    const expected = this.config.checks.map((check) => check.id);
    if (expected.length === 0) return undefined;
    const limit = Math.max(1, this.config.maxConcurrency ?? 4);
    const out: JudgedChunk[] = new Array(chunks.length);
    let next = 0;
    let failed = false;
    let redactionFailed = false;
    let provider: string | undefined;
    let modelName: string | undefined;
    let questionHash: string | undefined;
    const workers = Array.from({ length: Math.min(limit, chunks.length) }, async () => {
      while (next < chunks.length && !failed) {
        const index = next;
        next += 1;
        const chunk = chunks[index];
        if (chunk === undefined) continue;
        // Redact BEFORE the external call. If redaction cannot run, the
        // chunk is never sent: fail closed rather than leaking raw text.
        let redactedDiff: string;
        try {
          redactedDiff = redactSecretsForModel(chunk.text);
        } catch {
          redactionFailed = true;
          return;
        }
        try {
          const questions = buildReviewQuestions(chunk, this.config.checks);
          const result = await model.evaluate({
            state: {
              diff: redactedDiff,
              title: input.title ?? "",
              description: input.description ?? "",
              files: input.files ?? chunk.files,
            },
            questions,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          if (typeof (result as { provider?: unknown }).provider === "string") {
            provider = (result as { provider: string }).provider;
          }
          if (typeof (result as { model?: unknown }).model === "string") {
            modelName = (result as { model: string }).model;
          }
          if (typeof (result as { questionHash?: unknown }).questionHash === "string") {
            questionHash = (result as { questionHash: string }).questionHash;
          }
          const probabilities: Record<string, number> = {};
          for (const [id, answer] of Object.entries(result.answers ?? {})) {
            if (answer !== null && typeof answer === "object" && (answer as { type?: unknown }).type === "noul") {
              const p = (answer as { noul?: unknown }).noul;
              if (typeof p === "number" && Number.isFinite(p)) probabilities[id] = p;
            }
          }
          // Every configured check must be answered, and every answer must
          // be a probability in [0,1]. A missing check, an out-of-range
          // value, or a non-numeric answer means this chunk was not judged
          // — the whole review is UNAVAILABLE rather than decided on a
          // subset of its checks.
          const complete = expected.every(
            (id) =>
              typeof probabilities[id] === "number" &&
              Number.isFinite(probabilities[id]) &&
              (probabilities[id] as number) >= 0 &&
              (probabilities[id] as number) <= 1,
          );
          if (!complete) {
            failed = true;
            return;
          }
          out[index] = { probabilities };
        } catch {
          failed = true;
          return;
        }
      }
    });
    await Promise.all(workers);
    if (redactionFailed) return { redactionFailed: true as const };
    if (failed) return undefined;
    return {
      judged: out,
      ...(provider !== undefined ? { provider } : {}),
      ...(modelName !== undefined ? { model: modelName } : {}),
      ...(questionHash !== undefined ? { questionHash } : {}),
    };
  }

  private unavailableFinding(
    id: string,
    message: string,
    observed?: { provider?: string; model?: string; questionHash?: string },
  ): ReviewResult {
    return this.pinned(
      {
        lane: "UNAVAILABLE",
        source: "deterministic",
        findings: [{ id, severity: "review", message }],
        policyVersion: this.config.policy.policy_version,
      },
      observed,
    );
  }

  async review(input: ReviewInput): Promise<ReviewResult> {
    // Absent, partially installed, or invalid configuration is never
    // silently replaced by an empty rule set: fail closed.
    if (this.config.invalid !== undefined || this.config.status === "absent" || this.config.status === "partial") {
      const status = this.config.status ?? "invalid";
      return this.pinned({
        lane: "BLOCK",
        source: "deterministic",
        findings: [
          {
            id: "config:invalid-review-config",
            severity: "hard",
            message: `Review config ${status}, failing closed: ${this.config.invalid ?? "mandatory review unavailable"}`,
          },
        ],
        policyVersion: this.config.policy.policy_version,
      });
    }
    const deterministic = runDetectors(input);
    if (deterministic.hardBlock.length > 0) {
      return this.pinned({ lane: "BLOCK", source: "deterministic", findings: deterministic.hardBlock, policyVersion: this.config.policy.policy_version });
    }
    // Uncalibrated (or wrong-backend) policy never judges: unmeasured
    // thresholds must not auto-pass a protected operation. This check sits
    // after detectors so deterministic hard-blocks still fire, and only
    // applies when a model is present — the keyless path below is already
    // advisory-only and must not block ordinary work.
    if (this.model !== null && !this.calibrationBound()) {
      const expected = this.config.expectedCalibration;
      if (expected?.backend === "openrouter") {
        return this.unavailableFinding(
          "config:openrouter-advisory",
          `OpenRouter estimates are advisory only (${PROTECTED_GATE_REASONS.advisoryProvider}); refusing to judge a protected operation (UNAVAILABLE, never MERGE): ${this.calibrationDetail()}`,
        );
      }
      const localHash = this.localQuestionHash();
      if (
        (expected?.questionHash !== undefined && localHash !== expected.questionHash) ||
        (this.config.policy.provenance?.questionHash !== undefined &&
          localHash !== this.config.policy.provenance.questionHash)
      ) {
        return this.unavailableFinding(
          "config:question-hash-mismatch",
          `Review question set changed since calibration (${PROTECTED_GATE_REASONS.questionHashMismatch}); refusing to judge (UNAVAILABLE, never MERGE): ${this.calibrationDetail()}`,
        );
      }
      return this.unavailableFinding(
        "config:uncalibrated-review-policy",
        `Review policy is not calibrated for this backend/model (${PROTECTED_GATE_REASONS.uncalibrated}); refusing to judge (UNAVAILABLE, never MERGE): ${this.calibrationDetail()}`,
      );
    }
    if (this.model === null) {
      if (deterministic.review.length > 0 || deterministic.notes.length > 0) {
        return this.pinned({
          lane: "NITS",
          source: "deterministic",
          findings: [...deterministic.review, ...deterministic.notes],
          policyVersion: this.config.policy.policy_version,
        });
      }
      return this.pinned({ lane: "UNAVAILABLE", source: "deterministic", findings: [], policyVersion: this.config.policy.policy_version });
    }
    const model = this.model;
    if (model === null) return this.pinned({ lane: "UNAVAILABLE" as const, source: "deterministic" as const, findings: [], policyVersion: this.config.policy.policy_version });
    const chunks = chunkDiff(input.diff, this.config.chunking);
    const maxChunks = this.config.maxChunks ?? 32;
    if (chunks.length > maxChunks) {
      return this.unavailableFinding(
        "review:diff-too-large",
        `Diff chunked into ${chunks.length} pieces (budget ${maxChunks}); refusing to judge partially (UNAVAILABLE, never MERGE). Split the change and retry.`,
      );
    }
    const outcome = await this.judgeChunks(model, chunks, input);
    if (outcome !== undefined && "redactionFailed" in outcome) {
      return this.unavailableFinding(
        "review:redaction-failed",
        "Secret redaction failed before inference; refusing to send unredacted diff text to the Jev provider (UNAVAILABLE, never MERGE).",
      );
    }
    if (outcome === undefined) {
      return this.unavailableFinding(
        "review:model-error",
        "Review inference failed or returned no usable judgments; refusing to judge partially (UNAVAILABLE, never MERGE).",
      );
    }
    // The answering backend is authoritative: OpenRouter output is
    // advisory-only no matter what was expected, and a question-hash drift
    // observed mid-review fails closed rather than judging on unmeasured
    // questions.
    const observed = {
      ...(outcome.provider !== undefined ? { provider: outcome.provider } : {}),
      ...(outcome.model !== undefined ? { model: outcome.model } : {}),
      ...(outcome.questionHash !== undefined ? { questionHash: outcome.questionHash } : {}),
    };
    if (outcome.provider === "openrouter") {
      return this.unavailableFinding(
        "review:openrouter-advisory",
        `Review answered via OpenRouter; estimates are advisory only (${PROTECTED_GATE_REASONS.advisoryProvider}) and never satisfy a protected gate (UNAVAILABLE, never MERGE).`,
        observed,
      );
    }
    if (!this.calibrationBound(observed)) {
      const provenance = this.config.policy.provenance;
      const expected = this.config.expectedCalibration;
      const modelVersionMismatch = expected?.modelVersion !== undefined && provenance?.modelVersion !== expected.modelVersion;
      const calibrationVersionMismatch = expected?.calibrationVersion !== undefined && provenance?.calibrationVersion !== expected.calibrationVersion;
      const modelMismatch =
        (observed.provider !== undefined && expected?.backend !== undefined && observed.provider !== expected.backend) ||
        (observed.model !== undefined && expected?.model !== undefined && observed.model !== expected.model) ||
        (provenance?.backend !== undefined && expected?.backend !== undefined && provenance.backend !== expected.backend) ||
        (provenance?.model !== undefined && expected?.model !== undefined && provenance.model !== expected.model);
      const reason = modelVersionMismatch
        ? PROTECTED_GATE_REASONS.modelVersionMismatch
        : calibrationVersionMismatch
          ? PROTECTED_GATE_REASONS.calibrationVersionMismatch
          : modelMismatch
            ? PROTECTED_GATE_REASONS.modelMismatch
            : PROTECTED_GATE_REASONS.uncalibrated;
      return this.unavailableFinding(
        "review:calibration-pin-mismatch",
        `Review calibration pin does not match the configured inference and measured provenance (${reason}); refusing to judge (UNAVAILABLE, never MERGE).`,
        observed,
      );
    }
    const expectedHash = this.config.expectedCalibration?.questionHash;
    const recordedHash = this.config.policy.provenance?.questionHash;
    if (
      (outcome.questionHash !== undefined &&
        ((expectedHash !== undefined && outcome.questionHash !== expectedHash) ||
          (recordedHash !== undefined && outcome.questionHash !== recordedHash))) ||
      (outcome.questionHash === undefined &&
        ((expectedHash !== undefined && this.localQuestionHash() !== expectedHash) ||
          (recordedHash !== undefined && this.localQuestionHash() !== recordedHash)))
    ) {
      return this.unavailableFinding(
        "review:question-hash-mismatch",
        `Review question set does not match the calibrated set (${PROTECTED_GATE_REASONS.questionHashMismatch}); refusing to judge (UNAVAILABLE, never MERGE).`,
        observed,
      );
    }
    const result = applyReviewPolicy({ deterministic, judged: outcome.judged, policy: this.config.policy });
    result.judged = provenanceOf(outcome.judged);
    return this.pinned(result, observed);
  }
}

export function reviewToReason(result: ReviewResult): string {
  if (result.findings.length === 0) return `review: ${result.lane}`;
  // Reasons feed evidence receipts and logs, which must carry redacted
  // text only. Finding messages are already literal-free labels, and this
  // pass is the backstop. If redaction itself cannot run, emit the lane
  // alone rather than unredacted text.
  let lines: string[];
  try {
    lines = result.findings.map((f) => `- ${redactSecretsForModel(f.message)}`);
  } catch {
    return `review: ${result.lane}`;
  }
  return [`review: ${result.lane}`, ...lines].join("\n");
}
