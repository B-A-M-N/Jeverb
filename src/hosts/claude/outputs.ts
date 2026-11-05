import type { UnifiedDecision } from "../../decision/types.js";
import type { EscalatingDecision, HookOutput } from "../../hooks/types.js";

export type ClaudeEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "SubagentStop"
  | "Stop"
  | "SessionEnd";

/**
 * Render a UnifiedDecision as Claude Code hook JSON.
 *
 * This is the Claude-side twin of `toMuseOutput`: same decision in, the
 * host's own closed schema out. `permissionDecision` stays `"ask" | "deny"`
 * — `"allow"` is unrepresentable by the `EscalatingDecision` type, so a
 * model-derived approval cannot compile here, exactly as in the legacy
 * handlers.
 */
export function toClaudeOutput(event: ClaudeEvent, d?: UnifiedDecision): HookOutput | undefined {
  if (!d) return undefined;
  const reasons = d.reasons.join("\n");
  switch (d.enforcement) {
    case "deny":
    case "ask": {
      const channel: EscalatingDecision = d.enforcement;
      return {
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: channel,
          permissionDecisionReason: reasons,
        },
      };
    }
    case "advise":
      return {
        hookSpecificOutput: { hookEventName: event, additionalContext: reasons },
      };
    case "continue_work":
      if (event === "Stop" || event === "SubagentStop") {
        return { decision: "block", reason: reasons };
      }
      return undefined;
    case "terminal":
      return undefined;
    case "allow":
      return undefined;
  }
}
