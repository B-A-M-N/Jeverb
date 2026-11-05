/**
 * Three-stage mission-closure lockbox scoring.
 *
 * Purpose: measure deterministic preflight, semantic-model judgment, and the
 * integrated production decision separately on the same lockbox case, so a
 * model-only failure cannot be misread as a production-system failure (or
 * vice versa). The text-only lockbox mapper is explicitly legacy-only;
 * new semantic-candidate scoring accepts a host-built trusted snapshot.
 * Version-2 rows retain sanitized per-call identity, usage, and
 * latency; verification still accepts immutable version-1 historical rows.
 * The integrated stage calls the exact production entry point
 * `decideMissionClosure`, never a reimplementation of it.
 *
 * Forbidden responsibilities: this module scores and reports. It never sets
 * enforcement policy, never marks a model calibrated, and never grants
 * terminal authority — the bench policy below carries `calibrated: true` as
 * an explicit measurement premise ("as if this model were the calibrated
 * one"), recorded in every summary, so the integrated stage exercises the
 * full production path instead of stopping at the calibration gate.
 *
 * Owner: src/jev/lockbox.ts (three-stage lockbox measurement).
 * May be imported by: scripts/jev-lockbox.ts, tests.
 */
import {
  classifySemanticFailure,
  affirmativeRequest,
  decideMissionClosure,
  MISSION_CLOSURE_CHOICES,
  preflightMissionClosure,
  preflightReachedReview,
  semanticFulfillmentCandidateRequest,
  MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2,
  MISSION_SEMANTIC_FULFILLMENT_CHOICES,
  type SemanticFulfillmentChoice,
  validSemanticDistribution,
  type MissionClosureDecision,
  type MissionClosureEvidence,
  type MissionClosurePolicy,
  type SemanticFailure,
} from "../mission/closure.js";
import { hashQuestions } from "../decision/provenance.js";
import type { CalibrationCase } from "./calibration.js";
import type { ChoiceAnswer, DecisionModel, EvaluateResult, Usage } from "../decision/types.js";

export const LOCKBOX_BENCH_VERSION = "mission-lockbox/1";
/** Schema version for one recorded three-stage score row. */
export const LOCKBOX_ROW_VERSION = "mission-lockbox-row/3";
const PREVIOUS_LOCKBOX_ROW_VERSION = "mission-lockbox-row/2";
const LEGACY_LOCKBOX_ROW_VERSION = "mission-lockbox-row/1";

/** Lockbox `state` shape for mission-completion cases. */
interface LockboxState {
  objective?: unknown;
  acceptanceCriteria?: Array<{ id?: unknown; statement?: unknown; outcome?: unknown; evidenceRef?: unknown }>;
  tests?: { passed?: unknown; independent?: unknown; evidenceRef?: unknown };
  operations?: { pending?: unknown; uncertain?: unknown };
  blockers?: Array<{ id?: unknown; unresolved?: unknown }>;
  graphRuns?: MissionClosureEvidence["graphRuns"];
  missionRevision?: unknown;
  evidenceRevision?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Map a lockbox case state to production `MissionClosureEvidence`.
 *
 * Documented fill-ins where the lockbox dataset carries no separate field:
 * `missionId` is the case id; per-criterion revisions and the tests revision
 * reuse the case-level revisions (the dataset holds one revision pair per
 * case). A criterion counts as verified only when it carries a non-empty
 * outcome and evidence reference.
 */
export function lockboxEvidence(caseId: string, state: unknown): MissionClosureEvidence {
  // A plain lockbox row is untrusted benchmark narrative. Keep the shape for
  // analysis, but never promote non-empty strings to verified outcomes.
  const legacy = lockboxLegacyEvidence(caseId, state);
  return { ...legacy, criteria: legacy.criteria.map((criterion) => ({ ...criterion, verified: false })) };
}

/**
 * Historical v1/v2/v3 replay mapper. It preserves the former textual
 * `outcome + evidenceRef` heuristic solely so immutable receipts can still
 * be independently replayed. Its `verified` bit is not host verification;
 * new evaluation code must use a session-source snapshot from the trusted
 * v2 path instead.
 */
export function lockboxLegacyEvidence(caseId: string, state: unknown): MissionClosureEvidence {
  const s = (state ?? {}) as LockboxState;
  const missionRevision = asString(s.missionRevision) ?? "";
  const evidenceRevision = asString(s.evidenceRevision) ?? "";
  const criteria = Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria : [];
  const tests = s.tests ?? {};
  const testsEvidenceRef = asString(tests.evidenceRef);
  const operations = s.operations ?? {};
  const blockers = Array.isArray(s.blockers) ? s.blockers : [];
  return {
    missionId: caseId,
    objective: asString(s.objective) ?? "",
    missionRevision,
    evidenceRevision,
    criteria: criteria.map((criterion) => {
      const outcome = asString(criterion.outcome);
      const evidenceRef = asString(criterion.evidenceRef);
      return {
        id: asString(criterion.id) ?? "",
        statement: asString(criterion.statement) ?? "",
        verified:
          outcome !== undefined && outcome.trim().length > 0 &&
          evidenceRef !== undefined && evidenceRef.length > 0,
        ...(outcome === undefined ? {} : { outcome }),
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
        missionRevision,
        evidenceRevision,
      };
    }),
    tests: {
      passed: tests.passed === true,
      independent: tests.independent === true,
      ...(testsEvidenceRef === undefined ? {} : { evidenceRef: testsEvidenceRef }),
      revision: evidenceRevision,
    },
    operations: {
      pending: asNumber(operations.pending) ?? 0,
      uncertain: asNumber(operations.uncertain) ?? 0,
    },
    blockers: blockers.map((blocker) => ({
      id: asString(blocker.id) ?? "",
      unresolved: blocker.unresolved === true,
    })),
    ...(s.graphRuns === undefined ? {} : { graphRuns: s.graphRuns }),
  };
}

export interface LockboxPolicyOptions {
  policyVersion: string;
  minConfidence: number;
  backend: string;
  model: string;
  modelVersion: string;
  calibrationVersion?: string;
}

/**
 * Build the bench policy binding one exact backend/model/question set.
 * `calibrated: true` is the measurement premise documented above.
 */
export function lockboxPolicy(
  questions: CalibrationCase["questions"],
  options: LockboxPolicyOptions,
): MissionClosurePolicy {
  return {
    policyVersion: options.policyVersion,
    minConfidence: options.minConfidence,
    calibrated: true,
    backend: options.backend,
    model: options.model,
    modelVersion: options.modelVersion,
    questionHash: hashQuestions(questions),
    calibrationVersion: options.calibrationVersion ?? LOCKBOX_BENCH_VERSION,
  };
}

export interface LockboxPolicySnapshot {
  policyVersion: string;
  backend: string;
  model: string;
  modelVersion: string;
  minConfidence: number;
  calibrationVersion: string | undefined;
}

export interface SemanticFulfillmentCandidateScore {
  status: "answered" | "preflight-stopped" | "invalid" | "unavailable";
  expected: SemanticFulfillmentChoice;
  choice?: string;
  correct?: boolean;
  confidence?: number;
  probabilities?: Record<string, number>;
  provider?: string;
  model?: string;
  questionHash?: string;
  requestId?: string;
  latencyMs?: number;
  usage?: Usage;
  error?: string;
}

export interface SemanticQuestionPairScore {
  status: "scored" | "preflight-stopped" | "invalid-identity" | "identity-mismatch" | "model-error";
  inferenceRequests: number;
  baselineFailure?: string;
  baseline?: {
    choice?: string;
    confidence?: number;
    probabilities?: Record<string, number>;
    semanticChoice?: SemanticFulfillmentChoice;
    semanticCorrect?: boolean;
    provider?: string;
    model?: string;
    questionHash?: string;
    requestId?: string;
    latencyMs?: number;
    usage?: Usage;
    failure?: string;
    terminalGateAccepted: boolean;
    terminalDecision: MissionClosureDecision["status"];
  };
  candidate?: SemanticFulfillmentCandidateScore;
}

function baselineSemanticChoice(choice: string | undefined): SemanticFulfillmentChoice | undefined {
  if (choice === "COMPLETE") return "FULFILLED";
  if (choice === "INCOMPLETE" || choice === "BLOCKED") return "NOT_FULFILLED";
  if (choice === "INSUFFICIENT_EVIDENCE") return "UNCERTAIN";
  return undefined;
}

/**
 * Paired development comparison on the same trusted v2 snapshot. The existing
 * four-choice response is evaluated once, then fed through the real
 * `decideMissionClosure` path via a question-hash-bound cache so its 0.90
 * terminal gate is measured without a duplicate provider call. The distinct
 * semantic question is one additional call. This function is measurement
 * only and cannot activate candidate routing or completion authority.
 */
export async function scoreSemanticQuestionPair(args: {
  model: DecisionModel;
  evidence: MissionClosureEvidence;
  baselinePolicy: MissionClosurePolicy;
  candidatePolicy: MissionClosurePolicy;
  expected: SemanticFulfillmentChoice;
}): Promise<SemanticQuestionPairScore> {
  const { model, evidence, baselinePolicy, candidatePolicy, expected } = args;
  const baselineRequest = affirmativeRequest(evidence);
  const baselineQuestionHash = hashQuestions(baselineRequest.questions);
  const preflight = preflightMissionClosure(evidence, baselinePolicy);
  if (!preflightReachedReview(preflight)) return { status: "preflight-stopped", inferenceRequests: 0 };
  if (
    baselinePolicy.questionHash !== baselineQuestionHash ||
    candidatePolicy.backend !== baselinePolicy.backend ||
    candidatePolicy.model !== baselinePolicy.model ||
    candidatePolicy.modelVersion !== baselinePolicy.modelVersion ||
    candidatePolicy.minConfidence !== baselinePolicy.minConfidence ||
    semanticFulfillmentCandidateRequest(evidence, candidatePolicy) === undefined
  ) return { status: "invalid-identity", inferenceRequests: 0 };

  let baselineResult: EvaluateResult | undefined;
  let baselineFailure: string | undefined;
  try {
    baselineResult = await model.evaluate(baselineRequest);
  } catch (error) {
    // Record the failed baseline as a measured non-answer. Candidate evaluation
    // still runs so the paired harness preserves both stage outcomes.
    const failure = classifySemanticFailure(error);
    baselineFailure = `${failure.kind}: ${failure.detail}`;
  }

  if (baselineResult !== undefined && (
    baselineResult.provider !== baselinePolicy.backend ||
    baselineResult.model !== baselinePolicy.modelVersion ||
    baselineResult.questionHash !== baselineQuestionHash
  )) return {
    status: "identity-mismatch",
    inferenceRequests: 1,
    baseline: {
      provider: baselineResult.provider,
      model: baselineResult.model,
      questionHash: baselineResult.questionHash,
      ...(baselineResult.correlationId === undefined ? {} : { requestId: baselineResult.correlationId }),
      latencyMs: baselineResult.latency_ms,
      usage: { ...baselineResult.usage },
      terminalGateAccepted: false,
      terminalDecision: "INSUFFICIENT_EVIDENCE",
    },
  };

  let baseline: SemanticQuestionPairScore["baseline"];
  if (baselineResult !== undefined) {
    const raw = baselineResult.answers.closure;
    const choiceAnswer = raw?.type === "choice" ? raw as ChoiceAnswer : undefined;
    const captured = baselineResult;
    const cachedModel = new Proxy(model, {
      get(target, property, receiver) {
        if (property === "evaluate") {
          return async (request: Parameters<DecisionModel["evaluate"]>[0]) => {
            if (hashQuestions(request.questions) !== baselineQuestionHash) {
              throw new Error("paired baseline cache rejected a different question set");
            }
            return captured as unknown as EvaluateResult<typeof request.questions>;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const decision = await decideMissionClosure(cachedModel, evidence, baselinePolicy);
    const semanticChoice = baselineSemanticChoice(choiceAnswer?.choice);
    baseline = {
      ...(choiceAnswer === undefined ? {} : {
        choice: choiceAnswer.choice,
        confidence: choiceAnswer.confidence,
        probabilities: { ...choiceAnswer.probabilities },
      }),
      ...(semanticChoice === undefined ? {} : {
        semanticChoice,
        semanticCorrect: semanticChoice === expected,
      }),
      provider: captured.provider,
      model: captured.model,
      questionHash: captured.questionHash,
      ...(captured.correlationId === undefined ? {} : { requestId: captured.correlationId }),
      latencyMs: captured.latency_ms,
      usage: { ...captured.usage },
      terminalGateAccepted: decision.complete,
      terminalDecision: decision.status,
    };
  }

  const candidate = await scoreSemanticFulfillmentCandidate(model, evidence, candidatePolicy, expected);
  const candidateQuestionHash = hashQuestions({ closure: MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2 });
  if (candidate.status === "invalid" && (
    (candidate.provider !== undefined && candidate.provider !== candidatePolicy.backend) ||
    (candidate.model !== undefined && candidate.model !== candidatePolicy.modelVersion) ||
    (candidate.questionHash !== undefined && candidate.questionHash !== candidateQuestionHash)
  )) return {
    status: "identity-mismatch", inferenceRequests: 2,
    ...(baseline === undefined ? {} : { baseline }), candidate,
  };
  return {
    status: baseline !== undefined && candidate.status === "answered" ? "scored" : "model-error",
    inferenceRequests: 1 + Number(candidate.status !== "preflight-stopped"),
    ...(baseline === undefined ? {} : { baseline }),
    ...(baselineFailure === undefined ? {} : { baselineFailure }),
    candidate,
  };
}

/**
 * Development-only scorer for the separately versioned semantic question.
 * It accepts only a trusted host snapshot that passes the production
 * deterministic preflight, records semantic accuracy independently of the
 * production four-choice confidence gate, and never authorizes completion.
 */
export async function scoreSemanticFulfillmentCandidate(
  model: DecisionModel,
  evidence: MissionClosureEvidence,
  policy: MissionClosurePolicy,
  expected: SemanticFulfillmentChoice,
): Promise<SemanticFulfillmentCandidateScore> {
  const request = semanticFulfillmentCandidateRequest(evidence, policy);
  if (request === undefined) return { status: "preflight-stopped", expected };
  const questionHash = hashQuestions(request.questions);
  try {
    const result = await model.evaluate(request);
    const raw = result.answers.closure;
    if (
      result.provider !== policy.backend || result.model !== policy.modelVersion || result.questionHash !== questionHash ||
      raw === undefined || raw.type !== "choice" ||
      !(MISSION_SEMANTIC_FULFILLMENT_CHOICES as readonly string[]).includes(raw.choice) ||
      !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1 ||
      Object.keys(raw.probabilities).length !== MISSION_SEMANTIC_FULFILLMENT_CHOICES.length ||
      MISSION_SEMANTIC_FULFILLMENT_CHOICES.some((choice) =>
        !Number.isFinite(raw.probabilities[choice]) || raw.probabilities[choice]! < 0 || raw.probabilities[choice]! > 1,
      ) || Math.abs(Object.values(raw.probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.01 ||
      raw.probabilities[raw.choice]! + 0.01 < Math.max(...Object.values(raw.probabilities)) ||
      Math.abs(raw.confidence - (
        Math.max(...Object.values(raw.probabilities)) - 1 / MISSION_SEMANTIC_FULFILLMENT_CHOICES.length
      ) / (1 - 1 / MISSION_SEMANTIC_FULFILLMENT_CHOICES.length)) > 0.01 ||
      !Number.isFinite(result.latency_ms) || result.latency_ms < 0 ||
      !Number.isSafeInteger(result.usage.input_tokens) || result.usage.input_tokens < 0 ||
      !Number.isSafeInteger(result.usage.output_tokens) || result.usage.output_tokens < 0 ||
      (result.usage.cost_usd !== undefined && (!Number.isFinite(result.usage.cost_usd) || result.usage.cost_usd < 0))
    ) return {
      status: "invalid", expected, provider: result.provider, model: result.model,
      questionHash: result.questionHash,
      ...(result.correlationId === undefined ? {} : { requestId: result.correlationId }),
      ...(raw?.type === "choice" ? {
        choice: raw.choice,
        confidence: raw.confidence,
        probabilities: { ...raw.probabilities },
      } : {}),
      latencyMs: result.latency_ms,
      usage: { ...result.usage },
      error: "semantic response identity, choice, probability distribution, or telemetry is invalid",
    };
    return {
      status: "answered", expected, choice: raw.choice, correct: raw.choice === expected,
      confidence: raw.confidence, probabilities: { ...raw.probabilities }, provider: result.provider,
      model: result.model, questionHash: result.questionHash, latencyMs: result.latency_ms,
      ...(result.correlationId === undefined ? {} : { requestId: result.correlationId }),
      usage: { ...result.usage },
    };
  } catch (error) {
    const failure = classifySemanticFailure(error);
    return { status: "unavailable", expected, questionHash, error: `${failure.kind}: ${failure.detail}` };
  }
}

/** Bounded metadata for one actual model call; never includes prompt or answer text. */
export interface LockboxCallMetadata {
  provider: string;
  model: string;
  questionHash: string;
  usage: Usage;
  latencyMs: number;
  requestId?: string;
  memo?: boolean;
}

/**
 * Integrated-stage outcome, derived from the production decision without
 * parsing reason text. `completed` is terminal COMPLETE; `semantic_refusal`
 * is a reviewed non-COMPLETE verdict; `threshold_hold` is a COMPLETE vote
 * kept below the confidence bar; `unavailable` is a transport/timeout
 * failure with no usable judgment; `invalid_judgment` is a malformed or
 * unbound vote. Absent only when preflight stopped the case before any
 * semantic review ran, and on rows recorded before this field existed.
 */
export type IntegratedOutcome =
  | "completed"
  | "semantic_refusal"
  | "threshold_hold"
  | "unavailable"
  | "invalid_judgment";

export interface LockboxCaseScore {
  rowVersion: string;
  benchVersion: string;
  caseId: string;
  /** sha256 of the dataset bytes the row was scored against. */
  dataset: string;
  /** Question-set hash the row was scored against. */
  questionHash: string;
  /** Policy binding the row was scored against (measurement premise included). */
  policy: LockboxPolicySnapshot;
  expected: string | undefined;
  /** Model id reported by the answering backend (binding evidence). */
  observedModel: string;
  preflightStatus: MissionClosureDecision["status"];
  preflightReady: boolean;
  preflightReason: string;
  modelChoice: string | undefined;
  /** Legacy free-text model-only failure; retained for migration compatibility. */
  modelError?: string | undefined;
  /** Typed model-only failure; absent when the model-only call answered. */
  modelOnlyError?: SemanticFailure;
  modelConfidence: number | undefined;
  modelProbabilities?: Record<string, number>;
  modelCorrect: boolean;
  integratedStatus: MissionClosureDecision["status"];
  integratedComplete: boolean;
  integratedChoice: string;
  integratedReason: string;
  integratedOutcome?: IntegratedOutcome;
  integratedFailure?: SemanticFailure;
  /** Sanitized provider request id for the model-only call, when the backend supplied one. */
  modelRequestId?: string;
  /** Sanitized provider request id for the integrated judgment, when the backend supplied one. */
  integratedRequestId?: string;
  /** Confidence of the integrated request's own semantic vote, when one ran. */
  integratedConfidence: number | undefined;
  /** Probability distribution of the integrated request's own vote, when one ran. */
  integratedProbabilities: Record<string, number> | undefined;
  integratedCorrect: boolean;
  modelCall?: LockboxCallMetadata;
  integratedCall?: LockboxCallMetadata;
}

function decisionChoice(decision: MissionClosureDecision): string {
  return decision.complete ? "COMPLETE" : decision.status;
}

/**
 * Keep a provider request id only when it is a bounded token: non-empty,
 * short, and charset-clean. Anything else is dropped at the boundary so
 * untrusted backend text never persists into qualification evidence.
 */
function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return undefined;
  if (!/^[A-Za-z0-9_.:=-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function sanitizeIdentity(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return undefined;
  return /^[A-Za-z0-9_.:/@=-]+$/.test(value) ? value : undefined;
}

function callMetadata(result: EvaluateResult): LockboxCallMetadata | undefined {
  const provider = sanitizeIdentity(result.provider);
  const model = sanitizeIdentity(result.model);
  if (
    provider === undefined || model === undefined ||
    !/^[0-9a-f]{64}$/.test(result.questionHash) ||
    !Number.isFinite(result.latency_ms) || result.latency_ms < 0 ||
    !Number.isSafeInteger(result.usage.input_tokens) || result.usage.input_tokens < 0 ||
    !Number.isSafeInteger(result.usage.output_tokens) || result.usage.output_tokens < 0 ||
    (result.usage.cost_usd !== undefined && (!Number.isFinite(result.usage.cost_usd) || result.usage.cost_usd < 0))
  ) return undefined;
  const requestId = sanitizeRequestId(result.correlationId);
  return {
    provider,
    model,
    questionHash: result.questionHash,
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      ...(result.usage.cost_usd === undefined ? {} : { cost_usd: result.usage.cost_usd }),
    },
    latencyMs: result.latency_ms,
    ...(requestId === undefined ? {} : { requestId }),
    ...(result.memo === undefined ? {} : { memo: result.memo }),
  };
}

/**
 * Derive the integrated-stage outcome from the production decision's
 * structure — completion flag, failure classification, recorded vote —
 * never from reason text. Preflight stops carry no outcome: the
 * preflightStops bucket owns them.
 */
function deriveIntegratedOutcome(ready: boolean, decision: MissionClosureDecision): IntegratedOutcome | undefined {
  if (!ready) return undefined;
  if (decision.complete) return "completed";
  const kind = decision.failure?.kind;
  if (kind === "transport" || kind === "timeout") return "unavailable";
  if (kind === "protocol" || kind === "invalid") return "invalid_judgment";
  if (
    decision.confidence !== undefined && decision.probabilities !== undefined &&
    validSemanticDistribution("COMPLETE", decision.confidence, decision.probabilities)
  ) {
    return "threshold_hold";
  }
  return "semantic_refusal";
}

/**
 * Score one lockbox case through all three stages. The model stage answers
 * the case's own question set (today's model-only number); the integrated
 * stage runs the production `decideMissionClosure` on the mapped evidence.
 * This remains the historical text-only scoring path for immutable v1-v3
 * receipts. New evidence qualification must use a trusted session-source
 * snapshot and `scoreSemanticFulfillmentCandidate` instead.
 */
export async function scoreLockboxCase(
  model: DecisionModel,
  lockboxCase: CalibrationCase,
  policy: MissionClosurePolicy,
  dataset: string,
  options: { stopAfterModelOnlyFailureOrBindingMismatch?: boolean } = {},
): Promise<LockboxCaseScore> {
  const expected = lockboxCase.expected.closure?.choice;
  const evidence = lockboxLegacyEvidence(lockboxCase.id, lockboxCase.state);
  const preflight = preflightMissionClosure(evidence, policy);
  const preflightReady = preflightReachedReview(preflight);

  let modelChoice: string | undefined;
  let modelError: string | undefined;
  let modelOnlyError: SemanticFailure | undefined;
  let modelConfidence: number | undefined;
  let modelProbabilities: Record<string, number> | undefined;
  let modelCall: LockboxCallMetadata | undefined;
  let observedModel = model.name;
  let modelRequestId: string | undefined;
  try {
    const result = await model.evaluate({
      state: lockboxCase.state as never,
      questions: lockboxCase.questions,
    });
    observedModel = result.model;
    modelCall = callMetadata(result);
    modelRequestId = sanitizeRequestId(result.correlationId);
    const answer = result.answers.closure;
    if (answer !== undefined && answer.type === "choice") {
      if (modelCall === undefined) {
        modelOnlyError = { kind: "invalid", detail: "model-only response metadata was malformed" };
        modelError = "invalid: model-only response metadata was malformed";
      } else {
        modelChoice = answer.choice;
        modelConfidence = answer.confidence;
        modelProbabilities = { ...answer.probabilities };
      }
    } else if (answer !== undefined) {
      modelOnlyError = { kind: "invalid", detail: `non-choice answer: ${answer.type}` };
      modelError = `invalid: non-choice answer: ${answer.type}`;
    } else {
      modelOnlyError = { kind: "invalid", detail: "answer missing from model result" };
      modelError = "invalid: answer missing from model result";
    }
  } catch (error) {
    modelOnlyError = classifySemanticFailure(error);
    modelError = `${modelOnlyError.kind}: ${modelOnlyError.detail}`;
  }
  const modelCorrect = modelChoice !== undefined && modelChoice === expected;

  // The production entry point never throws (evaluateAffirmative fails
  // closed with a classified decision), but a defensive catch keeps a
  // throwing future from losing the row: unavailability is recorded, never
  // completion.
  let integrated: MissionClosureDecision;
  let integratedResult: EvaluateResult | undefined;
  const stopBeforeIntegrated = options.stopAfterModelOnlyFailureOrBindingMismatch === true && (
    modelOnlyError !== undefined || modelCall === undefined ||
    modelCall.provider !== policy.backend || modelCall.model !== policy.modelVersion ||
    modelCall.questionHash !== policy.questionHash
  );
  const capturingModel = new Proxy(model, {
    get(target, property, receiver) {
      if (property === "evaluate") {
        return async (request: Parameters<DecisionModel["evaluate"]>[0]) => {
          const result = await target.evaluate(request);
          integratedResult = result;
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  if (stopBeforeIntegrated) {
    integrated = {
      ...preflight,
      status: "INSUFFICIENT_EVIDENCE",
      complete: false,
      reasons: ["integrated request skipped after model-only failure or binding mismatch"],
      failure: { kind: "invalid", detail: "integrated request skipped" },
    };
  } else {
    try {
      integrated = await decideMissionClosure(capturingModel, evidence, policy);
    } catch {
      integrated = {
        ...preflight,
        status: "INSUFFICIENT_EVIDENCE",
        complete: false,
        reasons: ["integrated assessment threw; no decision was made"],
        failure: { kind: "transport", detail: "Error" },
      };
    }
  }
  const integratedChoice = decisionChoice(integrated);
  const integratedOutcome = deriveIntegratedOutcome(preflightReady, integrated);
  const integratedRequestId = sanitizeRequestId(integrated.providerRequestId);
  return {
    rowVersion: LOCKBOX_ROW_VERSION,
    benchVersion: LOCKBOX_BENCH_VERSION,
    caseId: lockboxCase.id,
    dataset,
    questionHash: policy.questionHash,
    policy: {
      policyVersion: policy.policyVersion,
      backend: policy.backend,
      model: policy.model,
      modelVersion: policy.modelVersion,
      minConfidence: policy.minConfidence,
      calibrationVersion: policy.calibrationVersion,
    },
    expected,
    observedModel,
    modelConfidence,
    preflightStatus: preflight.status,
    preflightReady,
    preflightReason: preflight.reasons[0] ?? "",
    modelChoice,
    ...(modelError === undefined ? {} : { modelError }),
    ...(modelOnlyError === undefined ? {} : { modelOnlyError }),
    modelCorrect,
    integratedStatus: integrated.status,
    integratedComplete: integrated.complete,
    integratedChoice,
    integratedReason: integrated.reasons[0] ?? "",
    ...(integratedOutcome === undefined ? {} : { integratedOutcome }),
    ...(integrated.failure === undefined ? {} : { integratedFailure: integrated.failure }),
    ...(modelRequestId === undefined ? {} : { modelRequestId }),
    ...(integratedRequestId === undefined ? {} : { integratedRequestId }),
    integratedConfidence: integrated.confidence,
    integratedProbabilities: integrated.probabilities === undefined ? undefined : { ...integrated.probabilities },
    integratedCorrect: expected !== undefined && integratedChoice === expected,
    ...(modelCall === undefined ? {} : { modelCall }),
    ...(modelProbabilities === undefined ? {} : { modelProbabilities }),
    ...(integratedResult === undefined || callMetadata(integratedResult) === undefined
      ? {}
      : { integratedCall: callMetadata(integratedResult)! }),
  };
}

export interface LockboxSummary {
  benchVersion: string;
  calibrationPremise: string;
  cases: number;
  modelCorrect: number;
  integratedCorrect: number;
  preflightReadyOnCompleteExpected: { ready: number; total: number };
  preflightStoppedOnNonCompleteExpected: { stopped: number; total: number };
}

/**
 * Independently verify one recorded three-stage lockbox run.
 *
 * The verifier recomputes everything a deterministic checker can from the
 * labeled dataset, the recorded rows, and the authoritative policy binding:
 * row coverage (no missing, extra, or duplicate cases), dataset and
 * question-set binding, policy-snapshot equality, labeled expectations,
 * preflight reproduction, and the legality of each recorded stage
 * transition. Release tallies must come from `recomputed`, never from the
 * runner's own counters or its `*Correct` booleans (disagreement is itself
 * a rejection). The verifier never re-runs semantic inference: for a
 * preflight-stopped case it proves the integrated outcome equals the
 * preflight outcome with no vote attached; for a reviewed case it proves a
 * well-formed vote with provenance and threshold discipline is recorded.
 */
export interface LockboxVerification {
  ok: boolean;
  errors: string[];
  recomputed: LockboxSummary;
}

function policyMismatch(row: LockboxCaseScore, policy: MissionClosurePolicy): string | undefined {
  const p = row.policy;
  if (p === undefined) return "missing policy snapshot";
  if (
    p.policyVersion !== policy.policyVersion ||
    p.backend !== policy.backend ||
    p.model !== policy.model ||
    p.modelVersion !== policy.modelVersion ||
    p.minConfidence !== policy.minConfidence ||
    (p.calibrationVersion ?? undefined) !== (policy.calibrationVersion ?? undefined)
  ) {
    return "policy snapshot does not match the authoritative binding";
  }
  return undefined;
}

export function verifyLockboxRun(
  cases: CalibrationCase[],
  rows: LockboxCaseScore[],
  policy: MissionClosurePolicy,
  datasetRevision: string,
): LockboxVerification {
  const errors: string[] = [];
  if (!policy.calibrated) {
    errors.push("verifier requires the calibrated measurement premise (policy.calibrated must be true)");
  }
  const labeled = new Map<string, CalibrationCase>();
  for (const c of cases) {
    if (labeled.has(c.id)) errors.push(`duplicate dataset case: ${c.id}`);
    labeled.set(c.id, c);
  }
  const seen = new Map<string, number>();
  for (const row of rows) {
    seen.set(row.caseId, (seen.get(row.caseId) ?? 0) + 1);
  }
  for (const [caseId, count] of seen) {
    if (count > 1) errors.push(`duplicate recorded row: ${caseId} (${count} rows)`);
    if (!labeled.has(caseId)) errors.push(`recorded row for unknown case: ${caseId}`);
  }

  const verified: LockboxCaseScore[] = [];
  for (const c of cases) {
    const expected = c.expected.closure?.choice;
    if (expected === undefined || !(MISSION_CLOSURE_CHOICES as readonly string[]).includes(expected)) {
      errors.push(`case ${c.id} carries no labeled closure choice; unlabeled cases cannot qualify`);
      continue;
    }
    const row = rows.find((r) => r.caseId === c.id);
    if (row === undefined) {
      errors.push(`missing recorded row: ${c.id}`);
      continue;
    }
    if (
      row.rowVersion !== LOCKBOX_ROW_VERSION &&
      row.rowVersion !== PREVIOUS_LOCKBOX_ROW_VERSION &&
      row.rowVersion !== LEGACY_LOCKBOX_ROW_VERSION
    ) {
      errors.push(`case ${c.id}: unsupported row version ${String(row.rowVersion)}`);
      continue;
    }
    if (row.benchVersion !== LOCKBOX_BENCH_VERSION) {
      errors.push(`case ${c.id}: unsupported bench version ${String(row.benchVersion)}`);
      continue;
    }
    for (const [slot, requestId] of [["model", row.modelRequestId], ["integrated", row.integratedRequestId]] as const) {
      if (requestId !== undefined && sanitizeRequestId(requestId) === undefined) {
        errors.push(`case ${c.id}: malformed ${slot} provider request id`);
        continue;
      }
    }
    if (row.dataset !== datasetRevision) {
      errors.push(`case ${c.id}: dataset binding mismatch`);
      continue;
    }
    const caseHash = hashQuestions(c.questions);
    if (row.questionHash !== caseHash || row.questionHash !== policy.questionHash) {
      errors.push(`case ${c.id}: question-set binding mismatch`);
      continue;
    }
    const mismatch = policyMismatch(row, policy);
    if (mismatch !== undefined) {
      errors.push(`case ${c.id}: ${mismatch}`);
      continue;
    }
    if (row.expected !== expected) {
      errors.push(`case ${c.id}: recorded expectation does not match the dataset label`);
      continue;
    }
    if (typeof row.observedModel !== "string" || row.observedModel.length === 0) {
      errors.push(`case ${c.id}: missing observed model identity`);
      continue;
    }
    if (row.rowVersion === LOCKBOX_ROW_VERSION || row.rowVersion === PREVIOUS_LOCKBOX_ROW_VERSION) {
      const modelCall = row.modelCall;
      if (row.modelChoice !== undefined) {
        if (
          modelCall === undefined || modelCall.provider !== policy.backend ||
          modelCall.model !== policy.modelVersion || modelCall.questionHash !== policy.questionHash ||
          modelCall.model !== row.observedModel ||
          modelCall.requestId !== row.modelRequestId ||
          !Number.isFinite(modelCall.latencyMs) || modelCall.latencyMs < 0 ||
          !Number.isSafeInteger(modelCall.usage?.input_tokens) || modelCall.usage.input_tokens < 0 ||
          !Number.isSafeInteger(modelCall.usage?.output_tokens) || modelCall.usage.output_tokens < 0 ||
          (row.rowVersion === LOCKBOX_ROW_VERSION && modelCall.usage.cost_usd !== undefined &&
            (!Number.isFinite(modelCall.usage.cost_usd) || modelCall.usage.cost_usd < 0))
        ) {
          errors.push(`case ${c.id}: model-only response identity or telemetry does not match the policy`);
          continue;
        }
      }
    }

    const evidence = lockboxLegacyEvidence(c.id, c.state);
    const preflight = preflightMissionClosure(evidence, policy);
    const ready = preflightReachedReview(preflight);
    if (row.preflightStatus !== preflight.status || row.preflightReady !== ready ||
        row.preflightReason !== (preflight.reasons[0] ?? "")) {
      errors.push(`case ${c.id}: recorded preflight does not reproduce`);
      continue;
    }

    if (!ready) {
      const preflightChoice = decisionChoice(preflight);
      if (
        row.integratedStatus !== preflight.status ||
        row.integratedComplete !== false ||
        row.integratedChoice !== preflightChoice ||
        row.integratedConfidence !== undefined ||
        row.integratedProbabilities !== undefined ||
        row.integratedOutcome !== undefined ||
        row.integratedFailure !== undefined ||
        row.integratedRequestId !== undefined
      ) {
        errors.push(`case ${c.id}: preflight-stopped case must record the preflight outcome with no semantic vote`);
        continue;
      }
    } else {
      if (
        (row.rowVersion === LOCKBOX_ROW_VERSION || row.rowVersion === PREVIOUS_LOCKBOX_ROW_VERSION) &&
        row.integratedOutcome !== "unavailable" && row.integratedOutcome !== "invalid_judgment"
      ) {
        const integratedCall = row.integratedCall;
        if (
          integratedCall === undefined || integratedCall.provider !== policy.backend ||
          integratedCall.model !== policy.modelVersion || integratedCall.questionHash !== policy.questionHash ||
          integratedCall.requestId !== row.integratedRequestId ||
          !Number.isFinite(integratedCall.latencyMs) || integratedCall.latencyMs < 0 ||
          !Number.isSafeInteger(integratedCall.usage?.input_tokens) || integratedCall.usage.input_tokens < 0 ||
          !Number.isSafeInteger(integratedCall.usage?.output_tokens) || integratedCall.usage.output_tokens < 0 ||
          (row.rowVersion === LOCKBOX_ROW_VERSION && integratedCall.usage.cost_usd !== undefined &&
            (!Number.isFinite(integratedCall.usage.cost_usd) || integratedCall.usage.cost_usd < 0))
        ) {
          errors.push(`case ${c.id}: integrated response identity or telemetry does not match the policy`);
          continue;
        }
      }
      const conf = row.integratedConfidence;
      const probs = row.integratedProbabilities;
      const outcome = row.integratedOutcome;
      // An unavailable or invalid integrated vote carries no confidence,
      // no distribution, and never completion: it is a measured miss, not
      // a refusal and never an authorization.
      if (outcome === "unavailable" || outcome === "invalid_judgment") {
        if (row.integratedComplete) {
          errors.push(`case ${c.id}: ${outcome} outcome must never authorize COMPLETE`);
          continue;
        }
        if (conf !== undefined || probs !== undefined) {
          errors.push(`case ${c.id}: ${outcome} outcome must not record a semantic vote`);
          continue;
        }
      } else {
        if (typeof conf !== "number" || !Number.isFinite(conf)) {
          errors.push(`case ${c.id}: reviewed case must record the integrated vote's confidence`);
          continue;
        }
        if (!(MISSION_CLOSURE_CHOICES as readonly string[]).includes(row.integratedChoice)) {
          errors.push(`case ${c.id}: integrated choice is outside the calibrated set`);
          continue;
        }
        if (probs === undefined) {
          errors.push(`case ${c.id}: reviewed case must record the integrated vote distribution`);
          continue;
        }
        const voteForComplete = validSemanticDistribution("COMPLETE", conf, probs);
        const voteForChoice = validSemanticDistribution(row.integratedChoice, conf, probs);
        const meetsThresholds =
          voteForComplete && conf >= policy.minConfidence && (probs.COMPLETE ?? 0) >= policy.minConfidence;
        if (row.integratedComplete) {
          if (row.integratedChoice !== "COMPLETE" || !meetsThresholds) {
            errors.push(`case ${c.id}: terminal COMPLETE requires a threshold-meeting COMPLETE vote and the flag`);
            continue;
          }
        } else if (meetsThresholds) {
          errors.push(`case ${c.id}: vote met the terminal thresholds but completion was not recorded`);
          continue;
        } else if (voteForComplete) {
          // Threshold hold: production keeps the preflight outcome. The
          // recorded choice must be the preflight outcome, not the vote.
          const heldChoice = decisionChoice(preflight);
          if (row.integratedChoice !== heldChoice || row.integratedStatus !== preflight.status) {
            errors.push(`case ${c.id}: threshold-held vote must record the preflight outcome`);
            continue;
          }
        } else if (!voteForChoice) {
          errors.push(`case ${c.id}: reviewed case must record a valid integrated vote distribution`);
          continue;
        }
      }
    }

    const modelCorrect = row.modelChoice !== undefined && row.modelChoice === expected;
    const integratedCorrect = row.integratedChoice === expected;
    if (row.modelCorrect !== modelCorrect || row.integratedCorrect !== integratedCorrect) {
      errors.push(`case ${c.id}: recorded correctness booleans disagree with recomputation`);
      continue;
    }
    verified.push(row);
  }

  return { ok: errors.length === 0, errors, recomputed: summarizeLockbox(verified) };
}

/** Tally per-stage outcomes. Preflight alone never completes by design. */
export function summarizeLockbox(scores: LockboxCaseScore[]): LockboxSummary {
  let modelCorrect = 0;
  let integratedCorrect = 0;
  let ready = 0;
  let completeExpected = 0;
  let stopped = 0;
  let nonCompleteExpected = 0;
  for (const score of scores) {
    if (score.modelCorrect) modelCorrect += 1;
    if (score.integratedCorrect) integratedCorrect += 1;
    if (score.expected === "COMPLETE") {
      completeExpected += 1;
      if (score.preflightReady) ready += 1;
    } else if (score.expected !== undefined) {
      nonCompleteExpected += 1;
      if (!score.preflightReady) stopped += 1;
    }
  }
  return {
    benchVersion: LOCKBOX_BENCH_VERSION,
    calibrationPremise: "policy.calibrated=true: integrated stage measures the production path as if the model under test were the calibrated one",
    cases: scores.length,
    modelCorrect,
    integratedCorrect,
    preflightReadyOnCompleteExpected: { ready, total: completeExpected },
    preflightStoppedOnNonCompleteExpected: { stopped, total: nonCompleteExpected },
  };
}
