/**
 * SessionStart: say once, clearly, when the plugin is installed but inert.
 *
 * A gate that silently does nothing is worse than no gate, because the user
 * believes they have one. This is the only place the plugin volunteers
 * anything, and it says nothing at all when it is working.
 */

import type { Deps, HookInput, HookOutput } from "../types.js";

export async function handleSessionStart(input: HookInput, deps: Deps): Promise<HookOutput | undefined> {
  const { config, store } = deps;
  if (config.apiKey !== null) return undefined;
  if (config.gate === "off") return undefined;

  const sessionId = input.session_id ?? "unknown";
  // Claim the warning inside the session lock: `readSession` returns empty
  // state for corrupt or transiently-unreadable files, so a read-modify-write
  // here could overwrite real session bytes (or another hook's concurrent
  // update) with a stale snapshot. On unreadable state the claim fails
  // closed and the warning retries on a later start; nothing is rewritten.
  const outcome = store.lockedUpdate(sessionId, deps.now(), (state) => {
    if (state.key_warned === true) return undefined;
    return { state: { ...state, key_warned: true }, value: true as const };
  });
  if (outcome.status !== "committed") return undefined;

  const message =
    "jev hooks are inactive: no TypeSafe API key is configured. Set it with `/plugin` (jev → api_key) or by exporting TYPESAFE_API_KEY, then restart the session.";

  return {
    systemMessage: `[jev] ${message}`,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `[jev] The jev plugin's judgment hooks are installed but inactive, because no TypeSafe API key is configured. Deterministic pattern checks still run. ${message}`,
    },
  };
}
