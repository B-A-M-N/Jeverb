/**
 * Decision-log domain: the advisory append-only JSONL log plus session
 * pruning. Packaged as a class taking its store services as constructor
 * dependencies, so `Store` keeps only the API (`append` / `readLog` /
 * `pruneSessions`) and the IO lives here next to the rotation policy.
 */

import { appendFileSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFileSync,
  ensurePrivateRegularFile,
  removeStaleTempFiles,
  reportStoreWriteFailure,
  safe,
  withFileLock,
} from "./store-lock.js";
import type { DecisionRecord } from "./decision-record.js";

export interface DecisionLogDeps {
  dir: string;
  logPath: string;
  isDisabled(): boolean;
  ensureDir(): void;
  ensureSessionsDir(): void;
}

/**
 * The advisory append-only decision log plus session pruning. IO lives
 * here next to the rotation policy; `Store` delegates its `append` /
 * `readLog` / `pruneSessions` API to one instance.
 */
/** Rotate the decision log at this size. One generation is kept. */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** Session files older than this are pruned. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class DecisionLog {
  constructor(private readonly deps: DecisionLogDeps) {}

  /** Advisory log append; failures are visible but never change enforcement. */
  append(record: DecisionRecord): boolean {
    if (this.deps.isDisabled()) return false;
    try {
      this.deps.ensureDir();
      const locked = withFileLock(this.deps.dir, "decision-log", () => {
        if (this.deps.isDisabled()) return false;
        ensurePrivateRegularFile(this.deps.logPath);
        const size = safe(() => statSync(this.deps.logPath).size, 0);
        if (size >= LOG_ROTATE_BYTES) {
          const rotated = join(this.deps.dir, "decisions.1.jsonl");
          ensurePrivateRegularFile(rotated);
          renameSync(this.deps.logPath, rotated);
        }
        appendFileSync(this.deps.logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
        return true;
      });
      if (locked.locked && locked.value === true) return true;
      reportStoreWriteFailure("decision log lock", new Error("LOCK_TIMEOUT"));
      return false;
    } catch (error) {
      reportStoreWriteFailure("decision log write", error);
      return false;
    }
  }


  /** Read the log back, newest last. Malformed lines are skipped. */
  readLog(): DecisionRecord[] {
    try { this.deps.ensureDir(); } catch { return []; }
    const files = [join(this.deps.dir, "decisions.1.jsonl"), this.deps.logPath];
    const out: DecisionRecord[] = [];
    for (const file of files) {
      try { ensurePrivateRegularFile(file); } catch { continue; }
      const raw = safe(() => readFileSync(file, "utf8"), "");
      for (const line of raw.split("\n")) {
        if (line.trim() === "") continue;
        const parsed = safe<DecisionRecord | null>(() => JSON.parse(line) as DecisionRecord, null);
        if (parsed !== null && typeof parsed === "object") out.push(parsed);
      }
    }
    return out;
  }


  /**
   * Drop session files older than the TTL, at most once a day. Called from
   * UserPromptSubmit, which is the one hook with time to spare.
   */
  pruneSessions(now: number = Date.now()): number {
    if (this.deps.isDisabled()) return 0;
    const marker = join(this.deps.dir, "last-prune");
    try {
      this.deps.ensureDir();
      this.deps.ensureSessionsDir();
      ensurePrivateRegularFile(marker);
    } catch {
      return 0;
    }
    const last = safe(() => Number(readFileSync(marker, "utf8").trim()), 0);
    if (Number.isFinite(last) && now - last < PRUNE_INTERVAL_MS) return 0;
    safe(() => atomicWriteFileSync(marker, String(now)), undefined);

    const dir = join(this.deps.dir, "sessions");
    const names = safe(() => readdirSync(dir), [] as string[]);
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      const mtime = safe(() => statSync(path).mtimeMs, now);
      if (now - mtime <= SESSION_TTL_MS) continue;
      // Prune/transaction race: a live session can be mid-transaction (lock
      // held, about to commit) while its file still shows an old mtime, or
      // a transaction can land between our stat and our unlink. Unlinking
      // then makes the next reader see "missing" and initialize empty
      // state — a vanished read becoming an authoritative empty commit.
      // Take the session's own lock and recheck freshness under it; a
      // contended lock means a live holder, so skip this round entirely.
      const base = name.slice(0, -".json".length);
      const outcome = withFileLock(this.deps.dir, `session-${base}`, () => {
        const fresh = safe(() => statSync(path).mtimeMs, now);
        if (now - fresh <= SESSION_TTL_MS) return false;
        safe(() => unlinkSync(path), undefined);
        // Count only what is actually gone: a failed unlink (EACCES, ENOSPC
        // on the directory entry) must not be reported as removed, or the
        // count becomes a false success signal. Absence is checked rather
        // than file-ness so a non-file entry can never count as removed.
        return safe(() => statSync(path), null) === null;
      });
      if (outcome.locked && outcome.value === true) removed += 1;
    }
    // Reap orphaned atomic-write temp files left by SIGKILLed writers. Only
    // provably-dead owners' stale tmps are removed; live and foreign names
    // are never touched. Bounded by the prune cadence (at most daily).
    removeStaleTempFiles(dir, now);
    return removed;
  }
}
