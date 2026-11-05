/**
 * Shared provider-health circuit for short-lived hook processes.
 *
 * When `stateDir` is supplied, hook workers coordinate through one locked,
 * atomically replaced record. Its sibling temps use the shared maintenance
 * reaper's `<base>.<pid>.<millis>.<random>.tmp` contract and are removed on
 * handled write/rename failures. Without it the in-memory mode remains useful
 * for isolated callers and unit tests. Persisted keys contain only a digest
 * of backend/model/credential/configuration identity, never provider secrets.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ProviderHealthKey {
  backend: string;
  model: string;
  generation?: string | number;
  credentialIdentity?: string;
  stateDir?: string;
}

export interface ProviderHealthOptions {
  /** Consecutive quota/forbidden failures before the circuit opens. */
  openAfter?: number;
  /** How long an open circuit stays open before a probe may be claimed. */
  openMs?: number;
  /** Time window in which one process owns the recovery probe. */
  probeLeaseMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
}

const DEFAULT_OPEN_AFTER = 3;
const DEFAULT_OPEN_MS = 5 * 60 * 1000;
const DEFAULT_PROBE_LEASE_MS = 30 * 1000;
const LOCK_WAIT_MS = 1000;
const LOCK_STALE_MS = 30 * 1000;

interface CircuitState {
  consecutiveQuotaFailures: number;
  openedAt: number | null;
  probeClaimedAt: number | null;
}

type StateMap = Record<string, CircuitState>;
const circuits = new Map<string, CircuitState>();

function keyFor(key: ProviderHealthKey): string {
  return createHash("sha256")
    .update(`${key.backend}\n${key.model}\n${key.credentialIdentity ?? ""}\n${key.generation ?? ""}`, "utf8")
    .digest("hex");
}

function freshState(): CircuitState {
  return { consecutiveQuotaFailures: 0, openedAt: null, probeClaimedAt: null };
}

function loadMap(path: string): StateMap {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return value as StateMap;
  } catch {
    return {};
  }
}

function withPersistentState<T>(
  key: ProviderHealthKey,
  mutate: (state: CircuitState) => { state: CircuitState; result: T; persist: boolean; delete?: boolean },
): T {
  const dir = key.stateDir;
  if (dir === undefined) {
    const id = keyFor(key);
    const current = circuits.get(id) ?? freshState();
    const changed = mutate(current);
    if (changed.persist) circuits.set(id, changed.state);
    else if (changed.delete) circuits.delete(id);
    return changed.result;
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "provider-health.json");
  const lockPath = `${path}.lock`;
  const started = Date.now();
  let lockFd: number | undefined;
  while (lockFd === undefined) {
    try {
      lockFd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch {
        // The lock disappeared between the failed create and stat.
      }
      if (Date.now() - started >= LOCK_WAIT_MS) {
        // A busy health record must fail safe by suppressing inference.
        throw new Error("provider health state lock timeout");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }

  try {
    const map = loadMap(path);
    const id = keyFor(key);
    const changed = mutate(map[id] ?? freshState());
    if (changed.persist) map[id] = changed.state;
    else if (changed.delete) delete map[id];
    const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(map)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Preserve the write/rename failure; daily maintenance can reap a
        // matching temp later if this cleanup also fails.
      }
      throw error;
    }
    return changed.result;
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
    } catch {
      // Preserve the result; a stale lock is reclaimed on the next access.
    }
  }
}

/** Return true while the circuit is open, claiming the single recovery probe when due. */
export function providerHealthShouldSkip(key: ProviderHealthKey, opts: ProviderHealthOptions = {}): boolean {
  const now = (opts.now ?? Date.now)();
  const openMs = opts.openMs ?? DEFAULT_OPEN_MS;
  const leaseMs = opts.probeLeaseMs ?? DEFAULT_PROBE_LEASE_MS;
  try {
    return withPersistentState(key, (state) => {
      if (state.openedAt === null) return { state, result: false, persist: false };
      if (now - state.openedAt < openMs) return { state, result: true, persist: false };
      if (state.probeClaimedAt !== null && now - state.probeClaimedAt < leaseMs) {
        return { state, result: true, persist: false };
      }
      state.probeClaimedAt = now;
      return { state, result: false, persist: true };
    });
  } catch {
    return true;
  }
}

export function providerHealthRecordQuotaFailure(key: ProviderHealthKey, opts: ProviderHealthOptions = {}): boolean {
  const now = (opts.now ?? Date.now)();
  const openAfter = opts.openAfter ?? DEFAULT_OPEN_AFTER;
  try {
    return withPersistentState(key, (state) => {
      state.consecutiveQuotaFailures += 1;
      if (state.openedAt === null && state.consecutiveQuotaFailures >= openAfter) state.openedAt = now;
      if (state.openedAt !== null && state.probeClaimedAt !== null) {
        // The one recovery probe failed; begin a fresh quiet window.
        state.openedAt = now;
        state.probeClaimedAt = null;
      }
      return { state, result: state.openedAt !== null, persist: true };
    });
  } catch {
    return true;
  }
}

export function providerHealthRecordSuccess(key: ProviderHealthKey): void {
  try {
    withPersistentState(key, () => ({ state: freshState(), result: undefined, persist: false, delete: true }));
  } catch {
    // Health bookkeeping must never turn a successful judgment into a failure.
  }
}

export function providerHealthRecordProbe(key: ProviderHealthKey): void {
  try {
    withPersistentState(key, () => ({
      state: { consecutiveQuotaFailures: 0, openedAt: null, probeClaimedAt: null },
      result: undefined,
      persist: true,
    }));
  } catch {
    // Keep the prior open circuit when its state cannot be updated.
  }
}

export function providerHealthResetForTests(): void {
  circuits.clear();
}

export interface ProviderHealthStatus {
  consecutiveQuotaFailures: number;
  openedAt: number | null;
  probeClaimedAt: number | null;
}

/**
 * Read-only snapshot of the circuit for provenance records. Never mutates:
 * a status read must not open, close, or claim anything — it reports what
 * the failure/success/skip paths already decided.
 */
export function providerHealthStatus(key: ProviderHealthKey): ProviderHealthStatus {
  const read = withPersistentState(key, (state) => ({
    state,
    result: {
      consecutiveQuotaFailures: state.consecutiveQuotaFailures,
      openedAt: state.openedAt,
      probeClaimedAt: state.probeClaimedAt,
    } satisfies ProviderHealthStatus,
    persist: false,
  }));
  return read;
}
