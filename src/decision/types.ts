/**
 * Provider-agnostic decision-model contract.
 *
 * A DecisionModel answers typed questions about a shared `state`. It never
 * generates free text: every answer is drawn from an answer space the caller
 * defined. Jev is one implementation; an LLM structured-output adapter can
 * implement the same interface.
 *
 * Wire shapes below intentionally mirror TypeSafe's /v1/systemone API so the
 * Jev implementation is a passthrough.
 */

/** JSON-serializable content. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The content being judged. A string, or structured data questions can reference by path. */
export type State = string | Json[] | { [key: string]: Json };

/** Instructions accept plain text or JSON structure. */
export type Instructions = string | Json[] | { [key: string]: Json };

/**
 * What one rubric entry may be.
 *
 * Prose or JSON structure, because the same jaggedness that makes structured
 * *instructions* work applies to criteria: `{what, not_for, examples}` on the
 * side a lookalike case would wrongly land on moves answers that a paragraph
 * does not. `null` is a value, not an absence — it says "the name says it all".
 */
export type EntryType = string | Json[] | { [key: string]: Json } | null;

export interface ChoiceQuestion {
  type: "choice";
  instructions: Instructions;
  /** option -> rubric entry (null when the option name is self-explanatory). */
  criteria: Record<string, EntryType>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: Instructions;
  /** Ordered level descriptions, lowest first. At least two. */
  criteria: EntryType[];
}

export interface NoulQuestion {
  type: "noul";
  instructions: Instructions;
  criteria?: { true?: EntryType; false?: EntryType };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  /** 0..1, how peaked the distribution is. */
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted level index; may fall between levels. */
  score: number;
  legend: Record<string, string>;
  /** Absent from some provider responses. */
  probabilities?: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  /** P(yes), 0..1. Has no separate confidence. */
  noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type AnswerFor<Q extends Question> = Q extends ChoiceQuestion
  ? ChoiceAnswer
  : Q extends ScoreQuestion
    ? ScoreAnswer
    : Q extends NoulQuestion
      ? NoulAnswer
      : never;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  /** Provider-reported request cost, when the transport exposes it. */
  cost_usd?: number;
}

export interface EvaluateRequest<Q extends Record<string, Question> = Record<string, Question>> {
  state: State;
  questions: Q;
  /** Optional logical request identity propagated through transport and receipts. */
  correlationId?: string;
  /** Overrides the model configured on the DecisionModel. */
  model?: string;
  signal?: AbortSignal;
}

/**
 * Which backend answered an evaluation. Thresholds calibrated on one
 * backend must never be applied to the other's numbers: native Jev
 * probabilities and OpenRouter chat-generated estimates are different
 * quantities with the same field names.
 */
export const PROVIDER_TYPESAFE = "typesafe";
export const PROVIDER_OPENROUTER = "openrouter";
/** Jev decisions reached through the local FI Gateway's named `jev` slot. */
export const PROVIDER_JEV_GATEWAY = "jev-gateway";

export interface EvaluateResult<Q extends Record<string, Question> = Record<string, Question>> {
  /** Versioned model id that actually answered. */
  model: string;
  /** Request correlation id, when the transport accepts one. */
  correlationId?: string;
  /** Backend that produced this result — never inferred from the model id. */
  provider: string;
  /**
   * sha256 over the canonical question set, so calibration can be pinned
   * to exact question text: editing instructions/criteria/option order
   * changes this hash and invalidates any "calibrated" marker.
   */
  questionHash: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: Usage;
  /** Wall-clock time including retries. */
  latency_ms: number;
  /**
   * Set by a caching wrapper when this answer came from its cache rather than
   * from the provider. Absent means "this call really happened".
   *
   * It is here rather than in the wrapper's own type because the whole point is
   * that a caller logging cost and latency can tell the difference: a hit
   * reports `latency_ms: 0` and `input_tokens: 0`, and without this flag those
   * zeroes would be indistinguishable from an implausibly fast real call.
   */
  memo?: boolean;
}

export interface DecisionModel {
  readonly name: string;

  /**
   * Evaluate many independent questions against one state in a single call.
   * This is the primitive; prefer it over the single-question helpers whenever
   * several judgments share a state.
   */
  evaluate<Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>>;

  choice(state: State, question: Omit<ChoiceQuestion, "type">): Promise<ChoiceAnswer>;
  score(state: State, question: Omit<ScoreQuestion, "type">): Promise<ScoreAnswer>;
  /** P(yes) for a yes/no question. */
  probability(state: State, question: Omit<NoulQuestion, "type">): Promise<number>;
}

/** Where a unified enforcement verdict came from. */
export type DecisionSource = "deterministic" | "jev" | "combined";

/**
 * Which decision family a recorded decision belongs to. Routing selects a
 * branch, authorization grants tool authority, verification judges an outcome
 * — three distinguishable types, never interchangeable. Every decision
 * record carries exactly one.
 */
export type DecisionKind = "routing" | "authorization" | "verification";

/** Whether a routing judgment may select a consequential branch. */
export type RoutingMode = "advisory" | "consequential";

/**
 * Host-neutral enforcement verdict. Jev never directly grants permission.
 * `"error"` is receipt-only (a failure classification, never a host output):
 * every host mapper falls through on it to silence, preserving fail-open.
 */
export type Enforcement = "allow" | "advise" | "ask" | "deny" | "continue_work" | "terminal" | "observed" | "error";

/** Reference to evidence backing a decision, never raw secrets. */
export interface EvidenceRef {
  kind: string;
  id: string;
}

/**
 * Why a judgment slot produced no blocking verdict. Pre-judgment exits are
 * deterministic policy; completed judgments are Jev evidence; anything else
 * names the failure class — never a silent "did not judge".
 */
export type JudgmentOutcome =
  | "SKIPPED_READ_ONLY"
  | "SKIPPED_IN_PROJECT"
  | "DETERMINISTIC_DENY"
  | "MODEL_NOT_CONFIGURED"
  | "MODEL_INITIALIZATION_ERROR"
  | "JUDGMENT_ATTEMPTED"
  | "JUDGMENT_SUCCEEDED"
  | "JUDGMENT_TIMEOUT"
  | "HOOK_DEADLINE_EXCEEDED"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "PROVIDER_FORBIDDEN"
  | "AUTH_FAILURE"
  | "NETWORK_FAILURE"
  | "INVALID_MODEL_RESPONSE"
  | "POLICY_SUPPRESSED";

export interface UnifiedDecision {
  event: string;
  enforcement: Enforcement;
  source: DecisionSource;
  reasons: string[];
  evidence: EvidenceRef[];
  model?: string;
  probabilities?: Record<string, number>;
  /** Machine-readable judgment outcome, when the slot was classified. */
  judgment?: JudgmentOutcome;
  /** Evidence-backed terminal mission outcome, set only by the closure gate. */
  terminalOutcome?: {
    status: "COMPLETE" | "BLOCKED";
    missionId: string;
    missionRevision: string;
    evidenceRevision: string;
    receiptCorrelationId: string;
  };
  policyVersion: string;
  decisionId: string;
}

/** Pinned unified model. Aliases must not be used for threshold-calibrated enforcement. */
export const DEFAULT_JEV_MODEL = "jev-1.14.0";
export const UNIFIED_POLICY_VERSION = "1";

/**
 * Structured evidence behind one recorded decision. Field-for-field this is
 * what the graph journal persists for the deciding node, so a replay can
 * re-derive the branch without re-invoking a backend: run + revision locate
 * the run, the node + question-set hash locate the judgment, the effective
 * evidence digest binds the runtime dependency evidence, and the
 * backend/model/version/qualification identity pins whose numbers these were.
 * `mode` records whether the judgment was allowed to select a consequential
 * branch (`consequential`) or was advisory-only.
 */
export interface DecisionEvidence {
  kind: DecisionKind;
  runId: string;
  revisionHash: string;
  nodeId: string;
  /** sha256 of the exact question set answered. */
  questionSetHash: string;
  /** Canonical digest of the runtime dependency evidence/decisions. */
  effectiveEvidenceDigest: string;
  backend: string;
  model: string;
  /** Deployed model version that actually answered. */
  modelVersion?: string;
  /** Qualification record id the consequential route was admitted under, if any. */
  qualificationId?: string;
  /** Typed answer payload (choice/score/noul) with its confidence. */
  answer?: { type: string; value: string; confidence?: number };
  /** Branch this run's gate evaluation selected. */
  selectedBranch?: string;
  /** Opaque hash or version of the decision policy in force. */
  policyVersion: string;
  mode: RoutingMode;
  reasons: string[];
}

/**
 * A verification outcome: a judgment that an executed outcome satisfies (or
 * fails) its expectation. A verification records what was checked and the
 * verdict — it never selects a branch (routing) and never grants tool
 * authority (authorization).
 */
export interface VerificationDecision {
  kind: "verification";
  subject: string;
  verdict: "pass" | "fail" | "inconclusive";
  reasons: string[];
  evidence: EvidenceRef[];
  policyVersion: string;
}

/** What deterministic policy does with a judgment. */
export type Gate = "auto" | "review" | "escalate";

export interface GateThresholds {
  /** At or above: act automatically. */
  auto: number;
  /** At or above (and below `auto`): proceed with caution / confirm. Below: escalate. */
  review: number;
}
