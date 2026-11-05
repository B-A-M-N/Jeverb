import type { UnifiedDecision } from "../../decision/types.js";

export type MuseEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PostToolBatch"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "SessionEnd"
  | "PreLLMCall"
  | "PostLLMCall"
  | "PreCompact"
  | "PostCompact"
  | "StopFailure"
  | "Notification";

const CONTEXT_EVENTS = new Set<MuseEvent>([
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "SubagentStart",
]);

export function supportsContext(event: MuseEvent): boolean {
  return CONTEXT_EVENTS.has(event);
}

export function toMuseOutput(event: MuseEvent, d?: UnifiedDecision): Record<string, unknown> | undefined {
  if (!d) return undefined;
  if (event === "PermissionRequest") {
    if (d.enforcement === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: event,
          decision: { behavior: "deny", message: d.reasons.join("\n") },
        },
      };
    }
    // Muse only accepts allow/deny here. Jeverb never approves a pending call.
    return undefined;
  }
  if (event === "PreToolUse") {
    if (d.enforcement === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: "deny",
          permissionDecisionReason: d.reasons.join("\n"),
        },
      };
    }
    if (d.enforcement === "ask") {
      return { hookSpecificOutput: { hookEventName: event, permissionDecision: "ask" } };
    }
    if (d.enforcement === "advise") {
      return {
        hookSpecificOutput: { hookEventName: event, additionalContext: d.reasons.join("\n") },
      };
    }
    return undefined;
  }
  if ((event === "Stop" || event === "SubagentStop") && d.enforcement === "continue_work") {
    return { decision: "block", reason: d.reasons.join("\n") };
  }
  if (event === "Stop" && d.enforcement === "terminal" && d.terminalOutcome !== undefined) {
    return {
      continue: false,
      stopReason: `TOTAL_MISSION_${d.terminalOutcome.status}: ${d.reasons.join("\n")}`,
    };
  }
  if (supportsContext(event) && d.enforcement === "advise") {
    return {
      hookSpecificOutput: { hookEventName: event, additionalContext: d.reasons.join("\n") },
    };
  }
  return undefined;
}
