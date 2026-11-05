/**
 * Host-owned control pathway: typed corrective action from trusted evidence.
 *
 * `jev_next_step` stays a lightweight advisory tool over agent-supplied
 * `goal`/`last_step`/`result`. This module is the separate host-owned
 * pathway: it consumes the mission contract, criterion coverage, per-kind
 * verification evidence, outstanding operations, blockers, and previous
 * corrective actions, and returns a typed action the host can direct.
 *
 * A model judgment may inform the decision but never is the decision:
 * `READY_FOR_CLOSURE` requires deterministic gates; `COMPLETE` also requires
 * a bound durable receipt. `RETRY` requires a credible transient-failure
 * signal, and an uncertain suggestion degrades to
 * gathering evidence — never to interrupting the user. Pure: no clock, no
 * model, no network.
 */

import type { VerificationLedger } from "../hooks/verification.js";
import { currentCheck } from "../hooks/verification.js";
import type { MissionClosureEvidence } from "../mission/closure.js";
import type { DecisionKind } from "./types.js";

export const CONTROL_ACTIONS = [
  "READY_FOR_CLOSURE",
  "COMPLETE",
  "REPAIR",
  "VERIFY",
  "RETRY",
  "CHANGE_APPROACH",
  "BLOCKED",
  "INSUFFICIENT_EVIDENCE",
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** A supported defect identified against one acceptance criterion. */
export type CorrectiveDefectKind =
  | "omission"
  | "contradiction"
  | "unsupported_claim"
  | "unresolved_requirement";

/** What the host must do to close the finding. */
export type CorrectiveStep =
  | "REPAIR"
  | "VERIFY"
  | "RECONCILE"
  | "CHANGE_APPROACH"
  | "REQUEST_INPUT";

/**
 * Every supported correction names the criterion, the defect, the evidence
 * behind it, the required next step, the observable outcome that resolves
 * it, the revision challenged, and the attempt budget. A correction without
 * these is speculation, not an instruction.
 */
export interface CorrectiveAction {
  criterionId: string;
  defectKind: CorrectiveDefectKind;
  evidenceRefs: string[];
  action: CorrectiveStep;
  requiredOutcome: string;
  /** The exact candidate challenged; undefined when no candidate is established. */
  baseCandidateDigest?: string;
  baseEvidenceRevision: string;
  maxAttempts: number;
}

/** Advisory model hint. Trusted evidence always outranks it. */
export interface ControlModelHint {
  /** Suggested action in the host vocabulary, or unrecognised text. */
  suggestion: string;
  /** Whether the suggestion is confident enough to act on. */
  confident: boolean;
  /**
   * Adversarial repair detail, when a reviewing judge supplied one. Used
   * only when it is bound to the current evidence revision; a stale or
   * targetless hint is speculation, not a repair instruction.
   */
  repair?: {
    criterionId: string;
    finding: string;
    requiredEvidence: string;
    evidenceRevision: string;
  };
}

/** A previously issued correction, for loop bounding. */
export interface PriorControlAction {
  action: ControlAction;
  criterionId?: string;
  baseEvidenceRevision: string;
  attempts: number;
  /** Mission the action was issued for; entries without it never authorise terminal state. */
  missionId?: string;
  missionRevision?: string;
  /** Candidate the action was issued against; undefined only when no candidate was established. */
  baseCandidateDigest?: string;
}

/**
 * Authoritative durable completion receipt. A history entry alone — however
 * well formed — never substitutes for this gate.
 */
export interface TerminalCompletionReceipt {
  missionId: string;
  missionRevision: string;
  evidenceRevision: string;
  candidateDigest?: string;
}

export interface ControllerInput {
  /** Trusted mission state from the host-owned evidence source. */
  evidence: MissionClosureEvidence;
  /** Per-kind verification outcomes; may be absent for unevaluated missions. */
  verification?: VerificationLedger | undefined;
  /** Corrections already issued, oldest first. */
  prior: PriorControlAction[];
  /**
   * Authoritative durable completion receipt. The prior-COMPLETE shortcut
   * fires only when this receipt binds the same mission, mission revision,
   * evidence revision, and candidate — never on a history entry alone.
   */
  terminalReceipt?: TerminalCompletionReceipt;
  /** Attempts already made at the current correction. */
  attempts: number;
  /** Deterministic transient-failure signal for the last attempt. */
  transientFailure: boolean;
  /** Advisory model hint; never trusted on its own. */
  modelHint?: ControlModelHint;
}

export interface ControlDecision {
  /** Decision family: host control decisions grant or withhold authority, never route or verify. */
  kind: DecisionKind;
  action: ControlAction;
  /** True only for COMPLETE: the host must stop delegating work. */
  complete: boolean;
  reasons: string[];
  correction?: CorrectiveAction;
}

/** Attempts at one correction before the approach must change. */
export const MAX_CONTROL_ATTEMPTS = 3;

const KNOWN_ACTIONS = new Set<string>(CONTROL_ACTIONS);

function criterionTarget(evidence: MissionClosureEvidence): string {
  return evidence.criteria.find((criterion) => !criterion.verified)?.id
    ?? evidence.criteria[0]?.id
    ?? "__mission";
}

function correction(
  evidence: MissionClosureEvidence,
  criterionId: string,
  defectKind: CorrectiveDefectKind,
  evidenceRefs: string[],
  action: CorrectiveStep,
  requiredOutcome: string,
  maxAttempts: number = MAX_CONTROL_ATTEMPTS,
): CorrectiveAction {
  return {
    criterionId,
    defectKind,
    evidenceRefs,
    action,
    requiredOutcome,
    ...(evidence.candidateDigest === undefined ? {} : { baseCandidateDigest: evidence.candidateDigest }),
    baseEvidenceRevision: evidence.evidenceRevision,
    maxAttempts,
  };
}

/**
 * Deterministic host-owned control decision. Pure.
 *
 * Order matters: terminal and safety outcomes first, then loop bounds,
 * then evidence-backed corrections. The advisory hint breaks ties only —
 * it can never establish completion, author a retry, or invent a repair.
 */
export function decideControlAction(input: ControllerInput): ControlDecision {
  const { evidence, verification, prior, attempts, transientFailure, modelHint } = input;
  const test = currentCheck(verification, "test");
  const testCurrent = test !== undefined && test.record.ok && test.editsSince === 0;
  const testFailed = test !== undefined && !test.record.ok && test.editsSince === 0;
  const criteriaVerified = evidence.criteria.length > 0
    && evidence.criteria.every((criterion) => criterion.verified);
  const operationsClear = evidence.operations.pending === 0 && evidence.operations.uncertain === 0;
  const blockersOpen = evidence.blockers.filter((blocker) => blocker.unresolved);
  const assured = evidence.tests.passed && evidence.tests.independent;

  // No automatic continuation after a durable completion receipt matches:
  // COMPLETE is terminal. Bind mission identity, mission revision, candidate
  // identity, and evidence revision. A prior COMPLETE record only changes
  // the explanation; it is never required to make the receipt authoritative.
  const receiptMatches =
    input.terminalReceipt !== undefined &&
    input.terminalReceipt.missionId === evidence.missionId &&
    input.terminalReceipt.missionRevision === evidence.missionRevision &&
    input.terminalReceipt.evidenceRevision === evidence.evidenceRevision &&
    input.terminalReceipt.candidateDigest === evidence.candidateDigest;
  if (receiptMatches) {
    return {
      action: "COMPLETE",
      kind: "authorization",
      complete: true,
      // Keep the receipt-backed explanation stable: this decision is persisted
      // under a revision/action idempotency key, so prior control history must
      // not change the payload for the same terminal action.
      reasons: ["matching durable mission-closure receipt establishes completion; no further work is authorised"],
    };
  }

  // READY_FOR_CLOSURE, never terminal COMPLETE: every deterministic gate
  // passed, but terminal authorization requires the authoritative semantic
  // mission-closure receipt, which only the closure gate can produce. The
  // host must request closure; this decision alone stops nothing.
  if (criteriaVerified && testCurrent && assured && operationsClear && blockersOpen.length === 0) {
    return {
      action: "READY_FOR_CLOSURE",
      kind: "authorization",
      complete: false,
      reasons: [
        "every acceptance criterion verified, current tests pass with independent verification, no pending operations or blockers; " +
        "request authoritative semantic closure — this decision alone is not a terminal completion receipt",
      ],
    };
  }

  // BLOCKED is terminal for progress but never completion: it names the
  // operator action instead of claiming success.
  if (blockersOpen.length > 0) {
    const ids = blockersOpen.map((blocker) => blocker.id).join(", ");
    return {
      action: "BLOCKED",
      kind: "authorization",
      complete: false,
      reasons: [`unresolved external dependency or authorisation boundary (${ids}); report the required operator action`],
      correction: correction(
        evidence,
        criterionTarget(evidence),
        "unresolved_requirement",
        blockersOpen.map((blocker) => `blocker:${blocker.id}`),
        "REQUEST_INPUT",
        `operator resolves ${ids} or explicitly re-scopes the mission`,
      ),
    };
  }

  // No repeated correction against unchanged evidence: a correction that
  // produced no new evidence is a stalled loop, not a plan. Scoped to the
  // same mission so one mission's history can never stall another.
  const repeated = [...prior].reverse().find(
    (entry) =>
      (entry.missionId === undefined || entry.missionId === evidence.missionId) &&
      entry.baseEvidenceRevision === evidence.evidenceRevision &&
      (entry.action === "REPAIR" || entry.action === "VERIFY" || entry.action === "RETRY" ||
        entry.action === "CHANGE_APPROACH"),
  );
  if (repeated !== undefined) {
    return {
      action: "INSUFFICIENT_EVIDENCE",
      kind: "authorization",
      complete: false,
      reasons: [
        `correction ${repeated.action}${repeated.criterionId === undefined ? "" : ` for ${repeated.criterionId}`} ` +
        `was already issued against evidence revision ${evidence.evidenceRevision} with no new evidence since; ` +
        `stop the loop and report the stalled condition`,
      ],
    };
  }

  // RETRY only with a credible transient-failure signal and budget left.
  // Anything else that failed the same way must change approach.
  if (transientFailure) {
    if (attempts < MAX_CONTROL_ATTEMPTS) {
      const target = criterionTarget(evidence);
      return {
        action: "RETRY",
        kind: "authorization",
        complete: false,
        reasons: [`last failure was transient and ${attempts} attempt(s) are under the cap of ${MAX_CONTROL_ATTEMPTS}`],
        correction: correction(
          evidence,
          target,
          "unresolved_requirement",
          test !== undefined ? [`verification:${test.record.command}`] : [],
          "RECONCILE",
          "re-run the same step unchanged and observe a pass",
        ),
      };
    }
    const target = criterionTarget(evidence);
    return {
      action: "CHANGE_APPROACH",
      kind: "authorization",
      complete: false,
      reasons: [
        `transient failures repeated ${attempts} time(s) at the cap of ${MAX_CONTROL_ATTEMPTS}; ` +
        `repeating the current approach is unlikely to succeed`,
      ],
      correction: correction(
        evidence,
        target,
        "unresolved_requirement",
        test !== undefined ? [`verification:${test.record.command}`] : [],
        "CHANGE_APPROACH",
        "a different method, tool, or set of inputs produces new evidence",
      ),
    };
  }

  // A supported adversarial repair hint, bound to the current revision,
  // becomes an actionable REPAIR. A stale or targetless hint is ignored:
  // speculation never becomes a mandatory repair.
  const hint = modelHint?.repair;
  if (
    hint !== undefined &&
    hint.evidenceRevision === evidence.evidenceRevision &&
    evidence.criteria.some((criterion) => criterion.id === hint.criterionId)
  ) {
    return {
      action: "REPAIR",
      kind: "authorization",
      complete: false,
      reasons: [`reviewing judge identified a supported defect in ${hint.criterionId} at the current evidence revision`],
      correction: correction(
        evidence,
        hint.criterionId,
        "unsupported_claim",
        [`repair:${hint.criterionId}:${hint.finding.slice(0, 200)}`],
        "REPAIR",
        hint.requiredEvidence,
      ),
    };
  }

  // Deterministic defect derivation, in priority order.
  if (evidence.operations.pending > 0 || evidence.operations.uncertain > 0) {
    const target = criterionTarget(evidence);
    return {
      action: "VERIFY",
      kind: "authorization",
      complete: false,
      reasons: [
        `${evidence.operations.pending} pending and ${evidence.operations.uncertain} uncertain operation(s); ` +
        `reconcile outstanding work before judging completion`,
      ],
      correction: correction(
        evidence,
        target,
        "unresolved_requirement",
        ["graph-journal:reconcile"],
        "RECONCILE",
        "no pending or uncertain operations remain",
      ),
    };
  }
  if (testFailed) {
    const target = criterionTarget(evidence);
    return {
      action: "REPAIR",
      kind: "authorization",
      complete: false,
      reasons: [`current ${test?.record.kind} check failed (\`${test?.record.command}\`); repair, never complete`],
      correction: correction(
        evidence,
        target,
        "unresolved_requirement",
        [`verification:${test?.record.command ?? "unknown"}`],
        "REPAIR",
        `a fresh passing ${test?.record.kind ?? "test"} run on the current candidate`,
      ),
    };
  }
  if (!testCurrent) {
    const target = criterionTarget(evidence);
    return {
      action: "VERIFY",
      kind: "authorization",
      complete: false,
      reasons: ["no current passing test for this candidate; collect the missing proof"],
      correction: correction(
        evidence,
        target,
        "omission",
        test !== undefined ? [`verification:${test.record.command}`] : [],
        "VERIFY",
        "a passing test run on the current candidate with no edits since",
      ),
    };
  }
  if (!criteriaVerified) {
    const target = criterionTarget(evidence);
    return {
      action: "VERIFY",
      kind: "authorization",
      complete: false,
      reasons: [`criterion ${target} has no valid attestation; collect the missing proof`],
      correction: correction(
        evidence,
        target,
        "omission",
        evidence.criteria.find((criterion) => criterion.id === target)?.evidenceRef === undefined
          ? []
          : [evidence.criteria.find((criterion) => criterion.id === target)?.evidenceRef as string],
        "VERIFY",
        `a user attestation or verifier receipt covering ${target}`,
      ),
    };
  }
  if (!evidence.tests.independent) {
    const target = criterionTarget(evidence);
    return {
      action: "VERIFY",
      kind: "authorization",
      complete: false,
      reasons: ["local execution passed but no independent verifier receipt binds this candidate; collect it"],
      correction: correction(
        evidence,
        target,
        "omission",
        test !== undefined ? [`verification:${test.record.command}`] : [],
        "VERIFY",
        `an independent verifier PASS bound to candidate revision ${evidence.candidateRevision ?? "current"}`,
      ),
    };
  }

  // Uncertainty degrades to gathering evidence, never to interrupting the
  // user: the host-owned pathway has no ask_user fallback.
  const hinted = modelHint !== undefined && KNOWN_ACTIONS.has(modelHint.suggestion) && modelHint.confident;
  return {
    action: "INSUFFICIENT_EVIDENCE",
    kind: "authorization",
    complete: false,
    reasons: [
      hinted
        ? `advisory hint \`${modelHint?.suggestion}\` is not backed by current evidence; gather evidence instead of acting on it`
        : "no supported correction can be established from current evidence",
    ],
  };
}
