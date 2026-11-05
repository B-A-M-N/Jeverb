/**
 * Daily evidence maintenance: bound ledger growth, reap crash-orphaned
 * atomic-write temps and graph journals whose runs are long over. Called
 * from UserPromptSubmit next to `pruneSessions` — the one hook with time to
 * spare — at most once a day per data dir. Best effort throughout:
 * maintenance must never break the hook it runs inside.
 */

import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceLedger } from "../evidence/ledger.js";
import { reconcileJournal } from "../graph/journal.js";
import { removeStaleTempFiles, withFileLock } from "./store-lock.js";

const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Only our own journal files are ever eligible for reaping. */
const JOURNAL_FILE = /^jeverb-graph-([A-Za-z0-9_-]{1,100})\.jsonl$/;
const MAX_JOURNAL_DIRECTORY_ENTRIES = 4096;
const MAX_JOURNAL_SCAN_FILES = 256;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_SCAN_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SETTLED_NODE_STATUSES = new Set(["succeeded", "failed", "skipped", "blocked", "cancelled"]);

export interface MaintenanceOutcome {
  /** False when the daily gate said not yet, or the inputs were invalid. */
  ran: boolean;
  /** Evidence records remaining after retention, when a ledger was pruned. */
  ledgerKept?: number;
  /** Crash-orphaned atomic-write temps removed from the data directory. */
  tempFilesRemoved: number;
  /** Graph journals removed as older than the retention window. */
  journalsRemoved: number;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function enforceEvidenceRetention(args: {
  ledger?: EvidenceLedger | undefined;
  dataDir: string;
  retentionDays: number;
  maxRecords: number;
  /** Preserve journals belonging to a session whose mission is still active. */
  isMissionSessionActive?: (sessionId: string) => boolean;
  /** Atomically check mission state and remove its settled journal if inactive. */
  removeGraphJournalIfMissionInactive?: (sessionId: string, remove: () => boolean) => boolean;
  now?: number;
}): MaintenanceOutcome {
  const none: MaintenanceOutcome = { ran: false, tempFilesRemoved: 0, journalsRemoved: 0 };
  const now = args.now ?? Date.now();
  if (!Number.isFinite(args.retentionDays) || args.retentionDays <= 0) return none;
  if (!Number.isFinite(args.maxRecords) || args.maxRecords <= 0) return none;
  // Daily cadence, same shape as session pruning: a marker file records the
  // last run so every prompt does not pay for a full ledger pass.
  const marker = join(args.dataDir, "last-evidence-prune");
  const last = safe(() => Number(readFileSync(marker, "utf8").trim()), 0);
  if (Number.isFinite(last) && now - last < MAINTENANCE_INTERVAL_MS) return none;
  safe(() => writeFileSync(marker, String(now), { mode: 0o600 }), undefined);

  let ledgerKept: number | undefined;
  if (args.ledger !== undefined) {
    const kept = safe(
      () => args.ledger?.prune({ maxAgeMs: args.retentionDays * MS_PER_DAY, maxCount: Math.floor(args.maxRecords) }, now),
      undefined,
    );
    if (typeof kept === "number") ledgerKept = kept;
  }

  // Ledger rewrite temps live beside evidence.log in dataDir; the session
  // store's reaper only scans its `sessions/` directory. Restrict deletion
  // to the shared atomic-write filename contract and provably dead owners.
  const tempFilesRemoved = removeStaleTempFiles(args.dataDir, now);

  let journalsRemoved = 0;
  const journalDir = join(args.dataDir, "graph-journals");
  const directoryStat = safe(() => lstatSync(journalDir), null);
  if (
    directoryStat === null || directoryStat.isSymbolicLink() || !directoryStat.isDirectory() ||
    (directoryStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())
  ) {
    return { ran: true, ...(ledgerKept === undefined ? {} : { ledgerKept }), tempFilesRemoved, journalsRemoved };
  }
  const names = safe(() => readdirSync(journalDir), [] as string[]);
  if (names.length > MAX_JOURNAL_DIRECTORY_ENTRIES) {
    return { ran: true, ...(ledgerKept === undefined ? {} : { ledgerKept }), tempFilesRemoved, journalsRemoved };
  }
  const retentionMs = args.retentionDays * MS_PER_DAY;
  const candidates: Array<{ path: string; runId: string; mtimeMs: number; size: number }> = [];
  const protectedSessions = new Set<string>();
  for (const name of names) {
    const match = JOURNAL_FILE.exec(name);
    if (match === null) continue;
    const path = join(journalDir, name);
    const beforeLockStat = safe(() => lstatSync(path), null);
    if (
      beforeLockStat === null || beforeLockStat.isSymbolicLink() || !beforeLockStat.isFile() ||
      beforeLockStat.nlink !== 1 || beforeLockStat.size > MAX_JOURNAL_BYTES ||
      (beforeLockStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && beforeLockStat.uid !== process.getuid()) ||
      now - beforeLockStat.mtimeMs <= retentionMs
    ) continue;
    candidates.push({ path, runId: match[1]!, mtimeMs: beforeLockStat.mtimeMs, size: beforeLockStat.size });
  }
  // Scan the oldest bounded set first. Large or oversized directories remain
  // untouched by this pass rather than turning an interactive prompt into an
  // unbounded history parse.
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.runId.localeCompare(b.runId));
  let scannedFiles = 0;
  let scannedBytes = 0;
  for (const candidate of candidates) {
    if (
      scannedFiles >= MAX_JOURNAL_SCAN_FILES ||
      scannedBytes + candidate.size > MAX_JOURNAL_SCAN_BYTES
    ) break;
    scannedFiles += 1;
    scannedBytes += candidate.size;
    const { path, runId } = candidate;
    const outcome = safe(() => withFileLock(journalDir, `graph-run-${runId}`, () => {
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        return false;
      }
      if (
        stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        stat.size > MAX_JOURNAL_BYTES || (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
        now - stat.mtimeMs <= retentionMs
      ) return false;

      let journal: ReturnType<typeof reconcileJournal>;
      try {
        journal = reconcileJournal(path);
      } catch {
        return false;
      }
      // A missing/malformed run, an unresolved authorization/effect, or an
      // unknown outcome is retained. Deleting it would erase uncertainty.
      if (
        journal.runId !== runId || !journal.runStarted || journal.malformed > 0 || journal.pending.length > 0 ||
        journal.unknowns.length > 0 || journal.nodes.some((node) => node.status === "outcome_unknown") ||
        journal.nodes.length === 0 || journal.nodes.some((node) =>
          !SETTLED_NODE_STATUSES.has(node.status) || !SHA256.test(node.inputHash ?? "") || !SHA256.test(node.outputDigest ?? "")
        )
      ) return false;
      const remove = (): boolean => {
        // The caller may acquire the session lock between reconciliation and
        // unlink. Recheck identity and age while that lock is held so only the
        // same old journal considered above can be removed.
        const current = safe(() => lstatSync(path), null);
        if (
          current === null || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 ||
          current.dev !== stat.dev || current.ino !== stat.ino || current.size > MAX_JOURNAL_BYTES ||
          (current.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && current.uid !== process.getuid()) ||
          now - current.mtimeMs <= retentionMs
        ) return false;
        try {
          unlinkSync(path);
          return true;
        } catch {
          return false;
        }
      };
      if (journal.hostSessionId !== undefined) {
        if (protectedSessions.has(journal.hostSessionId)) return false;
        if (args.removeGraphJournalIfMissionInactive !== undefined) {
          const removed = args.removeGraphJournalIfMissionInactive(journal.hostSessionId, remove);
          // Active, unreadable, or contended session state must not make
          // maintenance wait on the same owner for every journal in a pass.
          if (!removed) protectedSessions.add(journal.hostSessionId);
          return removed;
        }
        let active = true;
        try {
          active = args.isMissionSessionActive?.(journal.hostSessionId) ?? true;
        } catch { /* Unknown mission state preserves the journal. */ }
        if (active) {
          protectedSessions.add(journal.hostSessionId);
          return false;
        }
      }
      return remove();
    }), { locked: false, value: undefined as boolean | undefined });
    if (outcome.locked && outcome.value === true) journalsRemoved += 1;
  }
  return { ran: true, ...(ledgerKept === undefined ? {} : { ledgerKept }), tempFilesRemoved, journalsRemoved };
}

