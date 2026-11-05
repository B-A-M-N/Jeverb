/**
 * PreToolUse: the advisory gate.
 *
 * Three outcomes, and the difference between them is the whole design:
 *
 *  - **silent** — the common case. No output, no prompt, often no model call.
 *  - **note** — `additionalContext`, which Claude Code delivers *next to the
 *    tool result*, i.e. after the call ran. A note is therefore information for
 *    the agent's next decision, never a gate. It says what was scored and
 *    stops.
 *  - **trip** — `deny`. The only thing here that acts before execution. The
 *    text rides in `permissionDecisionReason`, because `additionalContext` is
 *    dropped when the call is blocked. The agent may re-issue the identical
 *    call with an affirmation marker and it passes without further judgment.
 *
 * Nobody is prompted. `permissionDecision: "ask"` is reachable only through the
 * explicit `ask_on_trip` setting, and `"allow"` is not representable at all.
 *
 * Order matters: prefilter, then the tripwire, then judgment. The prefilter
 * keeps the model off `ls`; the tripwire answers a re-issue without spending a
 * call on a question it already asked.
 */

import { createHash } from "node:crypto";
import { gateOutcome, bands, NOTE_DEDUPE_TTL_MS } from "../advisory.js";
import {
  runGateAction,
  type GateAction,
  type GateActionCoreResult,
  type GateContext,
  type GateRequest,
} from "../../tools/gate-action-core.js";
import { FILE_TOOLS, prefilter, SPAWN_TOOLS, structuredAction } from "../prefilter.js";
import { parseMcpSkipAllowlist } from "../mcp-policy.js";
import { handleLint } from "./lint.js";
import { handleCommit, isGitCommit } from "./commit.js";
import { compactJson, redact, redactAndClamp } from "../redact.js";
import { modelCost, MAX_PROMPT_CHARS } from "../decision-record.js";
import type { DecisionRecord } from "../decision-record.js";
import { fingerprint, tripIdOf, MAX_REASON_CHARS, type Trip } from "../tripwire.js";
import {
  JevAuthError,
  JevConnectionError,
  JevForbiddenError,
  JevOverloadedError,
  JevProtocolError,
  JevProviderHttpError,
  JevQuotaError,
  JevRateLimitError,
  JevTimeoutError,
  JevValidationError,
} from "../../jev/errors.js";
import type { JudgmentOutcome } from "../../decision/types.js";
import { providerHealthRecordQuotaFailure, providerHealthRecordSuccess, providerHealthShouldSkip, providerHealthStatus } from "../../jev/provider-health.js";
import {
  actionSubject,
  blastLabel,
  modelTripText,
  noteText,
  patternTripText,
  tripRepeatText,
  MAX_EMITTED_CHARS,
} from "../wording.js";
import type { Deps, HookInput, HookOutput } from "../types.js";
import { noteOutput, tripChannel, tripOutput } from "./response.js";

/** Longest tool input we will pay to have judged. */
const MAX_ACTION_CHARS = 4000;
/** The free-text fields of the judged action, longest-lived first. */
const ACTION_TEXT_FIELDS = ["command", "content_head", "old_string", "new_string", "text"] as const;
/** Longest `subject` written to the decision log. */
const MAX_LOG_SUBJECT_CHARS = 300;
/** Test-visible derivation of the shared circuit key for the active config. */
export function providerHealthKey(config: Deps["config"]) {
  return {
    backend: config.backend,
    model: config.model,
    generation: createHash("sha256").update(`${config.baseUrl}\n${config.timeoutMs}\n${config.maxRetries}`).digest("hex").slice(0, 16),
    credentialIdentity: createHash("sha256").update(config.apiKey ?? "gateway-managed").digest("hex").slice(0, 16),
    stateDir: config.dataDir,
  };
}

/**
 * Classify an inference failure into a typed judgment outcome. The wire stays
 * silent and enforcement stays fail-open; only the receipt names the class.
 */
export function classifyJudgmentError(error: unknown, hookDeadlineExpired = false): JudgmentOutcome {
  // A handler-owned abort often surfaces from fetch as a generic AbortError
  // (or its reason), not as JevTimeoutError. Preserve the existing caller
  // cancellation contract while classifying this configured hook deadline
  // as the timeout it actually is.
  if (hookDeadlineExpired) return "JUDGMENT_TIMEOUT";
  if (error instanceof JevRateLimitError) return "RATE_LIMITED";
  if (error instanceof JevQuotaError) return "QUOTA_EXHAUSTED";
  if (error instanceof JevForbiddenError || error instanceof JevProviderHttpError) return "PROVIDER_FORBIDDEN";
  if (error instanceof JevAuthError) return "AUTH_FAILURE";
  // Overloaded is a capacity failure on the provider path, not quota.
  if (error instanceof JevConnectionError || error instanceof JevOverloadedError) return "NETWORK_FAILURE";
  // The caller's own abort races the same budget as a provider timeout.
  if (error instanceof JevTimeoutError) return "JUDGMENT_TIMEOUT";
  if (error instanceof JevProtocolError || error instanceof JevValidationError) return "INVALID_MODEL_RESPONSE";
  return "JUDGMENT_ATTEMPTED";
}

/**
 * Provenance for the unified receipt path: which model judged, and the
 * per-signal probabilities behind the verdict. Attached to every
 * judgment-backed HookOutput (including the silent allow) and stripped
 * before anything reaches a host.
 */
function judgmentProvenance(result: GateActionCoreResult): NonNullable<HookOutput["jev"]> {
  return { model: result.model, probabilities: { ...result.signals } };
}

/**
 * Redact every string in the judged action, and keep the whole of it inside
 * `max`.
 *
 * The per-field caps in `structuredAction` already bound each tool's own
 * shape; this is the guard that holds whatever mix of fields a future tool
 * populates, trimming the longest-lived fields first in one pass.
 */
function boundAction(action: GateAction, max: number): GateAction {
  const out: GateAction = { ...action, target_paths: [...action.target_paths] };
  for (const field of ACTION_TEXT_FIELDS) {
    const value = out[field];
    if (typeof value === "string") out[field] = redactAndClamp(value, max);
  }
  if (out.input !== undefined) out.input = JSON.parse(redact(compactJson(out.input))) as typeof out.input;
  out.target_paths = out.target_paths.map((path) => redact(path));

  let over = compactJson(out).length - max;
  for (const field of ACTION_TEXT_FIELDS) {
    if (over <= 0) break;
    const value = out[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const keep = Math.max(0, value.length - over);
    over -= value.length - keep;
    out[field] = value.slice(0, keep);
  }
  return out;
}

/**
 * The user's request, split into the one that is current and the ones before
 * it, within a total character budget.
 *
 * Filled from the newest backwards, like `requestText` before it: what gets
 * cut is the oldest context and never the instruction the user just gave.
 */
export function gateRequest(prompts: readonly string[], max: number): GateRequest {
  const latest = redactAndClamp(prompts[prompts.length - 1] ?? "", max);
  const previous: string[] = [];
  let used = latest.length;
  for (let index = prompts.length - 2; index >= 0; index -= 1) {
    const room = max - used;
    if (room <= 0) break;
    previous.unshift(redactAndClamp(prompts[index] as string, room));
    used += (previous[0] as string).length;
  }
  return { latest, previous };
}

export async function handlePreToolUse(input: HookInput, deps: Deps): Promise<HookOutput | undefined> {
  const { config, store } = deps;
  if (config.gate === "off") return undefined;

  const sessionId = input.session_id ?? "unknown";
  const toolName = input.tool_name;
  if (toolName === undefined || toolName === "") return undefined;
  if (store.isDisabled(sessionId)) return undefined;

  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const cwd = input.cwd ?? process.cwd();
  const verdict = prefilter({
    toolName,
    toolInput,
    cwd,
    strict: config.gate === "strict",
    mcpSkipAllowlist: parseMcpSkipAllowlist(process.env.JEV_MCP_SKIP),
  });
  /** Marker text is never part of the action: not for the hash, not for Jev. */
  const action = verdict.stripped ?? toolInput;
  const marker = verdict.marker;
  const now = deps.now();

  const base = {
    ts: new Date(now).toISOString(),
    session_id: sessionId,
    event: input.hook_event_name === "PermissionRequest" ? "PermissionRequest" : "PreToolUse",
    tool_name: toolName,
    subject: redactAndClamp(`${toolName} ${compactJson(action)}`, MAX_LOG_SUBJECT_CHARS),
    prefilter: verdict.reason,
  } satisfies Partial<DecisionRecord> & { ts: string; session_id: string; event: string };

  // A `true # jev:intended t-…: <reason>` call: the sidecar affirmation, which
  // is how a Write, an Edit or an MCP call answers a tripwire. It emits nothing.
  if (verdict.kind === "affirm") {
    if (marker?.reason === undefined) {
      store.append({ ...base, decision: "marker-short" });
      return undefined;
    }
    const affirmation = redactAndClamp(marker.reason, MAX_REASON_CHARS);
    const trip = marker.trip_id === undefined ? undefined : store.findTripById(sessionId, marker.trip_id, now);
    if (trip === undefined) {
      store.append({ ...base, decision: "affirm-unmatched", affirmation, ...(marker.trip_id !== undefined ? { trip_id: marker.trip_id } : {}) });
      return undefined;
    }
    store.affirmTrip(sessionId, trip.id, affirmation, now);
    store.append({ ...base, decision: "affirm", trip_id: trip.id, fingerprint: trip.fingerprint, affirmation });
    return undefined;
  }

  // A subagent spawn. Bookkeeping only: the parent's `prompt` here is the task
  // the subagent is about to work on, and without it every call that subagent
  // makes is judged against what the *user* last asked for — which is how four
  // of the five model trips in the first live week happened.
  if (SPAWN_TOOLS.has(toolName)) {
    const agentType = toolInput.subagent_type;
    const prompt = toolInput.prompt;
    if (typeof agentType === "string" && agentType !== "" && typeof prompt === "string" && prompt !== "") {
      store.rememberSubagentTask(
        sessionId,
        {
          agent_type: agentType,
          prompt: redactAndClamp(prompt, MAX_PROMPT_CHARS),
          ts: now,
          ...(input.tool_use_id === undefined ? {} : { spawn_tool_use_id: input.tool_use_id }),
        },
        now,
      );
    }
    return undefined;
  }

  // An in-project file write is a skip for the gate (it destroys nothing and
  // reaches nowhere) but the place the semantic lint runs. It has its own
  // trip lifecycle, sharing the fingerprint and the sidecar affirmation.
  if (verdict.kind === "skip") {
    deps.judgment = { outcome: verdict.writesInProject === true ? "SKIPPED_IN_PROJECT" : "SKIPPED_READ_ONLY" };
    if (verdict.writesInProject === true && FILE_TOOLS.has(toolName) && config.lint !== "off") {
      return handleLint(input, deps, action, base, now);
    }
    return undefined;
  }

  const fp = fingerprint(toolName, action);
  const open = store.findTripByFingerprint(sessionId, fp, now);

  // A marker shorter than the minimum is treated as absent — and counted, so
  // `/jev:calibrate` can show a reflex forming rather than guess at one.
  if (marker?.short === true) {
    store.append({ ...base, decision: "marker-short", fingerprint: fp, ...(open !== undefined ? { trip_id: open.id } : {}) });
  }

  if (open !== undefined) {
    const affirmation = marker?.reason ?? open.affirmation;
    if (affirmation !== undefined) {
      // Row 3: affirmed. No judging, no model call, nothing on stdout.
      store.closeTrip(sessionId, open.id, now);
      store.append({
        ...base,
        decision: "reissue",
        trip_id: open.id,
        fingerprint: fp,
        source: open.source,
        affirmation: redactAndClamp(affirmation, MAX_REASON_CHARS),
        ...(input.tool_use_id !== undefined ? { tool_use_id: input.tool_use_id } : {}),
      });
      if (input.tool_use_id !== undefined) {
        store.rememberReissue(sessionId, {
          tool_use_id: input.tool_use_id,
          ts: now,
          tool_name: toolName,
          trip_id: open.id,
        });
      }
      return undefined;
    }

    // Row 4: the same call again, still without a reason.
    // The deny below is already decided: a bookkeeping failure (for
    // example lock contention with a concurrent hook) must not flip it
    // to an allow. Count best-effort and deny regardless.
    let attempt = open.denies + 1;
    try {
      attempt = store.repeatTrip(sessionId, open.id, now);
    } catch (error) {
      console.error(`[jeverb] trip bookkeeping failed (repeat session=${sessionId}); denying anyway: ${error instanceof Error ? error.message : String(error)}`);
    }
    const channel = tripChannel(config.askOnTrip, input.permission_mode, deps.authorizationHost);
    const text = tripRepeatText({ id: open.id, attempt, seconds: (now - open.ts) / 1000 });
    store.append({
      ...base,
      decision: "trip-repeat",
      trip_id: open.id,
      fingerprint: fp,
      source: open.source,
      channel,
      emitted: redactAndClamp(text, MAX_EMITTED_CHARS),
    });
    return tripOutput(channel, text);
  }

  // A `git commit` with nothing open against it: the commit-time lint. It runs
  // here, after the open-trip machinery, so an affirmed commit re-runs through
  // the same reissue path as any Bash trip.
  if (
    toolName === "Bash" &&
    config.lint !== "off" &&
    isGitCommit(typeof action.command === "string" ? action.command : undefined)
  ) {
    return handleCommit(input, deps, action.command as string, base, fp, now);
  }

  // Row 5: a marker on a call that was never tripped. It has already been
  // stripped out of `action`; all that is left is to say so in the log.
  if (marker?.reason !== undefined) {
    store.append({
      ...base,
      decision: "marker-unmatched",
      fingerprint: fp,
      affirmation: redactAndClamp(marker.reason, MAX_REASON_CHARS),
    });
  }

  if (verdict.kind === "escalate") {
    // Row 2: a code rule matched. Certain by construction; no model consulted.
    const id = tripIdOf(fp);
    const channel = tripChannel(config.askOnTrip, input.permission_mode, deps.authorizationHost);
    const text = patternTripText({ id, pattern: verdict.pattern, reason: verdict.reason });
    const trip: Trip = {
      id,
      fingerprint: fp,
      tool_name: toolName,
      ts: now,
      source: "pattern",
      pattern: verdict.pattern,
      reason: redactAndClamp(verdict.reason, MAX_REASON_CHARS),
      denies: 1,
    };
    // The deny below is already decided by the code rule: a bookkeeping
    // failure must not flip it to an allow. The trip simply re-opens on
    // the next matching call.
    try {
      store.openTrip(sessionId, trip, now);
    } catch (error) {
      console.error(`[jeverb] trip bookkeeping failed (open session=${sessionId}); denying anyway: ${error instanceof Error ? error.message : String(error)}`);
    }
    store.append({
      ...base,
      decision: "trip",
      trip_id: id,
      fingerprint: fp,
      source: "pattern",
      channel,
      reasons: [verdict.reason],
      emitted: redactAndClamp(text, MAX_EMITTED_CHARS),
      ...(input.tool_use_id !== undefined ? { tool_use_id: input.tool_use_id } : {}),
    });
    return tripOutput(channel, text);
  }

  // Row 6: from here on a judgment is needed. No model means no opinion.
  if (deps.model === null) {
    deps.judgment = { outcome: "MODEL_NOT_CONFIGURED" };
    return undefined;
  }

  // Quota circuit: repeated quota/forbidden failures skip inference while
  // deterministic hooks keep operating. Bounded probes may re-close it.
  const healthKey = providerHealthKey(config);
  if (providerHealthShouldSkip(healthKey)) {
    // Degraded-mode allow: fail open, but never silent in the log and never
    // shaped like a verified approval. The store record names the
    // suppression and carries the circuit counts and window; the wire stays
    // silent (undefined, no `jev` provenance) so the unified dispatcher
    // files an advisory `QUOTA_EXHAUSTED` receipt instead of a Jev `allow`.
    const circuit = providerHealthStatus(healthKey);
    const consecutiveFailures = Math.max(circuit.consecutiveQuotaFailures, 1);
    store.append({
      ...base,
      decision: "silent-quota-suppressed",
      fingerprint: fp,
      suppressed: "quota-suppressed",
      policy: {
        degraded_mode: true,
        consecutive_quota_failures: consecutiveFailures,
        quota_window_ms: 5 * 60 * 1000,
        quota_circuit_open: circuit.openedAt !== null,
      },
      reasons: [
        `judgment skipped: provider quota exhausted, circuit open after ${consecutiveFailures} consecutive failures; ` +
          `degraded-mode allow, not a verified approval; deterministic policy applies`,
      ],
      model: config.model,
      ...(input.tool_use_id !== undefined ? { tool_use_id: input.tool_use_id } : {}),
    });
    deps.judgment = { outcome: "QUOTA_EXHAUSTED" };
    return undefined;
  }

  // A degraded session read (corrupt/truncated file) falls back to an empty
  // session, whose empty prompts would silently enable `ignoreScope` below.
  // The allow/ask/deny outcome is unchanged, but the decision record names
  // the degradation (mirroring handlers/stop.ts), so a scope-blind judgment
  // is distinguishable from "nothing was ever recorded".
  const sessionHealth = store.readSessionDetailed(sessionId);
  const session = sessionHealth.session;

  /**
   * What stands in for the user's request.
   *
   * Inside a subagent it is the task the parent handed it, not the user's last
   * prompt — judging a subagent's work against a prompt it never saw is what
   * made every instrumental file rewrite read as out of scope. When two
   * same-type subagents are running there is no way to tell which one is
   * calling, so scope is ignored rather than judged against the wrong task.
   */
  const subagent = input.agent_type;
  const task = subagent === undefined ? undefined : store.takeSubagentTask(sessionId, subagent, now);
  const userRequest: GateRequest | undefined =
    task !== undefined
      ? {
          latest: task.prompt,
          previous: session.prompts.length > 0 ? [redactAndClamp(session.prompts[session.prompts.length - 1] as string, MAX_ACTION_CHARS)] : [],
        }
      : subagent !== undefined
        ? undefined
        : session.prompts.length > 0
          ? gateRequest(session.prompts, MAX_ACTION_CHARS)
          : undefined;
  const knownRequest = userRequest !== undefined;
  const scopeSource: NonNullable<DecisionRecord["scope_source"]> =
    task !== undefined ? "subagent_task" : knownRequest ? "prompts" : "none";

  const context: GateContext = { cwd };
  if (subagent !== undefined) context.subagent = subagent;
  if (input.permission_mode !== undefined) context.permission_mode = input.permission_mode;

  const strict = config.gate === "strict";
  const policyOptions = {
    ignoreScope: !knownRequest,
    uncertain: strict ? ("confirm" as const) : ("risky-lean" as const),
    // Strict mode keeps every reason to speak up. Advisory mode drops the three
    // that fire on ordinary, requested work.
    lenientScope: !strict,
    trustRequested: !strict,
    corroborateUncertain: !strict,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const result = await runGateAction(
      deps.model,
      {
        action: boundAction(structuredAction(toolName, action, cwd), MAX_ACTION_CHARS),
        user_request: userRequest ?? { latest: "(unknown)", previous: [] },
        context,
        policy: policyOptions,
      },
      {
        model: config.model,
        thresholds: { auto: config.autoThreshold, review: config.reviewThreshold },
        maxConcurrency: 1,
      },
      controller.signal,
    );
    providerHealthRecordSuccess(healthKey);

    const { scope } = result;
    const signals = {
      ...result.signals,
      blast_radius: result.blast_radius.score,
      scope_unrelated: scope.unrelated,
      scope_step: scope.step,
      scope_requested: scope.requested,
      mentions_target: scope.mentions_target,
      same_task_area: scope.same_task_area,
      ...(result.blast_radius.p_high !== undefined ? { blast_p_high: result.blast_radius.p_high } : {}),
    };
    const record: DecisionRecord = {
      ...base,
      decision: result.decision,
      fingerprint: fp,
      signals,
      policy: {
        ignore_scope: policyOptions.ignoreScope,
        uncertain: policyOptions.uncertain,
        lenient_scope: policyOptions.lenientScope,
        trust_requested: policyOptions.trustRequested,
        corroborate_uncertain: policyOptions.corroborateUncertain,
      },
      thresholds: {
        auto: result.thresholds.auto,
        review: result.thresholds.review,
        confidence: config.confidenceThreshold,
      },
      blast_source: result.blast_radius.source,
      scope_source: scopeSource,
      // A degraded session read leaves the outcome unchanged but must never
      // be silent in the log: without this, `ignore_scope: true` on a corrupt
      // session file is indistinguishable from a genuinely promptless one.
      ...(sessionHealth.degraded
        ? { storeDegraded: true, storeDegradedReason: sessionHealth.reason ?? "unknown" }
        : {}),
      ...(subagent !== undefined ? { subagent } : {}),
      reasons: result.reasons,
      ...modelCost(result),
    };
    if (input.tool_use_id !== undefined) record.tool_use_id = input.tool_use_id;

    const outcome = gateOutcome({
      decision: result.decision,
      signals: result.signals,
      blast_radius: result.blast_radius.score,
      ...(result.blast_radius.p_high !== undefined ? { blast_p_high: result.blast_radius.p_high } : {}),
      mentions_target: scope.mentions_target,
      thresholds: result.thresholds,
      strict,
      duplicate: store.wasNoted(sessionId, fp, NOTE_DEDUPE_TTL_MS, now),
      notes_this_prompt: session.notes_this_prompt ?? 0,
    });
    const firm: string[] = [...outcome.firm];
    /** How many requests the scope judgment actually had to read. */
    const prompts = userRequest === undefined ? 0 : 1 + userRequest.previous.length;

    if (outcome.outcome === "trip") {
      const id = tripIdOf(fp);
      const channel = tripChannel(config.askOnTrip, input.permission_mode, deps.authorizationHost);
      const text = modelTripText({
        id,
        tool: toolName,
        signals: result.signals,
        prompts,
        p_unrelated: scope.unrelated,
        sidecar: toolName !== "Bash",
      });
      store.openTrip(
        sessionId,
        {
          id,
          fingerprint: fp,
          tool_name: toolName,
          ts: now,
          source: "model",
          reason: redactAndClamp(result.reasons.slice(0, 2).join(" "), MAX_REASON_CHARS),
          signals,
          denies: 1,
        },
        now,
      );
      store.append({
        ...record,
        decision: "trip",
        trip_id: id,
        source: "model",
        channel,
        firm,
        emitted: redactAndClamp(text, MAX_EMITTED_CHARS),
      });
      deps.judgment = { outcome: "JUDGMENT_SUCCEEDED" };
      return { ...tripOutput(channel, text), jev: judgmentProvenance(result) };
    }

    if (outcome.outcome === "note") {
      const { requestedish } = bands({
        signals: result.signals,
        blast_radius: result.blast_radius.score,
        ...(result.blast_radius.p_high !== undefined ? { blast_p_high: result.blast_radius.p_high } : {}),
        mentions_target: scope.mentions_target,
        thresholds: result.thresholds,
      });
      const text = noteText({
        tool: toolName,
        subject: actionSubject(toolName, action),
        signals: result.signals,
        blast: {
          label: blastLabel(result.blast_radius.level),
          p_level: result.blast_radius.p_level,
          p_high: result.blast_radius.p_high,
        },
        prompts,
        scope: {
          requestedish,
          p_unrelated: scope.unrelated,
          mentions_target: scope.mentions_target,
        },
        firm: outcome.firm,
      });
      store.noteEmitted(sessionId, fp, now);
      store.append({
        ...record,
        decision: "note",
        channel: "note",
        firm,
        emitted: redactAndClamp(text, MAX_EMITTED_CHARS),
      });
      deps.judgment = { outcome: "JUDGMENT_SUCCEEDED" };
      return { ...noteOutput(text), jev: judgmentProvenance(result) };
    }

    // Silent on the wire, but attributed in the ledger: the judgment ran and
    // allowed, which is not the same as no judgment running at all. The
    // unified mapper turns this marker into an allow receipt; host mappers
    // stay silent and the Claude writer strips the internal field.
    const suppressed = outcome.suppressed ?? "allow";
    store.append({
      ...record,
      decision: suppressed === "allow" ? "allow" : `silent-${suppressed}`,
      suppressed,
      ...(firm.length > 0 ? { firm } : {}),
    });
    deps.judgment = { outcome: "JUDGMENT_SUCCEEDED" };
    return { jev: judgmentProvenance(result) };
  } catch (error) {
    const outcome = classifyJudgmentError(error, controller.signal.aborted);
    // Feed the shared quota circuit; never persist secrets or raw bodies.
    if (outcome === "QUOTA_EXHAUSTED" || outcome === "PROVIDER_FORBIDDEN") {
      providerHealthRecordQuotaFailure(healthKey);
    }
    const jevError = error as { status?: unknown; body?: unknown };
    const httpStatus = typeof jevError.status === "number" ? jevError.status : undefined;
    const bodyRecord = (typeof jevError.body === "object" && jevError.body !== null ? jevError.body : {}) as Record<string, unknown>;
    const providerErrorCode = typeof bodyRecord.providerErrorCode === "string" ? bodyRecord.providerErrorCode.slice(0, 64) : undefined;
    const diagnosticSuffix = [
      httpStatus !== undefined ? `httpStatus=${httpStatus}` : "",
      providerErrorCode !== undefined ? `providerErrorCode=${providerErrorCode}` : "",
      `backend=${config.backend}`,
      `model=${config.model}`,
    ].filter((part) => part !== "").join(" ");
    store.append({
      ...base,
      decision: "error",
      fingerprint: fp,
      error: `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}${diagnosticSuffix ? ` [${diagnosticSuffix}]` : ""}`,
      model: config.model,
      ...(input.tool_use_id !== undefined ? { tool_use_id: input.tool_use_id } : {}),
    });
    deps.judgment = { outcome };
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
