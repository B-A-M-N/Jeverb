/**
 * Structured decision evidence via the existing graph journal.
 *
 * A routing/authorization/verification decision is persisted as a
 * `node-terminal` journal event carrying field-for-field evidence: run +
 * revision, node, question-set id, effective evidence digest, backend /
 * model / version / qualification id, the typed answer + confidence, the
 * selected branch, the policy version, and the advisory-vs-consequential
 * flag. Replay restores the recorded judgment verbatim instead of
 * re-invoking a backend.
 *
 * Type-only imports: this module builds journal events but never touches
 * the journal itself, so the runtime direction stays one-way.
 */

import type { JevDecision } from "../graph/executor.js";
import type { JournalEvent } from "../graph/journal.js";
import type { DecisionEvidence } from "./types.js";

export interface DecisionJournalInput {
  evidence: DecisionEvidence;
  /** Full typed judgment the branch was evaluated at, when available. */
  jev?: JevDecision | undefined;
  /** Graph hash the run was authorized under, when known. */
  graphHash?: string | undefined;
}

/**
 * Build the journal event persisting one recorded decision. Pure: no clock
 * beyond the caller-supplied timestamp, no model, no network.
 */
export function buildDecisionJournalEvent(input: DecisionJournalInput, ts: string): JournalEvent {
  const { evidence, jev } = input;
  const event: JournalEvent = {
    type: "node-terminal",
    runId: evidence.runId,
    ts,
    nodeId: evidence.nodeId,
    status: "succeeded",
    ...(evidence.selectedBranch === undefined ? {} : { branch: evidence.selectedBranch }),
    effectiveInputHash: evidence.effectiveEvidenceDigest,
    revisionHash: evidence.revisionHash,
    ...(input.graphHash === undefined ? {} : { graphHash: input.graphHash }),
    policyHash: evidence.policyVersion,
    ...(evidence.modelVersion === undefined ? {} : { modelVersion: evidence.modelVersion }),
    ...(evidence.qualificationId === undefined ? {} : { qualificationId: evidence.qualificationId }),
    decisionKind: evidence.kind,
    decisionMode: evidence.mode,
  };
  if (jev !== undefined) {
    event.jev = jev;
  } else {
    event.jev = {
      provider: evidence.backend,
      ...(evidence.model === "" ? {} : { model: evidence.model }),
      questionHash: evidence.questionSetHash,
      calibrated: evidence.qualificationId !== undefined,
    };
  }
  return event;
}

/** Extract the recorded answer summary for one deciding question. */
export function answerSummary(
  jev: JevDecision | undefined,
  question: string,
): { type: string; value: string; confidence?: number } | undefined {
  const answer = jev?.answers?.[question];
  if (answer === undefined) {
    if (jev?.verdict !== undefined) {
      return {
        type: "verdict",
        value: jev.verdict,
        ...(jev.noul === undefined ? {} : { confidence: jev.noul }),
      };
    }
    return undefined;
  }
  if (answer.type === "choice") {
    return { type: "choice", value: answer.choice, confidence: answer.confidence };
  }
  if (answer.type === "score") {
    return { type: "score", value: String(answer.score), confidence: answer.confidence };
  }
  return { type: "noul", value: String(answer.noul) };
}
