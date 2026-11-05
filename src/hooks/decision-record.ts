/**
 * Decision-record shape and prompt helpers for the hooks gate.
 *
 * Leaf module: only a type reference to `tripwire.ts` (erased at runtime),
 * so the runtime direction stays one-way. `store.ts` re-exports these so
 * existing `hooks/store.js` importers keep working; handlers import from
 * here directly.
 */

import type { TripSource } from "./tripwire.js";

/** Maximum substantive prompts kept per session, oldest first. */
export const MAX_PROMPTS = 3;
export const MAX_PROMPT_CHARS = 2000;
/**
 * Below this a prompt is a continuation — "go", "ship both", "try it now". It
 * is kept, because "make it public" is an authorization the gate should see,
 * but it carries almost no scope and must not evict the request it continues.
 */
export const SHORT_PROMPT_CHARS = 40;
export const MAX_SHORT_PROMPTS = 2;

/**
 * Append a prompt, trimming short and substantive prompts separately. Order is
 * preserved.
 *
 * An identical consecutive prompt is dropped. In 0.4.0 `UserPromptSubmit` has
 * both an http entry and a command fallback, and the fallback is supposed to
 * notice the daemon answered and exit — but if it ever double-fires, the only
 * visible effect should be nothing at all, rather than the same sentence
 * occupying two of the three prompt slots and evicting the request before it.
 */
export function nextPrompts(existing: readonly string[], prompt: string): string[] {
  const text = prompt.trim();
  if (text === "") return [...existing];
  if (existing[existing.length - 1] === text) return [...existing];
  const all = [...existing, text];
  const isShort = (p: string): boolean => p.length < SHORT_PROMPT_CHARS;
  let short = all.filter(isShort).length;
  let long = all.length - short;
  return all.filter((p) => {
    if (isShort(p)) {
      if (short > MAX_SHORT_PROMPTS) {
        short -= 1;
        return false;
      }
      return true;
    }
    if (long > MAX_PROMPTS) {
      long -= 1;
      return false;
    }
    return true;
  });
}

/**
 * The user's request as one string within `max` characters. The budget is
 * filled from the newest prompt backwards, so what gets cut is the oldest
 * context and never the instruction the user just gave.
 */
export function requestText(prompts: readonly string[], max: number, separator = "\n---\n"): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = prompts.length - 1; i >= 0; i -= 1) {
    const prompt = prompts[i] as string;
    const cost = prompt.length + (kept.length > 0 ? separator.length : 0);
    if (used + cost > max) {
      if (kept.length === 0) kept.unshift(prompt.slice(0, max));
      break;
    }
    kept.unshift(prompt);
    used += cost;
  }
  return kept.join(separator);
}

export interface DecisionRecord {
  ts: string;
  session_id: string;
  event: string;
  tool_name?: string;
  tool_use_id?: string;
  /** Redacted, <= 300 chars. */
  subject?: string;
  prefilter?: string;
  signals?: Record<string, number>;
  /**
   * Policy options in force, so `/jev:calibrate` can replay the decision.
   *
   * Open-ended from 0.5.0: four events log a policy now, and pinning the
   * shape here meant a handler that recorded one more switch had to widen a
   * type in another module before the replay could read it.
   */
  policy?: Record<string, string | number | boolean>;
  /**
   * The thresholds the decision was actually made at, on every judged record.
   * Without them a replay has to assume the ones configured *now*, which is
   * wrong for exactly the log a threshold change is being judged on.
   */
  thresholds?: { auto: number; review: number; confidence: number };
  decision: string;
  reasons?: string[];
  /** 16 hex of the canonical action, so a trip and its re-issue can be paired. */
  fingerprint?: string;
  trip_id?: string;
  source?: TripSource;
  /** How the text reached its audience. `deny` and `ask` are pre-execution. */
  channel?: "note" | "deny" | "ask";
  /** The exact text handed to the agent, redacted and clamped. */
  emitted?: string;
  /** The agent's stated reason for a re-issue, redacted and clamped. */
  affirmation?: string;
  /** Why a note that the table called for was not emitted. */
  suppressed?: string;
  /** The firm reasons behind a note or a trip, in priority order. */
  firm?: string[];
  /** Gate: whether `wide` was decided on level probabilities or the expectation. */
  blast_source?: "probabilities" | "expectation";
  /**
   * Gate: what stood in for the user's request. `subagent_task` is the task a
   * parent handed this subagent; `none` means scope was ignored.
   */
  scope_source?: "prompts" | "subagent_task" | "none";
  /**
   * The `agent_type` this judgment happened inside, when it happened inside
   * one. Logged on every judged record so the subagent share of the gate's
   * output is measurable rather than a guess.
   */
  subagent?: string;
  /** Stop: which of the three unfinished Nouls fired. */
  unfinished_by?: string;
  /** PostToolUse: how the result was chunked, and how much of it was judged. */
  chunks_total?: number;
  chunks_judged?: number;
  chunks_failed?: number;
  /** Which 0.6.0 subsystem wrote this record; absent means the gate. */
  kind?: "gate" | "lint" | "commit" | "claims";
  /** lint/commit: the firm finding ids (conventions as `conv:<text>`). */
  findings?: string[];
  /** lint/commit: the redacted relative path of the edited file. */
  file?: string;
  /** Stop claims: the counts and the newest few items. */
  claims?: {
    extracted: number;
    fabricated: number;
    contradicted: number;
    supported: number;
    not_addressed: number;
    unlocated: number;
    items: { claim: string; verdict: string; p?: number | undefined }[];
  };
  model?: string;
  latency_ms?: number;
  input_tokens?: number;
  /**
   * The daemon answered this from its in-memory cache: no call went out, so
   * `latency_ms` and `input_tokens` are both 0 and mean it.
   */
  memo?: boolean;
  error?: string;
  /** Stop: the session read failed, so verification ran against an empty ledger. */
  storeDegraded?: boolean;
  /** Stop: the store failure kind behind `storeDegraded` (`corrupt` | `transient` | `unknown`). */
  storeDegradedReason?: string;
}

/**
 * The cost fields of a record, from a model result.
 *
 * One helper rather than four copies of the same three lines, because 0.4.0
 * added a fourth field — `memo` — and a handler that forgot it would report a
 * cached answer as a 0 ms, 0 token real call, which is the one thing the memo
 * must never be allowed to do to the log.
 */
export function modelCost(result: {
  model: string;
  latency_ms: number;
  usage: { input_tokens: number };
  memo?: boolean;
}): Pick<DecisionRecord, "model" | "latency_ms" | "input_tokens" | "memo"> {
  return {
    model: result.model,
    latency_ms: result.latency_ms,
    input_tokens: result.usage.input_tokens,
    ...(result.memo === true ? { memo: true } : {}),
  };
}
