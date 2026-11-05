import { createHash } from "node:crypto";
import type { ChoiceAnswer, DecisionModel, Json, Question } from "../decision/types.js";
import { hashQuestions } from "../decision/provenance.js";
import type { EvidenceLedger } from "../evidence/ledger.js";
import { validMissionProofObligation, type MissionProofObligation } from "./proof-obligations.js";
import type { CriterionCodeStructureEvidence } from "./structural-analysis.js";
import { persistMissionClosureReceipt, type MissionClosureReceiptResult } from "./receipt.js";
import {
  ADVERSARIAL_GAP_CHOICES,
  adversarialQuestionsFor,
  MAX_ADVERSARIAL_REPAIR_ATTEMPTS,
  MISSION_ADVERSARIAL_QUESTION,
  PROBABILITY_TOLERANCE,
  validateAdversarialFinding,
  validCriterionGap,
  validGapDistribution,
} from "./adversarial-closure.js";
import type {
  AdversarialClosureDecision,
  AdversarialClosureSummary,
  AdversarialFinding,
  AdversarialGap,
  AdversarialJudgeResult,
  AdversarialRepairTask,
  CriterionGap,
  PriorAdversarialChallenge,
} from "./adversarial-closure.js";
export {
  ADVERSARIAL_CLOSURE_STATES,
  ADVERSARIAL_GAP_CHOICES,
  CRITERION_GAP_CHOICES,
  MAX_ADVERSARIAL_REPAIR_ATTEMPTS,
  MISSION_ADVERSARIAL_QUESTION,
  adversarialQuestionsFor,
  validateAdversarialFinding,
  validCriterionGap,
  validGapDistribution,
} from "./adversarial-closure.js";
export type {
  AdversarialClosureDecision,
  AdversarialClosureSummary,
  AdversarialFinding,
  AdversarialFindingValidation,
  AdversarialGap,
  AdversarialJudgeResult,
  AdversarialRepairTask,
  CriterionGap,
  PriorAdversarialChallenge,
} from "./adversarial-closure.js";

/**
 * Decision core only. A host must build `MissionClosureEvidence` from trusted
 * prompt/session state, execution journals, and independent verification; do
 * not expose a raw caller-supplied evidence object as a completion tool.
 * Persistence and Stop-hook enforcement belong to that host integration.
 * Terminal completion requires prompt-bound exhaustive objective coverage,
 * a valid independent verifier receipt and host-journal binding for every
 * criterion, and the qualified global Jev mission judgment.
 * Native TypeSafe, the local Jev gateway, and OpenRouter each qualify only
 * against their own exact provider/model-version/question/evidence pins;
 * OpenRouter is never calibrated by a native or gateway receipt.
 * The DAG-local Choice and atomic Noul candidates below are advisory and
 * cannot write closure receipts, authorize work, or set terminal completion.
 * Supplemental verification is selected only from a host-authored bounded
 * registry: Jev sees ids/descriptions, while command text stays host-side.
 * A selected action becomes one non-idempotent graph node under an
 * evidence-bound run id; the existing graph executor remains responsible for
 * authorization, confinement, durable journaling, and refusing replay after
 * outcome_unknown. An explicit NO_PROBE is respected; uncertainty may use one
 * approved fallback only when no probe answer was supplied.
 */

export const MISSION_CLOSURE_POLICY_VERSION = "mission-closure/1";
export const MISSION_CLOSURE_CHOICES = ["COMPLETE", "INCOMPLETE", "BLOCKED", "INSUFFICIENT_EVIDENCE"] as const;
export type MissionClosureStatus = (typeof MISSION_CLOSURE_CHOICES)[number];

export interface MissionCriterionEvidence {
  id: string;
  statement: string;
  verified: boolean;
  /** Stable obligation derived from this original user-authored requirement. */
  proofObligation?: MissionProofObligation;
  /** Bounded user-reported outcome to compare against objective and criterion. */
  outcome?: string;
  evidenceRef?: string;
  missionRevision: string;
  evidenceRevision: string;
  /**
   * Additive graph traceability for this criterion. Resolved by
   * `resolveCriterionGraphBindings` against persisted host-owned journals
   * and receipts. Annotative only: NEVER sets `verified`, and a `bound`
   * entry never promotes the criterion. Unhealthy entries fail closed via
   * `operations.uncertain` instead. Absent when no bindings are configured.
   */
  graphEvidence?: CriterionGraphEvidence[];
  /**
   * Independent per-criterion verification summary. Present only on the
   * trusted-evidence path (`enableTrustedGraphEvidence`): the host
   * allowlist-gated verdict for this exact criterion, revision, and
   * candidate. Never verifier or model text — result token plus an
   * allowlisted verifier id at most.
   */
  criterionVerification?: CriterionVerificationSummary;
  /** Supplemental host probe observations. These inform semantic review but
   * never replace the required primary criterion verifier above. */
  supplementalVerifications?: CriterionVerificationSummary[];
}

/**
 * Independent per-criterion verification verdict. Host-supplied only: the
 * session source accepts these solely through its
 * `criterionVerifications` loadSnapshot arg (host-constructed, never
 * agent/MCP/user text) and counts them only against the host-supplied
 * verifier allowlist. Binds the exact criterion, mission revision, and
 * candidate digest; anything else is `unresolved`, fail closed.
 */
export interface MissionCriterionVerification {
  criterionId: string;
  verifierId: string;
  missionRevision: string;
  candidateDigest: string;
  result: "satisfied" | "failed";
  receiptCorrelationId: string;
  verifiedAt: number;
  /**
   * Verifier-produced detail (additive, never counted by the allowlist gate):
   * a bounded evidence reference (receipt id, artifact path, report name),
   * the raw observed result (exit code, digest comparison, service reply
   * summary — never a proof claim), the graph nodes+attempts the finding
   * traces to, and the adapter version that produced it. `result` stays the
   * only counted verdict; these fields explain it.
   */
  evidenceRef?: string;
  observedResult?: string;
  graphNodes?: Array<{ runId: string; nodeId: string; attemptId?: string }>;
  adapterVersion?: string;
}

export type CriterionVerificationResult = "satisfied" | "failed" | "unresolved";

export interface CriterionVerificationSummary {
  result: CriterionVerificationResult;
  /** Allowlisted verifier id, present only when a verdict was counted. */
  verifierId?: string;
  /** Bounded, sanitized reason; never verifier or model text. */
  detail: string;
  /** Present only in host-built trusted snapshots after receipt validation. */
  receiptCorrelationId?: string;
  evidenceRef?: string;
  /** Bounded host verifier observation; never used as proof by itself. */
  observedResult?: string;
  adapterVersion?: string;
  graphNodes?: Array<{ runId: string; nodeId: string; attemptId?: string }>;
}

export interface MissionGraphRunEvidence {
  runId: string;
  graphHash?: string;
  policyHash?: string;
  nodes: Array<{
    nodeId: string;
    status: "succeeded" | "failed" | "skipped" | "blocked" | "cancelled" | "outcome_unknown";
    inputHash?: string;
    outputDigest?: string;
    /** Exact static dependencies declared by the executed graph node. */
    declaredDependencies?: string[];
    /**
     * Attempt lineage from the journal reconcile: every authorized/settled
     * attempt id observed for this node, oldest first. The terminal outcome
     * is last-terminal-wins, but the lineage preserves retries and repairs so
     * a binding can name the actual settling attempt instead of an anonymous
     * "latest". Bounded by the session source (latest entries win).
     */
    attemptIds?: string[];
  }>;
}

/**
 * Graph-to-criterion evidence bridge (non-authoritative). Types live here
 * rather than in `contract.ts` because contract.ts is a strict user-prompt
 * parser (crypto/redact only) while criterion evidence and graph runs
 * already live here. Type-only addition: no new runtime edge, so the
 * `tests/architecture/dependency.test.ts` map is unaffected.
 *
 * A binding is an operator-declared traceability link from one acceptance
 * criterion to one persisted terminal graph node. It is a claim, not
 * evidence: `resolveCriterionGraphBindings` (src/mission/graph-binding.ts)
 * validates it against host-owned, session-scoped journals and receipts.
 * A `bound` result means traceable, never verified: execution-observed
 * rows (succeeded nodes, receipts, review lanes, observations, user
 * outcome strings, stub-model judgments) never satisfy acceptance
 * criteria. Authoritative promotion from graph evidence, if any is ever
 * built, lives behind an explicit opt-in flag defaulting to OFF.
 */
export type CriterionGraphEvidenceState =
  | "bound"
  | "missing"
  | "mismatched"
  | "stale"
  | "foreign"
  | "conflict"
  | "unavailable"
  | "unknown"
  | "unhealthy";

export interface MissionCriterionGraphBinding {
  criterionId: string;
  runId: string;
  nodeId: string;
  graphHash?: string;
  policyHash?: string;
  inputHash: string;
  outputDigest: string;
  /**
   * Claimed outcome the binding asserts. `"pending"` names an interrupted
   * authorization and always resolves `unknown`, never bound: it records
   * the interruption instead of inferring success.
   */
  executionStatus?: "succeeded" | "failed" | "skipped" | "blocked" | "cancelled" | "outcome_unknown" | "pending";
  receiptCorrelationId?: string;
  candidateDigest?: string;
  /**
   * The actual settling attempt this binding traces (an entry of the
   * journaled node's `attemptIds` lineage). When named, the resolver
   * requires it to be present in the lineage — a binding that names a
   * superseded or never-run attempt resolves `mismatched`, never bound — so
   * retries and repairs cannot silently re-target a stale observation.
   * When absent, the binding traces the node's terminal outcome without
   * naming which attempt settled it.
   */
  attemptId?: string;
  /**
   * Mission revision the binding was declared against. When named, the
   * resolver requires the current revision to match — a contract edit
   * rotates the binding to `mismatched` instead of letting an old
   * declaration satisfy a new requirement. The candidate digest already
   * covers the mission revision indirectly; this makes it explicit.
   */
  missionRevision?: string;
  /**
   * Host authority marker. Set only by the trusted host-owned producer
   * (`buildCriterionGraphBindings`: `"host:journal-projection/v2"` —
   * explicit per-criterion producer associations, never a heuristic).
   * Informational: the resolver validates hashes, never this marker, and
   * extra claim fields neither verify nor disturb traceability.
   */
  provenance?: string;
}

export interface CriterionGraphEvidence {
  criterionId: string;
  runId: string;
  nodeId: string;
  state: CriterionGraphEvidenceState;
  /** Bounded, sanitized reason; never provider or model text. */
  detail: string;
  /** Journal-bound execution attempt when the host association named one. */
  attemptId?: string;
  /** Host producer marker, retained for development candidate provenance checks. */
  provenance?: string;
  /** Journaled predecessor terminal states for this producer node. */
  dependencies?: Array<{
    nodeId: string;
    state: "succeeded" | "failed" | "skipped" | "blocked" | "cancelled" | "outcome_unknown" | "missing";
  }>;
}

export interface MissionClosureEvidence {
  missionId: string;
  objective: string;
  /** User-authored, prompt-bound declaration that the criteria exhaust the original objective. */
  objectiveCoverage?: {
    status: "attested" | "missing";
    missionRevision?: string;
    promptHash?: string;
    source?: "user-prompt-objective-coverage";
  };
  missionRevision: string;
  evidenceRevision: string;
  /**
   * Candidate identity: an observed execution-state digest, NOT a source-tree
   * fingerprint and NOT proof against out-of-band workspace modification.
   * Verifier receipts bind to `candidateRevision`/`candidateDigest`, never to
   * the aggregate `evidenceRevision` that incorporates their own receipts.
   */
  candidateDigest?: string;
  candidateRevision?: string;
  criteria: MissionCriterionEvidence[];
  tests: { passed: boolean; independent: boolean; evidenceRef?: string; revision: string };
  operations: { pending: number; uncertain: number };
  blockers: Array<{ id: string; unresolved: boolean }>;
  /** Bounded terminal graph outcomes from host-owned, session-scoped journals. */
  graphRuns?: MissionGraphRunEvidence[];
  /**
   * Request-profile identity for the model-bound closure request. Absent
   * (or v1) means the legacy wire shape: `affirmativeRequest` emits exactly
   * the historical state and the v1 closure question, so old calibration
   * pins keep applying to the old shape only. The trusted-evidence path
   * sets `mission-closure/v2-graph-evidence`, which switches both the
   * state projection and the question — old question hashes cannot
   * silently match the new request.
   */
  requestProfile?: string;
}

export interface MissionClosurePolicy {
  policyVersion: string;
  /** Threshold measured for this exact backend, model, and question set. */
  minConfidence: number;
  calibrated: boolean;
  backend: string;
  model: string;
  modelVersion: string;
  questionHash: string;
  calibrationVersion: string;
  /**
   * Calibration record for the adversarial gap-question family, measured for
   * this exact backend and model. Required for pair mode: without it the
   * adversarial judge stays silent and the controller gathers evidence.
   * The question binding itself is checked dynamically — the answer must
   * match the hash of the exact question set asked — because per-criterion
   * questions vary with the evidence and no static hash could match them.
   */
  adversarialCalibrationVersion?: string;
}

/**
 * Machine-readable semantic failure classification. Human-readable reasons
 * stay for operators; this bounded, sanitized kind routes metrics and
 * qualification without parsing prose. `transport` covers pipe-level
 * failures (connection, HTTP, admission, overload, quota, unknown throws);
 * `timeout` covers exceeded deadlines and aborted calls; `protocol` covers
 * malformed provider exchanges; `invalid` covers judgments unusable for
 * this policy (non-choice answers, outside-set choices, bad distributions,
 * unbound votes). Detail is an error-class token or a fixed string — never
 * provider text.
 */
export type SemanticFailureKind = "transport" | "timeout" | "protocol" | "invalid";

export interface SemanticFailure {
  kind: SemanticFailureKind;
  detail: string;
}

/**
 * Classify a thrown semantic-judgment failure into the bounded kind set.
 * Unknown throws route to `transport` with a sanitized token: the judgment
 * never traversed a working pipe, and the token names the class.
 */
export function classifySemanticFailure(error: unknown): SemanticFailure {
  const name = error instanceof Error ? error.name : "unknown error";
  const token = /^[A-Za-z][A-Za-z0-9]*Error$/.test(name) ? name : "Error";
  if (/timeout/i.test(token) || /abort/i.test(token)) return { kind: "timeout", detail: token };
  if (/protocol/i.test(token) || /validation/i.test(token)) return { kind: "protocol", detail: token };
  return { kind: "transport", detail: token };
}

export interface MissionClosureDecision {
  status: MissionClosureStatus;
  complete: boolean;
  missionId: string;
  missionRevision: string;
  evidenceRevision: string;
  /** Machine-readable semantic failure, present only when no usable judgment was produced. */
  failure?: SemanticFailure;
  /**
   * Candidate the verdict was evaluated against. Terminal authorization
   * binds this alongside mission, mission revision, and evidence revision;
   * undefined only when no candidate was established.
   */
  candidateDigest?: string;
  policyVersion: string;
  checks: {
    objectivePresent: boolean;
    objectiveCoverageEstablished: boolean;
    revisionsMatch: boolean;
    criteriaPresent: boolean;
    allCriteriaVerified: boolean;
    testsPassed: boolean;
    independentVerificationPassed: boolean;
    noPendingOperations: boolean;
    noUncertainOperations: boolean;
    noUnresolvedBlockers: boolean;
    calibrationBound: boolean;
  };
  reasons: string[];
  model?: string;
  modelVersion?: string;
  provider?: string;
  /** Provider request id used to correlate the semantic vote with the gateway exchange. */
  providerRequestId?: string;
  questionHash?: string;
  calibrationVersion?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  /** Always false: confidence is distribution concentration, not correctness proof. */
  confidenceIsProof: false;
  /** Adversarial pair outcome; present only when closure ran in pair mode. */
  adversarial?: AdversarialClosureSummary;
  /** Bounded repair task issued by the pair controller; the host owns the repair lifecycle. */
  repairTask?: AdversarialRepairTask;
}

export const MISSION_CLOSURE_QUESTION = {
  type: "choice" as const,
  instructions:
    "Given the original objective and only the supplied verified outcomes, choose whether the objective is semantically fulfilled. Do not infer missing work or evidence. COMPLETE means every part of the original objective is met. INCOMPLETE means work remains. BLOCKED means an external dependency prevents completion. INSUFFICIENT_EVIDENCE means the evidence cannot support a reliable judgment.",
  criteria: {
    COMPLETE: "The verified outcomes together fulfill the user's original objective; no requested capability or deliverable is omitted.",
    INCOMPLETE: "The objective is understood, but at least one requested outcome remains unfinished or is not met.",
    BLOCKED: "A necessary external dependency or unresolved blocker prevents further completion.",
    INSUFFICIENT_EVIDENCE: "The evidence is missing, stale, contradictory, or too indirect to decide.",
  },
};

/**
 * Request-profile identities. v1 is the historical wire shape (field
 * absent on older evidence). v2 carries the trusted per-criterion graph
 * and verification projection; it is never emitted unless the session
 * source built the snapshot on the trusted-evidence path.
 */
export const MISSION_CLOSURE_REQUEST_PROFILE_V1 = "mission-closure/v1";
export const MISSION_CLOSURE_REQUEST_PROFILE_V2 = "mission-closure/v2-graph-evidence";

/**
 * The v2 closure question for trusted-evidence snapshots. Textually
 * distinct from the v1 question on purpose: the question hash pins the
 * exact question set a result was produced from, so a v1-calibrated
 * policy hash cannot silently validate a v2 judgment. No recalibration
 * is performed here — a host adopts v2 by measuring its own thresholds
 * against this exact question, never by reusing v1 pins.
 */
export const MISSION_CLOSURE_QUESTION_V2 = {
  type: "choice" as const,
  instructions:
    "Given the original objective, the per-criterion requirement statements, and only the supplied qualified evidence — observed terminal graph states plus independent per-criterion verification results bound to this mission revision and candidate — choose whether the objective is semantically fulfilled. Graph execution alone never satisfies a criterion: a criterion counts as met only when its traceability is bound, its independent verification is satisfied for this exact revision and candidate, and its outcome is recorded. Do not infer missing work or evidence. COMPLETE means every part of the original objective is met. INCOMPLETE means work remains. BLOCKED means an external dependency prevents completion. INSUFFICIENT_EVIDENCE means the evidence cannot support a reliable judgment.",
  criteria: {
    COMPLETE: "The qualified per-criterion evidence together fulfills the user's original objective; no requested capability or deliverable is omitted.",
    INCOMPLETE: "The objective is understood, but at least one requested outcome remains unfinished, unbound, unverified, or is not met.",
    BLOCKED: "A necessary external dependency or unresolved blocker prevents further completion.",
    INSUFFICIENT_EVIDENCE: "The evidence is missing, stale, contradictory, or too indirect to decide.",
  },
};

/**
 * Development-only semantic-fulfillment candidate. This three-way question
 * is intentionally separate from the production four-choice closure
 * contract: it distinguishes a positively fulfilled objective from a known
 * shortfall and from evidence that cannot support either conclusion. It is
 * never selected by `affirmativeRequest` or by the production closure gate.
 * A candidate requires its own provider/model/question/policy qualification.
 */
export const MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2 = {
  type: "choice" as const,
  instructions:
    "Judge semantic fulfillment only after deterministic preflight has passed. Treat the original objective as the complete scope; compare every requested behavior, constraint, phase, and operational requirement against the listed criteria and their host-owned, revision-bound verifier evidence. Do not assume an omitted criterion was satisfied. A passing test or successful graph node proves only its observed check, not untested requirements. Select FULFILLED only when the qualified evidence covers every part of the original objective. Select NOT_FULFILLED when the objective has a demonstrated shortfall, partial implementation, or omitted requirement. Select UNCERTAIN when evidence is contradictory, irrelevant to the requirement, or insufficient to decide.",
  criteria: {
    FULFILLED: "Every explicit requirement in the original objective is represented and supported by current, independent, criterion-bound verification for this candidate and revision; no required scope is omitted.",
    NOT_FULFILLED: "The evidence shows at least one requested behavior is missing, partial, failing, or omitted from the verified criteria.",
    UNCERTAIN: "The evidence is stale, contradictory, missing, irrelevant, or too indirect to decide whether the objective is fulfilled.",
  },
};

export const MISSION_SEMANTIC_FULFILLMENT_PROFILE_V2 = "mission-semantic-fulfillment/v2";
export const MISSION_SEMANTIC_FULFILLMENT_CHOICES = ["FULFILLED", "NOT_FULFILLED", "UNCERTAIN"] as const;
export type SemanticFulfillmentChoice = (typeof MISSION_SEMANTIC_FULFILLMENT_CHOICES)[number];

/**
 * Unqualified, development-only criterion frontier. Each request receives
 * exactly one requirement and its host-bound producer/verifier observations;
 * it never receives the mission's other criteria or the complete mission
 * state. This question family has no inherited production qualification.
 */
export const DAG_LOCAL_CRITERION_QUESTION_V1 = {
  type: "choice" as const,
  instructions:
    "Assess only the named acceptance requirement against the supplied criterion-bound graph predecessor states and independent verifier observation. The claimed outcome is not an observation; compare it against the host verifier result. Treat statuses, attempts, verifier identity, receipt, mission revision, and candidate digest as evidence scope. Do not infer omitted work or treat missing, failed, blocked, skipped, or outcome_unknown execution as success. Choose FULFILLED only when the observation directly supports this requirement; NOT_FULFILLED when observed evidence shows a shortfall; UNCERTAIN when evidence is missing, stale, contradictory, or insufficient.",
  criteria: {
    FULFILLED: "The current independent verifier observation directly supports this one requirement for the bound candidate and revision.",
    NOT_FULFILLED: "The criterion-bound observations establish that this requirement is unmet or only partially met.",
    UNCERTAIN: "The criterion's observations are absent, stale, contradictory, or insufficient to decide.",
  },
};
export const DAG_LOCAL_CRITERION_PROFILE_V1 = "mission-dag-local-criterion/v1";

/**
 * Host-owned verification actions available at one criterion frontier.
 * Only ids/descriptions enter Jev's context. The command remains on the host
 * and is never generated or returned by the model.
 */
export interface DagLocalVerificationProbeOption {
  id: string;
  description: string;
  /** Exact host-approved graph attempts this action is permitted to investigate. */
  producerRefs?: Array<{ runId: string; nodeId: string; attemptId: string }>;
}
export interface RegisteredDagLocalProbeAction extends DagLocalVerificationProbeOption {
  /** Fixed host-authored command. It is never included in Jev context. */
  command: string;
  /** Verifier/test action may write its own observation artifacts, but not source files. */
  sourceReadOnly: true;
}
export type DagLocalProbeSelection =
  | { status: "none"; reason: "satisfied" | "no-registered-probe" | "model-declined-probe" }
  | { status: "selected"; probe: RegisteredDagLocalProbeAction; source: "jev" | "uncertainty-fallback" };
export const MAX_DAG_LOCAL_PROBE_OPTIONS = 8;
/** At most one supplemental probe is run against one frozen evidence digest. */
export const MAX_DAG_LOCAL_PROBES_PER_EVIDENCE = 1;
export const DAG_LOCAL_NO_PROBE = "NO_PROBE";

/** Stable graph journal identity: a retry of the same evidence cannot rerun a probe. */
export function dagLocalProbeRunId(criterionId: string, evidenceDigest: string): string | undefined {
  if (criterionId.trim() === "" || !/^[0-9a-f]{64}$/.test(evidenceDigest)) return undefined;
  return `probe-${createHash("sha256").update(`${criterionId}\0${evidenceDigest}`, "utf8").digest("hex").slice(0, 48)}`;
}

/**
 * Materialize a one-node graph only from a previously resolved host registry
 * selection. The ordinary graph executor still performs authorization,
 * confinement, journaling, and crash reconciliation.
 */
export function dagLocalProbeGraph(
  selection: DagLocalProbeSelection,
  criterionId: string,
  evidenceDigest: string,
): { runId: string; graph: {
  version: 1;
  parallel: false;
  nodes: [{ id: string; kind: "shell"; command: string; maxAttempts: 1; idempotent: false }];
} } | undefined {
  if (selection.status !== "selected" || !validDagLocalProbeRegistry([selection.probe])) return undefined;
  const runId = dagLocalProbeRunId(criterionId, evidenceDigest);
  if (runId === undefined) return undefined;
  return {
    runId,
    graph: {
      version: 1,
      parallel: false,
      nodes: [{ id: "criterion-probe", kind: "shell", command: selection.probe.command, maxAttempts: 1, idempotent: false }],
    },
  };
}

/** Validate host-authored probe actions before exposing their names to Jev. */
export function validDagLocalProbeRegistry(
  registry: readonly RegisteredDagLocalProbeAction[],
): boolean {
  if (registry.length === 0 || registry.length > MAX_DAG_LOCAL_PROBE_OPTIONS) return false;
  if (registry.some((probe) => probe.sourceReadOnly !== true || probe.command.trim() === "" ||
    probe.command.length > 2000 || /[\r\n\0]/.test(probe.command) ||
    (probe.producerRefs !== undefined && (probe.producerRefs.length === 0 || probe.producerRefs.length > 8 ||
      probe.producerRefs.some((producer) => producer.runId.trim() === "" || producer.nodeId.trim() === "" || producer.attemptId.trim() === ""))))) return false;
  return dagLocalProbeQuestion(registry) !== undefined;
}

/** Resolve only a registered action; model output is an id, never a command. */
export function selectDagLocalProbe(
  judgment: DagLocalCriterionJudgment,
  registry: readonly RegisteredDagLocalProbeAction[],
): DagLocalProbeSelection {
  if (judgment.disposition === "SATISFIED") return { status: "none", reason: "satisfied" };
  // NO_PROBE is an explicit semantic choice, not a missing model answer.
  // Respect it; uncertainty still escalates through global closure, but must
  // not cause an unrelated approved action to run by fallback.
  if (judgment.recommendedProbe === DAG_LOCAL_NO_PROBE) {
    return { status: "none", reason: "model-declined-probe" };
  }
  if (!validDagLocalProbeRegistry(registry)) return { status: "none", reason: "no-registered-probe" };
  const recommended = registry.find((probe) => probe.id === judgment.recommendedProbe);
  if (recommended !== undefined) return { status: "selected", probe: recommended, source: "jev" };
  if (judgment.recommendedProbe !== undefined) return { status: "none", reason: "no-registered-probe" };
  // Registry membership is the deterministic host assertion that this action
  // is applicable to the criterion. If Jev is uncertain without naming an
  // action, execute one stable registered investigation rather than treating
  // uncertainty as a defect or silently stopping. An explicit NO_PROBE above
  // is respected.
  const fallback = registry[0];
  return fallback === undefined
    ? { status: "none", reason: "no-registered-probe" }
    : { status: "selected", probe: fallback, source: "uncertainty-fallback" };
}

export function dagLocalProbeQuestion(
  options: readonly DagLocalVerificationProbeOption[],
): Question | undefined {
  if (options.length === 0 || options.length > MAX_DAG_LOCAL_PROBE_OPTIONS) return undefined;
  const criteria: Record<string, string> = {
    [DAG_LOCAL_NO_PROBE]: "No registered probe is relevant; ask for clarification or preserve uncertainty.",
  };
  for (const option of options) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(option.id) || option.id === DAG_LOCAL_NO_PROBE ||
        option.description.trim().length === 0 || option.description.length > 300 || criteria[option.id] !== undefined) return undefined;
    const producerScope = option.producerRefs === undefined ? "" :
      ` Approved graph attempts: ${option.producerRefs.map((producer) => `${producer.runId}/${producer.nodeId}@${producer.attemptId}`).join(", ")}.`;
    criteria[option.id] = `${option.description}${producerScope}`;
  }
  return {
    type: "choice",
    instructions:
      "Choose only a registered verification probe that could resolve the uncertainty for this requirement. " +
      "Do not invent commands or changes. Prefer the narrowest probe that tests an unobserved semantic boundary. " +
      "Choose NO_PROBE only when no listed action is relevant.",
    criteria,
  };
}

export function validDagLocalCriterionDistribution(
  choice: string,
  confidence: number,
  probabilities: Record<string, number>,
): boolean {
  const keys = Object.keys(probabilities).sort();
  const expected = [...MISSION_SEMANTIC_FULFILLMENT_CHOICES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  const values = Object.values(probabilities);
  if (!values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return false;
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > PROBABILITY_TOLERANCE) return false;
  const selected = probabilities[choice];
  return selected !== undefined && selected + PROBABILITY_TOLERANCE >= Math.max(...values) &&
    Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 &&
    (confidence < 1 - PROBABILITY_TOLERANCE || selected >= 1 - PROBABILITY_TOLERANCE);
}

export interface DagLocalCriterionRequest {
  criterionId: string;
  missionRevision: string;
  candidateDigest: string;
  /** Digest of the exact criterion-local request evidence. */
  evidenceDigest: string;
  /** Digest of only this criterion's bound graph nodes and predecessor states. */
  graphRevision: string;
  graphNodeIds: Array<{
    runId: string;
    nodeId: string;
    attemptId?: string;
    status: string;
    bindingState?: CriterionGraphEvidenceState;
    provenance?: string;
    dependencies?: Array<{ nodeId: string; state: string }>;
  }>;
  verifier: {
    result: CriterionVerificationResult;
    observationState: "observed" | "missing";
    detail: string;
    verifierId?: string;
    receiptCorrelationId?: string;
    evidenceRef?: string;
    adapterVersion?: string;
    observedResult?: string;
    graphNodes?: Array<{ runId: string; nodeId: string; attemptId?: string }>;
  };
  proofObligation?: {
    id: string;
    criterionId: string;
    requirement: string;
    mandatory: true;
    dependencies: Array<{ runId: string; nodeId: string; state: string }>;
    requiredEvidence: readonly string[];
    codeStructure?: Pick<CriterionCodeStructureEvidence,
      "version" | "criterionId" | "proofObligationId" | "missionRevision" | "candidateDigest" | "provenance" | "fileDigests" | "symbols" | "imports" | "calls" | "evidenceDigest" | "limitations">;
  };
  contextHash: string;
  state: {
    criterionId: string;
    requirement: string;
    claimedOutcome?: string;
    missionRevision: string;
    candidateDigest: string;
    predecessorStates: DagLocalCriterionRequest["graphNodeIds"];
    verifierObservation: DagLocalCriterionRequest["verifier"];
    supplementalVerifierObservations?: NonNullable<MissionCriterionEvidence["supplementalVerifications"]>;
    proofObligation?: DagLocalCriterionRequest["proofObligation"];
  };
  questions: Record<string, Question> & { fulfillment: typeof DAG_LOCAL_CRITERION_QUESTION_V1 };
  /** Exact host allowlist represented by the optional probe Choice. */
  probeOptions: DagLocalVerificationProbeOption[];
}

export interface DagLocalCriterionJudgment {
  criterionId: string;
  missionRevision: string;
  candidateDigest: string;
  evidenceDigest: string;
  graphRevision: string;
  contextHash: string;
  graphNodeIds: DagLocalCriterionRequest["graphNodeIds"];
  verifierProvenance: {
    verifierId?: string;
    receiptCorrelationId?: string;
    evidenceRef?: string;
    adapterVersion?: string;
  };
  choice: SemanticFulfillmentChoice;
  /** Stable caller-facing form of the three semantic choices. */
  disposition: "SATISFIED" | "UNSATISFIED" | "UNCERTAIN";
  confidence: number;
  probabilities: Record<string, number>;
  provider: string;
  model: string;
  questionHash: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** Selected registry id, if this criterion request included bounded probes. */
  recommendedProbe?: string;
}

function dagLocalDisposition(choice: SemanticFulfillmentChoice): DagLocalCriterionJudgment["disposition"] {
  return choice === "FULFILLED" ? "SATISFIED" : choice === "NOT_FULFILLED" ? "UNSATISFIED" : "UNCERTAIN";
}

/** Build one criterion-isolated model request from a host-built v2 snapshot. */
export function dagLocalCriterionRequest(
  evidence: MissionClosureEvidence,
  criterionId: string,
  probeOptions: readonly DagLocalVerificationProbeOption[] = [],
): DagLocalCriterionRequest | undefined {
  if (
    evidence.requestProfile !== MISSION_CLOSURE_REQUEST_PROFILE_V2 ||
    !/^[0-9a-f]{64}$/.test(evidence.missionRevision) ||
    !/^[0-9a-f]{64}$/.test(evidence.candidateDigest ?? "")
  ) return undefined;
  const criterion = evidence.criteria.find((entry) => entry.id === criterionId);
  if (criterion === undefined || criterion.missionRevision !== evidence.missionRevision ||
      criterion.evidenceRevision !== evidence.evidenceRevision ||
      !validMissionProofObligation(criterion.proofObligation, criterion.id, criterion.statement, {
        missionRevision: evidence.missionRevision,
        ...(evidence.candidateDigest === undefined ? {} : { candidateDigest: evidence.candidateDigest }),
      }) || criterion.proofObligation?.codeStructure === undefined) return undefined;
  const graphNodeIds: DagLocalCriterionRequest["graphNodeIds"] = (criterion.graphEvidence ?? []).map((row) => {
    const node = evidence.graphRuns?.find((run) => run.runId === row.runId)?.nodes.find((entry) => entry.nodeId === row.nodeId);
    const attemptId = row.attemptId ?? node?.attemptIds?.at(-1);
    return {
      runId: row.runId,
      nodeId: row.nodeId,
      ...(attemptId === undefined ? {} : { attemptId }),
      status: node?.status ?? (row.state === "bound" ? "missing" : row.state),
      bindingState: row.state,
      ...(row.provenance === undefined ? {} : { provenance: row.provenance }),
      ...(row.dependencies === undefined ? {} : {
        dependencies: row.dependencies.slice(0, 64).map(({ nodeId, state }) => ({ nodeId, state })),
      }),
    };
  });
  const runById = new Map((evidence.graphRuns ?? []).map((run) => [run.runId, run]));
  for (const referenced of criterion.criterionVerification?.graphNodes ?? []) {
    if (graphNodeIds.some((row) => row.runId === referenced.runId && row.nodeId === referenced.nodeId && row.attemptId === referenced.attemptId)) continue;
    const node = runById.get(referenced.runId)?.nodes.find((entry) => entry.nodeId === referenced.nodeId);
    graphNodeIds.push({
      runId: referenced.runId,
      nodeId: referenced.nodeId,
      ...(referenced.attemptId === undefined ? {} : { attemptId: referenced.attemptId }),
      status: node?.status ?? "missing",
      provenance: "host:verifier-observation/v1",
    });
  }
  // The only fallback is an explicit missing state: absence is never removed
  // from the request or silently treated as success.
  if (graphNodeIds.length === 0) graphNodeIds.push({ runId: "", nodeId: "", status: "missing" });
  const verification = criterion.criterionVerification ?? { result: "unresolved" as const, detail: "no trusted verifier observation" };
  const verifier = {
    result: verification.result,
    observationState: verification.result !== "unresolved" &&
      typeof verification.verifierId === "string" && typeof verification.receiptCorrelationId === "string" &&
      typeof verification.adapterVersion === "string" && typeof verification.observedResult === "string"
      ? "observed" as const
      : "missing" as const,
    detail: verification.detail.slice(0, 200),
    ...(verification.verifierId === undefined ? {} : { verifierId: verification.verifierId }),
    ...(verification.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: verification.receiptCorrelationId }),
    ...(verification.evidenceRef === undefined ? {} : { evidenceRef: verification.evidenceRef.slice(0, 200) }),
    ...(verification.adapterVersion === undefined ? {} : { adapterVersion: verification.adapterVersion }),
    ...(verification.observedResult === undefined ? {} : { observedResult: verification.observedResult.slice(0, MAX_V2_CRITERION_TEXT_CHARS) }),
    ...(verification.graphNodes === undefined ? {} : { graphNodes: verification.graphNodes.slice(0, 16).map((node) => ({ ...node })) }),
  };
  const state = {
    criterionId,
    requirement: clampText(criterion.statement),
    ...(criterion.outcome === undefined ? {} : { claimedOutcome: clampText(criterion.outcome) }),
    missionRevision: evidence.missionRevision,
    candidateDigest: evidence.candidateDigest!,
    predecessorStates: graphNodeIds,
    verifierObservation: verifier,
    ...(criterion.supplementalVerifications === undefined || criterion.supplementalVerifications.length === 0 ? {} : {
      supplementalVerifierObservations: criterion.supplementalVerifications.slice(0, 8).map((observation) => ({
      result: observation.result,
      detail: observation.detail.slice(0, 200),
      ...(observation.verifierId === undefined ? {} : { verifierId: observation.verifierId }),
      ...(observation.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: observation.receiptCorrelationId }),
      ...(observation.evidenceRef === undefined ? {} : { evidenceRef: observation.evidenceRef.slice(0, 200) }),
      ...(observation.observedResult === undefined ? {} : { observedResult: observation.observedResult.slice(0, MAX_V2_CRITERION_TEXT_CHARS) }),
      ...(observation.graphNodes === undefined ? {} : { graphNodes: observation.graphNodes.slice(0, 16).map((node) => ({ ...node })) }),
      })),
    }),
    ...(projectProofObligationForRequest(criterion.proofObligation) === undefined ? {} : {
      proofObligation: projectProofObligationForRequest(criterion.proofObligation),
    }),
  };
  const contextHash = createHash("sha256").update(JSON.stringify(state), "utf8").digest("hex");
  const graphRevision = createHash("sha256").update(JSON.stringify(graphNodeIds), "utf8").digest("hex");
  const probeQuestion = dagLocalProbeQuestion(probeOptions);
  if (probeOptions.length > 0 && probeQuestion === undefined) return undefined;
  const questions: Record<string, Question> & { fulfillment: typeof DAG_LOCAL_CRITERION_QUESTION_V1 } = {
    fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1,
    ...(probeQuestion === undefined ? {} : { probe: probeQuestion }),
  };
  const evidenceDigest = createHash("sha256").update(JSON.stringify({
    criterionId,
    missionRevision: evidence.missionRevision,
    candidateDigest: evidence.candidateDigest,
    contextHash,
    graphRevision,
    ...(probeOptions.length === 0 ? {} : { probeOptions }),
  }), "utf8").digest("hex");
  return {
    criterionId,
    missionRevision: evidence.missionRevision,
    candidateDigest: evidence.candidateDigest!,
    evidenceDigest,
    graphRevision,
    graphNodeIds,
    verifier,
    contextHash,
    state,
    questions,
    probeOptions: probeOptions.map((option) => ({ ...option })),
  };
}

/**
 * Deterministic development aggregation. It produces an analysis disposition
 * only: terminal completion is permanently false in this candidate path.
 */
export function aggregateDagLocalCriterionJudgments(args: {
  evidence: MissionClosureEvidence;
  judgments: DagLocalCriterionJudgment[];
  expectedProvider: string;
  expectedModel: string;
  expectedQuestionHash: string;
}): {
  /** Raw semantic aggregation from valid pinned model choices, before confidence gating. */
  semanticDisposition: SemanticFulfillmentChoice;
  /** Fail-closed aggregate after confidence, evidence, and deterministic preflight gates. */
  disposition: SemanticFulfillmentChoice;
  missingCriterionIds: string[];
  unqualifiedCriterionIds: string[];
  objectiveCoverage: "covered" | "unresolved";
  terminalComplete: false;
} {
  // Runtime evidence only. Independently adjudicated benchmark labels are
  // scoring targets and must never be fed into the candidate aggregation.
  const coverage = args.evidence.objectiveCoverage?.status === "attested" &&
    args.evidence.objectiveCoverage.source === "user-prompt-objective-coverage" &&
    args.evidence.objectiveCoverage.missionRevision === args.evidence.missionRevision &&
    /^[0-9a-f]{64}$/.test(args.evidence.objectiveCoverage.promptHash ?? "")
    ? "covered" as const
    : "unresolved" as const;
  const expectedIds = args.evidence.criteria.map((criterion) => criterion.id).sort();
  const pinnedQuestionHash = hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 });
  const byId = new Map(args.judgments.map((judgment) => [judgment.criterionId, judgment]));
  const missingCriterionIds: string[] = [];
  const unqualifiedCriterionIds: string[] = [];
  const choices: SemanticFulfillmentChoice[] = [];
  const qualifiedChoices: SemanticFulfillmentChoice[] = [];
  for (const criterionId of expectedIds) {
    const request = dagLocalCriterionRequest(args.evidence, criterionId);
    const judgment = byId.get(criterionId);
    if (request === undefined || judgment === undefined) {
      missingCriterionIds.push(criterionId);
      continue;
    }
    if (
      request.verifier.observationState !== "observed" ||
      request.graphNodeIds.some((row) => row.bindingState === "bound" &&
        (row.status !== "succeeded" || row.attemptId === undefined || row.provenance !== "host:journal-projection/v2")) ||
      judgment.missionRevision !== request.missionRevision ||
      judgment.candidateDigest !== request.candidateDigest ||
      judgment.evidenceDigest !== request.evidenceDigest ||
      judgment.graphRevision !== request.graphRevision ||
      judgment.contextHash !== request.contextHash ||
      JSON.stringify(judgment.graphNodeIds) !== JSON.stringify(request.graphNodeIds) ||
      JSON.stringify(judgment.verifierProvenance) !== JSON.stringify({
        ...(request.verifier.verifierId === undefined ? {} : { verifierId: request.verifier.verifierId }),
        ...(request.verifier.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: request.verifier.receiptCorrelationId }),
        ...(request.verifier.evidenceRef === undefined ? {} : { evidenceRef: request.verifier.evidenceRef }),
        ...(request.verifier.adapterVersion === undefined ? {} : { adapterVersion: request.verifier.adapterVersion }),
      }) ||
      judgment.provider !== args.expectedProvider ||
      judgment.model !== args.expectedModel ||
      judgment.questionHash !== args.expectedQuestionHash ||
      args.expectedQuestionHash !== pinnedQuestionHash ||
      !(MISSION_SEMANTIC_FULFILLMENT_CHOICES as readonly string[]).includes(judgment.choice) ||
      judgment.disposition !== dagLocalDisposition(judgment.choice) ||
      !validDagLocalCriterionDistribution(judgment.choice, judgment.confidence, judgment.probabilities)
    ) {
      unqualifiedCriterionIds.push(criterionId);
      continue;
    }
    choices.push(judgment.choice);
    if (judgment.confidence >= 0.9 && (judgment.probabilities[judgment.choice] ?? 0) >= 0.9) {
      qualifiedChoices.push(judgment.choice);
    } else {
      unqualifiedCriterionIds.push(criterionId);
    }
  }
  const duplicateOrForeign = args.judgments.length !== expectedIds.length || byId.size !== args.judgments.length;
  const deterministicFailure = args.evidence.criteria.some((criterion) =>
    criterion.criterionVerification?.result === "failed" ||
    criterion.graphEvidence?.some((row) => row.state === "unhealthy") ||
    (dagLocalCriterionRequest(args.evidence, criterion.id)?.graphNodeIds.some((row) => row.status === "failed") ?? false),
  );
  const deterministicUnknown = args.evidence.criteria.some((criterion) =>
    !criterion.verified ||
    criterion.criterionVerification?.result !== "satisfied" ||
    criterion.criterionVerification.observedResult === undefined ||
    criterion.criterionVerification.receiptCorrelationId === undefined ||
    criterion.criterionVerification.adapterVersion === undefined ||
    (criterion.graphEvidence ?? []).length === 0 ||
    criterion.graphEvidence?.some((row) => row.state !== "bound" || row.provenance !== "host:journal-projection/v2") ||
    (dagLocalCriterionRequest(args.evidence, criterion.id)?.graphNodeIds.some((row) => row.status !== "succeeded") ?? true),
  );
  const semanticDisposition: SemanticFulfillmentChoice =
    choices.includes("NOT_FULFILLED")
      ? "NOT_FULFILLED"
      : coverage === "unresolved" || missingCriterionIds.length > 0 || duplicateOrForeign || choices.includes("UNCERTAIN")
        ? "UNCERTAIN"
        : choices.length === expectedIds.length && choices.every((choice) => choice === "FULFILLED") && !deterministicUnknown
          ? "FULFILLED"
          : "UNCERTAIN";
  const disposition: SemanticFulfillmentChoice =
    deterministicFailure || qualifiedChoices.includes("NOT_FULFILLED")
      ? "NOT_FULFILLED"
      : coverage === "unresolved" || missingCriterionIds.length > 0 || unqualifiedCriterionIds.length > 0 || duplicateOrForeign || qualifiedChoices.includes("UNCERTAIN")
        ? "UNCERTAIN"
        : qualifiedChoices.length === expectedIds.length && qualifiedChoices.every((choice) => choice === "FULFILLED") && !deterministicUnknown
          ? "FULFILLED"
          : "UNCERTAIN";
  return { semanticDisposition, disposition, missingCriterionIds, unqualifiedCriterionIds, objectiveCoverage: coverage, terminalComplete: false };
}

function mechanicalChecks(evidence: MissionClosureEvidence, policy: MissionClosurePolicy): MissionClosureDecision["checks"] {
  const ids = evidence.criteria.map((criterion) => criterion.id);
  const uniqueCriteria = ids.length > 0 && new Set(ids).size === ids.length;
  const sameEvidenceRevision = evidence.criteria.every((criterion) => criterion.evidenceRevision === evidence.evidenceRevision);
  const sameMissionRevision = evidence.criteria.every((criterion) => criterion.missionRevision === evidence.missionRevision);
  const testsCurrent = evidence.tests.revision === evidence.evidenceRevision;
  const calibratedModelMatches = policy.backend === "jev-gateway"
    ? policy.modelVersion === policy.model || policy.modelVersion.startsWith(`${policy.model}-`)
    : policy.backend === "openrouter"
      // OpenRouter aliases may resolve to a distinct serving id. The exact
      // returned id is pinned in the qualification manifest and checked on
      // every judgment; it need not share a textual prefix with the alias.
      ? policy.modelVersion.trim().length > 0
      : policy.modelVersion === policy.model;
  const modelPinMatches =
    (policy.backend === "typesafe" || policy.backend === "jev-gateway" || policy.backend === "openrouter") &&
    policy.model.length > 0 &&
    calibratedModelMatches &&
    policy.questionHash.length === 64 &&
    /^[0-9a-f]{64}$/.test(policy.questionHash) &&
    policy.calibrationVersion.length > 0 &&
    Number.isFinite(policy.minConfidence) &&
    policy.minConfidence > 0 &&
    policy.minConfidence <= 1;
  return {
    objectivePresent: evidence.missionId.trim().length > 0 && evidence.objective.trim().length > 0,
    objectiveCoverageEstablished:
      evidence.objectiveCoverage?.status === "attested" &&
      evidence.objectiveCoverage.source === "user-prompt-objective-coverage" &&
      evidence.objectiveCoverage.missionRevision === evidence.missionRevision &&
      /^[0-9a-f]{64}$/.test(evidence.objectiveCoverage.promptHash ?? ""),
    revisionsMatch:
      evidence.missionRevision.length > 0 &&
      evidence.evidenceRevision.length > 0 &&
      sameEvidenceRevision &&
      sameMissionRevision &&
      testsCurrent,
    criteriaPresent: uniqueCriteria,
    allCriteriaVerified:
      uniqueCriteria &&
      evidence.criteria.every((criterion) =>
        validMissionProofObligation(criterion.proofObligation, criterion.id, criterion.statement, {
          missionRevision: evidence.missionRevision,
          ...(evidence.candidateDigest === undefined ? {} : { candidateDigest: evidence.candidateDigest }),
        }) &&
        criterion.verified &&
        criterion.statement.trim().length > 0 &&
        typeof criterion.outcome === "string" &&
        criterion.outcome.trim().length > 0 &&
        typeof criterion.evidenceRef === "string" &&
        criterion.evidenceRef.length > 0 &&
        criterion.criterionVerification?.result === "satisfied" &&
        typeof criterion.criterionVerification.verifierId === "string" &&
        criterion.criterionVerification.verifierId.trim().length > 0 &&
        typeof criterion.criterionVerification.receiptCorrelationId === "string" &&
        criterion.criterionVerification.receiptCorrelationId.trim().length > 0 &&
        typeof criterion.criterionVerification.observedResult === "string" &&
        criterion.criterionVerification.observedResult.trim().length > 0 &&
        typeof criterion.criterionVerification.adapterVersion === "string" &&
        criterion.criterionVerification.adapterVersion.trim().length > 0 &&
        Array.isArray(criterion.graphEvidence) && criterion.graphEvidence.length > 0 &&
        criterion.graphEvidence.every((row) => row.state === "bound" && row.provenance === "host:journal-projection/v2"),
      ),
    testsPassed: evidence.tests.passed && typeof evidence.tests.evidenceRef === "string" && evidence.tests.evidenceRef.length > 0,
    independentVerificationPassed:
      evidence.tests.independent && typeof evidence.tests.evidenceRef === "string" && evidence.tests.evidenceRef.length > 0,
    noPendingOperations: Number.isSafeInteger(evidence.operations.pending) && evidence.operations.pending === 0,
    noUncertainOperations: Number.isSafeInteger(evidence.operations.uncertain) && evidence.operations.uncertain === 0,
    noUnresolvedBlockers: evidence.blockers.every((blocker) => !blocker.unresolved),
    calibrationBound: modelPinMatches && policy.calibrated,
  };
}

function baseDecision(evidence: MissionClosureEvidence, policy: MissionClosurePolicy): MissionClosureDecision {
  return {
    status: "INSUFFICIENT_EVIDENCE",
    complete: false,
    missionId: evidence.missionId,
    missionRevision: evidence.missionRevision,
    evidenceRevision: evidence.evidenceRevision,
    ...(evidence.candidateDigest === undefined ? {} : { candidateDigest: evidence.candidateDigest }),
    policyVersion: policy.policyVersion,
    checks: mechanicalChecks(evidence, policy),
    reasons: [],
    confidenceIsProof: false,
  };
}

export function validSemanticDistribution(
  choice: string,
  confidence: number,
  probabilities: Record<string, number>,
): boolean {
  const keys = Object.keys(probabilities).sort();
  const expected = [...MISSION_CLOSURE_CHOICES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  const values = Object.values(probabilities);
  if (!values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return false;
  if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > PROBABILITY_TOLERANCE) return false;
  const selected = probabilities[choice];
  const highest = Math.max(...values);
  // Confidence 1.0 means a fully concentrated distribution: all mass must be
  // on the selected outcome. Lower confidence values remain model metadata
  // and are not treated as probabilities or proof of correctness.
  return selected !== undefined && selected + PROBABILITY_TOLERANCE >= highest &&
    Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 &&
    (confidence < 1 - PROBABILITY_TOLERANCE || selected >= 1 - PROBABILITY_TOLERANCE);
}

/**
 * True when deterministic preflight passed every check and the decision
 * proceeds to semantic review. This is the single predicate the controller,
 * the bench scorer, and the bench verifier share — never re-spell the
 * underlying reason string at a call site.
 */
export function preflightReachedReview(preflight: MissionClosureDecision): boolean {
  return preflight.reasons.includes("deterministic evidence checks passed; semantic review required");
}

/** Deterministic terminal checks. A Jev answer is only considered after every check passes. */
export function preflightMissionClosure(
  evidence: MissionClosureEvidence,
  policy: MissionClosurePolicy,
): MissionClosureDecision {
  const decision = baseDecision(evidence, policy);
  const { checks } = decision;
  if (evidence.blockers.some((blocker) => blocker.unresolved)) {
    return { ...decision, status: "BLOCKED", reasons: ["unresolved blockers remain"] };
  }
  if (!checks.objectivePresent) {
    return { ...decision, reasons: ["trusted original objective is missing"] };
  }
  if (!checks.objectiveCoverageEstablished) {
    return { ...decision, status: "INCOMPLETE", reasons: ["explicit objective coverage attestation is missing or stale"] };
  }
  if (!checks.objectivePresent || !checks.revisionsMatch || !checks.criteriaPresent) {
    return { ...decision, reasons: ["objective coverage, criteria, or revision evidence is missing or stale"] };
  }
  if (!checks.allCriteriaVerified || !checks.testsPassed || !checks.independentVerificationPassed) {
    return { ...decision, status: "INCOMPLETE", reasons: ["acceptance criteria, tests, or independent verification are not all satisfied"] };
  }
  if (!checks.noPendingOperations || !checks.noUncertainOperations) {
    return { ...decision, status: "INCOMPLETE", reasons: ["pending or uncertain operations remain"] };
  }
  if (!checks.calibrationBound) {
    return { ...decision, reasons: ["mission-closure judgment is not calibrated for the exact backend, model, version, and question set"] };
  }
  return { ...decision, reasons: ["deterministic evidence checks passed; semantic review required"] };
}

/**
 * Snapshot-internal readiness for verified completion on the trusted path.
 * Pure and observational: it reports per-gate booleans, it never verifies
 * and never authorizes. The gates, in order:
 *
 * - currentShape: every criterion carries this snapshot's mission and
 *   evidence revisions (stale rows fail elsewhere, never here).
 * - traceableEvidence: every criterion has graph evidence and every row is
 *   `bound` — unhealthy, unknown, stale, conflicting, or absent
 *   traceability fails this gate, never satisfies it.
 * - independentOutcomes: every criterion carries a `satisfied` independent
 *   verification bound to this revision and candidate.
 * - zeroUncertainty: no pending or uncertain operations remain.
 * - trustedProfile: the snapshot was built on the trusted-evidence path
 *   (request profile v2), so the semantic question covers qualified
 *   per-criterion evidence rather than bare execution claims.
 *
 * Still required outside this helper: the contract must be current
 * (`isCurrent` after the semantic vote), a calibrated judge must agree
 * (COMPLETE under the v2 question), and the verdict must persist as a
 * durable consistent receipt (`terminalComplete`). Execution-observed rows
 * never satisfy any gate here: only `bound` traceability plus a
 * `satisfied` independent outcome count.
 */
export interface TrustedEvidenceReadiness {
  currentShape: boolean;
  traceableEvidence: boolean;
  independentOutcomes: boolean;
  zeroUncertainty: boolean;
  trustedProfile: boolean;
  ready: boolean;
}

export function trustedEvidenceReadiness(evidence: MissionClosureEvidence): TrustedEvidenceReadiness {
  const currentShape = evidence.criteria.every(
    (criterion) =>
      criterion.missionRevision === evidence.missionRevision &&
      criterion.evidenceRevision === evidence.evidenceRevision,
  );
  const traceableEvidence =
    evidence.criteria.length > 0 &&
    evidence.criteria.every(
      (criterion) =>
        Array.isArray(criterion.graphEvidence) &&
        criterion.graphEvidence.length > 0 &&
        criterion.graphEvidence.every((row) => row.state === "bound"),
    );
  const independentOutcomes = evidence.criteria.every(
    (criterion) => criterion.criterionVerification?.result === "satisfied",
  );
  const zeroUncertainty =
    Number.isSafeInteger(evidence.operations.pending) &&
    Number.isSafeInteger(evidence.operations.uncertain) &&
    evidence.operations.pending === 0 &&
    evidence.operations.uncertain === 0;
  const trustedProfile = evidence.requestProfile === MISSION_CLOSURE_REQUEST_PROFILE_V2;
  const ready = currentShape && traceableEvidence && independentOutcomes && zeroUncertainty && trustedProfile;
  return { currentShape, traceableEvidence, independentOutcomes, zeroUncertainty, trustedProfile, ready };
}

/**
 * Mission closure is a two-part decision: deterministic evidence must pass,
 * then calibrated Jev must challenge semantic completeness. Jev's confidence
 * is recorded as a distribution-shape statistic and is never treated as proof.
 */
export async function decideMissionClosure(
  model: DecisionModel,
  evidence: MissionClosureEvidence,
  policy: MissionClosurePolicy,
  signal?: AbortSignal,
): Promise<MissionClosureDecision> {
  const preflight = preflightMissionClosure(evidence, policy);
  if (!preflightReachedReview(preflight)) return preflight;
  return evaluateAffirmative(model, evidence, policy, preflight, signal);
}

/**
 * Allowlisted graph-node projection for model-bound requests. Maps
 * `graphRuns` to exactly `{ runId, graphHash?, policyHash?, nodes: [{
 * nodeId, status, inputHash?, outputDigest?, declaredDependencies? }] }`, dropping any future
 * journal metadata, output text, or extra node fields before they can
 * leak into Jev A/B context. The wire shape is identical today because
 * the session source already projects to this shape; this is a
 * defense-in-depth boundary, not a migration.
 */
export function projectGraphRunsForRequest(
  graphRuns: MissionClosureEvidence["graphRuns"],
): Array<{
  runId: string;
  graphHash?: string;
  policyHash?: string;
  nodes: Array<{ nodeId: string; status: string; inputHash?: string; outputDigest?: string; declaredDependencies?: string[] }>;
}> {
  return (graphRuns ?? []).map((run) => ({
    runId: run.runId,
    ...(run.graphHash === undefined ? {} : { graphHash: run.graphHash }),
    ...(run.policyHash === undefined ? {} : { policyHash: run.policyHash }),
    nodes: run.nodes.map((node) => ({
      nodeId: node.nodeId,
      status: node.status,
      ...(node.inputHash === undefined ? {} : { inputHash: node.inputHash }),
      ...(node.outputDigest === undefined ? {} : { outputDigest: node.outputDigest }),
      ...(node.declaredDependencies === undefined ? {} : { declaredDependencies: node.declaredDependencies.slice(0, 64) }),
    })),
  }));
}

/**
 * Bounded per-criterion evidence projection for the v2 trusted-evidence
 * request. Allowlisted fields only: the requirement statement, the claimed
 * user outcome, the observed terminal graph states (run/node/state —
 * digests and detail stay in host evidence, never raw output, credentials,
 * or artifact text), the independent verification result plus its
 * revision/candidate scope, and derived unresolved/contradiction flags.
 * Size-capped: at most MAX_V2_OBSERVED_GRAPH_ROWS observed rows per
 * criterion; statements/outcomes clamped to their contract bounds.
 */
export type AffirmativeCriterionProjection = {
  id: string;
  requirement: string;
  claimedOutcome?: string;
  observedGraphState: Array<{ runId: string; nodeId: string; state: string }>;
  verificationResult: CriterionVerificationResult;
  supplementalVerifierObservations?: Array<{
    result: CriterionVerificationResult;
    verifierId?: string;
    receiptCorrelationId?: string;
    evidenceRef?: string;
    observedResult?: string;
    graphNodes?: Array<{ runId: string; nodeId: string; attemptId?: string }>;
  }>;
  verificationScope?: { missionRevision: string; candidateDigest: string };
  unresolved: boolean;
  contradiction: boolean;
};

/** Max observed graph rows projected per criterion in the v2 request. */
export const MAX_V2_OBSERVED_GRAPH_ROWS = 8;
/** Max chars for projected requirement/claimed-outcome text (contract bound). */
export const MAX_V2_CRITERION_TEXT_CHARS = 1000;

const clampText = (text: string): string =>
  text.length <= MAX_V2_CRITERION_TEXT_CHARS ? text : `${text.slice(0, MAX_V2_CRITERION_TEXT_CHARS - 1)}…`;

/** Allowlist and size-cap the AST facts sent with one criterion obligation. */
export function projectProofObligationForRequest(
  obligation: MissionProofObligation | undefined,
): DagLocalCriterionRequest["proofObligation"] {
  if (obligation === undefined) return undefined;
  const structure = obligation.codeStructure;
  return {
    id: obligation.id,
    criterionId: obligation.criterionId,
    requirement: clampText(obligation.requirement),
    mandatory: true,
    dependencies: obligation.dependencies.slice(0, 64).map((row) => ({ ...row })),
    requiredEvidence: [...obligation.requiredEvidence],
    ...(structure === undefined ? {} : {
      codeStructure: {
        version: structure.version,
        criterionId: structure.criterionId,
        proofObligationId: structure.proofObligationId,
        missionRevision: structure.missionRevision,
        candidateDigest: structure.candidateDigest,
        provenance: structure.provenance,
        fileDigests: structure.fileDigests.slice(0, 16).map((row) => ({ ...row })),
        symbols: structure.symbols.slice(0, 48).map((row) => ({ ...row })),
        imports: structure.imports.slice(0, 32).map((row) => ({ ...row })),
        calls: structure.calls.slice(0, 64).map((row) => ({ ...row })),
        evidenceDigest: structure.evidenceDigest,
        limitations: structure.limitations,
      },
    }),
  };
}

export function projectCriterionEvidenceForRequest(
  evidence: MissionClosureEvidence,
): AffirmativeCriterionProjection[] {
  return evidence.criteria.map((criterion) => {
    const observed = (criterion.graphEvidence ?? [])
      .filter((row) => typeof row?.runId === "string" && typeof row?.nodeId === "string" && typeof row?.state === "string")
      .slice(0, MAX_V2_OBSERVED_GRAPH_ROWS)
      .map((row) => ({ runId: row.runId, nodeId: row.nodeId, state: row.state }));
    const verificationResult = criterion.criterionVerification?.result ?? "unresolved";
    const contradiction = (criterion.graphEvidence ?? []).some((row) => row.state === "conflict") ||
      verificationResult === "failed";
    const unresolved = verificationResult !== "satisfied" || observed.every((row) => row.state !== "bound");
    const supplementalVerifierObservations = (criterion.supplementalVerifications ?? []).slice(0, 8).map((observation) => ({
      result: observation.result,
      ...(observation.verifierId === undefined ? {} : { verifierId: observation.verifierId }),
      ...(observation.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: observation.receiptCorrelationId }),
      ...(observation.evidenceRef === undefined ? {} : { evidenceRef: observation.evidenceRef.slice(0, 200) }),
      ...(observation.observedResult === undefined ? {} : { observedResult: observation.observedResult.slice(0, MAX_V2_CRITERION_TEXT_CHARS) }),
      ...(observation.graphNodes === undefined ? {} : { graphNodes: observation.graphNodes.slice(0, 16).map((node) => ({ ...node })) }),
    }));
    return {
      id: criterion.id,
      requirement: clampText(criterion.statement),
      ...(criterion.outcome === undefined ? {} : { claimedOutcome: clampText(criterion.outcome) }),
      observedGraphState: observed,
      verificationResult,
      ...(verificationResult !== "satisfied" || evidence.candidateDigest === undefined
        ? {}
        : { verificationScope: { missionRevision: criterion.missionRevision, candidateDigest: evidence.candidateDigest } }),
      ...(supplementalVerifierObservations.length === 0 ? {} : { supplementalVerifierObservations }),
      unresolved,
      contradiction,
    };
  });
}

/**
 * The exact Jev A production request for revision-bound evidence, extracted
 * as a pure builder so the calibration benchmark invokes the same shape the
 * host evaluates — never a hand-recreated approximation of it.
 *
 * Profile binding: evidence WITHOUT a trusted request profile emits
 * exactly the historical v1 shape and v1 question (bit-identical to before
 * this bridge existed). Evidence built on the trusted-evidence path
 * (`requestProfile: "mission-closure/v2-graph-evidence"`) additionally
 * carries the bounded per-criterion projection and is judged under the v2
 * question, whose hash differs from v1 — a v1-calibrated policy cannot
 * silently validate a v2 request.
 */
export function affirmativeRequest(evidence: MissionClosureEvidence): {
  state: {
    objective: string;
    acceptanceCriteria: Array<{ id: string; statement: string; outcome?: string; evidenceRef?: string }>;
    tests: { passed: boolean; independent: boolean; evidenceRef?: string };
    operations: MissionClosureEvidence["operations"];
    blockers: MissionClosureEvidence["blockers"];
    graphRuns: Json[];
    missionRevision: string;
    evidenceRevision: string;
    requestProfile?: string;
    criterionEvidence?: AffirmativeCriterionProjection[];
  };
  questions: { closure: typeof MISSION_CLOSURE_QUESTION | typeof MISSION_CLOSURE_QUESTION_V2 };
} {
  const trusted = evidence.requestProfile === MISSION_CLOSURE_REQUEST_PROFILE_V2;
  return {
    state: {
      objective: evidence.objective,
      acceptanceCriteria: evidence.criteria.map(({ id, statement, outcome, evidenceRef }) => ({
        id,
        statement,
        ...(outcome === undefined ? {} : { outcome }),
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
      })),
      tests: {
        passed: evidence.tests.passed,
        independent: evidence.tests.independent,
        ...(evidence.tests.evidenceRef === undefined ? {} : { evidenceRef: evidence.tests.evidenceRef }),
      },
      operations: evidence.operations,
      blockers: evidence.blockers,
      graphRuns: projectGraphRunsForRequest(evidence.graphRuns) as unknown as Json[],
      missionRevision: evidence.missionRevision,
      evidenceRevision: evidence.evidenceRevision,
      ...(trusted
        ? {
            requestProfile: MISSION_CLOSURE_REQUEST_PROFILE_V2,
            criterionEvidence: projectCriterionEvidenceForRequest(evidence),
          }
        : {}),
    },
    questions: { closure: trusted ? MISSION_CLOSURE_QUESTION_V2 : MISSION_CLOSURE_QUESTION },
  };
}

/**
 * Build the development candidate request from a real trusted snapshot, but
 * only after the existing deterministic preflight admits semantic review.
 * The returned question is not wired to production closure and this helper
 * cannot authorize completion. Its distinct question hash prevents reuse of
 * any v1/v2 four-choice qualification.
 */
export function semanticFulfillmentCandidateRequest(
  evidence: MissionClosureEvidence,
  policy: MissionClosurePolicy,
): {
  state: ReturnType<typeof affirmativeRequest>["state"];
  questions: { closure: typeof MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2 };
} | undefined {
  if (
    evidence.requestProfile !== MISSION_CLOSURE_REQUEST_PROFILE_V2 ||
    policy.questionHash !== hashQuestions({ closure: MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2 }) ||
    !trustedEvidenceReadiness(evidence).ready ||
    !preflightReachedReview(preflightMissionClosure(evidence, policy))
  ) return undefined;
  const { state } = affirmativeRequest(evidence);
  return { state, questions: { closure: MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2 } };
}

/** Run one criterion-isolated, development-only semantic judgment. */
export async function evaluateDagLocalCriterion(
  model: DecisionModel,
  evidence: MissionClosureEvidence,
  criterionId: string,
  signal?: AbortSignal,
  probeOptions: readonly DagLocalVerificationProbeOption[] = [],
): Promise<DagLocalCriterionJudgment | undefined> {
  const request = dagLocalCriterionRequest(evidence, criterionId, probeOptions);
  if (request === undefined) return undefined;
  const result = await model.evaluate({
    state: request.state as unknown as Record<string, Json>,
    questions: request.questions,
    ...(signal === undefined ? {} : { signal }),
  });
  const answer = result.answers.fulfillment;
  if (answer?.type !== "choice" ||
      !(MISSION_SEMANTIC_FULFILLMENT_CHOICES as readonly string[]).includes(answer.choice) ||
      !validDagLocalCriterionDistribution(answer.choice, answer.confidence, answer.probabilities)) return undefined;
  const probeAnswer = result.answers.probe;
  if (request.probeOptions.length > 0) {
    const allowed = new Set([...request.probeOptions.map((option) => option.id), DAG_LOCAL_NO_PROBE]);
    if (probeAnswer?.type !== "choice" || !allowed.has(probeAnswer.choice)) return undefined;
  } else if (probeAnswer !== undefined) {
    return undefined;
  }
  return {
    criterionId,
    missionRevision: request.missionRevision,
    candidateDigest: request.candidateDigest,
    evidenceDigest: request.evidenceDigest,
    graphRevision: request.graphRevision,
    contextHash: request.contextHash,
    graphNodeIds: request.graphNodeIds,
    verifierProvenance: {
      ...(request.verifier.verifierId === undefined ? {} : { verifierId: request.verifier.verifierId }),
      ...(request.verifier.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: request.verifier.receiptCorrelationId }),
      ...(request.verifier.evidenceRef === undefined ? {} : { evidenceRef: request.verifier.evidenceRef }),
      ...(request.verifier.adapterVersion === undefined ? {} : { adapterVersion: request.verifier.adapterVersion }),
    },
    choice: answer.choice as SemanticFulfillmentChoice,
    disposition: dagLocalDisposition(answer.choice as SemanticFulfillmentChoice),
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    provider: result.provider,
    model: result.model,
    questionHash: result.questionHash,
    latencyMs: result.latency_ms,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    ...(result.usage.cost_usd === undefined ? {} : { costUsd: result.usage.cost_usd }),
    ...(probeAnswer?.type === "choice"
      ? { recommendedProbe: probeAnswer.choice }
      : {}),
  };
}

/** Separate development-only atomic-question candidate; no terminal authority. */
export const DAG_LOCAL_ATOMIC_QUESTIONS_V1 = {
  evidenceRelevance: {
    type: "noul" as const,
    instructions: "Does the supplied host verifier observation directly test the named requirement, considering the listed code structure and graph dependencies?",
    criteria: {
      true: "The observation directly exercises or inspects the behavior named by the requirement.",
      false: "The observation is unrelated, too indirect, or does not test the named behavior.",
    },
  },
  requirementSatisfied: {
    type: "noul" as const,
    instructions: "Do the supplied independently observed verifier results show that the named requirement is satisfied?",
    criteria: {
      true: "The current host verifier observation demonstrates the required behavior.",
      false: "The current host verifier observation shows a missing, partial, or failed behavior.",
    },
  },
  semanticMismatch: {
    type: "noul" as const,
    instructions: "Does the supplied relevant host evidence contradict the named requirement or show a semantic mismatch?",
    criteria: {
      true: "Relevant observed evidence contradicts the requirement or demonstrates a shortfall.",
      false: "Relevant observed evidence does not contradict the requirement.",
    },
  },
};
export const DAG_LOCAL_ATOMIC_PROFILE_V1 = "mission-dag-local-atomic-noul/v1";
export const DAG_LOCAL_ATOMIC_QUESTION_HASH_V1 = hashQuestions(DAG_LOCAL_ATOMIC_QUESTIONS_V1);

export interface DagLocalAtomicAnswers {
  evidenceRelevance: number;
  requirementSatisfied: number;
  semanticMismatch: number;
}

export interface DagLocalAtomicJudgment {
  criterionId: string;
  missionRevision: string;
  candidateDigest: string;
  evidenceDigest: string;
  graphRevision: string;
  contextHash: string;
  graphNodeIds: DagLocalCriterionRequest["graphNodeIds"];
  verifierProvenance: DagLocalCriterionJudgment["verifierProvenance"];
  answers: DagLocalAtomicAnswers;
  disposition: "SATISFIED" | "UNSATISFIED" | "UNCERTAIN";
  provider: string;
  model: string;
  questionHash: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface DagLocalAtomicCriterionRequest {
  criterionId: string;
  state: Record<string, Json>;
  questions: typeof DAG_LOCAL_ATOMIC_QUESTIONS_V1;
  questionHash: typeof DAG_LOCAL_ATOMIC_QUESTION_HASH_V1;
  contextHash: string;
}

/**
 * Explicit preregistered development rule. Noul is P(yes), not a separate
 * confidence value; these cut points are unqualified and cannot authorize
 * production completion until this question family is independently calibrated.
 */
export function composeDagLocalAtomicDisposition(answers: DagLocalAtomicAnswers): DagLocalAtomicJudgment["disposition"] {
  if (!Object.values(answers).every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return "UNCERTAIN";
  if (answers.evidenceRelevance <= 0.1) return "UNCERTAIN";
  if (answers.semanticMismatch >= 0.9 || answers.requirementSatisfied <= 0.1) return "UNSATISFIED";
  if (answers.evidenceRelevance >= 0.9 && answers.requirementSatisfied >= 0.9 && answers.semanticMismatch <= 0.1) return "SATISFIED";
  return "UNCERTAIN";
}

/** Model-facing projection intentionally omits mission/candidate/receipt hashes and agent claims. */
function atomicModelState(request: DagLocalCriterionRequest): Record<string, Json> {
  const structure = request.state.proofObligation?.codeStructure;
  const symbols = new Map((structure?.symbols ?? []).map((symbol) => [symbol.id, `${symbol.path}:${symbol.name}`]));
  const safeText = (value: string): string => value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key omitted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})\b/g, "[secret omitted]")
    .replace(/\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "[credential omitted]")
    .replace(/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[token omitted]")
    .replace(/\b((?:api[_-]?key|apikey|secret|password|passwd|pwd|token|access[_-]?key|private[_-]?key|auth|credential)s?)\s*[:=]\s*(?:"[^"]{4,}"|'[^']{4,}'|[^\s,;&"']{4,})/gi, "$1=[secret omitted]")
    .replace(/\b[0-9a-f]{32,64}\b/gi, "[digest omitted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  const safeNodeId = (value: string): string => safeText(value).slice(0, 96);
  return {
    requirement: safeText(request.state.requirement),
    dependencies: request.state.proofObligation?.dependencies.map(({ nodeId, state }) => ({ nodeId: safeNodeId(nodeId), state })) ?? [],
    execution: request.graphNodeIds.slice(0, 8).map(({ nodeId, status, dependencies }) => ({
      nodeId: safeNodeId(nodeId), status, ...(dependencies === undefined ? {} : {
        dependencies: dependencies.slice(0, 16).map((dependency) => ({ nodeId: safeNodeId(dependency.nodeId), state: dependency.state })),
      }),
    })),
    observedVerifier: {
      result: request.verifier.result,
      state: request.verifier.observationState,
      // `detail` is a verifier diagnostic, not an observed outcome. Keep the
      // model view limited to the host-produced behavior/result description.
      ...(request.verifier.observedResult === undefined ? {} : { observation: safeText(request.verifier.observedResult) }),
    },
    ...(structure === undefined ? {} : {
      codeStructure: {
        symbols: structure.symbols.slice(0, 24).map(({ path, name, kind, line }) => ({ path: safeText(path), name: safeText(name), kind, line })),
        imports: structure.imports.slice(0, 16).map(({ path, specifier, resolution, resolvedPath }) => ({
          path: safeText(path), specifier: safeText(specifier), resolution,
          ...(resolvedPath === undefined ? {} : { resolvedPath: safeText(resolvedPath) }),
        })),
        calls: structure.calls.slice(0, 32).map(({ path, callerSymbolId, callee, line, relation, targetSymbolId }) => ({
          path: safeText(path), ...(callerSymbolId === undefined ? {} : { caller: safeText(symbols.get(callerSymbolId) ?? "unresolved") }),
          callee: safeText(callee), line, relation,
          ...(targetSymbolId === undefined ? {} : { target: safeText(symbols.get(targetSymbolId) ?? "unresolved") }),
        })),
      },
    }),
  };
}

/** Exact atomic model context shared by blind review packets and live scoring. */
export function dagLocalAtomicCriterionRequest(
  evidence: MissionClosureEvidence,
  criterionId: string,
): DagLocalAtomicCriterionRequest | undefined {
  const request = dagLocalCriterionRequest(evidence, criterionId);
  if (request === undefined || request.verifier.observationState !== "observed") return undefined;
  const state = atomicModelState(request);
  return {
    criterionId,
    state,
    questions: DAG_LOCAL_ATOMIC_QUESTIONS_V1,
    questionHash: DAG_LOCAL_ATOMIC_QUESTION_HASH_V1,
    contextHash: createHash("sha256").update(JSON.stringify(state), "utf8").digest("hex"),
  };
}

export async function evaluateDagLocalAtomicCriterion(
  model: DecisionModel,
  evidence: MissionClosureEvidence,
  criterionId: string,
  signal?: AbortSignal,
): Promise<DagLocalAtomicJudgment | undefined> {
  const request = dagLocalCriterionRequest(evidence, criterionId);
  const modelRequest = dagLocalAtomicCriterionRequest(evidence, criterionId);
  if (request === undefined || modelRequest === undefined) return undefined;
  const { state, contextHash } = modelRequest;
  const result = await model.evaluate({ state, questions: modelRequest.questions, ...(signal === undefined ? {} : { signal }) });
  if (result.questionHash !== DAG_LOCAL_ATOMIC_QUESTION_HASH_V1) return undefined;
  const answers: DagLocalAtomicAnswers = {
    evidenceRelevance: result.answers.evidenceRelevance?.type === "noul" ? result.answers.evidenceRelevance.noul : Number.NaN,
    requirementSatisfied: result.answers.requirementSatisfied?.type === "noul" ? result.answers.requirementSatisfied.noul : Number.NaN,
    semanticMismatch: result.answers.semanticMismatch?.type === "noul" ? result.answers.semanticMismatch.noul : Number.NaN,
  };
  if (!Object.values(answers).every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return undefined;
  const verifierProvenance = {
    ...(request.verifier.verifierId === undefined ? {} : { verifierId: request.verifier.verifierId }),
    ...(request.verifier.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: request.verifier.receiptCorrelationId }),
    ...(request.verifier.evidenceRef === undefined ? {} : { evidenceRef: request.verifier.evidenceRef }),
    ...(request.verifier.adapterVersion === undefined ? {} : { adapterVersion: request.verifier.adapterVersion }),
  };
  return {
    criterionId,
    missionRevision: request.missionRevision,
    candidateDigest: request.candidateDigest,
    evidenceDigest: createHash("sha256").update(JSON.stringify({ requestEvidenceDigest: request.evidenceDigest, contextHash }), "utf8").digest("hex"),
    graphRevision: request.graphRevision,
    contextHash,
    graphNodeIds: request.graphNodeIds,
    verifierProvenance,
    answers,
    disposition: composeDagLocalAtomicDisposition(answers),
    provider: result.provider,
    model: result.model,
    questionHash: result.questionHash,
    latencyMs: result.latency_ms,
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    ...(result.usage.cost_usd === undefined ? {} : { costUsd: result.usage.cost_usd }),
  };
}

/** Deterministic development aggregation for the atomic candidate; never terminal authority. */
export function aggregateDagLocalAtomicJudgments(args: {
  evidence: MissionClosureEvidence;
  judgments: DagLocalAtomicJudgment[];
  expectedProvider: string;
  expectedModel: string;
  expectedQuestionHash: string;
}): {
  semanticDisposition: SemanticFulfillmentChoice;
  disposition: SemanticFulfillmentChoice;
  missingCriterionIds: string[];
  unqualifiedCriterionIds: string[];
  objectiveCoverage: "covered" | "unresolved";
  policyQualified: false;
  terminalComplete: false;
} {
  const coverage = args.evidence.objectiveCoverage?.status === "attested" &&
    args.evidence.objectiveCoverage.source === "user-prompt-objective-coverage" &&
    args.evidence.objectiveCoverage.missionRevision === args.evidence.missionRevision &&
    /^[0-9a-f]{64}$/.test(args.evidence.objectiveCoverage.promptHash ?? "") ? "covered" as const : "unresolved" as const;
  const ids = args.evidence.criteria.map(({ id }) => id).sort();
  const byId = new Map(args.judgments.map((judgment) => [judgment.criterionId, judgment]));
  const missingCriterionIds: string[] = [];
  const unqualifiedCriterionIds: string[] = [];
  const dispositions: DagLocalAtomicJudgment["disposition"][] = [];
  for (const id of ids) {
    const criterion = args.evidence.criteria.find((entry) => entry.id === id)!;
    const request = dagLocalCriterionRequest(args.evidence, id);
    const judgment = byId.get(id);
    if (request === undefined || judgment === undefined) {
      missingCriterionIds.push(id);
      continue;
    }
    const state = atomicModelState(request);
    const contextHash = createHash("sha256").update(JSON.stringify(state), "utf8").digest("hex");
    const expectedEvidenceDigest = createHash("sha256").update(JSON.stringify({ requestEvidenceDigest: request.evidenceDigest, contextHash }), "utf8").digest("hex");
    const expectedProvenance = {
      ...(request.verifier.verifierId === undefined ? {} : { verifierId: request.verifier.verifierId }),
      ...(request.verifier.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: request.verifier.receiptCorrelationId }),
      ...(request.verifier.evidenceRef === undefined ? {} : { evidenceRef: request.verifier.evidenceRef }),
      ...(request.verifier.adapterVersion === undefined ? {} : { adapterVersion: request.verifier.adapterVersion }),
    };
    if (request.verifier.observationState !== "observed" ||
        judgment.missionRevision !== request.missionRevision || judgment.candidateDigest !== request.candidateDigest ||
        judgment.evidenceDigest !== expectedEvidenceDigest || judgment.graphRevision !== request.graphRevision ||
        judgment.contextHash !== contextHash || JSON.stringify(judgment.graphNodeIds) !== JSON.stringify(request.graphNodeIds) ||
        JSON.stringify(judgment.verifierProvenance) !== JSON.stringify(expectedProvenance) ||
        judgment.provider !== args.expectedProvider || judgment.model !== args.expectedModel ||
        judgment.questionHash !== args.expectedQuestionHash || args.expectedQuestionHash !== DAG_LOCAL_ATOMIC_QUESTION_HASH_V1 ||
        !Object.values(judgment.answers).every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
        judgment.disposition !== composeDagLocalAtomicDisposition(judgment.answers) ||
        request.graphNodeIds.some((row) => row.bindingState === "bound" &&
          (row.status !== "succeeded" || row.attemptId === undefined || row.provenance !== "host:journal-projection/v2"))) {
      unqualifiedCriterionIds.push(id);
      continue;
    }
    dispositions.push(judgment.disposition);
    if (criterion.criterionVerification?.result === "failed" || request.graphNodeIds.some((row) => row.status === "failed")) {
      dispositions[dispositions.length - 1] = "UNSATISFIED";
    }
  }
  const duplicateOrForeign = args.judgments.length !== ids.length || byId.size !== args.judgments.length;
  const deterministicUnknown = args.evidence.criteria.some((criterion) =>
    !criterion.verified || criterion.criterionVerification?.result !== "satisfied" ||
    criterion.criterionVerification.observedResult === undefined || criterion.criterionVerification.receiptCorrelationId === undefined ||
    criterion.criterionVerification.adapterVersion === undefined || (criterion.graphEvidence ?? []).length === 0 ||
    criterion.graphEvidence?.some((row) => row.state !== "bound" || row.provenance !== "host:journal-projection/v2") ||
    (dagLocalCriterionRequest(args.evidence, criterion.id)?.graphNodeIds.some((row) => row.status !== "succeeded") ?? true),
  );
  const semanticDisposition: SemanticFulfillmentChoice = dispositions.includes("UNSATISFIED") ? "NOT_FULFILLED" :
    coverage === "covered" && !duplicateOrForeign && missingCriterionIds.length === 0 && unqualifiedCriterionIds.length === 0 &&
    dispositions.length === ids.length && dispositions.every((value) => value === "SATISFIED") && !deterministicUnknown
      ? "FULFILLED" : "UNCERTAIN";
  const disposition = semanticDisposition === "FULFILLED" ? "UNCERTAIN" : semanticDisposition;
  return { semanticDisposition, disposition, missingCriterionIds, unqualifiedCriterionIds, objectiveCoverage: coverage, policyQualified: false, terminalComplete: false };
}

/**
 * Candidate evidence-summary backbone for the richness experiment (P1-E).
 * Builds bounded, deterministic summary lines ONLY from verified,
 * revision-matched, host-owned facts: the mission objective, criterion
 * statements with their recorded verified flags and evidence references,
 * test/operation/blocker states with revisions, and revision identity.
 * Agent-authored outcome strings are never consulted: they are claims for
 * the semantic judge to weigh in `state`, never facts for the summary to
 * assert. NOT wired into `affirmativeRequest`: activating the summary in
 * the production request requires operator-authorized metered validation
 * on development/validation data first. The frozen blind lockbox is
 * untouched.
 */
export const EVIDENCE_SUMMARY_MAX_LINES = 12;
export const EVIDENCE_SUMMARY_MAX_LINE_CHARS = 160;
export const EVIDENCE_SUMMARY_MAX_CHARS = 2000;

export function summarizeVerifiedEvidence(evidence: MissionClosureEvidence): string[] {
  const clip = (text: string): string =>
    text.length <= EVIDENCE_SUMMARY_MAX_LINE_CHARS ? text : `${text.slice(0, EVIDENCE_SUMMARY_MAX_LINE_CHARS - 1)}…`;
  const lines: string[] = [
    clip(`mission "${evidence.objective}" rev ${evidence.missionRevision}: ` +
      `${evidence.criteria.length} criteria, evidence bundle rev ${evidence.evidenceRevision}.`),
  ];
  const shown = evidence.criteria.slice(0, EVIDENCE_SUMMARY_MAX_LINES - 4);
  for (const criterion of shown) {
    lines.push(clip(
      `criterion "${criterion.id}" ${criterion.verified ? "verified" : "unverified"}: ` +
      `"${criterion.statement}" — evidence ${criterion.evidenceRef ?? "none"} ` +
      `(rev ${criterion.evidenceRevision}).`,
    ));
  }
  const hidden = evidence.criteria.length - shown.length;
  if (hidden > 0) lines.push(`+${hidden} further criteria omitted by the summary bound.`);
  const drift = evidence.tests.revision === evidence.evidenceRevision
    ? ""
    : `; revision drift vs bundle rev ${evidence.evidenceRevision}`;
  lines.push(clip(
    `tests: ${evidence.tests.passed ? "passing" : "failing"}, ` +
    `${evidence.tests.independent ? "independently verified" : "not independently verified"} ` +
    `(${evidence.tests.evidenceRef ?? "no receipt"}, rev ${evidence.tests.revision}${drift}).`,
  ));
  const unresolved = evidence.blockers.filter((b) => b.unresolved);
  lines.push(clip(
    `operations: ${evidence.operations.pending} pending, ${evidence.operations.uncertain} uncertain; ` +
    `blockers: ${unresolved.length === 0 ? "none" : `${unresolved.length} unresolved (${unresolved.map((b) => b.id).join(", ")})`}.`,
  ));
  const joined = lines.join("\n");
  if (joined.length <= EVIDENCE_SUMMARY_MAX_CHARS) return lines;
  return [joined.slice(0, EVIDENCE_SUMMARY_MAX_CHARS - 1) + "…"];
}

/** Jev A alone: the affirmative semantic challenge over revision-bound evidence. */
export async function evaluateAffirmative(
  model: DecisionModel,
  evidence: MissionClosureEvidence,
  policy: MissionClosurePolicy,
  preflight: MissionClosureDecision,
  signal?: AbortSignal,
): Promise<MissionClosureDecision> {
  const { state, questions } = affirmativeRequest(evidence);
  try {
    const result = await model.evaluate({
      state,
      questions,
      ...(signal === undefined ? {} : { signal }),
    });
    const rawAnswer = result.answers.closure;
    if (rawAnswer?.type !== "choice") {
      return {
        ...preflight,
        reasons: ["semantic judgment chose an outcome outside the calibrated set; the vote is not usable"],
        failure: { kind: "invalid", detail: "non-choice semantic answer" },
      };
    }
    const answer = rawAnswer as ChoiceAnswer;
    if (!(MISSION_CLOSURE_CHOICES as readonly string[]).includes(answer.choice)) {
      return {
        ...preflight,
        reasons: ["semantic judgment chose an outcome outside the calibrated set; the vote is not usable"],
        failure: { kind: "invalid", detail: "choice outside calibrated set" },
      };
    }
    if (!validSemanticDistribution(answer.choice, answer.confidence, answer.probabilities)) {
      return {
        ...preflight,
        reasons: ["semantic judgment distribution was invalid or did not support the selected outcome"],
        failure: { kind: "invalid", detail: "invalid semantic distribution" },
      };
    }
    const bound =
      result.provider === policy.backend &&
      result.model === policy.modelVersion &&
      result.questionHash === policy.questionHash;
    if (!bound) {
      return {
        ...preflight,
        reasons: ["semantic judgment binding did not match the calibrated backend, model version, or question set"],
        failure: { kind: "invalid", detail: "unbound semantic vote" },
      };
    }
    if (answer.choice !== "COMPLETE") {
      return {
        ...preflight,
        status: answer.choice as MissionClosureStatus,
        reasons: [`Jev semantic challenge returned ${answer.choice}`],
        model: result.model,
        modelVersion: policy.modelVersion,
        provider: result.provider,
        ...(result.correlationId === undefined ? {} : { providerRequestId: result.correlationId }),
        questionHash: result.questionHash,
        calibrationVersion: policy.calibrationVersion,
        confidence: answer.confidence,
        probabilities: { ...answer.probabilities },
      };
    }
    if (answer.confidence < policy.minConfidence || answer.probabilities.COMPLETE! < policy.minConfidence) {
      return {
        ...preflight,
        reasons: [`Jev chose COMPLETE below the calibrated confidence or outcome-probability threshold ${policy.minConfidence}`],
        model: result.model,
        modelVersion: policy.modelVersion,
        provider: result.provider,
        ...(result.correlationId === undefined ? {} : { providerRequestId: result.correlationId }),
        questionHash: result.questionHash,
        calibrationVersion: policy.calibrationVersion,
        confidence: answer.confidence,
        probabilities: { ...answer.probabilities },
      };
    }
    return {
      ...preflight,
      status: "COMPLETE",
      complete: true,
      reasons: ["deterministic checks passed and calibrated Jev semantic challenge agreed; confidence is not proof"],
      model: result.model,
      modelVersion: policy.modelVersion,
      provider: result.provider,
      ...(result.correlationId === undefined ? {} : { providerRequestId: result.correlationId }),
      questionHash: result.questionHash,
      calibrationVersion: policy.calibrationVersion,
      confidence: answer.confidence,
      probabilities: { ...answer.probabilities },
    };
  } catch (error) {
    // `error.name` is model-path-controlled text: the bounded classifier
    // keeps only a conventional error-class token so a hostile throw cannot
    // inject content into decision reasons (which the Stop hook persists to
    // the decision log).
    const failure = classifySemanticFailure(error);
    return {
      ...preflight,
      reasons: [`semantic judgment unavailable: ${failure.detail}`],
      failure,
    };
  }
}

/**
 * The exact Jev B production request for revision-bound evidence, extracted
 * as a pure builder so the calibration benchmark invokes the same shape the
 * host evaluates — never a hand-recreated approximation of it.
 */
export function adversarialRequest(evidence: MissionClosureEvidence): {
  state: {
    objective: string;
    acceptanceCriteria: Array<{ id: string; statement: string; verified: boolean; outcome?: string; evidenceRef?: string }>;
    tests: { passed: boolean; independent: boolean; evidenceRef?: string };
    operations: MissionClosureEvidence["operations"];
    blockers: MissionClosureEvidence["blockers"];
    graphRuns: Json[];
    missionRevision: string;
    evidenceRevision: string;
  };
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
} {
  return {
    state: {
      objective: evidence.objective,
      acceptanceCriteria: evidence.criteria.map(({ id, statement, outcome, evidenceRef, verified }) => ({
        id,
        statement,
        verified,
        ...(outcome === undefined ? {} : { outcome }),
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
      })),
      tests: {
        passed: evidence.tests.passed,
        independent: evidence.tests.independent,
        ...(evidence.tests.evidenceRef === undefined ? {} : { evidenceRef: evidence.tests.evidenceRef }),
      },
      operations: evidence.operations,
      blockers: evidence.blockers,
      graphRuns: projectGraphRunsForRequest(evidence.graphRuns) as unknown as Json[],
      missionRevision: evidence.missionRevision,
      evidenceRevision: evidence.evidenceRevision,
    },
    questions: adversarialQuestionsFor(evidence),
  };
}

/**
 * Jev B alone: the adversarial gap challenge over the same revision-bound
 * snapshot Jev A saw. Returns `undefined` when the adversarial contract is
 * uncalibrated or the answer is unusable — never a fabricated gap verdict.
 */
export async function evaluateAdversarial(
  model: DecisionModel,
  evidence: MissionClosureEvidence,
  policy: MissionClosurePolicy,
  signal?: AbortSignal,
): Promise<AdversarialJudgeResult | undefined> {
  if (policy.adversarialCalibrationVersion === undefined || policy.adversarialCalibrationVersion.trim() === "") return undefined;
  const { state, questions } = adversarialRequest(evidence);
  // Dynamic binding: the answer must match the hash of the exact question
  // set asked in this call. A static policy hash cannot work here because
  // per-criterion questions vary with the evidence under review.
  const expectedQuestionHash = hashQuestions(questions);
  try {
    const result = await model.evaluate({
      state,
      questions,
      ...(signal === undefined ? {} : { signal }),
    });
    const bound =
      result.provider === policy.backend &&
      result.model === policy.modelVersion &&
      result.questionHash === expectedQuestionHash;
    if (!bound) return undefined;
    const rawGap = result.answers.gap;
    if (rawGap?.type !== "choice") return undefined;
    const gapAnswer = rawGap as ChoiceAnswer;
    if (
      !(ADVERSARIAL_GAP_CHOICES as readonly string[]).includes(gapAnswer.choice) ||
      !validGapDistribution(gapAnswer.choice, gapAnswer.confidence, gapAnswer.probabilities)
    ) return undefined;
    const perCriterion: Record<string, CriterionGap> = {};
    for (const criterion of evidence.criteria) {
      const raw = (result.answers as Record<string, { type?: unknown; choice?: unknown } | undefined>)[`gap_${criterion.id}`];
      perCriterion[criterion.id] = raw?.type === "choice" && validCriterionGap(raw.choice) ? raw.choice : "UNKNOWN";
    }
    return {
      gap: gapAnswer.choice as AdversarialGap,
      perCriterion,
      findings: [],
      model: result.model,
      modelVersion: policy.modelVersion,
      provider: result.provider,
      ...(result.correlationId === undefined ? {} : { providerRequestId: result.correlationId }),
      questionHash: result.questionHash,
      ...(policy.adversarialCalibrationVersion === undefined ? {} : { calibrationVersion: policy.adversarialCalibrationVersion }),
      confidence: gapAnswer.confidence,
      probabilities: { ...gapAnswer.probabilities },
    };
  } catch {
    return undefined;
  }
}

/**
 * Pair controller. Unanimous approval is necessary for completion, never
 * sufficient: the deterministic preflight stays the acceptance prerequisite.
 * Disagreement never continues work by itself — continuation requires a
 * specific, actionable defect tied to a criterion, and each iteration must
 * advance the evidence revision. A repeated challenge on unchanged evidence
 * terminates as BLOCKED, and speculation without a target gathers evidence
 * instead of vetoing.
 */
export function resolveAdversarialClosure(
  affirmative: MissionClosureDecision,
  adversarial: AdversarialJudgeResult | undefined,
  evidence: MissionClosureEvidence,
  priorChallenges: PriorAdversarialChallenge[] = [],
): AdversarialClosureDecision {
  const noAdversarial: AdversarialClosureDecision = {
    state: "GATHER_EVIDENCE",
    affirmative: affirmative.status,
    adversarial: adversarial ?? { gap: "UNKNOWN", perCriterion: {}, findings: [] },
    conflictingFindings: [],
    priorChallengeRepeated: false,
    reasons: ["adversarial judgment unavailable or uncalibrated; gather evidence or repair the provider path"],
  };
  if (adversarial === undefined) return noAdversarial;

  const supportedTargets = Object.entries(adversarial.perCriterion)
    .filter(([, verdict]) => verdict === "GAP")
    .map(([id]) => id);
  const unknownTargets = Object.entries(adversarial.perCriterion)
    .filter(([, verdict]) => verdict === "UNKNOWN")
    .map(([id]) => id);
  const gapSupported = adversarial.gap === "SUPPORTED_GAP" && supportedTargets.length > 0;
  const gapUnknown = adversarial.gap === "UNKNOWN";
  // A criterion-level GAP is never overridden by an overall NO_GAP_FOUND:
  // the overall verdict must be consistent with every per-criterion judgment.
  const inconsistentNoGap = adversarial.gap === "NO_GAP_FOUND" && supportedTargets.length > 0;
  // A SUPPORTED_GAP that names no criterion is speculation, not a veto.
  const speculative = adversarial.gap === "SUPPORTED_GAP" && supportedTargets.length === 0;

  // Every criterion-level GAP is validated against the deterministic evidence
  // before it may direct work. The kind records what the evidence itself
  // establishes — never the model's assertion alone.
  const validations = new Map(
    supportedTargets.map((criterionId) => [criterionId, validateAdversarialFinding(evidence, criterionId)] as const),
  );
  const findings: AdversarialFinding[] = supportedTargets.map((criterionId) => {
    const validation = validations.get(criterionId);
    return {
      criterionId,
      kind: validation?.status === "corroborated" ? validation.defectKind : "unsupported-claim",
      evidence: evidence.criteria.find((criterion) => criterion.id === criterionId)?.evidenceRef ?? "no evidence reference",
    };
  });

  if (gapUnknown || speculative) {
    const leastEvidenced = evidence.criteria.find((criterion) =>
      !criterion.verified || criterion.outcome === undefined || criterion.evidenceRef === undefined,
    ) ?? evidence.criteria[0];
    return {
      state: "GATHER_EVIDENCE",
      affirmative: affirmative.status,
      adversarial,
      conflictingFindings: findings,
      priorChallengeRepeated: false,
      ...(leastEvidenced === undefined ? {} : {
        repairTask: {
          criterionId: leastEvidenced.id,
          finding: speculative
            ? "adversarial judge reported a gap without identifying the affected criterion"
            : "adversarial judgment was uncertain",
          requiredEvidence: `targeted verification for criterion ${leastEvidenced.id}: a test, receipt, or attestation that resolves it`,
          evidenceRevision: evidence.evidenceRevision,
          defectKind: "unresolved-requirement" as const,
          evidenceRefs: leastEvidenced.evidenceRef === undefined ? [] : [leastEvidenced.evidenceRef],
          ...(evidence.candidateDigest === undefined ? {} : { baseCandidateDigest: evidence.candidateDigest }),
          maxAttempts: MAX_ADVERSARIAL_REPAIR_ATTEMPTS,
        },
      }),
      reasons: [
        speculative
          ? "adversarial gap claim names no affected criterion; targeted verification required, not a veto"
          : "adversarial judgment was uncertain; gather evidence or report uncertainty",
      ],
    };
  }

  if (gapSupported || inconsistentNoGap) {
    const target = supportedTargets[0] as string;
    const repeated = priorChallenges.some((prior) =>
      prior.criterionId === target && prior.evidenceRevision === evidence.evidenceRevision,
    );
    // A repeated challenge on unchanged evidence terminates regardless of
    // whether the finding was corroborated: neither repair nor re-verification
    // may loop forever.
    if (repeated) {
      return {
        state: "BLOCKED",
        affirmative: affirmative.status,
        adversarial,
        conflictingFindings: findings,
        priorChallengeRepeated: true,
        reasons: [
          `criterion ${target} was already challenged at evidence revision ${evidence.evidenceRevision} with no new evidence since; further progress is impossible without it`,
        ],
      };
    }
    const criterion = evidence.criteria.find((item) => item.id === target);
    const validation = validations.get(target);
    // An uncorroborated GAP never becomes a mandatory repair: the model
    // assertion alone, against fully attested evidence with passing tests,
    // orders targeted independent verification instead of rework.
    if (validation?.status !== "corroborated") {
      return {
        state: "GATHER_EVIDENCE",
        affirmative: affirmative.status,
        adversarial,
        conflictingFindings: findings,
        priorChallengeRepeated: false,
        repairTask: {
          criterionId: target,
          finding: `adversarial judge asserted a gap in criterion ${target}, but ${validation?.detail ?? "the assertion has no deterministic corroboration"}`,
          requiredEvidence: `independent verification of criterion ${target} on the current candidate, advancing revision ${evidence.evidenceRevision}`,
          evidenceRevision: evidence.evidenceRevision,
          defectKind: "unsupported-claim" as const,
          evidenceRefs: criterion?.evidenceRef === undefined ? [] : [criterion.evidenceRef],
          ...(evidence.candidateDigest === undefined ? {} : { baseCandidateDigest: evidence.candidateDigest }),
          maxAttempts: MAX_ADVERSARIAL_REPAIR_ATTEMPTS,
        },
        reasons: [
          `criterion-level GAP in ${target} is preserved (never overridden by an overall verdict) but lacks deterministic corroboration; verify independently rather than repair`,
        ],
      };
    }
    return {
      state: "REPAIR",
      affirmative: affirmative.status,
      adversarial,
      conflictingFindings: findings,
      priorChallengeRepeated: false,
      repairTask: {
        criterionId: target,
        finding: `adversarial judge found a material gap in criterion ${target}: ${validation.detail} (evidence: ${criterion?.evidenceRef ?? "none"})`,
        requiredEvidence: `repair criterion ${target} and produce new evidence advancing revision ${evidence.evidenceRevision}`,
        evidenceRevision: evidence.evidenceRevision,
        defectKind: validation.defectKind,
        evidenceRefs: criterion?.evidenceRef === undefined ? [] : [criterion.evidenceRef],
        ...(evidence.candidateDigest === undefined ? {} : { baseCandidateDigest: evidence.candidateDigest }),
        maxAttempts: MAX_ADVERSARIAL_REPAIR_ATTEMPTS,
      },
      reasons: [inconsistentNoGap
        ? `adversarial overall verdict conflicts with a criterion-level GAP in ${target}; the criterion judgment governs, repair or reconcile`
        : `adversarial judge found a supported material gap in criterion ${target}; repair or reconcile`],
    };
  }

  // An UNKNOWN criterion is never silently treated as NO_GAP: without a
  // per-criterion verdict for every required criterion there is no consensus.
  if (unknownTargets.length > 0) {
    return {
      state: "GATHER_EVIDENCE",
      affirmative: affirmative.status,
      adversarial,
      conflictingFindings: findings,
      priorChallengeRepeated: false,
      reasons: [`adversarial judgment left criteria uncertain (${unknownTargets.join(", ")}); gather targeted evidence, do not accept`],
    };
  }

  // NO_GAP_FOUND: eligible for completion only if Jev A and every deterministic gate agree.
  if (affirmative.status === "COMPLETE" && affirmative.complete) {
    return {
      state: "ACCEPT",
      affirmative: affirmative.status,
      adversarial,
      conflictingFindings: [],
      priorChallengeRepeated: false,
      reasons: ["deterministic checks passed, affirmative and adversarial judges agree; confidence is not proof"],
    };
  }
  return {
    state: "GATHER_EVIDENCE",
    affirmative: affirmative.status,
    adversarial,
    conflictingFindings: [],
    priorChallengeRepeated: false,
    reasons: ["affirmative judge did not find completion and no gap explains it; investigate missing requirements or inconsistent judgments"],
  };
}

/**
 * Full pair evaluation: deterministic preflight, then Jev A and Jev B
 * independently against the same revision-bound snapshot. The two calls run
 * concurrently; they ask different hypotheses, never the same question twice.
 */
/**
 * Layering note: through this pipeline REPAIR is unreachable, by construction.
 * Every `validateAdversarialFinding` corroboration condition (unattested
 * criterion, stale revision, missing outcome/reference, failing tests)
 * independently fails `preflightMissionClosure`, so the pair is never
 * consulted on evidence that could corroborate a gap. REPAIR remains
 * available to direct `resolveAdversarialClosure` callers as defense in
 * depth; here the reachable pair states are ACCEPT, GATHER_EVIDENCE, and
 * BLOCKED (repeated challenge).
 */
export async function decideAdversarialClosure(
  model: DecisionModel,
  evidence: MissionClosureEvidence,
  policy: MissionClosurePolicy,
  options: { priorChallenges?: PriorAdversarialChallenge[]; signal?: AbortSignal | undefined } = {},
): Promise<{ affirmative: MissionClosureDecision; adversarial: AdversarialJudgeResult | undefined; pair: AdversarialClosureDecision }> {
  const preflight = preflightMissionClosure(evidence, policy);
  const mechanicallyReady = preflight.reasons.includes("deterministic evidence checks passed; semantic review required");
  if (!mechanicallyReady) {
    const pair: AdversarialClosureDecision = {
      state: preflight.status === "BLOCKED" ? "BLOCKED" : "GATHER_EVIDENCE",
      affirmative: preflight.status,
      adversarial: { gap: "UNKNOWN", perCriterion: {}, findings: [] },
      conflictingFindings: [],
      priorChallengeRepeated: false,
      reasons: [...preflight.reasons],
    };
    return { affirmative: preflight, adversarial: undefined, pair };
  }
  const [affirmative, adversarial] = await Promise.all([
    evaluateAffirmative(model, evidence, policy, preflight, options.signal),
    evaluateAdversarial(model, evidence, policy, options.signal),
  ]);
  const pair = resolveAdversarialClosure(affirmative, adversarial, evidence, options.priorChallenges ?? []);
  return { affirmative, adversarial, pair };
}

export interface MissionClosureEvidenceSource {
  /** Resolve the original prompt, acceptance contract, and current verifier evidence for this session. */
  load(sessionId: string, missionId: string, signal?: AbortSignal, context?: MissionClosureRequestContext): Promise<MissionClosureEvidence>;
  /** Recheck that the exact source revisions are still current after semantic evaluation. */
  isCurrent(
    sessionId: string,
    missionId: string,
    missionRevision: string,
    evidenceRevision: string,
    signal?: AbortSignal,
    context?: MissionClosureRequestContext,
  ): Promise<boolean>;
}

export interface MissionClosureRequestContext {
  backgroundTasks: number;
  sessionCrons: number;
}

export interface MissionClosureGateResult {
  decision: MissionClosureDecision;
  receipt: MissionClosureReceiptResult;
  /** The only value a host may use as a terminal COMPLETE signal. */
  terminalComplete: boolean;
}

/** The host has no applicable mission contract; this is not a failed judgment. */
export interface MissionClosureNotApplicable {
  outcome: "NOT_APPLICABLE";
  reason: "mission_contract_missing";
}

/**
 * A COMPLETE verdict that could not be durably recorded authorizes nothing.
 * When the receipt is a conflict or is unavailable, downgrade the in-memory
 * COMPLETE to an explicit non-complete disposition: only `terminalComplete`
 * (a complete decision plus a durable appended/duplicate receipt) is terminal
 * authorization, and `decision.complete` alone must never read as proof.
 * Non-complete dispositions stand as diagnostic: they authorize nothing
 * either way, and downgrading them would erase meaningful terminal signals
 * such as a repeat-challenge BLOCKED.
 */
function downgradeUndurableReceipt(
  decision: MissionClosureDecision,
  receipt: MissionClosureReceiptResult,
): MissionClosureDecision {
  if (decision.complete !== true) return decision;
  if (receipt.status === "appended" || receipt.status === "duplicate") return decision;
  const cause = "reason" in receipt && typeof receipt.reason === "string" ? receipt.reason : "unknown persistence failure";
  return {
    ...decision,
    status: "INSUFFICIENT_EVIDENCE",
    complete: false,
    reasons: [
      ...decision.reasons,
      `mission-closure verdict could not be durably recorded (${receipt.status}: ${cause}); completion not established`,
    ],
  };
}

export type MissionClosureRunnerResult = MissionClosureGateResult | MissionClosureNotApplicable;

/**
 * Host-facing composition of trusted evidence loading, Jev's semantic
 * challenge, and durable receipt persistence. Until a real host supplies an
 * evidence source and enforces `terminalComplete`, this class is a seam, not
 * a user-reachable completion authority.
 */
export class MissionClosureGate {
  /** `evidenceTimeoutMs` bounds the host-owned evidence source; the model transport enforces its own request timeout. */
  constructor(
    private readonly model: DecisionModel,
    private readonly policy: MissionClosurePolicy,
    private readonly source: MissionClosureEvidenceSource,
    private readonly ledger: EvidenceLedger,
    private readonly evidenceTimeoutMs = 1500,
  ) {}

  private unavailable(sessionId: string, missionId: string): MissionClosureGateResult {
    const decision: MissionClosureDecision = {
      status: "INSUFFICIENT_EVIDENCE",
      complete: false,
      missionId,
      missionRevision: "evidence-source-unavailable",
      evidenceRevision: "evidence-source-unavailable",
      policyVersion: this.policy.policyVersion,
      checks: {
        objectivePresent: false,
        objectiveCoverageEstablished: false,
        revisionsMatch: false,
        criteriaPresent: false,
        allCriteriaVerified: false,
        testsPassed: false,
        independentVerificationPassed: false,
        noPendingOperations: false,
        noUncertainOperations: false,
        noUnresolvedBlockers: false,
        calibrationBound: false,
      },
      reasons: ["trusted mission evidence was unavailable or did not match the requested mission identity"],
      confidenceIsProof: false,
    };
    const receipt = persistMissionClosureReceipt(this.ledger, sessionId, decision);
    return { decision, receipt, terminalComplete: false };
  }

  async close(
    sessionId: string,
    missionId: string,
    signal?: AbortSignal,
    context?: MissionClosureRequestContext,
  ): Promise<MissionClosureGateResult> {
    if (sessionId.trim() === "" || missionId.trim() === "") throw new Error("session and mission identity are required");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = (): void => undefined;
    try {
      const timeoutMs = Number.isFinite(this.evidenceTimeoutMs) && this.evidenceTimeoutMs > 0 ? this.evidenceTimeoutMs : 1500;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("evidence source timeout"));
        }, timeoutMs);
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal?.aborted === true) {
          controller.abort();
          reject(new Error("closure request aborted"));
          return;
        }
        if (signal !== undefined) {
          const onAbort = (): void => {
            controller.abort();
            reject(new Error("closure request aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        }
      });
      const evidence = await Promise.race([
        this.source.load(sessionId, missionId, controller.signal, context),
        timeout,
        aborted,
      ]);
      if (evidence.missionId !== missionId) return this.unavailable(sessionId, missionId);
      let decision = await decideMissionClosure(this.model, evidence, this.policy, signal);
      if (decision.complete || decision.status === "BLOCKED") {
        const current = await Promise.race([
          this.source.isCurrent(
            sessionId,
            missionId,
            evidence.missionRevision,
            evidence.evidenceRevision,
            controller.signal,
            context,
          ),
          timeout,
          aborted,
        ]);
        if (!current) {
          decision = {
            ...decision,
            status: "INSUFFICIENT_EVIDENCE",
            complete: false,
            reasons: ["mission or evidence revision changed during closure review"],
          };
        }
      }
      const receipt = persistMissionClosureReceipt(this.ledger, sessionId, decision);
      const recorded = downgradeUndurableReceipt(decision, receipt);
      return {
        decision: recorded,
        receipt,
        terminalComplete: recorded.complete && (receipt.status === "appended" || receipt.status === "duplicate"),
      };
    } catch {
      // Keep source errors and provider text out of receipts. The failure is
      // durable and idempotent, and can never be mistaken for a completion.
      return this.unavailable(sessionId, missionId);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbort();
    }
  }
}

/** Prior challenges recorded for this mission, used to bound repeat challenges on unchanged evidence. */
export function findPriorAdversarialChallenges(
  ledger: EvidenceLedger,
  missionId: string,
  missionRevision: string,
): PriorAdversarialChallenge[] {
  const challenges: PriorAdversarialChallenge[] = [];
  try {
    const read = ledger.read();
    if (read.corrupt !== undefined) return challenges;
    for (const record of read.records) {
      const closure = record.missionClosure;
      if (record.event !== "MissionClosure" || closure === undefined) continue;
      if (closure.missionId !== missionId || closure.missionRevision !== missionRevision) continue;
      const adversarial = closure.adversarial;
      if (adversarial === undefined) continue;
      for (const target of adversarial.targets ?? []) {
        if (typeof target === "string" && target !== "") {
          challenges.push({ criterionId: target, evidenceRevision: closure.evidenceRevision });
        }
      }
      if (typeof adversarial.repairCriterion === "string" && adversarial.repairCriterion !== "") {
        challenges.push({ criterionId: adversarial.repairCriterion, evidenceRevision: closure.evidenceRevision });
      }
    }
  } catch {
    // An unreadable ledger yields no priors: the challenge runs once more
    // rather than blocking on missing history. Fail open, never closed.
    // Measured consequence on a corrupt ledger: repeat→BLOCKED cannot engage
    // (and the receipt cannot persist either), so each close re-issues the
    // same REPAIR/GATHER challenge — but the per-prompt Stop budget absorbs
    // repeats before inference runs, nothing is persisted, and no terminal
    // outcome is possible. Bounded nuisance, not a loop.
  }
  return challenges;
}

function adversarialSummary(
  pair: AdversarialClosureDecision,
  adversarial: AdversarialJudgeResult | undefined,
): AdversarialClosureSummary {
  return {
    state: pair.state,
    gap: pair.adversarial.gap,
    targets: Object.entries(pair.adversarial.perCriterion)
      .filter(([, verdict]) => verdict === "GAP")
      .map(([id]) => id),
    conflictingFindings: pair.conflictingFindings.map((finding) => ({ ...finding })),
    ...(pair.repairTask === undefined ? {} : { repairCriterion: pair.repairTask.criterionId }),
    priorChallengeRepeated: pair.priorChallengeRepeated,
    ...(adversarial?.model === undefined ? {} : { model: adversarial.model }),
    ...(adversarial?.modelVersion === undefined ? {} : { modelVersion: adversarial.modelVersion }),
    ...(adversarial?.provider === undefined ? {} : { provider: adversarial.provider }),
    ...(adversarial?.providerRequestId === undefined ? {} : { providerRequestId: adversarial.providerRequestId }),
    ...(adversarial?.questionHash === undefined ? {} : { questionHash: adversarial.questionHash }),
    ...(adversarial?.calibrationVersion === undefined ? {} : { calibrationVersion: adversarial.calibrationVersion }),
    ...(adversarial?.confidence === undefined ? {} : { confidence: adversarial.confidence }),
    ...(adversarial?.probabilities === undefined ? {} : { probabilities: { ...adversarial.probabilities } }),
  };
}

/**
 * Pair-mode gate: deterministic preflight, Jev A and Jev B in parallel over
 * one revision-bound snapshot, controller verdict, durable receipt. Results
 * are cached by mission/evidence revision, model, questions, and policy, so
 * unchanged evidence is never re-judged. Completion requires unanimous
 * approval plus every deterministic gate; it is never sufficient alone.
 */
export class AdversarialClosureGate {
  private readonly cache = new Map<string, {
    affirmative: MissionClosureDecision;
    adversarial: AdversarialJudgeResult | undefined;
    pair: AdversarialClosureDecision;
  }>();

  constructor(
    private readonly model: DecisionModel,
    private readonly policy: MissionClosurePolicy,
    private readonly source: MissionClosureEvidenceSource,
    private readonly ledger: EvidenceLedger,
    private readonly evidenceTimeoutMs = 1500,
  ) {}

  private cacheKey(evidence: MissionClosureEvidence): string {
    // A cached judgment must never survive a changed model, backend, question
    // set, calibration, or policy binding: every binding rides the key.
    return [
      evidence.missionId,
      evidence.evidenceRevision,
      this.policy.backend,
      this.policy.model,
      this.policy.modelVersion,
      this.policy.questionHash,
      this.policy.adversarialCalibrationVersion ?? "",
      this.policy.calibrationVersion,
      this.policy.policyVersion,
    ].join("\0");
  }

  private remember(
    evidence: MissionClosureEvidence,
    result: {
      affirmative: MissionClosureDecision;
      adversarial: AdversarialJudgeResult | undefined;
      pair: AdversarialClosureDecision;
    },
  ): void {
    if (this.cache.size >= 32) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(this.cacheKey(evidence), result);
  }

  async close(
    sessionId: string,
    missionId: string,
    signal?: AbortSignal,
    context?: MissionClosureRequestContext,
  ): Promise<MissionClosureGateResult> {
    if (sessionId.trim() === "" || missionId.trim() === "") throw new Error("session and mission identity are required");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = (): void => undefined;
    try {
      const timeoutMs = Number.isFinite(this.evidenceTimeoutMs) && this.evidenceTimeoutMs > 0 ? this.evidenceTimeoutMs : 1500;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("evidence source timeout"));
        }, timeoutMs);
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        if (signal?.aborted === true) {
          controller.abort();
          reject(new Error("closure request aborted"));
          return;
        }
        if (signal !== undefined) {
          const onAbort = (): void => {
            controller.abort();
            reject(new Error("closure request aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        }
      });
      const evidence = await Promise.race([
        this.source.load(sessionId, missionId, controller.signal, context),
        timeout,
        aborted,
      ]);
      if (evidence.missionId !== missionId) return this.unavailable(sessionId, missionId);
      const priorChallenges = findPriorAdversarialChallenges(this.ledger, missionId, evidence.missionRevision);
      const cached = this.cache.get(this.cacheKey(evidence));
      if (cached !== undefined) {
        // No new inference on a cache hit, but the loop bound is re-checked:
        // a repair that produced no new evidence upgrades to BLOCKED.
        // A cached terminal result is still revalidated against the source:
        // evidence that moved after loading invalidates the cached verdict
        // instead of publishing a stale COMPLETE.
        const pair = resolveAdversarialClosure(cached.affirmative, cached.adversarial, evidence, priorChallenges);
        let decision = this.toDecision(cached.affirmative, pair);
        if (decision.complete || decision.status === "BLOCKED") {
          const current = await Promise.race([
            this.source.isCurrent(
              sessionId,
              missionId,
              evidence.missionRevision,
              evidence.evidenceRevision,
              controller.signal,
              context,
            ),
            timeout,
            aborted,
          ]);
          if (!current) {
            decision = {
              ...decision,
              status: "INSUFFICIENT_EVIDENCE",
              complete: false,
              reasons: [...decision.reasons, "mission or evidence revision changed after the cached verdict was loaded"],
            };
          }
        }
        const receipt = persistMissionClosureReceipt(this.ledger, sessionId, decision);
        const recorded = downgradeUndurableReceipt(decision, receipt);
        return {
          decision: recorded,
          receipt,
          terminalComplete: recorded.complete && (receipt.status === "appended" || receipt.status === "duplicate"),
        };
      }
      const { affirmative, adversarial, pair } = await decideAdversarialClosure(this.model, evidence, this.policy, {
        priorChallenges,
        signal,
      });
      this.remember(evidence, { affirmative, adversarial, pair });
      let decision = this.toDecision(affirmative, pair);
      if (decision.complete || decision.status === "BLOCKED") {
        const current = await Promise.race([
          this.source.isCurrent(
            sessionId,
            missionId,
            evidence.missionRevision,
            evidence.evidenceRevision,
            controller.signal,
            context,
          ),
          timeout,
          aborted,
        ]);
        if (!current) {
          decision = {
            ...decision,
            status: "INSUFFICIENT_EVIDENCE",
            complete: false,
            reasons: [...decision.reasons, "mission or evidence revision changed during closure review"],
          };
        }
      }
      const receipt = persistMissionClosureReceipt(this.ledger, sessionId, decision);
      const recorded = downgradeUndurableReceipt(decision, receipt);
      return {
        decision: recorded,
        receipt,
        terminalComplete: recorded.complete && (receipt.status === "appended" || receipt.status === "duplicate"),
      };
    } catch {
      return this.unavailable(sessionId, missionId);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbort();
    }
  }

  /**
   * Map the pair verdict onto the terminal decision. ACCEPT keeps Jev A's
   * COMPLETE only when every deterministic check already passed; every other
   * state downgrades to a non-complete status carrying the repair task.
   */
  private toDecision(affirmative: MissionClosureDecision, pair: AdversarialClosureDecision): MissionClosureDecision {
    const summary = adversarialSummary(pair, pair.adversarial.gap === "UNKNOWN" && Object.keys(pair.adversarial.perCriterion).length === 0 ? undefined : pair.adversarial);
    if (pair.state === "ACCEPT" && affirmative.status === "COMPLETE" && affirmative.complete) {
      return {
        ...affirmative,
        reasons: [...affirmative.reasons, ...pair.reasons],
        adversarial: summary,
      };
    }
    if (pair.state === "BLOCKED") {
      return {
        ...affirmative,
        status: "BLOCKED",
        complete: false,
        reasons: [...affirmative.reasons, ...pair.reasons],
        adversarial: summary,
        ...(pair.repairTask === undefined ? {} : { repairTask: pair.repairTask }),
      };
    }
    const status = pair.state === "REPAIR" ? "INCOMPLETE" : "INSUFFICIENT_EVIDENCE";
    return {
      ...affirmative,
      status,
      complete: false,
      reasons: [...affirmative.reasons, ...pair.reasons],
      adversarial: summary,
      ...(pair.repairTask === undefined ? {} : { repairTask: pair.repairTask }),
    };
  }

  private unavailable(sessionId: string, missionId: string): MissionClosureGateResult {
    const decision: MissionClosureDecision = {
      status: "INSUFFICIENT_EVIDENCE",
      complete: false,
      missionId,
      missionRevision: "evidence-source-unavailable",
      evidenceRevision: "evidence-source-unavailable",
      policyVersion: this.policy.policyVersion,
      checks: {
        objectivePresent: false,
        objectiveCoverageEstablished: false,
        revisionsMatch: false,
        criteriaPresent: false,
        allCriteriaVerified: false,
        testsPassed: false,
        independentVerificationPassed: false,
        noPendingOperations: false,
        noUncertainOperations: false,
        noUnresolvedBlockers: false,
        calibrationBound: false,
      },
      reasons: ["trusted mission evidence was unavailable or did not match the requested mission identity"],
      confidenceIsProof: false,
    };
    const receipt = persistMissionClosureReceipt(this.ledger, sessionId, decision);
    return { decision, receipt, terminalComplete: false };
  }
}
