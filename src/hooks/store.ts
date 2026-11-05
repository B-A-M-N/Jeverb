/**
 * On-disk state for the hooks: one small JSON file per session, plus an
 * append-only decision log.
 *
 * Read-only fallbacks are best-effort for missing or legacy state. Writes
 * that affect session decisions are transactional and report failure; the
 * advisory decision log reports failures to stderr without changing policy.
 *
 * The session file exists because a hook fires with a tool call, not with the
 * user's request. `transcript_path` is documented as "conversation JSON" with
 * no schema and is written asynchronously, so parsing it would be guessing at a
 * private format; the UserPromptSubmit hook records the prompt instead and
 * every other handler reads it from here.
 */

import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { applyRememberReissue, claimPostTx, claimStopTx, evictProcessedPosts, foldPostTx, MAX_PROCESSED_POSTS, postObservationKey, takeReissueTx } from "./observations.js";
import type { PendingReissue, ProcessedPost, StopInterventionClaim } from "./observations.js";
export { evictProcessedPosts, type PendingReissue, type ProcessedPost, type StopInterventionClaim } from "./observations.js";
import { DecisionLog } from "./decision-log.js";
export { LOG_ROTATE_BYTES, SESSION_TTL_MS } from "./decision-log.js";
import type { SessionConfig } from "./daemon/registry.js";
import { assertOwned, atomicWriteFileSync, ensurePrivateDirectory, ensurePrivateRegularFile, removeStaleTempFiles, reportStoreWriteFailure, safe, withFileLock } from "./store-lock.js";
import { applyAffirmTrip, applyCloseTrip, applyOpenTrip, applyRepeatTrip, liveTrips, MAX_TRIPS, readTrip, type Trip, type TripSource } from "./tripwire.js";
import { applyBindSubagentTask, applyDropSubagentTask, applyRememberSubagentTask, liveSubagentTasks, MAX_SUBAGENT_TASKS, parseTaskIdentity, selectSubagentTask, SUBAGENT_TASK_TTL_MS, type SubagentTask, type SubagentTaskBinding } from "./subagent-tasks.js";
export { liveSubagentTasks, MAX_SUBAGENT_TASKS, SUBAGENT_TASK_TTL_MS, type SubagentTask, type SubagentTaskBinding } from "./subagent-tasks.js";
import { VERIFICATION_KINDS, type VerificationLedger } from "./verification.js";
import { readMissionContract, readProvisionalChecklist, type MissionContract, type ProvisionalChecklist } from "../mission/contract.js";
import { PROTECTED_MASTER_SWITCH_PATH } from "../control/constants.js";

const MAX_NOTED = 40;

/** One fingerprint this session has already handed the agent a note about. */
export interface NotedAction {
  fingerprint: string;
  ts: number;
}

/**
 * Outcome of one locked session transaction. `skipped` means the callback
 * asked for no write (already claimed: a duplicate); `failed` carries a
 * machine-readable reason and means nothing was persisted.
 */
export type TxOutcome<T> =
  | { status: "committed"; value: T }
  | { status: "skipped" }
  | { status: "failed"; reason: string };

export interface SessionState {
  /** Last few user prompts, oldest first, each truncated. */
  prompts: string[];
  /** Stop blocks issued since the last user prompt. */
  stop_blocks: number;
  /** Increments only for a distinct user prompt; duplicate event delivery cannot reset Stop's budget. */
  prompt_revision?: number;
  last_prompt_event_id?: string;
  /** Stop interventions already claimed in the current prompt revision. */
  stop_interventions?: string[];
  /**
   * Evidence revisions a Stop block was already issued against in the current
   * prompt revision. A changed revision may qualify for reassessment within
   * the overall per-prompt budget; an unchanged one never re-blocks.
   */
  stop_block_revisions?: string[];
  /** `/jev:off` for this session. */
  disabled?: boolean;
  /**
   * Calls this plugin tripped and then let through after an affirmation,
   * awaiting the PostToolUse that says whether they ran.
   */
  pending_reissues?: PendingReissue[];
  /**
   * Open tripwires. Deliberately NOT reset by a new user prompt: a trip issued
   * a moment before the user types "yes, do it" must still be affirmable.
   */
  trips?: Trip[];
  /**
   * Tasks handed to subagents that have not stopped yet. Deliberately NOT
   * reset by a new user prompt: a subagent spawned before the user typed is
   * still working on what the parent told it to do.
   */
  subagent_tasks?: SubagentTask[];
  /** Notes emitted since the last user prompt, for the per-prompt cap. */
  notes_this_prompt?: number;
  /** Fingerprints already noted, for the duplicate check. */
  noted?: NotedAction[];
  /** SessionStart already told the user the key is missing. */
  key_warned?: boolean;
  /**
   * The non-secret configuration snapshot this session posted to the daemon.
   *
   * Written so a *replaced* daemon — a plugin update, a crash, a
   * `/jev:daemon restart` — can answer a hook for a session it never saw hello
   * from with that session's settings rather than with its own environment's.
   */
  config?: SessionConfig;
  /**
   * What the last test/build/type-check/lint run established, and how many
   * edits have happened since. Deliberately NOT reset by a new user prompt:
   * a failing test suite is still failing after the user types something.
   */
  verification?: VerificationLedger;
  /** Explicit user-authored objective and acceptance criteria, if provided. */
  mission_contract?: MissionContract;
  /**
   * Automatically derived routine checklist, if any. Provisional guidance
   * only: never a mission contract, never closure evidence.
   */
  routine_checklist?: ProvisionalChecklist;
  /** Epoch ms of the last write, for pruning. */
  updated?: number;
  /**
   * Post-execution observations already folded into this session, by
   * `tool_use_id`. The host may deliver the same execution twice — once as
   * an individual post-tool event and once inside a batch — and a batch may
   * be redelivered outright. The first observation wins; later ones are
   * duplicates, not new evidence.
   */
  processed_posts?: ProcessedPost[];
}

export const EMPTY_SESSION: SessionState = { prompts: [], stop_blocks: 0 };

/**
export type TxOutcome<T> =
  | { status: "committed"; value: T }
  | { status: "skipped" }
  | { status: "failed"; reason: string };

/** Read one claim list, accepting the pre-timestamp string shape. */
function readProcessedPosts(raw: unknown): ProcessedPost[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const posts: ProcessedPost[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) {
      // Legacy shape: unknown age, so evict first — never before a
      // timestamped entry whose relevance is still established.
      posts.push({ key: entry, ts: 0 });
      continue;
    }
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Partial<ProcessedPost>;
      if (typeof record.key === "string" && record.key.length > 0 && typeof record.ts === "number") {
        posts.push({ key: record.key, ts: record.ts });
      }
    }
  }
  return posts;
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Validate a ledger read back off disk.
 *
 * The session file is state this plugin wrote, but it is still a file on disk
 * that anything could have edited, and `last.kind` reaches a user-visible
 * message. Anything unrecognized is dropped rather than repaired.
 */
function readLedger(raw: unknown): VerificationLedger | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Partial<VerificationLedger>;
  const ledger: VerificationLedger = {
    edits_since: typeof value.edits_since === "number" && value.edits_since >= 0 ? Math.floor(value.edits_since) : 0,
  };
  const last = value.last;
  if (
    typeof last === "object" &&
    last !== null &&
    (VERIFICATION_KINDS as readonly string[]).includes(last.kind) &&
    typeof last.ok === "boolean" &&
    typeof last.ts === "number" &&
    typeof last.command === "string"
  ) {
    ledger.last = { kind: last.kind, ok: last.ok, ts: last.ts, command: last.command };
    if (typeof last.cwd === "string" && last.cwd !== "") ledger.last.cwd = last.cwd;
  }
  const rawByKind = value.byKind;
  if (typeof rawByKind === "object" && rawByKind !== null) {
    const byKind: Partial<Record<(typeof VERIFICATION_KINDS)[number], VerificationLedger["last"]>> = {};
    for (const kind of VERIFICATION_KINDS) {
      const entry = (rawByKind as Record<string, unknown>)[kind];
      if (
        typeof entry === "object" && entry !== null &&
        (entry as { kind?: unknown }).kind === kind &&
        typeof (entry as { ok?: unknown }).ok === "boolean" &&
        typeof (entry as { ts?: unknown }).ts === "number" &&
        typeof (entry as { command?: unknown }).command === "string"
      ) {
        const record = entry as { ok: boolean; ts: number; command: string; cwd?: unknown };
        byKind[kind] = { kind, ok: record.ok, ts: record.ts, command: record.command };
        if (typeof record.cwd === "string" && record.cwd !== "") {
          (byKind[kind] as { cwd?: string }).cwd = record.cwd;
        }
      }
    }
    if (Object.keys(byKind).length > 0) ledger.byKind = byKind as NonNullable<VerificationLedger["byKind"]>;
  }
  const rawCounts = value.editsSinceByKind;
  if (typeof rawCounts === "object" && rawCounts !== null) {
    const counts: Partial<Record<(typeof VERIFICATION_KINDS)[number], number>> = {};
    for (const kind of VERIFICATION_KINDS) {
      const count = (rawCounts as Record<string, unknown>)[kind];
      if (typeof count === "number" && count >= 0) counts[kind] = Math.floor(count);
    }
    if (Object.keys(counts).length > 0) ledger.editsSinceByKind = counts;
  }
  if (typeof value.uncertain_since === "number" && value.uncertain_since > 0) {
    ledger.uncertain_since = Math.floor(value.uncertain_since);
  }
  return ledger;
}

/** Session ids arrive from the harness; never let one escape the data dir. */
export function safeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
  return cleaned === "" ? "unknown" : cleaned;
}

/**
 * The marketplace was renamed from `brainwires-jev` to `brainwires-jevwire`
 * after 0.4.0, which moves the plugin's data directory (Claude Code derives it
 * from `<plugin>@<marketplace>`). Copy the old directory into the new one
 * exactly once, so `/jev:calibrate` keeps its history. Only when the new
 * directory has no log yet: this never overwrites anything.
 */
export const LEGACY_DATA_DIR_NAMES: Record<string, string> = { "jev-brainwires-jevwire": "jev-brainwires-jev" };

export function migrateLegacyDataDir(dir: string): boolean {
  const legacyName = LEGACY_DATA_DIR_NAMES[basename(dir)];
  if (legacyName === undefined) return false;
  const legacy = join(dirname(dir), legacyName);
  if (!existsSync(join(legacy, "decisions.jsonl"))) return false;
  if (existsSync(join(dir, "decisions.jsonl"))) return false;
  return safe(() => {
    mkdirSync(dir, { recursive: true });
    for (const entry of ["decisions.jsonl", "decisions.1.jsonl", "sessions", "last-prune"]) {
      const from = join(legacy, entry);
      if (existsSync(from)) cpSync(from, join(dir, entry), { recursive: true, errorOnExist: false, force: false });
    }
    return true;
  }, false);
}

/**
 * Master-switch state lives in the control layer (`control/master-switch.ts`).
 * Re-exported here so existing `hooks/store.js` importers keep working; new
 * code in `control/` and `evidence/` must import from the control module
 * directly to keep the layering one-way.
 */
export {
  environmentDisableOverride,
  globalDisablePathFor,
  isGloballyDisabled,
  legacyDisablePathFor,
  readMasterSwitch,
  writeMasterSwitch,
  type MasterSwitchStatus,
} from "../control/master-switch.js";
import { readMasterSwitch, type MasterSwitchStatus } from "../control/master-switch.js";
import type { DecisionRecord } from "./decision-record.js";
export {
  MAX_PROMPT_CHARS,
  MAX_PROMPTS,
  MAX_SHORT_PROMPTS,
  SHORT_PROMPT_CHARS,
  modelCost,
  nextPrompts,
  requestText,
  type DecisionRecord,
} from "./decision-record.js";

/** How a session-file read failed. Only `missing` may seed empty state. */
export type SessionReadFailureKind = "missing" | "corrupt" | "transient";

/** Typed read failure: transactional paths fail closed, display paths fall back. */
export class SessionReadError extends Error {
  readonly kind: SessionReadFailureKind;
  constructor(kind: SessionReadFailureKind, message: string) {
    super(message);
    this.name = "SessionReadError";
    this.kind = kind;
  }
}

/** Errno codes that mean "try again later", never "the bytes are bad". */
const TRANSIENT_READ_CODES = new Set([
  "EACCES",
  "EPERM",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EROFS",
  "EIO",
  "EBUSY",
  "EAGAIN",
  "ENOMEM",
  "ETXTBSY",
  "EINTR",
  "ENOBUFS",
]);

function classifySessionReadError(error: unknown, what: string): SessionReadError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return new SessionReadError("missing", `${what} does not exist yet`);
  if (typeof code === "string" && TRANSIENT_READ_CODES.has(code)) {
    return new SessionReadError("transient", `${what} unreadable (${code}; bytes preserved)`);
  }
  return new SessionReadError("corrupt", `${what} unreadable (${code ?? String(error)}; bytes preserved)`);
}

export class Store {
  readonly dir: string;
  readonly masterSwitchPath: string;
  readonly requireRootOwnedMasterSwitch: boolean;
  private sessionsHardened = false;
  private readonly log: DecisionLog;

  constructor(dir: string, options: { masterSwitchPath?: string; requireRootOwnedMasterSwitch?: boolean } = {}) {
    this.dir = dir;
    this.masterSwitchPath = options.masterSwitchPath ?? PROTECTED_MASTER_SWITCH_PATH;
    this.requireRootOwnedMasterSwitch = options.requireRootOwnedMasterSwitch ?? true;
    migrateLegacyDataDir(dir);
    this.log = new DecisionLog({
      dir,
      logPath: this.logPath,
      isDisabled: () => this.globallyDisabled(),
      ensureDir: () => { this.ensureDir(); },
      ensureSessionsDir: () => { this.ensureSessionsDir(); },
    });
  }

  /** Advisory log append; failures are visible but never change enforcement. */
  append(record: DecisionRecord): boolean {
    return this.log.append(record);
  }

  /** Read the log back, newest last. Malformed lines are skipped. */
  readLog(): DecisionRecord[] {
    return this.log.readLog();
  }

  /**
   * Drop session files older than the TTL, at most once a day. Called from
   * UserPromptSubmit, which is the one hook with time to spare.
   */
  pruneSessions(now: number = Date.now()): number {
    return this.log.pruneSessions(now);
  }

  private globallyDisabled(): boolean {
    return readMasterSwitch(this.dir, false, this.masterSwitchPath, this.requireRootOwnedMasterSwitch).effective === "OFF";
  }

  /** Current authoritative install-wide state, including its generation fence. */
  masterSwitchStatus(): MasterSwitchStatus {
    return readMasterSwitch(this.dir, false, this.masterSwitchPath, this.requireRootOwnedMasterSwitch);
  }

  private ensureDir(sub?: string): string {
    const target = sub === undefined ? this.dir : join(this.dir, sub);
    ensurePrivateDirectory(target);
    return target;
  }

  private ensureSessionsDir(): string {
    const sessionsDir = this.ensureDir("sessions");
    if (!this.sessionsHardened) {
      for (const name of readdirSync(sessionsDir)) {
        if (name.endsWith(".json")) ensurePrivateRegularFile(join(sessionsDir, name));
      }
      this.sessionsHardened = true;
    }
    return sessionsDir;
  }

  private sessionPath(sessionId: string): string {
    return join(this.dir, "sessions", `${safeSessionId(sessionId)}.json`);
  }

  get logPath(): string {
    return join(this.dir, "decisions.jsonl");
  }

  /** The `/jev:off` fallback when a command cannot learn the session id. */
  get globalDisablePath(): string {
    return this.masterSwitchPath;
  }

  /**
   * Tolerant reader for read-only display paths (prompts, trips, config,
   * stop blocks). Any failure — missing, corrupt, or transient — degrades
   * to an empty session, exactly as before. Transactional paths must use
   * the raw reader via `lockedUpdate`: committing state synthesized from a
   * failed read would durably wipe trips, claims, and verification folds.
   */
  readSession(sessionId: string): SessionState {
    return this.readSessionDetailed(sessionId).session;
  }

  /**
   * Same tolerant contract as `readSession`, with the health attached. A
   * missing file is a legitimately new session, not degradation: only a
   * failed read of existing state (`corrupt`, `transient`, or an unexpected
   * error) reports `degraded`, so callers can tell "the store is down" apart
   * from "nothing was ever recorded".
   */
  readSessionDetailed(sessionId: string): { session: SessionState; degraded: boolean; reason?: string } {
    try {
      return { session: this.readSessionRaw(sessionId), degraded: false };
    } catch (error) {
      const kind = error instanceof SessionReadError ? error.kind : "unknown";
      if (kind === "missing") return { session: { ...EMPTY_SESSION }, degraded: false };
      return { session: { ...EMPTY_SESSION }, degraded: true, reason: kind };
    }
  }

  /**
   * Whether graph history for this session must be retained. The per-session
   * lock makes the mission check linearizable with contract updates; missing
   * state is inactive, while corrupt/unreadable state and lock contention
   * preserve history conservatively.
   */
  shouldRetainGraphHistory(sessionId: string): boolean {
    const outcome = withFileLock(this.dir, `session-${safeSessionId(sessionId)}`, () => {
      try {
        return this.readSessionRaw(sessionId).mission_contract !== undefined;
      } catch (error) {
        return !(error instanceof SessionReadError && error.kind === "missing");
      }
    });
    return !outcome.locked || outcome.value !== false;
  }

  /** Run a graph-history removal only while this session has no mission. */
  withInactiveMissionSession(sessionId: string, remove: () => boolean): boolean {
    const outcome = withFileLock(this.dir, `session-${safeSessionId(sessionId)}`, () => {
      try {
        if (this.readSessionRaw(sessionId).mission_contract !== undefined) return false;
      } catch (error) {
        // Missing state cannot own an active mission. Any other read failure
        // leaves ownership uncertain and must preserve the graph history.
        if (!(error instanceof SessionReadError && error.kind === "missing")) return false;
      }
      return remove();
    });
    return outcome.locked && outcome.value === true;
  }

  /**
   * Fallible reader for transactional paths. A missing file (legitimately
   * new) throws `missing`; invalid JSON or a non-object top level throws
   * `corrupt`; any other I/O failure throws `transient`. The bytes on disk
   * are never papered over: `lockedUpdate` seeds empty only for `missing`
   * and aborts with no commit for every other failure.
   */
  private readSessionRaw(sessionId: string): SessionState {
    try {
      this.ensureDir();
      this.ensureSessionsDir();
      const path = this.sessionPath(sessionId);
      ensurePrivateRegularFile(path);
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (error) {
        throw classifySessionReadError(error, `session ${sessionId}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new SessionReadError("corrupt", `session ${sessionId} is not valid JSON (bytes preserved)`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new SessionReadError("corrupt", `session ${sessionId} has a non-object top level (bytes preserved)`);
      }
      const state = parsed as Partial<SessionState>;
      const session: SessionState = {
        prompts: Array.isArray(state.prompts) ? state.prompts.filter((p) => typeof p === "string") : [],
        stop_blocks: typeof state.stop_blocks === "number" ? state.stop_blocks : 0,
      };
      if (typeof state.prompt_revision === "number" && Number.isSafeInteger(state.prompt_revision) && state.prompt_revision >= 0) {
        session.prompt_revision = state.prompt_revision;
      }
      if (typeof state.last_prompt_event_id === "string") session.last_prompt_event_id = state.last_prompt_event_id.slice(0, 200);
      if (Array.isArray(state.stop_interventions)) {
        session.stop_interventions = state.stop_interventions.filter((key): key is string => typeof key === "string").slice(-64);
      }
      if (Array.isArray(state.stop_block_revisions)) {
        session.stop_block_revisions = state.stop_block_revisions.filter((key): key is string => typeof key === "string").slice(-16);
      }
      if (state.disabled === true) session.disabled = true;
      if (state.key_warned === true) session.key_warned = true;
      // Kept opaque here and validated field by field where it is used
      // (`readSessionConfig`), which is the only place that knows what a
      // sensible value for each setting is.
      if (typeof state.config === "object" && state.config !== null && !Array.isArray(state.config)) {
        session.config = state.config;
      }
      if (Array.isArray(state.pending_reissues)) {
        session.pending_reissues = state.pending_reissues.filter(
          (p): p is PendingReissue => typeof p === "object" && p !== null && typeof p.tool_use_id === "string",
        );
      }
      // Trips reach user-visible text and a `deny` reason, so every field is
      // validated rather than trusted, and expired ones never come back at all.
      if (Array.isArray(state.trips)) {
        const trips = state.trips.map((raw) => readTrip(raw)).filter((trip): trip is Trip => trip !== undefined);
        if (trips.length > 0) session.trips = trips.slice(-MAX_TRIPS);
      }
      // A task's prompt reaches the Jev API as the request a call is judged
      // against, so every field is validated rather than trusted.
      if (Array.isArray(state.subagent_tasks)) {
        const tasks = state.subagent_tasks.filter(
          (task): task is SubagentTask =>
            typeof task === "object" &&
            task !== null &&
            typeof task.agent_type === "string" &&
            typeof task.prompt === "string" &&
            typeof task.ts === "number",
        );
        if (tasks.length > 0) {
          session.subagent_tasks = tasks.map((task) => ({
            ...task,
            ...(typeof task.spawn_tool_use_id === "string" ? { spawn_tool_use_id: task.spawn_tool_use_id } : {}),
            ...(typeof task.subagent_id === "string" ? { subagent_id: task.subagent_id } : {}),
            ...(typeof task.child_session_id === "string" ? { child_session_id: task.child_session_id } : {}),
          })).slice(-MAX_SUBAGENT_TASKS);
        }
      }
      if (typeof state.notes_this_prompt === "number" && state.notes_this_prompt >= 0) {
        session.notes_this_prompt = Math.floor(state.notes_this_prompt);
      }
      if (Array.isArray(state.noted)) {
        const noted = state.noted.filter(
          (n): n is NotedAction =>
            typeof n === "object" && n !== null && typeof n.fingerprint === "string" && typeof n.ts === "number",
        );
        if (noted.length > 0) session.noted = noted.slice(-MAX_NOTED);
      }
      if (typeof state.updated === "number") session.updated = state.updated;
      const missionContract = readMissionContract(state.mission_contract, sessionId);
      if (missionContract !== undefined) session.mission_contract = missionContract;
      const routineChecklist = readProvisionalChecklist(state.routine_checklist);
      if (routineChecklist !== undefined) session.routine_checklist = routineChecklist;
      {
        const processed = readProcessedPosts(state.processed_posts);
        if (processed !== undefined && processed.length > 0) {
          session.processed_posts = processed.slice(-MAX_PROCESSED_POSTS);
        }
      }
      const ledger = readLedger(state.verification);
      if (ledger !== undefined) session.verification = ledger;
      return session;
    } catch (error) {
      if (error instanceof SessionReadError) throw error;
      throw classifySessionReadError(error, `session ${sessionId}`);
    }
  }

  writeSession(sessionId: string, state: SessionState, now: number = Date.now()): void {
    if (this.globallyDisabled()) throw new Error("session state write suppressed: Jeverb is OFF");
    this.ensureDir();
    this.ensureSessionsDir();
    // Atomic replace: a crash lands the old file or the new file on disk,
    // never a half-written one. A torn session file used to read back as
    // EMPTY and silently drop claims, trips, and verification folds.
    const locked = withFileLock(this.dir, `session-${safeSessionId(sessionId)}`, () => {
      atomicWriteFileSync(this.sessionPath(sessionId), `${JSON.stringify({ ...state, updated: now })}\n`);
      return true;
    });
    if (!locked.locked || locked.value !== true) {
      throw new Error("session state write failed (lock-unavailable)");
    }
  }

  /**
   * One locked read-modify-write of a session file. The lock serializes
   * this process against concurrent hook processes (within one process
   * the synchronous body is already race-free); the atomic write makes
   * the update all-or-nothing across a crash. Returns the callback's
   * value, or undefined when the lock could not be taken — the caller
   * then takes its degraded path and says so, rather than writing
   * unlocked and racing a concurrent hook.
   */
  lockedUpdate<T>(
    sessionId: string,
    now: number,
    fn: (state: SessionState) => { state: SessionState; value: T } | undefined,
  ): TxOutcome<T> {
    if (this.globallyDisabled()) return { status: "failed", reason: "master-switch-off" };
    this.ensureDir();
    this.ensureSessionsDir();
    const outcome = withFileLock(this.dir, `session-${safeSessionId(sessionId)}`, () => {
      if (this.globallyDisabled()) return { status: "failed", reason: "master-switch-off" } as const;
      let state: SessionState;
      try {
        state = this.readSessionRaw(sessionId);
      } catch (error) {
        // Only a genuinely missing file seeds empty state. A corrupt or
        // transiently-unreadable file must never be synthesized over: the
        // bytes stay on disk and this transaction commits nothing.
        if (error instanceof SessionReadError && error.kind === "missing") {
          state = { ...EMPTY_SESSION };
        } else {
          const detail =
            error instanceof SessionReadError ? `${error.kind} (${error.message})` : String(error);
          return { status: "failed", reason: `read: ${detail}` } as const;
        }
      }
      let result: { state: SessionState; value: T } | undefined;
      try {
        result = fn(state);
      } catch (error) {
        return { status: "failed", reason: `transaction: ${String(error)}` } as const;
      }
      if (result === undefined) return { status: "skipped" } as const;
      if (this.globallyDisabled()) return { status: "failed", reason: "master-switch-off" } as const;
      // Inside the lock, all-or-nothing across a crash: the claim and
      // the state it guards land in the same atomic write, so a crash
      // before this point leaves the event unclaimed (redelivery folds
      // it exactly once) and a crash after leaves it fully folded.
      try {
        atomicWriteFileSync(this.sessionPath(sessionId), `${JSON.stringify({ ...result.state, updated: now })}\n`);
      } catch (error) {
        return { status: "failed", reason: `commit: ${String(error)}` } as const;
      }
      return { status: "committed", value: result.value } as const;
    });
    if (!outcome.locked) return { status: "failed", reason: "lock-unavailable" };
    // With the lock held the body above always returns a TxOutcome, so
    // `value` is present; the fallback only guards a lock-primitive bug.
    return outcome.value ?? { status: "failed", reason: "lock-primitive" };
  }

  updateSession(sessionId: string, mutate: (state: SessionState) => SessionState, now: number = Date.now()): SessionState {
    const outcome = this.lockedUpdate(sessionId, now, (state) => {
      const next = mutate(state);
      return { state: next, value: next };
    });
    if (outcome.status !== "committed") {
      throw new Error(`session state update failed (${outcome.status === "failed" ? outcome.reason : outcome.status})`);
    }
    return outcome.value;
  }

  /** Atomically deduplicate a Stop event and claim one bounded intervention. */
  tryClaimStopIntervention(
    sessionId: string,
    eventKey: string,
    cap: number,
    now: number = Date.now(),
    revisionKey?: string,
  ): StopInterventionClaim {
    const outcome = this.lockedUpdate(sessionId, now, (state) => claimStopTx(state, eventKey, cap, revisionKey));
    if (outcome.status === "committed") return "claimed";
    if (outcome.status === "failed") {
      console.error(`[jeverb] stop intervention claim failed (${outcome.reason} session=${sessionId})`);
      return "error";
    }
    const state = this.readSession(sessionId);
    return (state.stop_interventions ?? []).includes(eventKey) ? "duplicate" : "capped";
  }

  /** Session-scoped or global `/jev:off`. */
  isDisabled(sessionId: string): boolean {
    if (this.globallyDisabled()) return true;
    return this.readSession(sessionId).disabled === true;
  }

  setDisabled(sessionId: string | null, disabled: boolean): { scope: "session" | "global"; path: string } {
    if (sessionId === null) {
      throw new Error("install-wide switch transitions require the protected jeverb-control service");
    }
    this.updateSession(sessionId, (state) => {
      const next: SessionState = { ...state };
      if (disabled) next.disabled = true;
      else delete next.disabled;
      return next;
    });
    return { scope: "session", path: this.sessionPath(sessionId) };
  }

  /** Record that a re-issue was let through, so PostToolUse can see it ran. */
  rememberReissue(sessionId: string, pending: PendingReissue): void {
    this.updateSession(sessionId, (state) => ({
      ...state,
      pending_reissues: applyRememberReissue(state.pending_reissues, pending),
    }));
  }

  /**
   * Claim a post-execution observation for a tool use. Returns true the
   * first time a `tool_use_id` is seen, false for every repeat — so replayed
   * batches and individual-plus-batch double delivery fold state exactly
   * once. First observation wins, whatever shape it arrived in.
   *
   * Inter-process safe: the check and the write hold the session lock, so
   * two concurrent hooks cannot both win the same claim. When the lock is
   * unavailable, the commit fails, or the session file is unreadable, the
   * claim reports not-claimed (false) with a loud error — the event stays
   * unclaimed, so redelivery folds it exactly once. Failing open here
   * would fold without a claim and double-fold on redelivery.
   */
  claimPostObservation(sessionId: string, toolUseId: string, scope: "state" | "receipt", now: number = Date.now()): boolean {
    // Keyed by session + tool invocation + policy version + scope: a policy
    // change re-opens observation because the new rules may judge the same
    // execution differently. State and receipt are separate scopes because
    // different deliveries fold each one — the Approval hook folds
    // verification state while the batch writes the evidence receipt, and
    // either may legitimately arrive first.
    const key = postObservationKey(toolUseId, scope);
    let outcome: TxOutcome<true>;
    try {
      outcome = this.lockedUpdate(sessionId, now, claimPostTx(key, now));
    } catch (error) {
      console.error(`[jeverb] claim failed (${String(error)} session=${sessionId}); event stays unclaimed`);
      return false;
    }
    if (outcome.status === "committed") return true;
    if (outcome.status === "skipped") return false;
    console.error(`[jeverb] claim failed (${outcome.reason} session=${sessionId}); event stays unclaimed`);
    return false;
  }

  /**
   * Claim an observation AND fold its state update in one transaction.
   * The claim and the mutation land in the same atomic write, so a crash
   * between them is impossible: before the write the event is unclaimed
   * (redelivery folds it exactly once); after it the event is fully
   * folded. Returns "folded" on success, "duplicate" when another
   * delivery already folded this event, and "error" when the commit
   * failed — the event stays unclaimed then, so redelivery recovers.
   */
  foldPostObservation(
    sessionId: string,
    toolUseId: string,
    scope: "state" | "receipt",
    now: number,
    fold: (state: SessionState) => SessionState,
  ): "folded" | "duplicate" | "error" {
    const key = postObservationKey(toolUseId, scope);
    let outcome: TxOutcome<"folded">;
    try {
      outcome = this.lockedUpdate(sessionId, now, foldPostTx(key, now, fold));
    } catch (error) {
      console.error(`[jeverb] fold failed (${String(error)} session=${sessionId}); event stays unclaimed`);
      return "error";
    }
    if (outcome.status === "committed") return "folded";
    if (outcome.status === "skipped") return "duplicate";
    console.error(`[jeverb] fold failed (${outcome.reason} session=${sessionId}); event stays unclaimed`);
    return "error";
  }

  /** Consume a pending re-issue. Returns it when this call was one of ours. */
  takeReissue(sessionId: string, toolUseId: string): PendingReissue | undefined {
    // Locked like the observation claims: two concurrent post-tool hooks
    // for the same re-issued call must not both consume it. A lock
    // failure returns undefined (unconsumed) rather than guessing.
    const outcome = this.lockedUpdate(sessionId, Date.now(), takeReissueTx(toolUseId));
    if (outcome.status !== "committed") {
      if (outcome.status === "failed") {
        console.error(`[jeverb] takeReissue failed (${outcome.reason} session=${sessionId})`);
      }
      return undefined;
    }
    return outcome.value;
  }

  // ----------------------------------------------------------- subagent tasks

  /** Record the task a parent just handed a subagent. */
  rememberSubagentTask(sessionId: string, task: SubagentTask, now: number = Date.now()): void {
    this.updateSession(
      sessionId,
      (state) => ({ ...state, subagent_tasks: applyRememberSubagentTask(state.subagent_tasks ?? [], task, now) }),
      now,
    );
  }

  /** Bind a host-issued child identity to an exact spawn call or unique task type. */
  bindSubagentTask(
    sessionId: string,
    agentType: string,
    identity: SubagentTaskBinding,
    now: number = Date.now(),
  ): boolean {
    let bound = false;
    this.updateSession(sessionId, (state) => {
      const applied = applyBindSubagentTask(state.subagent_tasks ?? [], agentType, identity, now);
      bound = applied.bound;
      return { ...state, subagent_tasks: applied.tasks };
    }, now);
    return bound;
  }

  /**
   * The live task for this agent type, when there is exactly one.
   *
   * Reads without consuming — a subagent makes many tool calls and every one
   * of them is judged against the same task; `SubagentStop` is what removes
   * it. Two live tasks of the same type means two same-type subagents are
   * running in parallel and nothing here can say which one is calling, so the
   * answer is "unknown" rather than a guess: the caller then ignores scope
   * instead of judging against the wrong task.
   */
  takeSubagentTask(sessionId: string, agentType: string, identityOrNow?: string | number, maybeNow?: string | number): SubagentTask | undefined {
    const { identity, now } = parseTaskIdentity(identityOrNow, maybeNow);
    return selectSubagentTask(this.readSession(sessionId).subagent_tasks ?? [], agentType, identity, now);
  }

  /** The subagent stopped: its task is no longer anybody's request. */
  dropSubagentTask(sessionId: string, agentType: string, identityOrNow?: string | number, maybeNow?: string | number): void {
    const { identity, now } = parseTaskIdentity(identityOrNow, maybeNow);
    this.updateSession(
      sessionId,
      (state) => {
        const remaining = applyDropSubagentTask(state.subagent_tasks ?? [], agentType, identity, now);
        if (remaining === undefined) {
          const next: SessionState = { ...state };
          delete next.subagent_tasks;
          return next;
        }
        return { ...state, subagent_tasks: remaining };
      },
      now,
    );
  }

  // --------------------------------------------------------------- tripwires

  /** Open tripwires, expired ones dropped. */
  liveTrips(sessionId: string, now: number = Date.now()): Trip[] {
    return liveTrips(this.readSession(sessionId).trips ?? [], now);
  }

  /**
   * The open trip for this exact action, if there is one.
   *
   * Exact fingerprint, deliberately: an affirmation answers one action, not a
   * family of them, so an edited re-issue is a new judgment.
   */
  findTripByFingerprint(sessionId: string, fingerprint: string, now: number = Date.now()): Trip | undefined {
    return this.liveTrips(sessionId, now).find((trip) => trip.fingerprint === fingerprint);
  }

  /** The open trip with this id, for the sidecar affirmation form. */
  findTripById(sessionId: string, tripId: string, now: number = Date.now()): Trip | undefined {
    return this.liveTrips(sessionId, now).find((trip) => trip.id === tripId);
  }

  /** Write a new trip, replacing any expired one for the same action. */
  openTrip(sessionId: string, trip: Trip, now: number = Date.now()): Trip {
    this.updateSession(
      sessionId,
      (state) => ({ ...state, trips: applyOpenTrip(state.trips ?? [], trip, now) }),
      now,
    );
    return trip;
  }

  /** Count one more deny against an open trip, and return the new count. */
  repeatTrip(sessionId: string, tripId: string, now: number = Date.now()): number {
    let denies = 1;
    this.updateSession(
      sessionId,
      (state) => {
        const applied = applyRepeatTrip(state.trips ?? [], tripId, now);
        denies = applied.denies;
        return { ...state, trips: applied.trips };
      },
      now,
    );
    return denies;
  }

  /** Record a sidecar affirmation against an open trip. */
  affirmTrip(sessionId: string, tripId: string, affirmation: string, now: number = Date.now()): void {
    this.updateSession(
      sessionId,
      (state) => ({ ...state, trips: applyAffirmTrip(state.trips ?? [], tripId, affirmation, now) }),
      now,
    );
  }

  /** Close a trip: it was answered and the call went through. */
  closeTrip(sessionId: string, tripId: string, now: number = Date.now()): void {
    this.updateSession(
      sessionId,
      (state) => ({ ...state, trips: applyCloseTrip(state.trips ?? [], tripId, now) }),
      now,
    );
  }

  /** Remember that a note went out, for the duplicate check and the cap. */
  noteEmitted(sessionId: string, fingerprint: string, now: number = Date.now()): void {
    this.updateSession(
      sessionId,
      (state) => ({
        ...state,
        notes_this_prompt: (state.notes_this_prompt ?? 0) + 1,
        noted: [...(state.noted ?? []).filter((n) => n.fingerprint !== fingerprint), { fingerprint, ts: now }].slice(
          -MAX_NOTED,
        ),
      }),
      now,
    );
  }

  /** Was this exact action noted recently enough that a second note adds nothing? */
  wasNoted(sessionId: string, fingerprint: string, withinMs: number, now: number = Date.now()): boolean {
    return (this.readSession(sessionId).noted ?? []).some(
      (noted) => noted.fingerprint === fingerprint && now - noted.ts <= withinMs,
    );
  }


}
