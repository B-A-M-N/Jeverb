/**
 * Host-owned mission control loop: the live wiring for `decideControlAction`.
 *
 * The controller is pure; this module feeds it trusted execution evidence
 * and persists what it decides so the next iteration can reconcile the
 * execution outcome before choosing another action:
 *
 *  1. load trusted mission evidence from the host-owned source;
 *  2. read previously issued corrections for this mission revision;
 *  3. look up an authoritative durable completion receipt, when one exists;
 *  4. decide the typed control action;
 *  5. persist the decision as an idempotent `ControlAction` receipt.
 *
 * The host executes corrections, requests semantic closure on
 * READY_FOR_CLOSURE, or stops on receipt-bound COMPLETE/BLOCKED, then calls
 * back with fresh evidence. A correction that produces no new
 * evidence revision stalls instead of repeating. Pure apart from the
 * ledger: no clock, no model, no network.
 */

import { createHash } from "node:crypto";
import { describeLedgerCorrupt, EvidenceLedger, hashSubject, type EvidenceRecord } from "../evidence/ledger.js";
import type { VerificationLedger } from "../hooks/verification.js";
import type { MissionClosureEvidence, MissionClosureEvidenceSource } from "../mission/closure.js";
import {
  CONTROL_ACTIONS,
  decideControlAction,
  type ControlAction,
  type ControlDecision,
  type ControlModelHint,
  type PriorControlAction,
  type TerminalCompletionReceipt,
} from "./control.js";

export interface MissionControlOptions {
  ledger: EvidenceLedger;
  sessionId: string;
  source: MissionClosureEvidenceSource;
  missionId: string;
  verification?: VerificationLedger | undefined;
  /** Attempts already made at the current correction, observed by the host. */
  attempts?: number;
  /** Deterministic transient-failure signal for the last attempt. */
  transientFailure?: boolean;
  /** Advisory model hint; never trusted on its own. */
  modelHint?: ControlModelHint | undefined;
  policyVersion?: string;
}

export interface MissionControlResult {
  decision: ControlDecision;
  persisted: "appended" | "duplicate" | "unavailable";
  correlationId: string;
  reason?: string;
}

function controlCorrelationId(
  missionId: string,
  missionRevision: string,
  evidenceRevision: string,
  action: string,
  criterionId?: string,
): string {
  return createHash("sha256")
    .update(`${missionId}\0${missionRevision}\0${evidenceRevision}\0${action}\0${criterionId ?? ""}`)
    .digest("hex");
}

/**
 * Previously issued corrections for one mission revision, oldest first.
 * Each entry carries the evidence revision it targeted so a repeat against
 * unchanged evidence stalls, while a genuinely changed revision reassesses.
 * The trailing run length of the same action key counts attempts at the
 * current correction.
 */
export function findPriorControlActions(
  ledger: EvidenceLedger,
  missionId: string,
  missionRevision: string,
): PriorControlAction[] {
  const read = ledger.read();
  if (read.corrupt !== undefined) return [];
  const entries: PriorControlAction[] = [];
  for (const record of read.records) {
    const action = record.controlAction;
    if (action === undefined) continue;
    if (action.missionId !== missionId || action.missionRevision !== missionRevision) continue;
    const known = (CONTROL_ACTIONS as readonly string[]).includes(action.action);
    entries.push({
      action: known ? (action.action as ControlAction) : "INSUFFICIENT_EVIDENCE",
      ...(action.criterionId === undefined ? {} : { criterionId: action.criterionId }),
      baseEvidenceRevision: action.evidenceRevision,
      attempts: trailingAttempts(entries, action.action, action.criterionId) + 1,
      missionId: action.missionId,
      missionRevision: action.missionRevision,
      ...(action.candidateDigest === undefined ? {} : { baseCandidateDigest: action.candidateDigest }),
    });
  }
  return entries;
}

function trailingAttempts(
  entries: PriorControlAction[],
  action: string,
  criterionId: string | undefined,
): number {
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.action !== action || entry.criterionId !== criterionId) break;
    count += 1;
  }
  return count;
}

/**
 * The authoritative durable completion receipt for this mission revision
 * and evidence revision, when one is recorded. A history entry alone —
 * however well formed — never substitutes for this gate; only a persisted
 * `MissionClosure` receipt with `complete: true` binds terminal state.
 */
export function findTerminalCompletionReceipt(
  ledger: EvidenceLedger,
  missionId: string,
  missionRevision: string,
  evidenceRevision: string,
  candidateDigest?: string,
): TerminalCompletionReceipt | undefined {
  const read = ledger.read();
  if (read.corrupt !== undefined) return undefined;
  for (const record of read.records) {
    const closure = record.missionClosure;
    if (closure === undefined || !closure.complete) continue;
    if (closure.missionId !== missionId || closure.missionRevision !== missionRevision) continue;
    if (closure.evidenceRevision !== evidenceRevision) continue;
    // Strict candidate binding both ways: a receipt evaluated against a
    // different candidate — or none — never authorises this candidate.
    const closureCandidate = typeof closure.candidateDigest === "string" ? closure.candidateDigest : undefined;
    if (closureCandidate !== candidateDigest) continue;
    return {
      missionId: closure.missionId,
      missionRevision: closure.missionRevision,
      evidenceRevision: closure.evidenceRevision,
      ...(closureCandidate === undefined ? {} : { candidateDigest: closureCandidate }),
    };
  }
  return undefined;
}

function persistControlAction(
  ledger: EvidenceLedger,
  sessionId: string,
  evidence: MissionClosureEvidence,
  decision: ControlDecision,
  prior: PriorControlAction[],
  policyVersion: string,
): { persisted: MissionControlResult["persisted"]; correlationId: string; reason?: string } {
  const correlationId = controlCorrelationId(
    evidence.missionId,
    evidence.missionRevision,
    evidence.evidenceRevision,
    decision.action,
    decision.correction?.criterionId,
  );
  const correctionKey =
    decision.correction === undefined
      ? undefined
      : `${decision.action}\0${decision.correction.criterionId}`;
  const attempt =
    correctionKey === undefined
      ? 0
      : trailingAttempts(
        prior,
        decision.action,
        decision.correction?.criterionId,
      ) + 1;
  const record: EvidenceRecord = {
    schema: 1,
    id: "",
    ts: new Date().toISOString(),
    sessionId,
    decisionId: correlationId.slice(0, 32),
    correlationId,
    event: "ControlAction",
    subjectHash: hashSubject(
      `${evidence.missionId}\n${evidence.missionRevision}\n${evidence.evidenceRevision}\n${decision.action}`,
    ),
    policyVersion,
    deterministicFindings: [],
    enforcement: decision.complete ? "mission_complete" : "mission_not_complete",
    reasons: decision.reasons,
    latencyMs: 0,
    controlAction: {
      missionId: evidence.missionId,
      missionRevision: evidence.missionRevision,
      evidenceRevision: evidence.evidenceRevision,
      ...(evidence.candidateDigest === undefined ? {} : { candidateDigest: evidence.candidateDigest }),
      action: decision.action,
      ...(decision.correction?.criterionId === undefined
        ? {}
        : { criterionId: decision.correction.criterionId }),
      ...(decision.correction?.defectKind === undefined
        ? {}
        : { defectKind: decision.correction.defectKind }),
      ...(decision.correction?.requiredOutcome === undefined
        ? {}
        : { requiredOutcome: decision.correction.requiredOutcome }),
      ...(decision.correction?.maxAttempts === undefined
        ? {}
        : { maxAttempts: decision.correction.maxAttempts }),
      attempt,
      ...(decision.action !== "INSUFFICIENT_EVIDENCE" || prior.length === 0
        ? {}
        : { stalled: true }),
    },
  };
  const appended = ledger.appendDetailed(record, { durable: true, idempotencyKey: correlationId });
  if (!appended.ok) {
    return { persisted: "unavailable", correlationId, reason: appended.error.message };
  }
  return appended.duplicate === true
    ? { persisted: "duplicate", correlationId }
    : { persisted: "appended", correlationId };
}

/**
 * One host-owned control step: trusted evidence in, typed action out, with
 * the decision persisted for outcome reconciliation. The host executes the
 * correction, requests semantic closure on READY_FOR_CLOSURE, or stops on
 * receipt-bound COMPLETE/BLOCKED, then calls back with fresh
 * evidence; nothing here re-invokes a correction against the revision it
 * already targeted.
 */
export async function directMissionControl(options: MissionControlOptions): Promise<MissionControlResult> {
  // A failed evidence load (model unavailable mid-closure, store
  // unreachable, session mismatch) is a typed unavailable disposition,
  // never an exception and never a completion claim. The host treats
  // persisted "unavailable" as "no decision was made": nothing was
  // authorized, nothing was recorded as a correction.
  let evidence: MissionClosureEvidence;
  try {
    evidence = await options.source.load(options.sessionId, options.missionId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      decision: {
        action: "INSUFFICIENT_EVIDENCE",
        kind: "authorization",
        complete: false,
        reasons: [`trusted mission evidence is unavailable (${reason}); no decision was made`],
      },
      persisted: "unavailable",
      correlationId: "",
      reason: "evidence source failure; nothing persisted",
    };
  }
  // A corrupt ledger cannot reconcile anything: no prior, no receipt, no
  // write can be trusted, so no action is authorized.
  try {
    const corruptRead = options.ledger.read();
    if (corruptRead.corrupt !== undefined) {
      const detail = describeLedgerCorrupt(corruptRead.corrupt);
      return {
        decision: {
          action: "INSUFFICIENT_EVIDENCE",
          kind: "authorization",
          complete: false,
          reasons: [`${detail}; no decision can be reconciled or recorded`],
        },
        persisted: "unavailable",
        correlationId: "",
        reason: `${detail}; nothing persisted`,
      };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      decision: {
        action: "INSUFFICIENT_EVIDENCE",
        kind: "authorization",
        complete: false,
        reasons: [`evidence ledger is unreadable (${reason}); no decision was made`],
      },
      persisted: "unavailable",
      correlationId: "",
      reason: "ledger read failure; nothing persisted",
    };
  }
  // Revalidate before deciding: evidence that moved between load and this
  // step must not produce an actionable decision against a stale revision.
  try {
    const current = await options.source.isCurrent(
      options.sessionId,
      options.missionId,
      evidence.missionRevision,
      evidence.evidenceRevision,
    );
    if (!current) {
      return {
        decision: {
          action: "INSUFFICIENT_EVIDENCE",
          kind: "authorization",
          complete: false,
          reasons: ["mission or evidence revision changed after loading; reloaded evidence is required"],
        },
        persisted: "unavailable",
        correlationId: "",
        reason: "stale evidence; nothing persisted",
      };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      decision: {
        action: "INSUFFICIENT_EVIDENCE",
        kind: "authorization",
        complete: false,
        reasons: [`evidence freshness cannot be established (${reason}); no decision was made`],
      },
      persisted: "unavailable",
      correlationId: "",
      reason: "freshness check failure; nothing persisted",
    };
  }
  const prior = findPriorControlActions(options.ledger, evidence.missionId, evidence.missionRevision);
  const terminalReceipt = findTerminalCompletionReceipt(
    options.ledger,
    evidence.missionId,
    evidence.missionRevision,
    evidence.evidenceRevision,
    evidence.candidateDigest,
  );
  const decision = decideControlAction({
    evidence,
    ...(options.verification === undefined ? {} : { verification: options.verification }),
    prior,
    ...(terminalReceipt === undefined ? {} : { terminalReceipt }),
    attempts: options.attempts ?? 0,
    transientFailure: options.transientFailure ?? false,
    ...(options.modelHint === undefined ? {} : { modelHint: options.modelHint }),
  });
  const persisted = persistControlAction(
    options.ledger,
    options.sessionId,
    evidence,
    decision,
    prior,
    options.policyVersion ?? "control-loop/1",
  );
  // Persistence failure means no action authorized: the host reconciles
  // against durable records, so an unrecorded decision must not execute.
  // "duplicate" is already recorded and stays executable.
  if (persisted.persisted === "unavailable") {
    return {
      decision: {
        action: "INSUFFICIENT_EVIDENCE",
        kind: "authorization",
        complete: false,
        reasons: [
          `decided ${decision.action} but the record could not be persisted` +
          `${persisted.reason === undefined ? "" : ` (${persisted.reason})`}; no action is authorized without a durable record`,
        ],
      },
      persisted: "unavailable",
      correlationId: persisted.correlationId,
      ...(persisted.reason === undefined ? {} : { reason: persisted.reason }),
    };
  }
  return { decision, ...persisted };
}
