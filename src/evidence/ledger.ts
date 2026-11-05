import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { writeAllSync } from "../util/write-all.js";
import { PROTECTED_MASTER_SWITCH_PATH } from "../control/constants.js";
import { environmentDisableOverride, readMasterSwitch } from "../control/master-switch.js";
import { atomicWriteFileSync, withFileLock, type LockOutcome } from "../hooks/store-lock.js";
import type { ReceiptOutcome } from "./receipt-validation.js";
import { isValidReceipt } from "./receipt-validation.js";
export { RECEIPT_OUTCOMES, hashSubject, isValidReceipt, resolveEventHost, type ReceiptOutcome } from "./receipt-validation.js";

export interface EvidenceRecord {
  schema: 1;
  /**
   * Receipt identity, always ledger-minted (randomUUID). Distinct receipts
   * for identical invocations get distinct ids; use `decisionId` to
   * correlate receipts that belong to the same decision.
   */
  id: string;
  ts: string;
  sessionId: string;
  turnId?: string;
  /** Deterministic decision/dedupe key (may repeat across receipts). */
  decisionId?: string;
  /**
   * Stable end-to-end correlation across graph/tool redelivery: unlike
   * `id` (ledger-minted per receipt) this value is never generated or
   * overwritten by the ledger — a redelivered event must reuse the
   * originator's `correlationId` so retries join to one logical operation.
   */
  correlationId?: string;
  /** Typed terminal mission verdict; optional for backward-compatible receipts. */
  missionClosure?: {
    missionId: string;
    status: "COMPLETE" | "INCOMPLETE" | "BLOCKED" | "INSUFFICIENT_EVIDENCE";
    complete: boolean;
    missionRevision: string;
    evidenceRevision: string;
    /** Candidate the verdict was evaluated against; absent only for legacy receipts. */
    candidateDigest?: string;
    checks: Record<string, boolean>;
    model?: string;
    modelVersion?: string;
    provider?: string;
    providerRequestId?: string;
    questionHash?: string;
    calibrationVersion?: string;
    confidence?: number;
    probabilities?: Record<string, number>;
    confidenceIsProof: false;
    /**
     * Adversarial pair outcome, when closure ran in pair mode. An unresolved
     * challenge survives restart here: the record keeps both judges and the
     * controller rationale, and a repeated challenge on the same revision
     * can never silently become success.
     */
    adversarial?: {
      state: string;
      gap: string;
      targets: string[];
      repairCriterion?: string;
      priorChallengeRepeated: boolean;
    };
  };
  /**
   * Typed host-owned control directive issued by the corrective-action
   * controller. Lets the host reconcile execution outcomes against the
   * exact evidence revision a correction targeted; optional for
   * backward-compatible receipts.
   */
  controlAction?: {
    missionId: string;
    missionRevision: string;
    evidenceRevision: string;
    candidateDigest?: string;
    action: string;
    criterionId?: string;
    defectKind?: string;
    requiredOutcome?: string;
    maxAttempts?: number;
    attempt?: number;
    terminalReceipt?: string;
    /** Trusted source references bound to a corrective action or obligation. */
    evidenceRefs?: string[];
    stalled?: boolean;
  };
  /**
   * Originating host that produced the event (e.g. "muse", "claude", "ci",
   * "mcp"). Recorded at append time and NEVER overwritten at retrieval:
   * projection helpers must carry this value through verbatim and must
   * not substitute the retrieving host. See `resolveEventHost`.
   */
  eventHost?: string;
  /**
   * Outcome class: what kind of fact this receipt records.
   * `decision-requested` — an enforcement decision was asked for;
   * `hook-output-emitted` — hook output was produced;
   * `host-action-enforced` — the host enforced an action;
   * `execution-observed` — post-hoc observation of something executed.
   */
  outcome?: ReceiptOutcome;
  /** The host's tool-use identifier, when the event belongs to one call. */
  toolUseId?: string;
  /** Candidate build identity (commit SHA), when the harness provides it. */
  candidate?: string;
  /**
   * Token counters reported by the host lifecycle event. These are
   * diagnostic metadata, not independently verified provider usage or spend.
   */
  hostUsage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  /** Opaque hashes of host-supplied turn and parent-tool identities, when present. */
  hostTurnCorrelationId?: string;
  parentExecutionCorrelationId?: string;
  /** sha256 of complete graph-node output, kept as typed evidence rather than redacted prose. */
  outputDigest?: string;
  /** Terminal graph-node status, kept as structured outcome evidence. */
  executionStatus?: "succeeded" | "failed" | "skipped" | "blocked" | "cancelled" | "outcome_unknown";
  event: string;
  /**
   * Integrity fingerprint of the judged subject (truncated sha256).
   * Tamper-evidence only: it proves WHAT was observed, and is explicitly
   * NOT authentication — it carries no signature, no authority, and grants
   * nothing. Never treat it as permission, approval, or certification.
   */
  subjectHash: string;
  policyVersion: string;
  model?: string;
  probabilities?: Record<string, number>;
  /**
   * Machine-readable judgment outcome (see `JudgmentOutcome`). Optional and
   * advisory-only: it classifies why a slot produced no blocking verdict,
   * never authorization.
   */
  judgment?: string;
  deterministicFindings: string[];
  enforcement: string;
  reasons: string[];
  latencyMs: number;
  error?: string;
}

const REDACTIONS: RegExp[] = [
  /sk-[A-Za-z0-9]{8,}/g,
  /-----BEGIN (?:OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?-----/g,
  /gh[pousr]_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /xox[bpas]-[A-Za-z0-9-]{8,}/g,
  /AIza[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?<=[?&:;,\s'"])(?:password|passwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*[^\s'"]+/gi,
  /:\/\/[^/\s:]+:[^/\s@]+@/g,
];

function redactLine(line: string): string {
  let out = line;
  for (const re of REDACTIONS) {
    re.lastIndex = 0;
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map((item) => normalize(item));
    if (typeof input === "object" && input !== null) {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value)) ?? "null";
}

/** Compare the persisted receipt meaning, excluding per-delivery metadata. */
function idempotencyPayload(record: EvidenceRecord): string {
  const { id: _id, ts: _ts, latencyMs: _latencyMs, ...meaning } = record;
  return canonicalJson(meaning);
}

export interface Retention {
  /** Drop receipts older than this many milliseconds. */
  maxAgeMs?: number;
  /** Keep at most this many of the newest receipts. */
  maxCount?: number;
}

/**
 * Machine-readable ledger-target validation failure. Callers fail closed
 * on any of these: never silently write elsewhere, never downgrade to a
 * different path.
 */
export type LedgerTargetViolation =
  | "LEDGER_SYMLINK"
  | "LEDGER_NOT_REGULAR"
  | "LEDGER_UID_MISMATCH"
  | "LEDGER_MODE"
  | "LEDGER_PARENT_UID"
  | "LEDGER_PARENT_WORLD_WRITABLE"
  | "LEDGER_LOCK_TIMEOUT"
  | "LEDGER_IDEMPOTENCY_CONFLICT"
  | "LEDGER_IO";

export interface LedgerTargetError {
  code: LedgerTargetViolation;
  message: string;
  path: string;
}

export type LedgerTargetCheck = { ok: true } | { ok: false; error: LedgerTargetError };

function currentUid(): number | undefined {
  try {
    return typeof process.getuid === "function" ? process.getuid() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate the ledger target with no-follow semantics: `lstat` (never
 * follows symlinks) rejects symlinks before `stat` resolves anything.
 * Missing file is OK (created with mode 0600); the parent directory must
 * be uid-owned and not world-writable.
 */
export function checkLedgerTarget(ledgerPath: string): LedgerTargetCheck {
  const fail = (code: LedgerTargetViolation, message: string): LedgerTargetCheck => ({
    ok: false,
    error: { code, message, path: ledgerPath },
  });
  const mine = currentUid();
  // Parent-directory gate, shared by both paths: a missing file is
  // created in the parent, so a foreign-owned or world-writable parent
  // fails closed even when nothing exists yet.
  const checkParent = (): LedgerTargetCheck | undefined => {
    let pst;
    try {
      pst = statSync(dirname(ledgerPath));
    } catch (err) {
      return fail("LEDGER_IO", `cannot stat ledger parent: ${(err as Error)?.message ?? String(err)}`);
    }
    if (mine !== undefined && pst.uid !== mine) {
      return fail("LEDGER_PARENT_UID", `ledger parent owned by uid ${pst.uid}, expected ${mine}`);
    }
    if ((pst.mode & 0o002) !== 0) {
      return fail("LEDGER_PARENT_WORLD_WRITABLE", "ledger parent directory is world-writable");
    }
    return undefined;
  };
  let lst;
  try {
    lst = lstatSync(ledgerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return fail("LEDGER_IO", `cannot lstat ledger target: ${(err as Error)?.message ?? String(err)}`);
    }
    return checkParent() ?? { ok: true };
  }
  if (lst.isSymbolicLink()) return fail("LEDGER_SYMLINK", "ledger target is a symlink; refusing to follow");
  let st;
  try {
    st = statSync(ledgerPath);
  } catch (err) {
    return fail("LEDGER_IO", `cannot stat ledger target: ${(err as Error)?.message ?? String(err)}`);
  }
  if (!st.isFile()) return fail("LEDGER_NOT_REGULAR", "ledger target is not a regular file");
  if (mine !== undefined && st.uid !== mine) {
    return fail("LEDGER_UID_MISMATCH", `ledger owned by uid ${st.uid}, expected ${mine}`);
  }
  if ((st.mode & 0o777) !== 0o600) {
    return fail("LEDGER_MODE", `ledger mode is 0${(st.mode & 0o777).toString(8)}, expected 0600`);
  }
  return checkParent() ?? { ok: true };
}

/** Throwing variant of `checkLedgerTarget` for open-time validation. */
export function assertLedgerTarget(ledgerPath: string): void {
  const check = checkLedgerTarget(ledgerPath);
  if (!check.ok) {
    const err = new Error(`[jevidence:${check.error.code}] ${check.error.message} (${check.error.path})`) as Error & {
      code: LedgerTargetViolation;
      ledgerPath: string;
    };
    err.code = check.error.code;
    err.ledgerPath = check.error.path;
    throw err;
  }
}

/** fsync a directory entry so file creation/rename survives a crash. */
function fsyncDirSync(dir: string): void {
  let fd = -1;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Best effort: e.g. filesystems without directory fsync. The file-level
    // fsync still holds; directory durability is degraded, not silent loss.
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export type CorruptReason = "corrupt-truncated" | "corrupt-record";

export interface LedgerCorrupt {
  /** Byte offset of the first bad record from the start of the file. */
  offset: number;
  reason: CorruptReason;
  /** The offending line content (bounded) for diagnostics. */
  line: string;
}

/**
 * Human-facing corruption summary for deny reasons and diagnostics. The byte
 * offset and torn-tail-vs-record classification are what distinguish "the
 * disk tore a write, run maintenance repair" from deeper damage — a bare
 * "ledger is corrupt" leaves the operator guessing.
 */
export function describeLedgerCorrupt(corrupt: LedgerCorrupt): string {
  return `evidence ledger is corrupt (${corrupt.reason} at byte ${corrupt.offset}); maintenance repair required`;
}

export interface LedgerRead {
  records: EvidenceRecord[];
  corrupt?: LedgerCorrupt;
}

/**
 * Candidate build identity for evidence attribution. The harness sets
 * `JEVERB_CANDIDATE` and/or writes the frozen candidate SHA into a
 * `candidate` file next to the ledger. Env wins when both are present;
 * absent both, receipts are unattributed. File content is bounded and a
 * missing/unreadable file is not an error.
 */
/**
 * Candidate stamps stay bounded (a hostile or stray file must not bloat
 * every receipt), but the bound must fit the harness's own identities:
 * `hex` (40) or `hex+dirty:hex` (40+7+64=111). Truncating below that
 * silently breaks receipt-to-candidate correlation for dirty-tree runs.
 */
const MAX_CANDIDATE_STAMP = 256;

function candidateBuild(ledgerPath: string, bundlePath?: string): string | undefined {
  const fromEnv = (process.env["JEVERB_CANDIDATE"] ?? "").trim();
  if (fromEnv !== "") return fromEnv.slice(0, MAX_CANDIDATE_STAMP);
  try {
    const raw = readFileSync(join(dirname(ledgerPath), "candidate"), "utf8").trim();
    if (raw !== "") return raw.slice(0, MAX_CANDIDATE_STAMP);
  } catch {
    // Fall through to the bundle-adjacent file below.
  }
  // Hook transports sanitize subprocess env and may resolve a host-owned
  // data dir the harness cannot predict, so neither channel above may be
  // visible. The running bundle's own install directory is always
  // reachable via argv: the harness plants a `candidate` file at the
  // installed plugin root (never in the frozen source). Bounded walk-up,
  // bounded content, unreadable/missing is silence.
  if (bundlePath !== undefined) {
    let dir = dirname(bundlePath);
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const raw = readFileSync(join(dir, "candidate"), "utf8").trim();
        if (raw !== "") return raw.slice(0, MAX_CANDIDATE_STAMP);
      } catch {
        // Keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
  return undefined;
}

export interface AppendOptions {
  /**
   * Crash-durable write (open + write + fsync + close, plus a directory
   * fsync so the entry itself survives a crash) instead of a plain
   * O_APPEND write. Use for enforcing decisions on protected operations:
   * the receipt must survive a machine crash, not just a clean process
   * exit. Advisory events keep the fast path.
   */
  durable?: boolean;
  /**
   * Stable event key checked under the ledger lock before appending. A
   * matching prior event is a duplicate only when its persisted receipt
   * meaning matches; id, timestamp, and latency are per-delivery metadata.
   * Reusing the key for different receipt content fails closed.
   */
  idempotencyKey?: string;
}

export type AppendResult = { ok: true; duplicate?: true } | { ok: false; error: LedgerTargetError };

export interface LedgerSwitchConfig {
  /** Protected control-state path the suppression check reads. Defaults to the install-wide protected path. */
  switchPath?: string;
  /** Whether the switch file and its parent must be root-owned. Defaults to true. */
  requireRootOwnedSwitch?: boolean;
}

/**
 * Is receipt suppression in force? Consults the authoritative install-wide
 * control state — the same source as `readMasterSwitch` — never a bare
 * marker probe of a user-writable directory. That reader validates the
 * switch file, treats unreadable or missing state as suppressing, and honors
 * the environment override.
 */
function controlSuppressesReceipts(switchPath: string, requireRootOwned: boolean): boolean {
  return readMasterSwitch(dirname(switchPath), environmentDisableOverride(), switchPath, requireRootOwned).effective !== "ON";
}

export class EvidenceLedger {
  constructor(
    readonly path: string,
    private readonly opts: { bundlePath?: string } & LedgerSwitchConfig = {},
  ) {}

  private suppressionActive(): boolean {
    return controlSuppressesReceipts(
      this.opts.switchPath ?? PROTECTED_MASTER_SWITCH_PATH,
      this.opts.requireRootOwnedSwitch ?? true,
    );
  }

  /**
   * Open-time validation: fail closed with a machine-readable error.
   * Refuse targets that could divert evidence: symlinks (hijack the append
   * into another file), non-regular files, files owned by another uid,
   * files not mode 0600, and ledgers whose parent is not uid-owned or is
   * world-writable. A missing file is fine — it is created with mode 0600
   * below, followed by a directory fsync.
   */
  checkTarget(): LedgerTargetCheck {
    return checkLedgerTarget(this.path);
  }

  /**
   * Refuse targets that could divert evidence: symlinks (hijack the append
   * into another file) and files owned by another uid (another user's
   * ledger). A missing file is fine — it is created with mode 0600 below.
   */
  private targetOk(): boolean {
    return this.checkTarget().ok;
  }

  private writeDurable(line: string): void {
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeAllSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Crash durability: fsync the directory entry so a create/append
    // survives a machine crash, not just the file contents.
    fsyncDirSync(dirname(this.path));
  }

  /**
   * Append a receipt. Returns true when the receipt reached disk.
   *
   * Concurrency: append and maintenance rotation share a per-ledger
   * cross-process lock. This prevents a prune rename from detaching the
   * file while a writer appends to the old inode. Contention is bounded by
   * the lock helper; timeout is returned as a typed append failure.
   *
   * Durability: the default write is process-level (the data left the
   * process; a machine crash may still lose it). Pass `{ durable: true }`
   * for enforcing decisions, which fsyncs the file and the directory entry
   * before returning. A torn tail from a crashed non-durable write is
   * detected on read and reported as `corrupt-truncated`, never silently
   * accepted.
   *
   * Provenance: `correlationId` and `eventHost` pass through verbatim —
   * the ledger never mints or overwrites them (only `id` is minted when
   * absent). Retrieval must preserve `eventHost` (see `resolveEventHost`).
   *
   * A false return means enforcement proceeded WITHOUT a receipt — callers
   * gating protected operations must surface that, never swallow it. Use
   * `appendDetailed` for the machine-readable reason.
   */
  append(record: EvidenceRecord, opts: AppendOptions = {}): boolean {
    return this.appendDetailed(record, opts).ok;
  }

  /** Append with a machine-readable failure reason; fails closed. */
  appendDetailed(record: EvidenceRecord, opts: AppendOptions = {}): AppendResult {
    if (this.suppressionActive()) {
      return { ok: false, error: { code: "LEDGER_IO", message: "receipt suppressed by install-wide OFF switch", path: this.path } };
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      fsyncDirSync(dirname(this.path));
      const target = this.checkTarget();
      if (!target.ok) return { ok: false, error: target.error };
      const locked = withFileLock(dirname(this.path), basename(this.path), () => {
        if (this.suppressionActive()) {
          return { ok: false as const, error: { code: "LEDGER_IO" as const, message: "receipt suppressed by install-wide OFF switch", path: this.path } };
        }
        const current = this.checkTarget();
        if (!current.ok) return { ok: false as const, error: current.error };
        // Candidate attribution is ledger-owned so every transport (hooks,
        // daemon, MCP server) stamps identically. An explicit record field
        // wins (caller-supplied correlation); otherwise env, the
        // harness-planted candidate file next to the ledger, or the
        // candidate file at the installed plugin root.
        const candidate = record.candidate ?? candidateBuild(this.path, this.opts.bundlePath);
        const safe: EvidenceRecord = {
          ...record,
          id: record.id || randomUUID(),
          ...(candidate === undefined ? {} : { candidate }),
          reasons: record.reasons.map(redactLine),
          deterministicFindings: record.deterministicFindings.map(redactLine),
          ...(record.error === undefined ? {} : { error: redactLine(record.error) }),
        };
        if (!isValidReceipt(safe)) {
          return {
            ok: false as const,
            error: { code: "LEDGER_IO" as const, message: "receipt failed structural validation", path: this.path },
          };
        }
        if (opts.idempotencyKey !== undefined && existsSync(this.path)) {
          try {
            let duplicate = false;
            for (const line of readFileSync(this.path, "utf8").split("\n")) {
              if (line === "") continue;
              let existing: unknown;
              try {
                existing = JSON.parse(line);
              } catch {
                continue;
              }
              if (!isValidReceipt(existing)) continue;
              const sameScope = existing.correlationId === opts.idempotencyKey &&
                existing.sessionId === safe.sessionId &&
                existing.event === safe.event &&
                existing.toolUseId === safe.toolUseId;
              if (!sameScope) continue;
              if (idempotencyPayload(existing) !== idempotencyPayload(safe)) {
                return {
                  ok: false as const,
                  error: {
                    code: "LEDGER_IDEMPOTENCY_CONFLICT" as const,
                    message: "idempotency key reused for conflicting receipt content",
                    path: this.path,
                  },
                };
              }
              duplicate = true;
            }
            if (duplicate) return { ok: true as const, duplicate: true as const };
          } catch {
            return { ok: false as const, error: { code: "LEDGER_IO" as const, message: "cannot inspect idempotency history", path: this.path } };
          }
        }
        const line = `${JSON.stringify(safe)}\n`;
        if (opts.durable === true) this.writeDurable(line);
        else appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
        return { ok: true as const };
      });
      if (!locked.locked) {
        return {
          ok: false,
          error: {
            code: "LEDGER_LOCK_TIMEOUT",
            message: "append lock timeout",
            path: this.path,
          },
        };
      }
      return locked.value!;
    } catch (err) {
      return {
        ok: false,
        error: { code: "LEDGER_IO", message: (err as Error)?.message ?? String(err), path: this.path },
      };
    }
  }

  /**
   * Read all receipts. A missing ledger reads as zero receipts (no
   * corruption). A torn tail (file not ending in `\n`, or a final line
   * that is not a valid receipt) is reported as `corrupt-truncated`, and
   * any earlier malformed line as `corrupt-record` — with the byte offset
   * of the first bad record. Corrupt reads report corrupt, never empty:
   * records before the first bad record are still returned alongside the
   * `corrupt` descriptor.
   */
  read(): LedgerRead {
    let raw: Buffer;
    try {
      raw = readFileSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { records: [] };
      throw err;
    }
    const text = raw.toString("utf8");
    if (text === "") return { records: [] };
    const records: EvidenceRecord[] = [];
    let offset = 0;
    // Iterate lines while tracking byte offsets for corruption reports.
    const endsWithNewline = text.endsWith("\n");
    const parts = text.split("\n");
    // A trailing "\n" yields a final empty part — not a record.
    const tailEmpty = endsWithNewline ? 1 : 0;
    const lineCount = parts.length - tailEmpty;
    for (let i = 0; i < lineCount; i++) {
      const lineText = parts[i] as string;
      const lineBytes = Buffer.byteLength(lineText, "utf8") + 1; // + "\n", except possibly the torn tail
      const isTail = i === lineCount - 1;
      const terminated = isTail ? endsWithNewline : true;
      const lineOffset = offset;
      offset += terminated ? lineBytes : Buffer.byteLength(lineText, "utf8");
      if (lineText === "" && terminated) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lineText);
      } catch {
        return {
          records,
          corrupt: {
            offset: lineOffset,
            reason: !terminated ? "corrupt-truncated" : "corrupt-record",
            line: lineText.slice(0, 280),
          },
        };
      }
      if (!isValidReceipt(parsed)) {
        return {
          records,
          corrupt: {
            offset: lineOffset,
            reason: !terminated ? "corrupt-truncated" : "corrupt-record",
            line: lineText.slice(0, 280),
          },
        };
      }
      records.push(parsed);
    }
    // Non-empty file with content after the last newline that split()
    // already handled above; the remaining torn-tail case is an unterminated
    // final line that parsed as JSON but may still be a partial write of a
    // longer line. A valid receipt on an unterminated tail is indistinguishable
    // from a clean write that lost its newline, so report it truncated too:
    // durability requires the newline as the commit marker.
    if (!endsWithNewline && records.length > 0) {
      const lastStart = raw.length - Buffer.byteLength(parts[lineCount - 1] as string, "utf8");
      // Recompute: if the tail parsed, it is still a torn framing.
      return {
        records: records.slice(0, -1),
        corrupt: {
          offset: lastStart,
          reason: "corrupt-truncated",
          line: (parts[lineCount - 1] as string).slice(0, 280),
        },
      };
    }
    return { records };
  }

  /**
   * Enforce retention explicitly. One-shot hook processes never auto-prune
   * (a hook must not delete evidence as a side effect of judging); call
   * this from maintenance flows. Returns the number of receipts kept.
   * The rewrite is atomic (temp file + rename) with file and directory
   * fsyncs so a crash during rotate never loses the ledger.
   */
  prune(retention: Retention, nowMs: number = Date.now()): number {
    const target = this.checkTarget();
    if (!target.ok) return 0;
    try {
      const locked = withFileLock(dirname(this.path), basename(this.path), () => this.pruneLocked(retention, nowMs));
      return locked.locked ? locked.value! : 0;
    } catch {
      return 0;
    }
  }

  private pruneLocked(retention: Retention, nowMs: number): number {
    const target = this.checkTarget();
    if (!target.ok) return 0;
    let lines: string[];
    try {
      lines = readFileSync(this.path, "utf8").split("\n").filter((l) => l.length > 0);
    } catch {
      return 0;
    }
    let kept = lines;
    if (retention.maxAgeMs !== undefined) {
      const cutoff = new Date(nowMs - retention.maxAgeMs).toISOString();
      kept = kept.filter((line) => {
        try {
          const r = JSON.parse(line) as { ts?: unknown };
          return typeof r.ts !== "string" || r.ts >= cutoff;
        } catch {
          return false;
        }
      });
    }
    if (retention.maxCount !== undefined && kept.length > retention.maxCount) {
      kept = kept.slice(kept.length - retention.maxCount);
    }
    atomicWriteFileSync(this.path, kept.length > 0 ? `${kept.join("\n")}\n` : "");
    return kept.length;
  }

  /**
   * Maintenance-only recovery from a crash-torn tail. Truncates the file at
   * the first corrupt byte offset when — and only when — the corruption is a
   * torn tail (`corrupt-truncated`); earlier valid records are preserved byte
   * for byte, and a post-truncation read verifies the ledger is clean before
   * reporting success. Mid-file `corrupt-record` corruption is never trimmed:
   * the intent of the surrounding bytes is unknowable, so that stays manual
   * surgery. Never called automatically from hook paths; run it from explicit
   * maintenance flows after a crash is suspected.
   */
  repair(): LedgerRepairResult {
    const target = this.checkTarget();
    if (!target.ok) return { repaired: false, reason: "unrepairable" };
    let locked: LockOutcome<LedgerRepairResult>;
    try {
      locked = withFileLock(dirname(this.path), basename(this.path), () => this.repairLocked());
    } catch {
      return { repaired: false, reason: "unrepairable" };
    }
    if (!locked.locked || locked.value === undefined) return { repaired: false, reason: "unrepairable" };
    return locked.value;
  }

  private repairLocked(): LedgerRepairResult {
    let read: LedgerRead;
    try {
      read = this.read();
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { repaired: false, reason: "missing" };
      throw err;
    }
    if (read.corrupt === undefined) return { repaired: false, reason: "clean" };
    if (read.corrupt.reason !== "corrupt-truncated") return { repaired: false, reason: "unrepairable" };
    const at = read.corrupt.offset;
    const raw = readFileSync(this.path);
    atomicWriteFileSync(this.path, raw.subarray(0, at));
    // The truncation must itself yield a clean ledger; anything else means
    // the corruption was not really a tail, so report failure, not success.
    if (this.read().corrupt !== undefined) return { repaired: false, reason: "unrepairable" };
    return { repaired: true, truncatedAt: at };
  }
}

export interface LedgerRepairResult {
  repaired: boolean;
  /** Byte offset the file was truncated to, when repaired. */
  truncatedAt?: number;
  /** Why nothing was done: clean ledger, missing file, or unrepairable corruption. */
  reason?: "clean" | "missing" | "unrepairable";
}
