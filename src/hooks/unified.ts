import { createHash, randomUUID } from "node:crypto";
import type { DecisionModel, JudgmentOutcome, UnifiedDecision } from "../decision/types.js";
import { UNIFIED_POLICY_VERSION } from "../decision/types.js";
import { inspectToolCall } from "../enforcement/deterministic.js";
import { hashSubject, type EvidenceLedger, type EvidenceRecord } from "../evidence/ledger.js";
import type { ReviewService } from "../review/service.js";
import { reviewToReason } from "../review/service.js";
import { HANDLERS } from "./dispatch.js";
import { isGitCommit } from "./handlers/commit.js";
import { MAX_STOP_BLOCKS } from "./handlers/stop.js";
import { MIN_PROMPT_CHARS } from "./handlers/user-prompt-submit.js";
import { classifyPrompt, classifySubagent } from "../routing/policy.js";
import { gitStagedDiff } from "./workspace.js";
import type { Deps, HookInput, HookOutput } from "./types.js";
import { redact } from "./redact.js";
import { normalizeToolName } from "./types.js";
import { adaptMuseHookInput } from "../hosts/muse/tool-adapter.js";

export interface UnifiedDeps extends Deps {
  review?: ReviewService;
}

const SWITCH_POLL_MS = 25;
const DISPATCH_MAX_MS = 3_300;

function joinSignals(parent: AbortSignal | undefined, child: AbortSignal): AbortSignal {
  return parent === undefined ? child : AbortSignal.any([parent, child]);
}

function modelWithSignal(model: DecisionModel | null, signal: AbortSignal): DecisionModel | null {
  if (model === null) return null;
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === "evaluate") {
        return (request: Parameters<DecisionModel["evaluate"]>[0]) =>
          target.evaluate({ ...request, signal: joinSignals(request.signal, signal) });
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const STORE_MUTATIONS = new Set([
  "writeSession", "updateSession", "setDisabled", "rememberReissue", "claimPostObservation",
  "foldPostObservation", "tryClaimStopIntervention", "takeReissue", "rememberSubagentTask", "bindSubagentTask", "dropSubagentTask", "openTrip",
  "repeatTrip", "affirmTrip", "closeTrip", "noteEmitted", "append", "pruneSessions",
]);

function storeWithSwitchFence(store: Deps["store"], signal: AbortSignal, generation: string | null): Deps["store"] {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof property === "string" && STORE_MUTATIONS.has(property) && typeof value === "function") {
        return (...args: unknown[]) => {
          const current = target.masterSwitchStatus();
          if (signal.aborted || current.effective === "OFF" || current.generation !== generation) {
            throw new Error("Jeverb operation cancelled by master-switch transition");
          }
          return (value as (...items: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Events that fire before the tool runs: the only ones where a
 * deterministic inspection may deny. Post-execution events (PostToolUse,
 * PostToolUseFailure, PostToolBatch) observe calls that already ran, so a
 * deny there would be a verdict without a gate — never emitted.
 */
const PRE_EXECUTION_EVENTS = new Set(["PreToolUse"]);
const OBSERVATION_ONLY_EVENTS = new Set([
  "PreLLMCall", "PostLLMCall", "PreCompact", "PostCompact", "StopFailure", "Notification",
]);

/**
 * Per-dispatch invocation identity. The host's `tool_use_id` is stable
 * across the timeout and settled receipts of one call; for events without
 * one, mint a UUID once per input object so every `decisionIdFor` call in
 * the same dispatch — including the detached deadline receipt, which
 * receives the same object — correlates, while distinct dispatches never
 * share an ID.
 */
const invocationIds = new WeakMap<object, string>();

function invocationIdFor(input: HookInput): string {
  if (typeof input.tool_use_id === "string" && input.tool_use_id !== "") return input.tool_use_id;
  let id = invocationIds.get(input);
  if (id === undefined) {
    id = randomUUID();
    invocationIds.set(input, id);
  }
  return id;
}

function decisionIdFor(event: string, input: HookInput): string {
  const invocation = invocationIdFor(input);
  const key = `${event}\n${input.session_id ?? ""}\n${input.tool_name ?? ""}\n${invocation}\n${JSON.stringify(input.tool_input ?? {})}\n${JSON.stringify(input.tool_response ?? {})}`;
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}

function mapHookOutput(event: string, output: HookOutput | undefined, input: HookInput): UnifiedDecision | undefined {
  if (!output) return undefined;
  const id = decisionIdFor(event, input);
  // Judgment provenance rides every judgment-backed output (including the
  // silent allow) into the receipt. Host mappers build fresh wire objects
  // and never forward it.
  const provenance = output.jev;
  const attribute = (decision: UnifiedDecision): UnifiedDecision =>
    provenance?.model === undefined
      ? decision
      : {
          ...decision,
          model: provenance.model,
          ...(provenance.probabilities !== undefined ? { probabilities: { ...provenance.probabilities } } : {}),
        };
  if (output.terminalOutcome !== undefined) {
    return attribute({
      event,
      enforcement: "terminal",
      source: "combined",
      reasons: [
        `TOTAL_MISSION_${output.terminalOutcome.status}`,
        `mission=${output.terminalOutcome.missionId}`,
        `missionRevision=${output.terminalOutcome.missionRevision}`,
        `evidenceRevision=${output.terminalOutcome.evidenceRevision}`,
        `receipt=${output.terminalOutcome.receiptCorrelationId}`,
      ],
      evidence: [
        { kind: "mission", id: output.terminalOutcome.missionId },
        { kind: "mission-revision", id: output.terminalOutcome.missionRevision },
        { kind: "evidence-revision", id: output.terminalOutcome.evidenceRevision },
        { kind: "receipt", id: output.terminalOutcome.receiptCorrelationId },
      ],
      terminalOutcome: output.terminalOutcome,
      policyVersion: UNIFIED_POLICY_VERSION,
      decisionId: id,
    });
  }
  if (output.decision === "block") {
    return attribute({
      event,
      enforcement: "continue_work",
      source: "combined",
      reasons: [output.reason ?? "blocked"],
      evidence: [],
      policyVersion: UNIFIED_POLICY_VERSION,
      decisionId: id,
    });
  }
  const permission = output.hookSpecificOutput?.permissionDecision;
  if (permission === "deny") {
    return attribute({
      event,
      enforcement: "deny",
      source: "combined",
      reasons: [output.hookSpecificOutput?.permissionDecisionReason ?? "denied"],
      evidence: [],
      policyVersion: UNIFIED_POLICY_VERSION,
      decisionId: id,
    });
  }
  if (permission === "ask") {
    return attribute({
      event,
      enforcement: "ask",
      source: "combined",
      reasons: [output.hookSpecificOutput?.permissionDecisionReason ?? "review required"],
      evidence: [],
      policyVersion: UNIFIED_POLICY_VERSION,
      decisionId: id,
    });
  }
  if (output.hookSpecificOutput?.additionalContext) {
    return attribute({
      event,
      enforcement: "advise",
      source: "combined",
      reasons: [output.hookSpecificOutput.additionalContext],
      evidence: [],
      policyVersion: UNIFIED_POLICY_VERSION,
      decisionId: id,
    });
  }
  if (output.systemMessage) {
    return attribute({
      event,
      enforcement: "advise",
      source: "combined",
      reasons: [output.systemMessage],
      evidence: [],
      policyVersion: UNIFIED_POLICY_VERSION,
      decisionId: id,
    });
  }
  // The silent-allow marker: no host output, but the ledger must record
  // that a judgment ran and allowed — not that nothing was judged.
  if (provenance?.model !== undefined) {
    return {
      event,
      enforcement: "allow",
      source: "jev",
      reasons: ["jev judgment allowed the action"],
      evidence: [],
      model: provenance.model,
      ...(provenance.probabilities !== undefined ? { probabilities: { ...provenance.probabilities } } : {}),
      policyVersion: UNIFIED_POLICY_VERSION,
      decisionId: id,
    };
  }
  return undefined;
}

/** Host-neutral dispatch. Undefined means allow (fail open). Jev is evidence, never authorization. */
async function dispatchEventInner(event: string, input: HookInput, deps: UnifiedDeps): Promise<UnifiedDecision | undefined> {
  input = adaptMuseHookInput(input);
  if (deps.signal?.aborted || deps.store.isDisabled(input.session_id ?? "unknown")) return undefined;
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const toolName = normalizeToolName(input.tool_name);

  if (event === "PermissionRequest") {
    // Muse owns the approval result. The third-party hook receives no trusted,
    // action-bound receipt proving that an operator approved this request, so
    // it must not re-run inference or turn an approval prompt into a second
    // policy pass. Independent prohibitions still apply here.
    const deterministic = inspectToolCall({ tool_name: toolName, tool_input: toolInput });
    if (deterministic.enforcement === "deny") {
      deps.judgment = { outcome: "DETERMINISTIC_DENY" };
      return {
        event,
        enforcement: "deny",
        source: "deterministic",
        reasons: [deterministic.reason ?? "deterministic denial"],
        evidence: [],
        policyVersion: UNIFIED_POLICY_VERSION,
        decisionId: decisionIdFor(event, input),
      };
    }
    return undefined;
  }

  if (PRE_EXECUTION_EVENTS.has(event)) {
    const deterministic = inspectToolCall({ tool_name: toolName, tool_input: toolInput });
    if (deterministic.enforcement === "deny") {
      deps.judgment = { outcome: "DETERMINISTIC_DENY" };
      return {
        event,
        enforcement: "deny",
        source: "deterministic",
        reasons: [deterministic.reason ?? "deterministic denial"],
        evidence: [],
        policyVersion: UNIFIED_POLICY_VERSION,
        decisionId: decisionIdFor(event, input),
      };
    }
    if (deterministic.risk === "promotion") {
      return {
        event,
        enforcement: "ask",
        source: "deterministic",
        reasons: ["Operator release approval is required; Muse remains the permission authority."],
        evidence: [],
        policyVersion: UNIFIED_POLICY_VERSION,
        decisionId: decisionIdFor(event, input),
      };
    }
  }

  if (event === "PreToolUse" && deps.review !== undefined && toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : undefined;
    if (isGitCommit(command)) {
      const cwd = input.cwd ?? process.cwd();
      const staged = await gitStagedDiff(cwd);
      if (deps.signal?.aborted) return undefined;
      const review = await deps.review.review({ diff: staged?.text ?? "", files: [], ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
      if (deps.signal?.aborted) return undefined;
      const deterministicHardBlock = review.source === "deterministic" && review.findings.some(
        (finding) => finding.severity === "hard" && !finding.id.startsWith("config:"),
      );
      if (deterministicHardBlock) {
        return {
          event,
          enforcement: "deny",
          source: "deterministic",
          reasons: [reviewToReason(review)],
          evidence: [],
          policyVersion: UNIFIED_POLICY_VERSION,
          decisionId: decisionIdFor(event, input),
        };
      }
      if (review.lane === "SECURITY REVIEW") {
        if (deps.config.commitEnforcement === "mandatory") {
          return {
            event,
            enforcement: "ask",
            source: "combined",
            reasons: [reviewToReason(review)],
            evidence: [],
            policyVersion: UNIFIED_POLICY_VERSION,
            decisionId: decisionIdFor(event, input),
          };
        }
      }
      if (deps.config.commitEnforcement === "mandatory" && review.lane === "NITS") {
        return {
          event,
          enforcement: "advise",
          source: "combined",
          reasons: [reviewToReason(review)],
          evidence: [],
          policyVersion: UNIFIED_POLICY_VERSION,
          decisionId: decisionIdFor(event, input),
        };
      }
      // Model review has no commit authority by default. Uncalibrated,
      // unavailable, or model-derived block outcomes remain diagnostic unless
      // an operator explicitly enabled mandatory commit enforcement.
      if (deps.config.commitEnforcement === "mandatory" && (review.lane === "BLOCK" || review.lane === "UNAVAILABLE")) {
        return {
          event,
          enforcement: "deny",
          source: "deterministic",
          reasons: [reviewToReason(review)],
          evidence: [],
          policyVersion: UNIFIED_POLICY_VERSION,
          decisionId: decisionIdFor(event, input),
        };
      }
      if (deps.config.commitEnforcement === "advisory" && review.lane !== "MERGE") {
        return {
          event,
          enforcement: "advise",
          source: "combined",
          reasons: [`Commit review is advisory (${review.lane}): ${reviewToReason(review)}`],
          evidence: [],
          policyVersion: UNIFIED_POLICY_VERSION,
          decisionId: decisionIdFor(event, input),
        };
      }
    }
  }

  const handler = HANDLERS[event];
  if (!handler) {
    return subagentStartAdvisory(event, input, deps);
  }
  const output = await handler(input, deps);
  const mapped = mapHookOutput(event, output, input);
  if (mapped !== undefined) return mapped;
  if (OBSERVATION_ONLY_EVENTS.has(event)) {
    return {
      event,
      enforcement: "observed",
      source: "combined",
      reasons: ["Muse lifecycle event observed; no host action taken"],
      evidence: [],
      policyVersion: UNIFIED_POLICY_VERSION,
      decisionId: decisionIdFor(event, input),
    };
  }
  if (event === "PreToolUse" && (toolName === "Agent" || toolName === "Task")) {
    return subagentSpawnAdvisory(input);
  }
  if (event === "Stop" || event === "SubagentStop") {
    return emptyDeliverableGate(event, input, deps);
  }
  return promptAdvisoryFallback(event, input, deps);
}

/**
 * Deterministic completion gate for the keyless path: the Jev-backed
 * `handleStop` stays silent without a model, but an empty deliverable needs
 * no judgment — there is nothing to accept. Bounded by the same per-prompt
 * stop-block counter the Jev path uses, so a stuck child can hold the turn
 * open at most once per user prompt before failing open.
 */
function emptyDeliverableGate(event: string, input: HookInput, deps: UnifiedDeps): UnifiedDecision | undefined {
  // Do not infer subagent failure from a parent-facing
  // lifecycle event's absent or empty final message.
  if (event !== "Stop") return undefined;

  // Missing information is unknown, not an empty deliverable.
  if (!Object.hasOwn(input, "last_assistant_message")) {
    return undefined;
  }

  if (typeof input.last_assistant_message !== "string") {
    return undefined;
  }

  if (input.stop_hook_active === true) return undefined;
  if ((input.last_assistant_message ?? "").trim().length > 0) return undefined;
  const sessionId = input.session_id ?? "unknown";
  const session = deps.store.readSession(sessionId);
  const eventKey = `empty:${session.prompt_revision ?? 0}:${createHash("sha256").update(input.last_assistant_message).digest("hex")}`;
  if (deps.store.tryClaimStopIntervention(sessionId, eventKey, MAX_STOP_BLOCKS, deps.now()) !== "claimed") return undefined;
  const who = "empty final message";
  return {
    event,
    enforcement: "continue_work",
    source: "deterministic",
    reasons: [`[completion] ${who} — nothing to accept; keep working or state what blocks you`],
    evidence: [],
    policyVersion: UNIFIED_POLICY_VERSION,
    decisionId: decisionIdFor(event, input),
  };
}

/**
 * Deterministic effort hint when the Jev-backed classifier stayed silent
 * (no model, routing off, short prompt excluded, low confidence). Advisory
 * only: it never changes the host's model or effort, it only suggests.
 */
function promptAdvisoryFallback(event: string, input: HookInput, deps: UnifiedDeps): UnifiedDecision | undefined {
  if (event !== "UserPromptSubmit" || !deps.config.routePrompts) return undefined;
  const prompt = (input.prompt ?? "").trim();
  if (prompt.length < MIN_PROMPT_CHARS) return undefined;
  const { effort, reason } = classifyPrompt(prompt);
  return {
    event,
    enforcement: "advise",
    source: "deterministic",
    reasons: [`[router] suggested effort: ${effort} — ${reason} (advisory only; host decides effort)`],
    evidence: [],
    policyVersion: UNIFIED_POLICY_VERSION,
    decisionId: decisionIdFor(event, input),
  };
}

/**
 * `SubagentStart` has no judging handler — there is no deliverable yet — so
 * the only honest output is a deterministic note identifying the subagent.
 * Muse's documented `subagent_id` / `child_session_id` are preferred; the
 * legacy `agent_type` stays as fallback.
 */
function subagentStartAdvisory(event: string, input: HookInput, deps: UnifiedDeps): UnifiedDecision | undefined {
  if (event !== "SubagentStart") return undefined;
  const subagentId = (input.subagent_id ?? "").trim().slice(0, 80);
  const childSessionId = (input.child_session_id ?? "").trim().slice(0, 80);
  const agentType = (input.agent_type ?? "").trim().slice(0, 80);
  const identity = subagentId !== "" ? `id: ${subagentId}` : childSessionId !== "" ? `id: ${childSessionId}` : agentType !== "" ? `type: ${agentType}` : "";
  if (identity === "") return undefined;
  let task: string | undefined;
  if (agentType !== "") {
    try {
      const childIdentity = subagentId || childSessionId;
      if (childIdentity !== "") {
        deps.store.bindSubagentTask(input.session_id ?? "unknown", agentType, {
          ...(subagentId === "" ? {} : { subagentId }),
          ...(childSessionId === "" ? {} : { childSessionId }),
          ...(input.parent_tool_use_id === undefined ? {} : { parentToolUseId: input.parent_tool_use_id }),
        }, deps.now());
      }
      task = deps.store.takeSubagentTask(input.session_id ?? "unknown", agentType, deps.now(), childIdentity || undefined)?.prompt;
    } catch {
      // A missing or corrupt task record makes classification unknown. Never
      // guess which of two same-type parallel subagents this start represents.
    }
  }
  const classification = task === undefined
    ? { suitable: false, reason: "captured task is unavailable or ambiguous" }
    : classifySubagent(task);
  return {
    event,
    enforcement: "advise",
    source: "deterministic",
    reasons: [
      `[router] subagent started (${identity}): suitability ${classification.suitable ? "suitable" : "not established"} — ${classification.reason}; advisory only; host decides model and effort`,
    ],
    evidence: [],
    policyVersion: UNIFIED_POLICY_VERSION,
    decisionId: decisionIdFor(event, input),
  };
}

/** Give the parent controller a suitability hint before its spawn call runs. */
function subagentSpawnAdvisory(input: HookInput): UnifiedDecision {
  const raw = input.tool_input ?? {};
  const agentType = typeof raw["subagent_type"] === "string" ? raw["subagent_type"].trim().slice(0, 80) : "";
  const task = typeof raw["prompt"] === "string" ? raw["prompt"] : "";
  const classification = classifySubagent(task);
  const identity = agentType === "" ? "delegated task" : `delegated task for ${agentType}`;
  return {
    event: "PreToolUse",
    enforcement: "advise",
    source: "deterministic",
    reasons: [
      `[router] ${identity} suitability ${classification.suitable ? "suitable" : "not established"} — ${classification.reason}; advisory only; Muse decides whether to spawn and which model/effort to use`,
    ],
    evidence: [],
    policyVersion: UNIFIED_POLICY_VERSION,
    decisionId: decisionIdFor("PreToolUse", input),
  };
}

function subjectFor(event: string, input: HookInput): string {
  if (OBSERVATION_ONLY_EVENTS.has(event)) {
    // Never persist LLM message text, notification content, error text, or
    // usage payloads. Hash only bounded, non-content metadata for correlation.
    const fields: Record<string, unknown> = {
      ...(typeof input.session_id === "string" ? { session_id: input.session_id.slice(0, 100) } : {}),
    };
    for (const key of [
      "provider", "request_id", "response_id", "attempt", "step", "message_count", "tool_count",
      "status", "finish_reason", "tool_call_count", "trigger", "error_category", "notification_type",
    ] as const) {
      const value = input[key];
      if (typeof value === "string" || typeof value === "number") fields[key] = String(value).slice(0, 100);
    }
    const hostUsage = hostUsageFor(input);
    if (hostUsage !== undefined) fields.host_usage = hostUsage;
    if (event === "Notification" && typeof input.type === "string") {
      fields.notification_type = input.type.slice(0, 100);
    }
    return JSON.stringify(fields);
  }
  if (event === "PreToolUse") {
    const rawCommand = (input.tool_input as Record<string, unknown> | undefined)?.command;
    const detail = typeof rawCommand === "string" ? rawCommand : JSON.stringify(input.tool_input ?? {});
    return `${input.tool_name ?? ""} ${detail}`.slice(0, 500);
  }
  return JSON.stringify(input).slice(0, 500);
}

/** Keep only bounded integer token counters; never retain the raw usage payload. */
function hostUsageFor(input: HookInput): EvidenceRecord["hostUsage"] {
  if (typeof input.usage !== "object" || input.usage === null || Array.isArray(input.usage)) return undefined;
  const usage = input.usage as Record<string, unknown>;
  const inputTokens = usage["input_tokens"];
  const outputTokens = usage["output_tokens"];
  const validCounter = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
  const counters = {
    ...(validCounter(inputTokens) ? { inputTokens } : {}),
    ...(validCounter(outputTokens) ? { outputTokens } : {}),
  };
  return Object.keys(counters).length === 0 ? undefined : counters;
}

/** Stable opaque correlation for pre/post events; the raw host request id is never stored. */
function hostRequestCorrelation(input: HookInput): string | undefined {
  if (typeof input.session_id !== "string" || input.session_id === "" ||
      input.session_id.length > 200 || typeof input.request_id !== "string" ||
      input.request_id === "" || input.request_id.length > 200) return undefined;
  return createHash("sha256")
    .update(`muse-llm-request\0${input.session_id}\0${input.request_id}`, "utf8")
    .digest("hex");
}

function hostIdentityCorrelation(kind: "turn" | "parent-tool", identity: string | undefined, sessionId: string | undefined): string | undefined {
  if (typeof sessionId !== "string" || sessionId === "" || sessionId.length > 200 ||
      typeof identity !== "string" || identity === "" || identity.length > 200) return undefined;
  return createHash("sha256")
    .update(`muse-${kind}\0${sessionId}\0${identity}`, "utf8")
    .digest("hex");
}

function lifecycleAttribution(event: string, input: HookInput): Partial<Pick<EvidenceRecord,
  "eventHost" | "hostUsage" | "correlationId" | "hostTurnCorrelationId" | "parentExecutionCorrelationId"
>> {
  if (!OBSERVATION_ONLY_EVENTS.has(event)) return {};
  const hostUsage = hostUsageFor(input);
  const correlationId = hostRequestCorrelation(input);
  const hostTurnCorrelationId = hostIdentityCorrelation("turn", input.turn_id, input.session_id);
  const parentExecutionCorrelationId = hostIdentityCorrelation("parent-tool", input.parent_tool_use_id, input.session_id);
  return {
    eventHost: "muse",
    ...(hostUsage === undefined ? {} : { hostUsage }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(hostTurnCorrelationId === undefined ? {} : { hostTurnCorrelationId }),
    ...(parentExecutionCorrelationId === undefined ? {} : { parentExecutionCorrelationId }),
  };
}

function appendReceipt(
  ledger: EvidenceLedger,
  decision: UnifiedDecision | undefined,
  event: string,
  input: HookInput,
  startMs: number,
  endMs: number,
  error?: unknown,
): boolean {
  const toolUseId = typeof input.tool_use_id === "string" && input.tool_use_id !== "" ? input.tool_use_id : undefined;
  // Only authorization/enforcement decisions, critical terminal state, and
  // errors that must survive a crash are fsync'd. Ordinary lifecycle
  // observations (observed/advise/allow) keep the fast process-level path;
  // a lost observation receipt is a gap with explicit reporting, not a
  // safety violation.
  const durable =
    decision === undefined ||
    decision.enforcement === "deny" ||
    decision.enforcement === "ask" ||
    decision.enforcement === "continue_work" ||
    decision.enforcement === "terminal" ||
    decision.enforcement === "error";
  const ok = ledger.append(
    {
      schema: 1,
    id: randomUUID(),
    ts: new Date(startMs).toISOString(),
    sessionId: input.session_id ?? "unknown",
    ...lifecycleAttribution(event, input),
    ...(decision?.decisionId !== undefined ? { decisionId: decision.decisionId } : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    event,
    subjectHash: hashSubject(subjectFor(event, input)),
    policyVersion: decision?.policyVersion ?? UNIFIED_POLICY_VERSION,
    ...(decision?.model !== undefined ? { model: decision.model } : {}),
    ...(decision?.probabilities !== undefined ? { probabilities: decision.probabilities } : {}),
    ...(decision?.judgment !== undefined ? { judgment: decision.judgment } : {}),
    deterministicFindings: decision !== undefined && decision.source === "deterministic" ? decision.reasons : [],
    enforcement: decision?.enforcement ?? "error",
    reasons: decision?.reasons ?? [error instanceof Error ? `${error.name}: ${error.message}` : String(error)],
    latencyMs: Math.max(0, endMs - startMs),
    ...(error === undefined ? {} : { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
    },
    { durable },
  );
  if (!ok) {
    // Never silently swallowed: every receipt failure is loud on stderr.
    // Enforcing callers additionally surface the gap on the returned
    // decision itself — see dispatchEvent, which owns the real object.
    console.error(`[jeverb] evidence receipt write failed (event=${event} enforcement=${decision?.enforcement ?? "none"})`);
  }
  return ok;
}

/**
 * Dispatch with evidence. Every defined decision is recorded before it is
 * returned, so an enforced deny always has a receipt. A pre-execution event
 * with no decision (implicit allow) is recorded as an advisory receipt, so
 * every correlated invocation has exactly one observation — the receipt
 * says the hook did not judge, never that it authorized. An unexpected
 * throw is recorded as an error receipt and fails open (undefined),
 * matching the hook runtime's fail-open rule.
 */
/**
 * One human-readable line naming why a judgment slot produced no blocking
 * verdict. Pre-judgment exits name the policy; failures name the class.
 */
export function judgmentReason(outcome: JudgmentOutcome): string {
  switch (outcome) {
    case "SKIPPED_READ_ONLY":
      return "no judgment needed: read-only operation; host approval applies";
    case "SKIPPED_IN_PROJECT":
      return "no judgment needed: ordinary in-project operation; host approval applies";
    case "DETERMINISTIC_DENY":
      return "deterministic policy denied the operation before any judgment";
    case "MODEL_NOT_CONFIGURED":
      return "no model configured, so no judgment ran; host approval applies";
    case "MODEL_INITIALIZATION_ERROR":
      return "model initialization failed, so no judgment ran; host approval applies";
    case "JUDGMENT_SUCCEEDED":
      return "judgment completed without a blocking verdict; host approval applies";
    case "JUDGMENT_TIMEOUT":
      return "judgment timed out before the model answered; host approval applies";
    case "HOOK_DEADLINE_EXCEEDED":
      return "hook deadline expired before the judgment settled; host approval applies";
    case "RATE_LIMITED":
      return "judgment rate-limited by the provider; host approval applies";
    case "QUOTA_EXHAUSTED":
      return "judgment skipped: provider quota exhausted, circuit open; deterministic policy applies";
    case "PROVIDER_FORBIDDEN":
      return "judgment refused by provider admission policy; host approval applies";
    case "AUTH_FAILURE":
      return "judgment failed authentication; host approval applies";
    case "NETWORK_FAILURE":
      return "judgment failed on the provider path; host approval applies";
    case "INVALID_MODEL_RESPONSE":
      return "judgment got an unusable model response; host approval applies";
    case "POLICY_SUPPRESSED":
      return "judgment completed but policy suppressed the output; host approval applies";
    case "JUDGMENT_ATTEMPTED":
      return "judgment attempted but produced no classified result; host approval applies";
  }
}

/** Gap note surfaced on a gating decision whose receipt could not persist. */
const RECEIPT_GAP_REASON = "[evidence] receipt write failed; enforcement proceeded without durable receipt";

/**
 * Enforcements that already gate the host action. Anything else (`allow`,
 * `advise`, `observed`) lets the action proceed, so a lost receipt on one of
 * those is a silent pass — the case that must block instead.
 */
function isGatingDecision(decision: UnifiedDecision): boolean {
  return (
    decision.enforcement === "deny" ||
    decision.enforcement === "ask" ||
    decision.enforcement === "continue_work" ||
    decision.enforcement === "terminal" ||
    decision.enforcement === "error"
  );
}

/**
 * Fail loudly when a receipt cannot be persisted on a gating path: deny the
 * tool call, or hold the stop gate, rather than proceeding unrecorded.
 * Post-execution and observation-only events never reach here — a verdict
 * without a gate is meaningless after the call already ran.
 */
function receiptFailureBlock(event: string, input: HookInput): UnifiedDecision {
  const stop = event === "Stop" || event === "SubagentStop";
  return {
    event,
    enforcement: stop ? "continue_work" : "deny",
    source: "deterministic",
    reasons: ["[evidence] receipt write failed; blocking the action rather than proceeding without a durable receipt"],
    evidence: [],
    policyVersion: UNIFIED_POLICY_VERSION,
    decisionId: decisionIdFor(event, input),
  };
}

export async function dispatchEvent(event: string, input: HookInput, deps: UnifiedDeps): Promise<UnifiedDecision | undefined> {
  const start = deps.now();
  const baseline = deps.store.masterSwitchStatus();
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(deps.signal?.reason);
  if (deps.signal?.aborted) forwardAbort();
  else deps.signal?.addEventListener("abort", forwardAbort, { once: true });
  const cancelled = (): boolean => {
    const current = deps.store.masterSwitchStatus();
    const changed = current.effective === "OFF" || current.generation !== baseline.generation;
    if (changed && !controller.signal.aborted) controller.abort(new Error("Jeverb switch changed during dispatch"));
    return controller.signal.aborted || deps.config.disabled || deps.store.isDisabled(input.session_id ?? "unknown");
  };
  const poll = setInterval(() => { cancelled(); }, SWITCH_POLL_MS);
  poll.unref?.();
  const deadline = setTimeout(() => controller.abort(new Error("Jeverb dispatch deadline exceeded")), DISPATCH_MAX_MS);
  const executionDeps: UnifiedDeps = {
    ...deps,
    signal: controller.signal,
    store: storeWithSwitchFence(deps.store, controller.signal, baseline.generation),
    model: modelWithSignal(deps.model, controller.signal),
    ...(deps.missionClosure === undefined
      ? {}
      : {
          missionClosure: (sessionId, signal, context) =>
            deps.missionClosure?.(sessionId, joinSignals(signal, controller.signal), context) as ReturnType<NonNullable<Deps["missionClosure"]>>,
        }),
  };
  delete executionDeps.judgment;
  try {
    if (cancelled()) return undefined;
    const decision = await dispatchEventInner(event, input, executionDeps);
    if (executionDeps.judgment !== undefined) deps.judgment = executionDeps.judgment;
    // Suppress a verdict and receipt if OFF won while this dispatch awaited a
    // model or review. The lifecycle signal cancels providers that support it;
    // providers that ignore abort are drained and their result is discarded.
    if (cancelled()) return undefined;
    // Consume the handler's classified outcome: a reused deps object must
    // never attribute one event's outcome to a later event's receipt.
    const pending = deps.judgment;
    delete deps.judgment;
    if (deps.ledger !== undefined) {
      if (cancelled()) return undefined;
      if (decision !== undefined) {
        // Receipt-only enrichment: a decision that came back without a
        // stamped outcome inherits the handler's classified outcome, so the
        // receipt states whether judgment ran. The returned decision keeps
        // its shape — host mappers never see this field.
        const attributed =
          decision.judgment === undefined && pending !== undefined
            ? { ...decision, judgment: pending.outcome }
            : decision;
        const ok = appendReceipt(deps.ledger, attributed, event, input, start, deps.now());
        if (!ok) {
          if (isGatingDecision(decision)) {
            // Durable-audit failure on a decision that already gates: the
            // decision stands per the emergency-disk-failure exception, but
            // the gap is surfaced on the decision itself — never silently
            // swallowed.
            decision.reasons = [...decision.reasons, RECEIPT_GAP_REASON];
          } else if (PRE_EXECUTION_EVENTS.has(event)) {
            // An allow that cannot be recorded must not proceed silently:
            // fail loudly by denying the gated action instead.
            return receiptFailureBlock(event, input);
          }
        }
      } else if (PRE_EXECUTION_EVENTS.has(event)) {
        const ok = appendReceipt(
          deps.ledger,
          {
            event,
            enforcement: "advise",
            source: "deterministic",
            reasons: [pending === undefined ? "no deterministic rule matched and no Jev judgment ran: hook did not judge; host approval applies" : judgmentReason(pending.outcome)],
            evidence: [],
            ...(pending === undefined ? {} : { judgment: pending.outcome }),
            policyVersion: UNIFIED_POLICY_VERSION,
            decisionId: decisionIdFor(event, input),
          },
          event,
          input,
          start,
          deps.now(),
        );
        // Implicit allow with no durable receipt: proceeding would enforce
        // nothing and record nothing. Block instead.
        if (!ok) return receiptFailureBlock(event, input);
      }
    }
    if (cancelled()) return undefined;
    return decision;
  } catch (err) {
    if (executionDeps.judgment !== undefined) deps.judgment = executionDeps.judgment;
    let receiptOk = true;
    if (deps.ledger !== undefined && !cancelled()) {
      receiptOk = appendReceipt(deps.ledger, undefined, event, input, start, deps.now(), err);
    }
    if (!receiptOk && (PRE_EXECUTION_EVENTS.has(event) || event === "Stop" || event === "SubagentStop")) {
      // The handler threw AND the error receipt could not persist: failing
      // open here would be silent twice over. Block the gated path instead.
      return receiptFailureBlock(event, input);
    }
    return undefined;
  } finally {
    clearInterval(poll);
    clearTimeout(deadline);
    deps.signal?.removeEventListener("abort", forwardAbort);
  }
}

export function newDecisionId(): string {
  return randomUUID();
}

/**
 * Hook deadline expired before the judgment settled. Recorded as a typed
 * `HOOK_DEADLINE_EXCEEDED` error receipt — never a silent exit, never a
 * fabricated "did not judge". Fail-open: the caller returns no host output.
 * The detached judgment may still land its own receipt afterwards; both
 * records carry the same decisionId so they correlate.
 */
export function recordDeadlineExceeded(
  ledger: EvidenceLedger,
  event: string,
  input: HookInput,
  budgetMs: number,
): boolean {
  const now = Date.now();
  const decisionId = decisionIdFor(event, input);
  const reasons = [judgmentReason("HOOK_DEADLINE_EXCEEDED")];
  const ok = ledger.append(
    {
      schema: 1,
      id: randomUUID(),
      ts: new Date(now).toISOString(),
      sessionId: input.session_id ?? "unknown",
      ...lifecycleAttribution(event, input),
      decisionId,
      ...(typeof input.tool_use_id === "string" && input.tool_use_id !== "" ? { toolUseId: input.tool_use_id } : {}),
      event,
      subjectHash: hashSubject(subjectFor(event, input)),
      policyVersion: UNIFIED_POLICY_VERSION,
      judgment: "HOOK_DEADLINE_EXCEEDED",
      deterministicFindings: [],
      enforcement: "error",
      reasons,
      latencyMs: budgetMs,
      error: "hook_deadline_exceeded",
    },
    { durable: true },
  );
  if (!ok) {
    console.error(`[jeverb] evidence receipt write failed (event=${event} enforcement=error)`);
  }
  return ok;
}

/**
 * Model-construction failure at an event boundary (`buildDeps` threw before
 * dispatch). The ledger is built independently of the model, so the failure
 * is recorded as a typed `model_init_error` receipt — never a silent exit.
 * Fail-open: the caller returns no host output after recording.
 */

export function recordInitError(
  ledger: EvidenceLedger,
  event: string,
  input: HookInput,
  error: unknown,
): boolean {
  const now = Date.now();
  // appendReceipt prefixes `${name}:`, so wrap only the message text. The
  // receipt carries the machine-readable MODEL_INITIALIZATION_ERROR outcome;
  // the human line keeps the judgmentReason wording.
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`[model_init_error] ${redact(message).slice(0, 500)}`);
  if (error instanceof Error) wrapped.name = error.name;
  const decision: UnifiedDecision = {
    event,
    enforcement: "error",
    source: "deterministic",
    reasons: [judgmentReason("MODEL_INITIALIZATION_ERROR")],
    evidence: [],
    judgment: "MODEL_INITIALIZATION_ERROR",
    policyVersion: UNIFIED_POLICY_VERSION,
    decisionId: decisionIdFor(event, input),
  };
  return appendReceipt(ledger, decision, event, input, now, now, wrapped);
}

/** Durable, sanitized failure receipt when a hook event cannot be parsed. */
export function recordInputFailure(ledger: EvidenceLedger, event: string, error: unknown): boolean {
  const now = Date.now();
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const decision: UnifiedDecision = {
    event,
    enforcement: "error",
    source: "deterministic",
    reasons: ["hook input could not be read or parsed; no judgment ran"],
    evidence: [],
    policyVersion: UNIFIED_POLICY_VERSION,
    decisionId: newDecisionId(),
  };
  const wrapped = new Error(`[hook_input_error] ${redact(message).slice(0, 500)}`);
  return appendReceipt(ledger, decision, event, {}, now, now, wrapped);
}

/** Durable failure receipt when a handler throws before returning a verdict. */
export function recordRuntimeFailure(
  ledger: EvidenceLedger,
  event: string,
  input: HookInput,
  error: unknown,
): boolean {
  const now = Date.now();
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  const decision: UnifiedDecision = {
    event,
    enforcement: "error",
    source: "deterministic",
    reasons: ["hook handler failed before returning a verdict"],
    evidence: [],
    policyVersion: UNIFIED_POLICY_VERSION,
    decisionId: decisionIdFor(event, input),
  };
  const wrapped = new Error(`[hook_runtime_error] ${redact(`${name}: ${message}`).slice(0, 500)}`);
  wrapped.name = name;
  return appendReceipt(ledger, decision, event, input, now, now, wrapped);
}

/** Durable denial receipt for a protected Muse commit when Jev cannot initialize. */
export function recordProtectedInitDeny(
  ledger: EvidenceLedger,
  event: string,
  input: HookInput,
  error: unknown,
): boolean {
  const now = Date.now();
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  const decision: UnifiedDecision = {
    event,
    enforcement: "deny",
    source: "deterministic",
    reasons: [`[jev] model initialization failed (${name}); refusing protected commit`],
    evidence: [],
    judgment: "MODEL_INITIALIZATION_ERROR",
    policyVersion: UNIFIED_POLICY_VERSION,
    decisionId: decisionIdFor(event, input),
  };
  const wrapped = new Error(`[model_init_error] ${redact(message).slice(0, 500)}`);
  wrapped.name = name;
  return appendReceipt(ledger, decision, event, input, now, now, wrapped);
}
