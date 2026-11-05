import type { HookInput } from "../hooks/types.js";

/**
 * Canonical event contract shared by the native Muse hook path and the
 * signed HTTP calibration adapter. Both transports construct one of these
 * and dispatch it to the same handlers with equivalent stores, so a verdict
 * difference between transports is a transport bug, never a judgment
 * difference. The judgment engine never sees the transport.
 *
 * Only the decision-bearing events are covered: UserPromptSubmit and
 * Stop/SubagentStop. Adding a new kind means adding both constructors and
 * differential coverage — never extend one transport alone.
 */
export type CanonicalEvent =
  | {
      kind: "user-prompt-submit";
      sessionId: string;
      prompt: string;
      eventId?: string;
    }
  | {
      kind: "stop";
      subagent: false;
      sessionId: string;
      message: string;
      stopHookActive: boolean;
      eventId?: string;
    }
  | {
      kind: "stop";
      subagent: true;
      sessionId: string;
      message: string;
      stopHookActive: boolean;
      agentType?: string;
      subagentId?: string;
      eventId?: string;
    };

export function canonicalFromHookInput(input: HookInput): CanonicalEvent | undefined {
  const sessionId = input.session_id ?? "unknown";
  if (input.hook_event_name === "UserPromptSubmit" && typeof input.prompt === "string") {
    return {
      kind: "user-prompt-submit",
      sessionId,
      prompt: input.prompt,
      ...(input.event_id === undefined ? {} : { eventId: input.event_id }),
    };
  }
  if (input.hook_event_name === "Stop" || input.hook_event_name === "SubagentStop") {
    const base = {
      kind: "stop" as const,
      sessionId,
      message: input.last_assistant_message ?? "",
      stopHookActive: input.stop_hook_active === true,
      ...(input.event_id === undefined ? {} : { eventId: input.event_id }),
    };
    if (input.hook_event_name === "SubagentStop") {
      return {
        ...base,
        subagent: true as const,
        ...(input.agent_type === undefined ? {} : { agentType: input.agent_type }),
        ...(() => {
          const id = input.subagent_id ?? input.child_session_id ?? input.agent_id;
          return id === undefined ? {} : { subagentId: id };
        })(),
      };
    }
    return { ...base, subagent: false as const };
  }
  return undefined;
}

/** The exact HookInput the native path would have carried for this event. */
export function hookInputFromCanonical(event: CanonicalEvent): HookInput {
  if (event.kind === "user-prompt-submit") {
    return {
      session_id: event.sessionId,
      hook_event_name: "UserPromptSubmit",
      prompt: event.prompt,
      ...(event.eventId === undefined ? {} : { event_id: event.eventId }),
    };
  }
  return {
    session_id: event.sessionId,
    hook_event_name: event.subagent ? "SubagentStop" : "Stop",
    last_assistant_message: event.message,
    stop_hook_active: event.stopHookActive,
    ...(event.eventId === undefined ? {} : { event_id: event.eventId }),
    ...(event.subagent
      ? {
          agent_type: event.agentType,
          subagent_id: event.subagentId,
        }
      : {}),
  };
}
