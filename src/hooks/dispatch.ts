/**
 * Event dispatch, shared by the command path and the daemon.
 *
 * This was the top of `main.ts` until 0.4.0. It moved because the daemon has to
 * run the same handlers, byte for byte, and `main.ts` now also imports the
 * daemon — which would close an import cycle. `main.ts` re-exports `HANDLERS`
 * and `runEvent`, so nothing that imported them from there had to change.
 *
 * The point of sharing this rather than reimplementing it is pinned by
 * `tests/hooks/conformance.test.ts`: the same input through `node hook.mjs
 * PreToolUse` and through `POST /v1/hook/PreToolUse` must produce identical
 * bytes. Two code paths that agree by construction beat two that agree because
 * somebody remembered.
 */

import { handleApproval, handlePostToolUse } from "./handlers/post-tool-use.js";
import { handlePostToolBatch } from "./handlers/post-tool-batch.js";
import { handlePreToolUse } from "./handlers/pre-tool-use.js";
import { handleSessionEnd } from "./handlers/session-end.js";
import { handleSessionStart } from "./handlers/session-start.js";
import { handleStop } from "./handlers/stop.js";
import { handleUserPromptSubmit } from "./handlers/user-prompt-submit.js";
import type { Deps, Handler, HookInput, HookOutput } from "./types.js";

/** Host events observed for correlation only; never modify model, prompt, or turn flow. */
const observeLifecycle: Handler = async () => undefined;

/** Hard ceiling for a handler, under the 5 s hooks.json timeout. */
export const WALL_CLOCK_MS = 3500;

/**
 * Remove receipt-only judgment provenance before a HookOutput reaches any
 * host. The silent-allow marker strips down to nothing (today's silence is
 * an absent body on the command path and `{}` on the daemon path), so
 * `runEvent`'s wire contract is unchanged. Idempotent: already-stripped
 * output passes through untouched.
 */
export function toWireOutput(output: HookOutput | undefined): HookOutput | undefined {
  if (output === undefined) return undefined;
  if (output.jev === undefined) return output;
  const { jev: _provenance, ...wire } = output;
  return Object.keys(wire).length === 0 ? undefined : wire;
}

/**
 * Every event this plugin answers.
 *
 * `Approval` is not a Claude Code event: it is this repo's label for the
 * bookkeeping-only path wired up to `PostToolUse` and `PostToolUseFailure`, and
 * it is in here because the daemon exposes one route per key of this object.
 */
export const HANDLERS: Record<string, Handler> = {
  PreToolUse: handlePreToolUse,
  PermissionRequest: handlePreToolUse,
  PostToolUse: handlePostToolUse,
  PostToolUseFailure: handlePostToolUse,
  /** Post-execution observation only. Answers nothing, records everything. */
  PostToolBatch: handlePostToolBatch,
  /** Correlation bookkeeping only. Answers nothing. */
  Approval: handleApproval,
  UserPromptSubmit: handleUserPromptSubmit,
  Stop: handleStop,
  SubagentStop: handleStop,
  SessionStart: handleSessionStart,
  SessionEnd: handleSessionEnd,
  PreLLMCall: observeLifecycle,
  PostLLMCall: observeLifecycle,
  PreCompact: observeLifecycle,
  PostCompact: observeLifecycle,
  StopFailure: observeLifecycle,
  Notification: observeLifecycle,
};

/** Resolve `undefined` rather than reject when the handler overruns. */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return (await withDeadlineResult(work, ms)).value;
}

/**
 * Deadline with attribution: callers that must distinguish "handler stayed
 * silent" from "deadline expired before it settled" use this instead of
 * `withDeadline`. The handler keeps running detached after expiry (its
 * receipt still lands); only this caller's verdict is marked timed out.
 */
export async function withDeadlineResult<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ value: T | undefined; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      work.then(
        (v): { value: T | undefined; timedOut: false } => ({ value: v, timedOut: false }),
        (e): Promise<never> => {
          throw e;
        },
      ),
      new Promise<{ value: undefined; timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ value: undefined, timedOut: true }), ms);
      }),
    ]);
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Dispatch one event. Exported for the tests, which inject `deps`.
 *
 * `signal` is the caller's deadline: it is threaded into the handler
 * invocation as `deps.signal` (the `Handler` contract is unchanged) so a
 * fired deadline cancels in-flight model work instead of leaving the
 * handler detached. The `deps` object identity is preserved and the field
 * restored afterwards, so a reused deps object never carries a stale —
 * possibly already-aborted — signal into a later event.
 */
export async function runEvent(
  event: string,
  raw: string,
  deps: Deps,
  signal?: AbortSignal,
): Promise<HookOutput | undefined> {
  if (deps.config.disabled || deps.store.isDisabled("unknown")) return undefined;
  const handler = HANDLERS[event];
  if (handler === undefined) return undefined;

  let input: HookInput;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    input = parsed as HookInput;
  } catch {
    // Malformed stdin is not this plugin's problem to report.
    return undefined;
  }

  if (input.hook_event_name === undefined) input.hook_event_name = event;
  // Hosts receive the wire form: receipt-only provenance is stripped here,
  // at the single choke point every host transport shares. The unified
  // receipt path reads handlers directly and keeps the provenance.
  const priorSignal = deps.signal;
  if (signal !== undefined) deps.signal = signal;
  let output: HookOutput | undefined;
  try {
    output = await handler(input, deps);
  } finally {
    if (signal !== undefined) {
      if (priorSignal === undefined) delete deps.signal;
      else deps.signal = priorSignal;
    }
  }
  // OFF racing an in-flight handler suppresses its result. Already-started
  // external work cannot always be cancelled, but it cannot publish a verdict.
  if (deps.config.disabled || deps.store.isDisabled(input.session_id ?? "unknown")) return undefined;
  return toWireOutput(output);
}
