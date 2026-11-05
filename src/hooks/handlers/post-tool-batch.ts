/**
 * PostToolBatch: observation only, for calls that already ran.
 *
 * Muse delivers the batch after execution, so every call in `tool_calls[]`
 * is committed fact, not a request. This handler therefore never emits a
 * permission decision: no deny, no ask, and in particular no replay of the
 * pre-execution denials the same commands would have earned before they ran.
 * It always resolves `undefined`.
 *
 * What it does, per call, is the same cheap bookkeeping the single-call
 * post-tool path does: close the tripwire lifecycle (`recordReissueRun`),
 * fold verification commands into the session ledger (`recordVerification`),
 * and append one evidence-ledger receipt keyed by the call's `tool_use_id`
 * carrying the collected verification outcome.
 */

import { randomUUID } from "node:crypto";
import { UNIFIED_POLICY_VERSION } from "../../decision/types.js";
import { hashSubject } from "../../evidence/ledger.js";
import { redactAndClamp } from "../redact.js";
import type { Deps, HookInput, HookOutput, ToolCallBatchEntry } from "../types.js";
import { normalizeToolName } from "../types.js";
import { ledgerEvent } from "../verification.js";
import { recordReissueRun, recordVerification } from "./post-tool-use.js";

/** Longest per-call input summary hashed into a receipt subject. */
const MAX_BATCH_SUBJECT_CHARS = 500;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Read one batch entry as a single-call post-tool input, so the shared
 * bookkeeping sees the same shape the non-batch path sees. Tool names are
 * normalized to the canonical spellings the switches use.
 */
export function batchCallInput(batch: HookInput, call: ToolCallBatchEntry): HookInput {
  const toolName = normalizeToolName(call.tool_name);
  const toolInput = asRecord(call.tool_input);
  const toolUseId = typeof call.tool_use_id === "string" ? call.tool_use_id : undefined;
  const error = typeof call.error === "string" ? call.error : undefined;
  // The batch channel reports failure with `error`; an entry without one is
  // the host reporting success. Stamp that explicitly: downstream readers
  // treat a missing response as an undemonstrated outcome, so the host's
  // success report must travel in the response shape, not as silence.
  const toolResponse =
    call.tool_response !== undefined || error !== undefined ? call.tool_response : { success: true };
  return {
    ...batch,
    hook_event_name: error !== undefined ? "PostToolUseFailure" : "PostToolUse",
    tool_name: toolName,
    ...(toolInput !== undefined ? { tool_input: toolInput } : {}),
    ...(toolResponse !== undefined ? { tool_response: toolResponse } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
  };
}

function outcomeReason(input: HookInput, now: number): string {
  const event = ledgerEvent(input, now);
  const toolName = input.tool_name ?? "";
  if (event.verification !== undefined) {
    const record = event.verification;
    return `post-tool-batch: ${toolName} ${record.kind} ${record.ok ? "passed" : "failed"}: ${record.command}`;
  }
  if (event.edited) return `post-tool-batch: ${toolName} edit recorded`;
  return "post-tool-batch: observed (no verification outcome)";
}

export async function handlePostToolBatch(input: HookInput, deps: Deps): Promise<HookOutput | undefined> {
  const calls = input.tool_calls ?? [];
  const sessionId = input.session_id ?? "unknown";
  for (const call of calls) {
    // A fired hook deadline stops the observation sweep: the caller that
    // set the deadline owns the timeout record, so no later call in the
    // batch appends its receipt after the abort.
    if (deps.signal?.aborted === true) break;
    if (call === null || typeof call !== "object") continue;
    const callInput = batchCallInput(input, call);
    const start = deps.now();
    // Bookkeeping first, exactly as the single-call path does.
    recordReissueRun(callInput, deps);
    recordVerification(callInput, deps);
    if (deps.ledger !== undefined) {
      const toolUseId = typeof call.tool_use_id === "string" && call.tool_use_id !== "" ? call.tool_use_id : undefined;
      const subject = `${callInput.tool_name ?? ""} ${toolUseId ?? ""} ${JSON.stringify(call.tool_input ?? {})}`.slice(
        0,
        MAX_BATCH_SUBJECT_CHARS,
      );
      const idempotencyKey = toolUseId === undefined ? undefined : `${sessionId}:PostToolBatch:${toolUseId}`;
      const recorded = deps.ledger.append({
        schema: 1,
        id: randomUUID(),
        ts: new Date(start).toISOString(),
        sessionId,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
        ...(idempotencyKey === undefined ? {} : { correlationId: idempotencyKey }),
        event: "PostToolBatch",
        subjectHash: hashSubject(subject),
        policyVersion: UNIFIED_POLICY_VERSION,
        deterministicFindings: [],
        // Observation, not authorization: this call already ran, so its
        // receipt records what happened rather than permitting anything.
        enforcement: "observed",
        reasons: [redactAndClamp(outcomeReason(callInput, start), MAX_BATCH_SUBJECT_CHARS)],
        latencyMs: Math.max(0, deps.now() - start),
      }, { durable: true, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
      if (!recorded) {
        // Leave the idempotency claim absent: redelivery can complete the receipt.
        console.error(`[jeverb] evidence receipt write failed (event=PostToolBatch session=${sessionId})`);
        continue;
      }
      if (toolUseId !== undefined) {
        deps.store.claimPostObservation(sessionId, toolUseId, "receipt", deps.now());
      }
    }
  }
  // Post-execution observation only: never a permission decision.
  return undefined;
}
