/**
 * Hook I/O types.
 *
 * `permissionDecision` is typed `"ask" | "deny"` on purpose. Invariant 1 of the
 * plugin spec says a Jev judgment must never grant permission — Jev is not
 * injection-hardened, so a tool input written to argue for its own approval
 * must not be able to produce an approval. Making `"allow"` unrepresentable is
 * the cheapest possible enforcement: a code path that tries to emit it does
 * not compile.
 */

import type { DecisionModel, JudgmentOutcome } from "../decision/types.js";
import type { EvidenceLedger } from "../evidence/ledger.js";
import type { HookConfig } from "./config.js";
import type { Store } from "./store.js";
import type { MissionClosureRequestContext, MissionClosureRunnerResult } from "../mission/closure.js";

export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions"
  | (string & {});

/** Every field is optional: stdin comes from outside and may be anything. */
export interface HookInput {
  session_id?: string;
  /** Stable host event/turn correlation, when supplied by the host. */
  event_id?: string;
  turn_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: PermissionMode;
  hook_event_name?: string;
  agent_id?: string;
  agent_type?: string;
  /** PreToolUse / PostToolUse / PostToolUseFailure. */
  tool_name?: string;
  /** Original host identifier retained when the Muse adapter canonicalizes `tool_name`. */
  original_tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  /**
   * PostToolUseFailure: a string describing the failure, whose first line is
   * `Exit code N` for a Bash command that ran and exited.
   */
  error?: string;
  /** PostToolUseFailure: the failure arrived as an abort, not as a verdict. */
  is_interrupt?: boolean;
  /** PostToolUseFailure: tool execution time, excluding permission prompts. */
  duration_ms?: number;
  /** UserPromptSubmit. */
  prompt?: string;
  /** Stop / SubagentStop. */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
  /** SessionStart. */
  source?: string;
  /**
   * PostToolBatch: every committed call in the batch. All-optional: stdin
   * comes from outside and may be anything.
   */
  tool_calls?: ToolCallBatchEntry[];
  /** SubagentStart: Muse's documented fields (preferred over `agent_type`). */
  subagent_id?: string;
  child_session_id?: string;
  parent_tool_use_id?: string;
  /** Observation-only Muse lifecycle metadata. Payload content is never copied into receipts. */
  provider?: string;
  request_id?: string;
  response_id?: string;
  attempt?: number;
  step?: number;
  message_count?: number;
  tool_count?: number;
  status?: string;
  finish_reason?: string;
  tool_call_count?: number;
  usage?: unknown;
  trigger?: string;
  error_category?: string;
  error_details?: string;
  notification_type?: string;
  /** Muse Notification payload's categorical `type`; body/title are excluded. */
  type?: string;
  title?: string;
  message?: string;
}

/** One committed call inside a `PostToolBatch` payload. */
export interface ToolCallBatchEntry {
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: string;
}

/**
 * Canonical tool names: the exact spellings the unified handlers switch on
 * (`Bash`/`PowerShell` for deterministic inspection, the `Write` family for
 * the file gate, `Agent`/`Task` for spawn bookkeeping, `WebFetch`/`WebSearch`
 * for result screening).
 */
const CANONICAL_TOOL_NAMES = [
  "Bash",
  "PowerShell",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Update",
  "Agent",
  "Task",
  "Read",
  "WebFetch",
  "WebSearch",
  "Grep",
  "Glob",
  "TodoWrite",
  "BashOutput",
  "KillShell",
  "Skill",
  "NotebookRead",
  "SlashCommand",
] as const;

function foldToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const TOOL_NAME_BY_FOLDED: Record<string, string> = Object.fromEntries(
  CANONICAL_TOOL_NAMES.map((name) => [foldToolName(name), name]),
);

/**
 * Normalize an incoming tool name to the canonical spelling the handlers
 * switch on. Folding is case- and separator-insensitive (`"bash"` →
 * `"Bash"`, `"multi_edit"` → `"MultiEdit"`), so hosts whose native aliases
 * differ in spelling still hit the same gates. `mcp__*` names are namespaced
 * and pass through untouched, as does anything unrecognized (fail open: an
 * unknown name must never break routing).
 */
export function normalizeToolName(name: string | undefined): string {
  if (name === undefined) return "";
  const trimmed = name.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith("mcp__")) return trimmed;
  return TOOL_NAME_BY_FOLDED[foldToolName(trimmed)] ?? trimmed;
}

/** The only permission decisions this plugin may emit. */
export type EscalatingDecision = "ask" | "deny";

export interface HookOutput {
  /**
   * Jev judgment provenance for the unified receipt path. Internal only:
   * host output mappers build fresh wire objects and never forward it, and
   * the Claude stdout writer strips it. It exists so a silent allow can
   * still record which model judged, instead of the receipt claiming no
   * judgment ran.
   */
  jev?: {
    model: string;
    probabilities?: Record<string, number>;
  };
  /** Internal terminal signal; host mappers emit it only for Muse Stop. */
  terminalOutcome?: {
    status: "COMPLETE" | "BLOCKED";
    missionId: string;
    missionRevision: string;
    evidenceRevision: string;
    receiptCorrelationId: string;
  };
  /** Stop / SubagentStop only. */
  decision?: "block";
  reason?: string;
  /** Shown to the user, on every event. */
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: EscalatingDecision;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

export interface Deps {
  /** Host approval surface, set by trusted dispatch code rather than hook JSON. */
  authorizationHost?: "muse";
  /**
   * Per-dispatch lifecycle signal; aborts when OFF or a switch generation
   * change is observed. `runEvent` also threads the caller's hook deadline
   * through this field (restoring the prior value afterwards), so a fired
   * deadline cancels in-flight model work instead of leaving the handler
   * detached. Handlers that await anything cancellable link this to their
   * own abort scope and publish nothing after it fires.
   */
  signal?: AbortSignal;
  /** `null` when no API key is configured: every judging path must fail open. */
  model: DecisionModel | null;
  config: HookConfig;
  store: Store;
  now: () => number;
  /**
   * Side channel for a classified judgment outcome on paths where the
   * handler returns no host output. The unified dispatcher consumes (reads
   * and clears) it when writing the fallback receipt, so a stale outcome
   * can never leak into a later event's receipt on a reused deps object.
   */
  judgment?: { outcome: JudgmentOutcome };
  /**
   * Unified-decision receipt log. Optional so legacy transports keep their
   * own Store-based logging; the Muse dispatch path always sets it and
   * records every enforced decision before returning.
   */
  ledger?: EvidenceLedger;
  /** Trusted host evidence adapter. Never accept evidence directly from hook stdin or model text. */
  missionClosure?: (sessionId: string, signal?: AbortSignal, context?: MissionClosureRequestContext) => Promise<MissionClosureRunnerResult>;
}

export type Handler = (input: HookInput, deps: Deps) => Promise<HookOutput | undefined>;
