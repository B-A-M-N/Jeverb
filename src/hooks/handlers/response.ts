/**
 * Shared PreToolUse response constructors.
 *
 * These lived in `pre-tool-use.ts` while `lint.ts` and `commit.ts` imported
 * them back, forming a three-module runtime import cycle. They are pure
 * output shapes with no handler state, so they belong in this neutral module,
 * which must not import any handler. `pre-tool-use.ts` keeps orchestration;
 * the lint/commit routers keep their decisions.
 */

import type { EscalatingDecision, HookOutput } from "../types.js";

/** Modes with no interactive approval surface, so an ask cannot be delivered. */
const PROMPTLESS_MODES = new Set(["dontAsk", "bypassPermissions"]);

/**
 * How a trip reaches its audience.
 *
 * Muse has a native approval surface, so trips use it in interactive modes.
 * Other hook hosts still require the explicit `ask_on_trip` option. A promptless
 * permission mode cannot provide operator input, so the trip remains a deny.
 */
export function tripChannel(askOnTrip: boolean, mode: string | undefined, host?: "muse"): EscalatingDecision {
  const hostCanAsk = host === "muse" || askOnTrip;
  return hostCanAsk && !PROMPTLESS_MODES.has(mode ?? "default") ? "ask" : "deny";
}

/** A trip: the reason accompanies a host prompt or a denial. */
export function tripOutput(channel: EscalatingDecision, reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: channel,
      permissionDecisionReason: reason,
    },
  };
}

/** A note: delivered with the tool result, with no permission decision at all. */
export function noteOutput(text: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } };
}
