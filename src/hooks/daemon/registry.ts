/**
 * Which sessions the daemon is serving, and with what settings.
 *
 * One daemon serves every Claude Code session on the machine, and two sessions
 * can be configured differently — one with `gate: strict`, one with the gate
 * off entirely. A command hook read its configuration from its own environment
 * and could not get this wrong; a shared daemon has to be told.
 *
 * `SessionStart` posts the snapshot to `/v1/session/start`. The secret, the
 * data directory, the warnings and the kill switch are excluded: the key is the
 * daemon's own (it is what authorized the request in the first place), the data
 * directory travels separately because it is a path rather than a setting, the
 * warnings are for `/jev:status` to print out of the reader's own environment,
 * and `disabled` is `JEV_HOOKS_DISABLE`, which stops the hook before it ever
 * reaches the daemon.
 *
 * The snapshot is also written into the session file, so a daemon that was
 * replaced mid-session — a plugin update, a crash, a `/jev:daemon restart` —
 * can reload it from disk for a session id it has never seen instead of judging
 * that session with the wrong settings.
 */

import { COMMIT_ENFORCEMENT_LEVELS, GATE_LEVELS, LINT_LEVELS, type CommitEnforcement, type GateLevel, type HookConfig, type LintLevel } from "../config.js";
import { PROTECTED_MASTER_SWITCH_PATH } from "../../control/constants.js";

/**
 * A session's configuration as the daemon needs it: everything except the
 * secret, the path, the warnings and the kill switch.
 */
export type SessionConfig = Omit<HookConfig, "apiKey" | "warnings" | "dataDir" | "disabled" | "masterSwitchPath">;

export function sessionConfigOf(config: HookConfig): SessionConfig {
  const { apiKey: _apiKey, warnings: _warnings, dataDir: _dataDir, disabled: _disabled, masterSwitchPath: _switchPath, ...rest } = config;
  return rest;
}

/** Rebuild a full `HookConfig` from a snapshot plus this daemon's secrets. */
export function hookConfigFrom(
  snapshot: SessionConfig,
  apiKey: string | null,
  dataDir: string,
  masterSwitchPath = PROTECTED_MASTER_SWITCH_PATH,
): HookConfig {
  return { ...snapshot, apiKey, dataDir, masterSwitchPath, disabled: false, warnings: [] };
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/**
 * Validate a snapshot that arrived over HTTP or came back off disk.
 *
 * Every field is checked and anything unrecognized falls back to the daemon's
 * own value rather than being repaired or trusted. A session config decides
 * whether a tool call is judged at all, so "it was in a JSON file we wrote" is
 * not a good enough reason to believe a number.
 */
export function readSessionConfig(raw: unknown, fallback: SessionConfig): SessionConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const gateRaw = value.gate;
  const gate: GateLevel =
    typeof gateRaw === "string" && (GATE_LEVELS as readonly string[]).includes(gateRaw)
      ? (gateRaw as GateLevel)
      : fallback.gate;
  const commitEnforcement: CommitEnforcement =
    typeof value.commitEnforcement === "string" && (COMMIT_ENFORCEMENT_LEVELS as readonly string[]).includes(value.commitEnforcement)
      ? (value.commitEnforcement as CommitEnforcement)
      : fallback.commitEnforcement;
  const auto = num(value.autoThreshold, fallback.autoThreshold, 0.01, 0.99);
  const backendRaw = value.backend;
  const backend: "typesafe" | "openrouter" | "jev-gateway" =
    backendRaw === "openrouter" || backendRaw === "typesafe" || backendRaw === "jev-gateway" ? backendRaw : fallback.backend;
  return {
    backend,
    // Calibration is install policy, not session-authored state. A persisted
    // session snapshot cannot enable a protected completion verdict.
    missionClosurePolicy: fallback.missionClosurePolicy,
    allowCustomRelay: bool(value.allowCustomRelay, fallback.allowCustomRelay),
    baseUrl: str(value.baseUrl, fallback.baseUrl),
    model: str(value.model, fallback.model),
    timeoutMs: num(value.timeoutMs, fallback.timeoutMs, 100, 10_000),
    maxRetries: num(value.maxRetries, fallback.maxRetries, 0, 10),
    gate,
    commitEnforcement,
    askOnTrip: bool(value.askOnTrip, fallback.askOnTrip),
    stopCheck: bool(value.stopCheck, fallback.stopCheck),
    screenResults: bool(value.screenResults, fallback.screenResults),
    routePrompts: bool(value.routePrompts, fallback.routePrompts),
    lint:
      typeof value.lint === "string" && (LINT_LEVELS as readonly string[]).includes(value.lint)
        ? (value.lint as LintLevel)
        : fallback.lint,
    lintConventions: bool(value.lintConventions, fallback.lintConventions),
    verifyClaims: bool(value.verifyClaims, fallback.verifyClaims),
    adversarialClosure: bool(value.adversarialClosure, fallback.adversarialClosure),
    autoThreshold: auto,
    reviewThreshold: Math.min(num(value.reviewThreshold, fallback.reviewThreshold, 0.01, 0.99), auto),
    confidenceThreshold: num(value.confidenceThreshold, fallback.confidenceThreshold, 0.5, 0.99),
    daemonPort: num(value.daemonPort, fallback.daemonPort, 0, 65_535),
    daemonIdleMs: num(value.daemonIdleMs, fallback.daemonIdleMs, 1000, 24 * 60 * 60 * 1000),
    evidenceRetentionDays: num(value.evidenceRetentionDays, fallback.evidenceRetentionDays, 1, 3650),
    evidenceMaxRecords: Math.floor(num(value.evidenceMaxRecords, fallback.evidenceMaxRecords, 10_000, 10_000_000)),
  };
}

export interface SessionEntry {
  id: string;
  dataDir: string;
  config: SessionConfig;
  started_at: number;
  /**
   * `credentialId` of the credential that created the session.
   *
   * A request naming this session acts with its config, data directory and
   * evidence only when it presents this same credential (or the admin
   * capability on an admin route). `undefined` means the entry predates
   * binding — reloaded from a disk snapshot by `makeDepsFor` on a daemon
   * that never saw the session start — and the server binds it to the first
   * credential that uses it rather than leaving it ownerless.
   */
  creator: string | undefined;
}

/** In-memory only. Disk stays the source of truth for everything durable. */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  start(id: string, dataDir: string, config: SessionConfig, creator?: string): SessionEntry {
    const entry: SessionEntry = { id, dataDir, config, started_at: this.now(), creator };
    this.sessions.set(id, entry);
    return entry;
  }

  /**
   * Bind an unbound entry (disk reload path) to the credential using it now.
   *
   * Never rebinds: once a creator is recorded, only `start` (a lifecycle
   * route, itself credential-checked) moves it. That is what makes rotation
   * safe — a new credential cannot silently adopt another session's binding
   * by posting a hook for it; it has to re-register the session.
   */
  bindIfAbsent(id: string, creator: string): void {
    const entry = this.sessions.get(id);
    if (entry !== undefined && entry.creator === undefined) entry.creator = creator;
  }

  end(id: string): boolean {
    return this.sessions.delete(id);
  }

  get(id: string): SessionEntry | undefined {
    return this.sessions.get(id);
  }

  count(): number {
    return this.sessions.size;
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }
}
