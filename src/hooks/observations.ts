/**
 * Post-execution observation domain: exactly-once claims, re-issue
 * correlations, and stop-intervention claims.
 *
 * Vocabulary plus pure transaction bodies; `Store` runs these inside its
 * session lock and keeps the outcome mapping, logging, and read fallbacks.
 * Only type references to `store.ts` (erased at runtime), so the runtime
 * direction stays one-way. `store.ts` re-exports the vocabulary for
 * existing importers.
 */

import { UNIFIED_POLICY_VERSION } from "../decision/types.js";
import type { SessionState } from "./store.js";

/** Pending re-issue correlations kept per session. */
const MAX_PENDING = 20;
/** Cap on remembered post-execution observations per session; oldest evicted first. */
export const MAX_PROCESSED_POSTS = 1000;
/**
 * A claimed observation stays deduped this long after the cap forces
 * eviction of older entries. Redeliveries arrive within seconds in
 * practice; evicting only entries older than this keeps a bounded store
 * from silently re-enabling duplicate folds of still-relevant events.
 */
const CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000;
export interface PendingReissue {
  tool_use_id: string;
  ts: number;
  tool_name: string;
  /** The trip the re-issue answered, when one is known. */
  trip_id?: string;
}
export type StopInterventionClaim = "claimed" | "duplicate" | "capped" | "error";
/**
 * One exactly-once claim on a post-execution observation. `key` covers
 * session (via the file), tool invocation, event class, and policy
 * version; `ts` bounds retention so the cap cannot silently re-enable a
 * duplicate fold of a still-relevant event.
 */
export interface ProcessedPost {
  key: string;
  ts: number;
}
/** Oldest-first eviction that never drops entries newer than retention. */
export function evictProcessedPosts(posts: readonly ProcessedPost[], now: number): ProcessedPost[] {
  if (posts.length <= MAX_PROCESSED_POSTS) return [...posts];
  const cutoff = now - CLAIM_RETENTION_MS;
  const evictable = posts.filter((p) => p.ts <= cutoff);
  const fresh = posts.filter((p) => p.ts > cutoff);
  const drop = Math.min(evictable.length, posts.length - MAX_PROCESSED_POSTS);
  const kept = [...evictable.slice(drop), ...fresh];
  // Absolute bound: a session that makes more calls than twice the cap
  // inside one retention window still cannot grow this list without
  // limit; the oldest entries go first, newest kept.
  const hardCap = 2 * MAX_PROCESSED_POSTS;
  return kept.length > hardCap ? kept.slice(kept.length - hardCap) : kept;
}

/**
 * Pure transaction bodies for the observation domain. Each takes the
 * current session state and returns the next state plus a value, or
 * `undefined` when the transaction asks for no write (already claimed).
 * `Store` runs these inside its session lock.
 */

/** Claim key: session (via the file) + tool invocation + policy version + scope. */
export function postObservationKey(toolUseId: string, scope: "state" | "receipt"): string {
  return `${UNIFIED_POLICY_VERSION}:${scope}:${toolUseId}`;
}

/** Transaction body for one stop-intervention claim. */
export function claimStopTx(
  state: SessionState,
  eventKey: string,
  cap: number,
  revisionKey?: string,
): { state: SessionState; value: "claimed" } | undefined {
  const claims = state.stop_interventions ?? [];
  if (claims.includes(eventKey)) return undefined;
  if (state.stop_blocks >= cap) return undefined;
  const revisions = state.stop_block_revisions ?? [];
  return {
    state: {
      ...state,
      stop_blocks: state.stop_blocks + 1,
      stop_interventions: [...claims, eventKey].slice(-64),
      ...(revisionKey === undefined ? {} : { stop_block_revisions: [...revisions, revisionKey].slice(-16) }),
    },
    value: "claimed" as const,
  };
}

/** Append a pending re-issue correlation, capping the list. */
export function applyRememberReissue(
  pending: readonly PendingReissue[] | undefined,
  reissue: PendingReissue,
): PendingReissue[] {
  return [...(pending ?? []), reissue].slice(-MAX_PENDING);
}

/** Transaction body claiming one post-execution observation. */
export function claimPostTx(
  key: string,
  now: number,
): (state: SessionState) => { state: SessionState; value: true } | undefined {
  return (state) => {
    const seen = state.processed_posts ?? [];
    if (seen.some((p) => p.key === key)) return undefined;
    return {
      state: { ...state, processed_posts: evictProcessedPosts([...seen, { key, ts: now }], now) },
      value: true,
    };
  };
}

/** Transaction body claiming an observation and folding its state update. */
export function foldPostTx(
  key: string,
  now: number,
  fold: (state: SessionState) => SessionState,
): (state: SessionState) => { state: SessionState; value: "folded" } | undefined {
  return (state) => {
    const seen = state.processed_posts ?? [];
    if (seen.some((p) => p.key === key)) return undefined;
    // One call: the fold runs once, and its result carries both the
    // state update and the claim into the same atomic write.
    const next = fold(state);
    return {
      state: {
        ...next,
        processed_posts: evictProcessedPosts([...(next.processed_posts ?? seen), { key, ts: now }], now),
      },
      value: "folded" as const,
    };
  };
}

/** Transaction body consuming one pending re-issue. */
export function takeReissueTx(
  toolUseId: string,
): (state: SessionState) => { state: SessionState; value: PendingReissue } | undefined {
  return (state) => {
    const pending = state.pending_reissues ?? [];
    const found = pending.find((p) => p.tool_use_id === toolUseId);
    if (found === undefined) return undefined;
    return {
      state: { ...state, pending_reissues: pending.filter((p) => p.tool_use_id !== toolUseId) },
      value: found,
    };
  };
}
