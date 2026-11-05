/**
 * Inter-process mutual exclusion and atomic file replacement for hook state.
 *
 * Hook processes are separate OS processes that read-modify-write the same
 * session JSON. Within one process the store's synchronous read-check-write
 * is already race-free (no awaits between read and write); across processes
 * it is not — two concurrent hooks can both pass a "not yet seen" check.
 * This module provides the two primitives that close that gap:
 *
 * - `withFileLock`: a lockdir mutex (mkdir is atomic) with stale-lock
 *   takeover guarded by process liveness, so a crashed holder cannot wedge
 *   the session forever.
 * - `atomicWriteFileSync`: write-temp + fsync + rename, so a crash can
 *   never leave a half-written session file behind. Failed replacements
 *   remove their temp; crash-orphan names are understood by the reaper.
 *
 * Zero repository imports (node:fs/path only) so the module can be bundled
 * standalone for cross-process tests and stays out of dependency cycles.
 */

import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How long to keep polling for a contended lock before giving up. */
export const LOCK_WAIT_MS = 2000;
/** Poll interval while waiting for a contended lock. */
export const LOCK_POLL_MS = 15;
/** A lock older than this with a dead owner is taken over. */
export const LOCK_STALE_MS = 5000;

export interface LockOutcome<T> {
  /** True when `fn` ran under the lock. False on timeout — `fn` did not run. */
  locked: boolean;
  value: T | undefined;
}

/**
 * Run `fn` while holding an exclusive lock named `name` under `dir`.
 * Best-effort by design: hooks must never block a session, so on timeout
 * the callback does not run and the caller falls back to its degraded
 * path (and says so loudly). The lock payload carries pid + randomness so
 * only the owner ever removes its own lock directory.
 */
export function withFileLock<T>(dir: string, name: string, fn: () => T): LockOutcome<T> {
  const lockDir = join(dir, `${name}.lock`);
  const ownerPath = join(lockDir, "owner");
  const token = `${process.pid}:${Date.now()}:${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  if (!acquire(lockDir, ownerPath, token)) return { locked: false, value: undefined };
  try {
    return { locked: true, value: fn() };
  } finally {
    release(lockDir, ownerPath, token);
  }
}

/** Async variant for protecting an operation that must retain the lock across awaits. */
export async function withFileLockAsync<T>(dir: string, name: string, fn: () => Promise<T> | T): Promise<LockOutcome<T>> {
  const lockDir = join(dir, `${name}.lock`);
  const ownerPath = join(lockDir, "owner");
  const token = `${process.pid}:${Date.now()}:${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;
  while (!acquired) {
    // The deadline is checked on every iteration, not just while waiting on
    // a live owner: a stale lock that can neither be taken nor cleared (e.g.
    // an undeletable lock dir) must still terminate instead of spinning
    // forever and wedging the process.
    if (Date.now() >= deadline) return { locked: false, value: undefined };
    if (tryMkdir(lockDir)) {
      try {
        writeFileSync(ownerPath, token, { encoding: "utf8", mode: 0o600 });
        acquired = true;
      } catch {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* preserve failure below */ }
        return { locked: false, value: undefined };
      }
      break;
    }
    if (!ownerAlive(lockDir, ownerPath)) {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* retry until timeout */ }
      continue;
    }
    if (Date.now() >= deadline) return { locked: false, value: undefined };
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(LOCK_POLL_MS, deadline - Date.now())));
  }
  try {
    return { locked: true, value: await fn() };
  } finally {
    release(lockDir, ownerPath, token);
  }
}

function lockIsOurs(ownerPath: string, token: string): boolean {
  try {
    return readFileSync(ownerPath, "utf8") === token;
  } catch {
    return false;
  }
}

function ownerAlive(lockDir: string, ownerPath: string): boolean {
  let pid = 0;
  try {
    pid = Number.parseInt(readFileSync(ownerPath, "utf8").split(":")[0] ?? "", 10);
  } catch {
    return true;
  }
  if (!Number.isFinite(pid) || pid <= 0) return true;
  let mtime = 0;
  try {
    mtime = statSync(lockDir).mtimeMs;
  } catch {
    return true;
  }
  // Fresh lock with a live-or-unknown owner: not ours to take. Only a
  // stale lock whose owner is provably dead gets taken over; EPERM (a
  // live process we cannot signal) counts as alive.
  if (Date.now() - mtime < LOCK_STALE_MS) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Best-effort mkdir that reports rather than throws. */
function tryMkdir(dir: string): boolean {
  try {
    mkdirSync(dir, { mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

function acquire(lockDir: string, ownerPath: string, token: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (tryMkdir(lockDir)) {
      try {
        writeFileSync(ownerPath, token, { encoding: "utf8", mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    }
    if (!ownerAlive(lockDir, ownerPath)) {
      // Stale + owner dead: clear someone else's wreckage, then retry.
      // Removal races a concurrent takeover the same way every lock
      // does — the mkdir retry below decides the winner.
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Fall through to the wait below.
      }
    }
    if (Date.now() >= deadline) return false;
    const until = Math.min(deadline, Date.now() + LOCK_POLL_MS);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, until - Date.now()));
  }
}

function release(lockDir: string, ownerPath: string, token: string): void {
  try {
    if (lockIsOurs(ownerPath, token)) rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // A stale takeover already cleared us; nothing to release.
  }
}

/**
 * Durably replace `path` with `data`: write a sibling temp file, fsync
 * it, then atomically rename over the target. Readers after a crash see
 * the old content or the new content, never a prefix of the new content.
 * The parent directory fsync makes the rename itself crash-durable on
 * kernels that honor it; where it is unavailable the rename is still
 * atomic at the process level.
 */
export function atomicWriteFileSync(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 0xffffffff).toString(16)}.tmp`;
  try {
    // Session snapshots include user prompts, acceptance contracts, and
    // verification state. Never let the process umask make them readable by
    // other local users, and never follow/reuse a stale temp path.
    if (typeof data === "string") {
      writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } else {
      writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    }
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    // Make the directory entry itself crash-durable where the kernel
    // honors it; failure here is advisory, the rename above already
    // replaced the file atomically.
    try {
      const dirFd = openSync(dirname(path), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Best-effort: some filesystems reject directory fsync.
    }
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Cleanup is best-effort; the write error below is what matters.
    }
    throw error;
  }
}

/**
 * A temp file is only deletable by the process that created it once that
 * process is provably gone. `STALE_TMP_MS` keeps the reaper conservative:
 * only a tmp older than this whose recorded pid is dead (ESRCH) is
 * removed. A live pid — including EPERM, which means a live process we
 * cannot signal — always vetoes deletion, as does any name that is not
 * exactly our `<base>.<pid>.<millis>.<rand>.tmp` shape. Returns the number
 * of files removed.
 */
export const STALE_TMP_MS = 60 * 60 * 1000;

export function removeStaleTempFiles(dir: string, nowMs: number = Date.now(), maxAgeMs: number = STALE_TMP_MS): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".tmp")) continue;
    const parts = name.slice(0, -".tmp".length).split(".");
    if (parts.length < 5) continue;
    const pid = Number.parseInt(parts[parts.length - 3] ?? "", 10);
    const stamp = Number.parseInt(parts[parts.length - 2] ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(stamp)) continue;
    let mtime = 0;
    try {
      mtime = statSync(join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    if (nowMs - mtime <= maxAgeMs) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    try {
      rmSync(join(dir, name), { force: true });
      removed += 1;
    } catch {
      // Lost a race with another reaper or the (dead) owner's cleanup.
    }
  }
  return removed;
}

/**
 * Private-file helpers shared by session state and the decision log.
 * Moved here so both `store.ts` and `decision-log.ts` use one copy
 * without a runtime cycle.
 */

export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function reportStoreWriteFailure(operation: string, error: unknown): void {
  const candidate = error as { code?: unknown; name?: unknown } | null;
  const raw = typeof candidate?.code === "string" ? candidate.code : typeof candidate?.name === "string" ? candidate.name : "IO_ERROR";
  const code = /^[A-Za-z0-9_-]{1,32}$/.test(raw) ? raw : "IO_ERROR";
  try {
    process.stderr.write(`[jeverb] ${operation} failed (${code})\n`);
  } catch {
    // Diagnostics cannot replace the host's valid hook response.
  }
}

export function assertOwned(path: string, uid: number | undefined): void {
  if (uid !== undefined && typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new Error(`hook state path is owned by uid ${uid}, expected ${process.getuid()}`);
  }
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("hook state directory is not a real directory");
  assertOwned(path, stat.uid);
  if ((stat.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

/** Harden old Muse-created state before reading user-authored prompt data. */
export function ensurePrivateRegularFile(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error("hook state file is not a private regular file");
  }
  assertOwned(path, stat.uid);
  if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}
