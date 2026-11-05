/**
 * Hook configuration, read from the environment.
 *
 * Claude Code exports each plugin `userConfig` value to hook processes as
 * `CLAUDE_PLUGIN_OPTION_<KEY>`; a shell-form hook command cannot interpolate
 * `${user_config.*}` at all, so the environment is the only channel. Every
 * option also has a `JEV_*` fallback so the hooks work when the code is wired
 * up by hand rather than installed as a plugin.
 *
 * Provider credentials come from (in order) the explicit plugin option / env
 * (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`), then a user-controlled
 * credential file at `$JEV_CREDENTIALS_FILE` or
 * `~/.config/jeverb/credentials`. Keys never travel in hook argv or the plugin
 * manifest — only through these two channels.
 *
 * Nothing here throws. A hook that dies on a malformed option is a hook that
 * breaks someone's session over a typo, so every value falls back to its
 * default and the fact is recorded in `warnings`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_IDLE_MS, DEFAULT_PORT } from "./daemon/protocol.js";
import { hashQuestions } from "../decision/provenance.js";
import { canonicalPolicyHash, questionSetHashFor, releasePolicyFloorSatisfied, verifyQualificationManifest, verifyThreeStageManifest } from "../jev/qualification.js";
import { MISSION_CLOSURE_POLICY_VERSION, MISSION_CLOSURE_QUESTION, type MissionClosurePolicy } from "../mission/closure.js";
import { protectedMasterSwitchPath } from "../control/constants.js";
import { HOOK_VERSION } from "./version.js";

/**
 * How much the tool gate says.
 *
 * `off`: nothing at all. `advisory`: the default — a note to the agent after
 * the fact, and a tripwire before execution for the two block-grade cases.
 * `strict`: also judges ordinary in-project edits, and notes the cases advisory
 * mode keeps to itself (a local overwrite the user asked for, a firm
 * out-of-scope reading with no risk signal).
 */
export const GATE_LEVELS = ["off", "advisory", "strict"] as const;
export type GateLevel = (typeof GATE_LEVELS)[number];

export const LINT_LEVELS = ["off", "tripwire", "advisory"] as const;
export type LintLevel = (typeof LINT_LEVELS)[number];
export const COMMIT_ENFORCEMENT_LEVELS = ["advisory", "mandatory"] as const;
export type CommitEnforcement = (typeof COMMIT_ENFORCEMENT_LEVELS)[number];

/** 0.2.x `gate_mode` values, and what each one means as a `gate`. */
const GATE_MODE_MIGRATION: Record<string, GateLevel> = {
  off: "off",
  standard: "advisory",
  strict: "strict",
};

export interface HookConfig {
  apiKey: string | null;
  /** Explicit protocol selector. Never derived from URL equality. */
  backend: "typesafe" | "openrouter" | "jev-gateway";
  /**
   * Approval to forward credentials to an OpenRouter-compatible relay URL
   * (free-only proxy, qualification harness). Without it, an openrouter
   * backend with a non-official base URL is a construction error, not a
   * silent fallthrough to the native client.
   */
  allowCustomRelay: boolean;
  baseUrl: string;
  model: string;
  /** Exact backend/model/question calibration required for terminal closure. */
  missionClosurePolicy: MissionClosurePolicy;
  /**
   * Operator toggle for the adversarial closure pair (Jev A + Jev B).
   * Off by default: pair mode doubles inference at each completion
   * checkpoint and requires a calibrated provider path. Deterministic
   * preflight and the single-judge gate keep operating either way.
   */
  adversarialClosure: boolean;
  /** Deadline for one Jev call inside a hook. Deliberately short. */
  timeoutMs: number;
  maxRetries: number;
  gate: GateLevel;
  /** Advisory by default; mandatory review requires explicit configuration. */
  commitEnforcement: CommitEnforcement;
  /**
   * The only way a human is ever prompted by this plugin: a tripwire emits
   * `ask` instead of `deny`, in the modes where a prompt has an audience.
   */
  askOnTrip: boolean;
  stopCheck: boolean;
  screenResults: boolean;
  routePrompts: boolean;
  /**
   * Semantic code lint on in-project edits. `tripwire`: only the block-grade
   * checks (a hardcoded secret, a removed test) trip; `advisory`: notes for the
   * rest, the CLAUDE.md conventions and commit scope; `off`: none.
   */
  lint: LintLevel;
  /** Ask one Noul per extracted CLAUDE.md convention line. */
  lintConventions: boolean;
  /** The model half of the Stop claim check (git diff HEAD). Stage 1 is free. */
  verifyClaims: boolean;
  autoThreshold: number;
  reviewThreshold: number;
  /**
   * The bar a Choice answer's `confidence` has to clear.
   *
   * Separate from `autoThreshold` because it is a different kind of quantity.
   * A Noul's `P(yes)` and a Score level's mass are both probabilities of a
   * binary event, so they share `auto`/`review`; a Choice's `confidence` is a
   * peakedness statistic over the option distribution, and holding it to a
   * probability threshold is a category error that happens to compile.
   */
  confidenceThreshold: number;
  /**
   * Loopback port the daemon listens on.
   *
   * `hooks.json` can interpolate environment variables into *headers* only, so
   * the URL in the manifest carries the literal default and this setting exists
   * for tests and for a hand-wired install. Changing it without changing the
   * manifest moves the daemon somewhere the http hooks do not look.
   */
  daemonPort: number;
  /** No request for this long and the daemon exits rather than sit resident. */
  daemonIdleMs: number;
  /**
   * Evidence retention enforced by daily maintenance: records older than
   * this many days, and oldest beyond the record cap, are pruned from the
   * evidence ledger, and graph journals older than this many days are
   * removed. Bounds ledger growth so reads stay well under the stale-lock
   * takeover window. Generous defaults: this trims ancient history, not
   * working state — missions never span retention windows this wide.
   */
  evidenceRetentionDays: number;
  evidenceMaxRecords: number;
  /** Directory for session files and the decision log. */
  dataDir: string;
  /** Fixed protected state source; never read from environment or plugin config. */
  masterSwitchPath: string;
  /** `JEV_HOOKS_DISABLE=1`: every hook becomes a no-op. */
  disabled: boolean;
  /** Malformed option values, for `/jev:status`. */
  warnings: string[];
}

export const HOOK_DEFAULTS = {
  baseUrl: "https://api.typesafe.ai",
  /**
   * Pinned, not an alias. `jev-latest` re-points silently when a release
   * ships, and every probability the thresholds here are tuned against moves
   * with it — including the ones `/jev:calibrate` replays over a log captured
   * from a different model. A user who wants to follow releases sets
   * `jev-latest` deliberately.
   */
  model: "jev-1.14.0",
  timeoutMs: 1500,
  maxRetries: 0,
  gate: "advisory" as GateLevel,
  commitEnforcement: "advisory" as CommitEnforcement,
  askOnTrip: false,
  stopCheck: true,
  screenResults: true,
  routePrompts: false,
  lint: "advisory" as LintLevel,
  lintConventions: true,
  verifyClaims: true,
  adversarialClosure: false,
  autoThreshold: 0.85,
  reviewThreshold: 0.6,
  confidenceThreshold: 0.85,
  daemonPort: DEFAULT_PORT,
  daemonIdleMs: DEFAULT_IDLE_MS,
  evidenceRetentionDays: 365,
  evidenceMaxRecords: 100_000,
} as const;

export type Env = Record<string, string | undefined>;

/** OpenRouter Jev default. Runtime receipts bind the actual returned version. */
export const OPENROUTER_DEFAULTS = {
  baseUrl: "https://openrouter.ai/api/v1",
  model: "typesafe/jev-latest",
} as const;

export const JEV_GATEWAY_DEFAULTS = {
  baseUrl: "http://127.0.0.1:18769/jev",
  model: "typesafe/jev-1.14",
} as const;

/** Fields a credentials file may carry. Nothing else is read from it. */
const CREDENTIAL_FIELDS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"] as const;
type CredentialField = (typeof CREDENTIAL_FIELDS)[number];

/**
 * Non-secret install settings from the resolved data dir (`config.json`).
 * Hook transports sanitize operator env, but the data dir is always
 * reachable — it is where the hook already reads and writes. A supervised
 * install or the qualification harness may plant backend, transport, and
 * policy settings there. Env always wins; a malformed field is ignored with a
 * warning, never fatal.
 */
export interface DataDirConfig {
  backend?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxConcurrency?: number;
  allowCustomRelay?: boolean;
  gate?: GateLevel;
  commitEnforcement?: CommitEnforcement;
  askOnTrip?: boolean;
  stopCheck?: boolean;
  screenResults?: boolean;
  routePrompts?: boolean;
  lint?: LintLevel;
  lintConventions?: boolean;
  verifyClaims?: boolean;
  autoThreshold?: number;
  reviewThreshold?: number;
  confidenceThreshold?: number;
  daemonPort?: number;
  daemonIdleMs?: number;
  evidenceRetentionDays?: number;
  evidenceMaxRecords?: number;
  missionClosure?: {
    calibrated: boolean;
    minConfidence: number;
    modelVersion: string;
    questionHash: string;
    calibrationVersion: string;
    /** Optional calibration record for the adversarial gap-question family. */
    adversarialCalibrationVersion?: string;
    /**
     * Optional path to a qualification manifest (resolved against the data
     * dir). When set, closure is calibrated only if the manifest verifies
     * against the active deployment identity and recomputed artifacts.
     */
    qualificationManifest?: string;
  };
  adversarialClosure?: boolean;
}

export function readDataDirConfig(path: string, warnings: string[]): DataDirConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`data-dir config at ${path} is not valid JSON; ignoring it.`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`data-dir config at ${path} is not a JSON object; ignoring it.`);
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const out: DataDirConfig = {};
  if (typeof record.timeout_ms === "number" && Number.isFinite(record.timeout_ms)) {
    out.timeoutMs = Math.floor(record.timeout_ms);
  } else if (record.timeout_ms !== undefined) {
    warnings.push("data-dir config timeout_ms is not a number; ignoring it.");
  }
  for (const [field, key, min, max] of [
    ["maxRetries", "max_retries", 0, 10],
    ["maxConcurrency", "max_concurrency", 1, 32],
  ] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) {
      out[field] = Math.floor(value);
    } else if (value !== undefined) {
      warnings.push(`data-dir config ${key} is outside [${min}, ${max}]; ignoring it.`);
    }
  }
  if (typeof record.backend === "string" && record.backend.trim() !== "") {
    const backend = record.backend.trim().toLowerCase();
    if (backend === "openrouter" || backend === "typesafe" || backend === "native" || backend === "jev-gateway") {
      out.backend = backend;
    } else {
      warnings.push(`data-dir config backend ${JSON.stringify(record.backend)} is unknown; ignoring it.`);
    }
  }
  if (typeof record.allow_custom_relay === "boolean") {
    out.allowCustomRelay = record.allow_custom_relay;
  } else if (record.allow_custom_relay !== undefined) {
    warnings.push("data-dir config allow_custom_relay is not a boolean; ignoring it.");
  }
  if (typeof record.base_url === "string" && record.base_url.trim() !== "") out.baseUrl = record.base_url.trim();
  if (typeof record.model === "string" && record.model.trim() !== "") out.model = record.model.trim();
  if (typeof record.gate === "string" && (GATE_LEVELS as readonly string[]).includes(record.gate.toLowerCase())) {
    out.gate = record.gate.toLowerCase() as GateLevel;
  } else if (record.gate !== undefined) {
    warnings.push(`data-dir config gate ${JSON.stringify(record.gate)} is not one of ${GATE_LEVELS.join("|")}; ignoring it.`);
  }
  if (typeof record.commit_enforcement === "string" && (COMMIT_ENFORCEMENT_LEVELS as readonly string[]).includes(record.commit_enforcement.toLowerCase())) {
    out.commitEnforcement = record.commit_enforcement.toLowerCase() as CommitEnforcement;
  } else if (record.commit_enforcement !== undefined) {
    warnings.push(`data-dir config commit_enforcement ${JSON.stringify(record.commit_enforcement)} is invalid; ignoring it.`);
  }
  for (const [field, key] of [
    ["askOnTrip", "ask_on_trip"],
    ["stopCheck", "stop_check"],
    ["screenResults", "screen_results"],
    ["routePrompts", "route_prompts"],
    ["lintConventions", "lint_conventions"],
    ["verifyClaims", "verify_claims"],
    ["adversarialClosure", "adversarial_closure"],
  ] as const) {
    const value = record[key];
    if (typeof value === "boolean") out[field] = value;
    else if (value !== undefined) warnings.push(`data-dir config ${key} is not a boolean; ignoring it.`);
  }
  if (typeof record.lint === "string" && (LINT_LEVELS as readonly string[]).includes(record.lint.toLowerCase())) {
    out.lint = record.lint.toLowerCase() as LintLevel;
  } else if (record.lint !== undefined) {
    warnings.push(`data-dir config lint ${JSON.stringify(record.lint)} is not one of ${LINT_LEVELS.join("|")}; ignoring it.`);
  }
  for (const [field, key, min, max] of [
    ["autoThreshold", "auto_threshold", 0.01, 0.99],
    ["reviewThreshold", "review_threshold", 0.01, 0.99],
    ["confidenceThreshold", "confidence_threshold", 0.5, 0.99],
    ["daemonPort", "daemon_port", 0, 65_535],
    ["daemonIdleMs", "daemon_idle_ms", 1_000, 86_400_000],
    ["evidenceRetentionDays", "evidence_retention_days", 1, 3650],
    ["evidenceMaxRecords", "evidence_max_records", 10_000, 10_000_000],
  ] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) {
      const integral = key === "daemon_port" || key === "daemon_idle_ms" || key === "evidence_retention_days" ||
        key === "evidence_max_records";
      out[field] = (integral ? Math.floor(value) : value) as never;
    } else if (value !== undefined) {
      warnings.push(`data-dir config ${key} is outside [${min}, ${max}]; ignoring it.`);
    }
  }
  if (record.mission_closure !== undefined) {
    const closure = record.mission_closure;
    if (typeof closure !== "object" || closure === null || Array.isArray(closure)) {
      warnings.push("data-dir config mission_closure is not an object; ignoring it.");
    } else {
      const value = closure as Record<string, unknown>;
      if (
        typeof value.calibrated === "boolean" &&
        typeof value.min_confidence === "number" && Number.isFinite(value.min_confidence) && value.min_confidence > 0 && value.min_confidence <= 1 &&
        typeof value.model_version === "string" && value.model_version.trim() !== "" &&
        typeof value.question_hash === "string" && /^[0-9a-f]{64}$/.test(value.question_hash) &&
        typeof value.calibration_version === "string" && value.calibration_version.trim() !== ""
      ) {
        out.missionClosure = {
          calibrated: value.calibrated,
          minConfidence: value.min_confidence,
          modelVersion: value.model_version.trim(),
          questionHash: value.question_hash,
          calibrationVersion: value.calibration_version.trim(),
          ...(typeof value.adversarial_calibration_version === "string" &&
          value.adversarial_calibration_version.trim() !== ""
            ? { adversarialCalibrationVersion: value.adversarial_calibration_version.trim() }
            : {}),
          ...(typeof value.qualification_manifest === "string" &&
          value.qualification_manifest.trim() !== ""
            ? { qualificationManifest: value.qualification_manifest.trim() }
            : {}),
        };
      } else {
        warnings.push("data-dir config mission_closure is incomplete or invalid; closure remains uncalibrated.");
      }
    }
  }
  return out;
}

/**
 * Verify a configured mission-closure-3stage qualification manifest.
 * Reconstructs the exact bench policy the rows were recorded under —
 * calibrated premise, pinned model version, lockbox bench version — and
 * replays the independent verifier: byte hashes, split independence,
 * record validity, stage-transition legality, recomputed tallies, and the
 * safety/liveness gate. Any failure degrades to uncalibrated with a
 * warning; a qualified decision alone never calibrates.
 */
function verifyThreeStageRuntime(
  resolvedManifest: string,
  record: Record<string, unknown>,
  active: { backend: string; model: string; modelVersion: string; questionHash: string; minConfidence: number; calibrationVersion: string },
  warnings: string[],
): boolean {
  const fail = (reason: string): boolean => {
    warnings.push(`mission_closure 3stage qualification manifest at ${resolvedManifest} ${reason}; closure remains uncalibrated.`);
    return false;
  };
  if (
    typeof record["datasetPath"] !== "string" || typeof record["receiptsPath"] !== "string" ||
    typeof record["developmentDatasetPath"] !== "string"
  ) {
    return fail("names no dataset/development/stage-rows artifacts");
  }
  if (record["datasetSplit"] === "lockbox" && typeof record["validationDatasetPath"] !== "string") {
    return fail("names no validation dataset artifact");
  }
  if (typeof record["calibrationVersion"] !== "string") {
    return fail("names no calibration version");
  }
  // The runtime calibration version is owned by configuration, not by the
  // manifest: a manifest bound to a different calibration cannot activate
  // this deployment even if every other binding matches.
  if (record["calibrationVersion"] !== active.calibrationVersion) {
    return fail(
      `calibration version ${JSON.stringify(record["calibrationVersion"])} does not match the active runtime version ${JSON.stringify(active.calibrationVersion)}`,
    );
  }
  // The trusted release policy owns the bar: the loader verifies the
  // manifest thresholds against the policy floor itself instead of
  // suppressing the comparison. A weakened qualified manifest cannot
  // activate production even if it verified elsewhere.
  if (record["decision"] === "qualified") {
    const floor = releasePolicyFloorSatisfied(record["thresholds"] as Record<string, unknown>);
    if (!floor.ok) {
      return fail(`release policy floor not met (${floor.reasons.join("; ")})`);
    }
  }
  const manifestDir = dirname(resolvedManifest);
  const policy: MissionClosurePolicy = {
    policyVersion: MISSION_CLOSURE_POLICY_VERSION,
    minConfidence: active.minConfidence,
    calibrated: true,
    backend: String(record["backend"] ?? ""),
    model: String(record["model"] ?? ""),
    modelVersion: String(record["modelVersion"] ?? ""),
    questionHash: active.questionHash,
    calibrationVersion: record["calibrationVersion"] as string,
  };
  const verification = verifyThreeStageManifest(
    record,
    {
      datasetPath: resolve(manifestDir, record["datasetPath"] as string),
      developmentDatasetPath: resolve(manifestDir, record["developmentDatasetPath"] as string),
      ...(typeof record["validationDatasetPath"] === "string"
        ? { validationDatasetPath: resolve(manifestDir, record["validationDatasetPath"]) }
        : {}),
      receiptsPath: resolve(manifestDir, record["receiptsPath"] as string),
    },
    {
      backend: active.backend,
      model: active.model,
      modelVersion: active.modelVersion,
      adapterVersion: HOOK_VERSION,
      questionSetHash: questionSetHashFor([active.questionHash]),
      policyHash: canonicalPolicyHash({
        policyVersion: MISSION_CLOSURE_POLICY_VERSION,
        questionHash: active.questionHash,
        minConfidence: active.minConfidence,
      }),
    },
    policy,
  );
  if (!verification.ok) {
    warnings.push(`mission_closure 3stage qualification manifest failed verification (${verification.reasons.join("; ")}); closure remains uncalibrated.`);
    return false;
  }
  if (!verification.authorizes) {
    warnings.push(
      `mission_closure 3stage qualification manifest does not authorize closure ` +
      `(${verification.reasons.join("; ")}); closure remains uncalibrated.`,
    );
    return false;
  }
  return true;
}

/**
 * Verify a configured mission-closure qualification manifest against the
 * active deployment identity. Relative paths resolve against the data dir
 * for the manifest and against the manifest file for its artifacts.
 * Returns true only when the manifest verifies AND records a qualified
 * release; every failure degrades to uncalibrated with a warning.
 */
export function verifyMissionClosureManifest(
  dataDir: string,
  manifestPath: string,
  active: { backend: string; model: string; modelVersion: string; questionHash: string; minConfidence: number; calibrationVersion: string },
  warnings: string[],
): boolean {
  const resolvedManifest = resolve(dataDir, manifestPath);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(resolvedManifest, "utf8")) as unknown;
  } catch {
    warnings.push(`mission_closure qualification manifest at ${resolvedManifest} cannot be read; closure remains uncalibrated.`);
    return false;
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    warnings.push(`mission_closure qualification manifest at ${resolvedManifest} is not an object; closure remains uncalibrated.`);
    return false;
  }
  const record = manifest as Record<string, unknown>;
  if (record["family"] !== "mission-closure" && record["family"] !== "mission-closure-3stage") {
    warnings.push(`mission_closure qualification manifest at ${resolvedManifest} is for family ${JSON.stringify(record["family"])}; closure remains uncalibrated.`);
    return false;
  }
  if (record["family"] === "mission-closure-3stage") {
    return verifyThreeStageRuntime(resolvedManifest, record, active, warnings);
  }
  if (
    typeof record["datasetPath"] !== "string" || typeof record["receiptsPath"] !== "string" ||
    typeof record["developmentDatasetPath"] !== "string"
  ) {
    warnings.push(`mission_closure qualification manifest at ${resolvedManifest} names no dataset/development/receipts artifacts; closure remains uncalibrated.`);
    return false;
  }
  if (record["datasetSplit"] === "lockbox" && typeof record["validationDatasetPath"] !== "string") {
    warnings.push(`mission_closure lockbox qualification manifest at ${resolvedManifest} names no validation dataset artifact; closure remains uncalibrated.`);
    return false;
  }
  const manifestDir = dirname(resolvedManifest);
  const verification = verifyQualificationManifest(
    manifest,
    {
      datasetPath: resolve(manifestDir, record["datasetPath"]),
      developmentDatasetPath: resolve(manifestDir, record["developmentDatasetPath"]),
      ...(typeof record["validationDatasetPath"] === "string"
        ? { validationDatasetPath: resolve(manifestDir, record["validationDatasetPath"]) }
        : {}),
      receiptsPath: resolve(manifestDir, record["receiptsPath"]),
    },
    {
      backend: active.backend,
      model: active.model,
      modelVersion: active.modelVersion,
      adapterVersion: HOOK_VERSION,
      questionSetHash: questionSetHashFor([active.questionHash]),
      thresholds: { minConfidence: active.minConfidence },
      policyHash: canonicalPolicyHash({
        policyVersion: MISSION_CLOSURE_POLICY_VERSION,
        questionHash: active.questionHash,
        minConfidence: active.minConfidence,
      }),
    },
  );
  if (!verification.ok) {
    warnings.push(`mission_closure qualification manifest failed verification (${verification.reasons.join("; ")}); closure remains uncalibrated.`);
    return false;
  }
  if (!verification.authorizes) {
    warnings.push(
      `mission_closure qualification manifest does not authorize closure ` +
      `(${verification.reasons.join("; ")}); closure remains uncalibrated.`,
    );
    return false;
  }
  return true;
}

/** Where hook credentials live when they are not in the environment. */
export function resolveCredentialsPath(env: Env = process.env): string {
  const explicit = env.JEV_CREDENTIALS_FILE?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  return join(env.HOME?.trim() || homedir(), ".config", "jeverb", "credentials");
}

/**
/**
 * Persist the adversarial-closure operator toggle to the install-scoped
 * data-dir `config.json`. Reads are tolerant (a missing or malformed file
 * behaves as defaults); writes are strict and report failure instead of
 * pretending the toggle flipped. Never throws; never touches credentials.
 */
export function writeAdversarialClosure(
  dataDir: string,
  enabled: boolean,
): { ok: true; path: string } | { ok: false; reason: string } {
  const path = join(dataDir, "config.json");
  let record: Record<string, unknown> = {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: `data-dir config at ${path} is not a JSON object; refusing to rewrite it` };
    }
    record = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, reason: `data-dir config at ${path} is unreadable; refusing to rewrite it` };
    }
  }
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify({ ...record, adversarial_closure: enabled }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, path };
}

/** Read the credential file: a JSON object with optional `TYPESAFE_API_KEY` /
 * `OPENROUTER_API_KEY` string fields. Never throws and never leaks key
 * material into warnings. A missing file is silence (no credential
 * configured); anything unreadable, malformed, or too broadly permissioned is
 * ignored with a warning.
 */
export function readFileCredentials(path: string, warnings: string[]): Partial<Record<CredentialField, string>> {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return {};
  }
  // 0600 or stricter: no permission bit outside the owner may be set.
  if ((mode & 0o077) !== 0) {
    warnings.push(
      `credential file at ${path} is accessible to group or others; ignoring it — set mode 0600 or stricter.`,
    );
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    warnings.push(`credential file at ${path} could not be read; ignoring it.`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`credential file at ${path} is not valid JSON; ignoring it.`);
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`credential file at ${path} is not a JSON object; ignoring it.`);
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const out: Partial<Record<CredentialField, string>> = {};
  for (const field of CREDENTIAL_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") out[field] = value.trim();
  }
  return out;
}

/**
 * Which provider+model pair is active, for labelling receipts. Read from the
 * explicit `backend` field on the resolved config — never re-derived from
 * URL equality, which mislabels approved relays.
 */
export interface ProviderIdentity {
  provider: "typesafe" | "openrouter" | "jev-gateway";
  model: string;
  baseUrl: string;
}

export function providerIdentityOf(config: Pick<HookConfig, "baseUrl" | "model" | "backend">): ProviderIdentity {
  return { provider: config.backend, model: config.model, baseUrl: config.baseUrl };
}

/** `CLAUDE_PLUGIN_OPTION_<KEY>` first, then the `JEV_*`/legacy names. */
function read(env: Env, option: string, ...fallbacks: string[]): string | undefined {
  for (const key of [`CLAUDE_PLUGIN_OPTION_${option.toUpperCase()}`, ...fallbacks]) {
    const raw = env[key];
    if (raw !== undefined && raw.trim() !== "") return raw.trim();
  }
  return undefined;
}

function readBool(env: Env, option: string, fallback: boolean, warnings: string[], ...aliases: string[]): boolean {
  const raw = read(env, option, ...aliases);
  if (raw === undefined) return fallback;
  const lowered = raw.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lowered)) return true;
  if (["false", "0", "no", "off"].includes(lowered)) return false;
  warnings.push(`${option}=${JSON.stringify(raw)} is not a boolean; using ${fallback}.`);
  return fallback;
}

function readNumber(
  env: Env,
  option: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
  ...aliases: string[]
): number {
  const raw = read(env, option, ...aliases);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    warnings.push(`${option}=${JSON.stringify(raw)} is not a number in [${min}, ${max}]; using ${fallback}.`);
    return fallback;
  }
  return value;
}

/** Where session files and the decision log live. */
export function resolveDataDir(env: Env = process.env, scriptPath: string | undefined = process.argv[1]): string {
  // Explicit operator override always wins, on either host.
  const jev = env.JEV_HOOKS_DATA_DIR?.trim();
  if (jev !== undefined && jev !== "") return jev;
  // Native Muse sessions export a per-plugin directory; use it directly.
  const muse = env.MUSE_PLUGIN_DATA_DIR?.trim();
  if (muse !== undefined && muse !== "") return muse;
  // Claude Code exports its own per-install directory.
  const explicit = env.CLAUDE_PLUGIN_DATA?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  // Native Muse clears MCP process environment. Recover its per-plugin data
  // directory from the immutable package-cache path.
  const museInstallId = museInstallIdFromScriptPath(scriptPath);
  if (museInstallId !== undefined) {
    const museDataHome = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "share");
    return join(museDataHome, "muse", "plugins", "data", museInstallId);
  }
  // A model-mediated Muse command runs in the user's shell, which does not
  // inherit MUSE_PLUGIN_DATA_DIR from native hook processes. If the native
  // install's XDG data directory already exists, resolve to the same store.
  const basename = scriptPath?.replace(/\\/g, "/").split("/").at(-1);
  if (basename === "jev-control" || basename === "control.js" || basename === "control.mjs") {
    const museDataHome = env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "share");
    const musePluginData = join(museDataHome, "muse", "plugins", "data", "jeverb");
    if (existsSync(musePluginData)) return musePluginData;
  }
  const dataRoot = join(env.HOME?.trim() || homedir(), ".claude", "plugins", "data");
  return join(dataRoot, installIdFromScriptPath(scriptPath) ?? "jev");
}

/** Canonical data directory for Muse hooks and the Muse control CLI. */
export function resolveMuseDataDir(env: Env = process.env): string {
  const native = env.MUSE_PLUGIN_DATA_DIR?.trim();
  if (native) return native;
  const canonical = env.JEV_MUSE_DATA_DIR?.trim();
  if (canonical) return canonical;
  throw new Error("Muse plugin data directory is ambiguous; Muse hooks require MUSE_PLUGIN_DATA_DIR and the control CLI requires JEV_MUSE_DATA_DIR.");
}

/**
 * CLAUDE_PLUGIN_DATA is exported to hook processes only. A /jev:* command runs
 * through the Bash tool without it, and must still read the directory the hooks
 * write to. An installed plugin runs from
 * `<…>/plugins/cache/<marketplace>/<plugin>/<version>/dist/hook.mjs`, and Claude
 * Code names the data directory `<plugin>-<marketplace>` with characters
 * outside [A-Za-z0-9_-] replaced by `-`.
 */
export function installIdFromScriptPath(scriptPath: string | undefined): string | undefined {
  if (scriptPath === undefined) return undefined;
  const parts = scriptPath.replace(/\\/g, "/").split("/");
  const cache = parts.lastIndexOf("cache");
  if (cache < 1 || parts[cache - 1] !== "plugins") return undefined;
  const marketplace = parts[cache + 1];
  const plugin = parts[cache + 2];
  if (!marketplace || !plugin || parts.length < cache + 5) return undefined;
  return `${plugin}@${marketplace}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Return the native Muse install id for an MCP entrypoint in its package cache. */
export function museInstallIdFromScriptPath(scriptPath: string | undefined): string | undefined {
  if (scriptPath === undefined) return undefined;
  const parts = scriptPath.replace(/\\/g, "/").split("/");
  const cache = parts.lastIndexOf("cache");
  if (cache < 1 || parts[cache - 1] !== "plugins") return undefined;
  const plugin = parts[cache + 2];
  const packageDigest = parts[cache + 3];
  if (parts[cache + 4] !== "package" || !/^[A-Za-z0-9_-]{1,80}$/.test(plugin ?? "") ||
      !/^[0-9a-f]{64}$/.test(packageDigest ?? "")) return undefined;
  return plugin;
}

/** Read the lint level, migrating an unknown value to the default with a warning. */
function readLint(env: Env, warnings: string[], fallback: LintLevel = HOOK_DEFAULTS.lint): LintLevel {
  const raw = read(env, "lint", "JEV_LINT");
  if (raw === undefined) return fallback;
  if ((LINT_LEVELS as readonly string[]).includes(raw.toLowerCase())) return raw.toLowerCase() as LintLevel;
  warnings.push(`lint=${JSON.stringify(raw)} is not one of off|tripwire|advisory; using ${fallback}.`);
  return fallback;
}

export function loadHookConfig(env: Env = process.env): HookConfig {
  const warnings: string[] = [];
  // Resolve the install-scoped config before policy parsing: native hosts
  // sanitize arbitrary hook env, but always supply the plugin data directory.
  const earlyDataDir = resolveDataDir(env);
  const dirCfg = readDataDirConfig(join(earlyDataDir, "config.json"), warnings);

  // `gate` replaced `gate_mode` in 0.3.0. An install that still carries the old
  // setting keeps working and is told so by `/jev:status`, rather than silently
  // falling back to the default and changing behaviour under the user.
  const gateRaw = read(env, "gate", "JEV_GATE");
  let gate: GateLevel = dirCfg.gate ?? HOOK_DEFAULTS.gate;
  if (gateRaw !== undefined) {
    const lowered = gateRaw.toLowerCase();
    if ((GATE_LEVELS as readonly string[]).includes(lowered)) {
      gate = lowered as GateLevel;
    } else {
      warnings.push(`gate=${JSON.stringify(gateRaw)} is not one of ${GATE_LEVELS.join("|")}; using ${dirCfg.gate ?? "advisory"}.`);
    }
  } else {
    const legacy = read(env, "gate_mode", "JEV_GATE_MODE");
    if (legacy !== undefined) {
      const mapped = GATE_MODE_MIGRATION[legacy.toLowerCase()];
      if (mapped === undefined) {
        warnings.push(
          `gate_mode=${JSON.stringify(legacy)} is not one of off|standard|strict; using gate=${dirCfg.gate ?? "advisory"}. ` +
            `Set "gate" in the install-scoped config.`,
        );
      } else {
        gate = mapped;
        warnings.push(`gate_mode is deprecated; read as gate=${mapped}. Set "gate" in the install-scoped config.`);
      }
    }
  }

  const commitEnforcementRaw = read(env, "commit_enforcement", "JEV_COMMIT_ENFORCEMENT");
  let commitEnforcement = dirCfg.commitEnforcement ?? HOOK_DEFAULTS.commitEnforcement;
  if (commitEnforcementRaw !== undefined) {
    const normalized = commitEnforcementRaw.toLowerCase();
    if ((COMMIT_ENFORCEMENT_LEVELS as readonly string[]).includes(normalized)) {
      commitEnforcement = normalized as CommitEnforcement;
    } else {
      warnings.push(`commit_enforcement=${JSON.stringify(commitEnforcementRaw)} is invalid; using ${commitEnforcement}.`);
    }
  }

  if (read(env, "auto_mode", "JEV_AUTO_MODE") !== undefined) {
    warnings.push("auto_mode is no longer used: every judgment is advisory to Claude and never prompts.");
  }

  const backend = (read(env, "backend", "JEV_BACKEND") ?? dirCfg.backend)?.toLowerCase();
  const openRouter = backend === "openrouter";
  const jevGateway = backend === "jev-gateway";
  if (backend !== undefined && !openRouter && !jevGateway && backend !== "typesafe" && backend !== "native") {
    warnings.push(`backend=${JSON.stringify(backend)} is unknown; using the native TypeSafe client.`);
  }
  const defaultBaseUrl = jevGateway ? JEV_GATEWAY_DEFAULTS.baseUrl : openRouter ? OPENROUTER_DEFAULTS.baseUrl : HOOK_DEFAULTS.baseUrl;
  const defaultModel = jevGateway ? JEV_GATEWAY_DEFAULTS.model : openRouter ? OPENROUTER_DEFAULTS.model : HOOK_DEFAULTS.model;
  // Install-scoped inference budget: hosted backends routinely need more
  // than the 1.5 s hook default, and hook transports sanitize the operator
  // env that would otherwise raise it. Env still wins when both are set;
  // the shared clamp below applies to either source.
  let fileTimeoutMs: number = HOOK_DEFAULTS.timeoutMs;
  if (dirCfg.timeoutMs !== undefined) {
    if (dirCfg.timeoutMs >= 100 && dirCfg.timeoutMs <= 10_000) {
      fileTimeoutMs = dirCfg.timeoutMs;
    } else {
      warnings.push(
        `data-dir config timeout_ms=${JSON.stringify(dirCfg.timeoutMs)} is outside [100, 10000]; using ${HOOK_DEFAULTS.timeoutMs}.`,
      );
    }
  }
  // A generic `api_key` plugin option is backend-agnostic and wins outright.
  // Backend-specific keys never cross backends: a TypeSafe key sent to
  // OpenRouter (or vice versa) only produces confusing 401s at the wrong
  // provider, so a key from the other backend is ignored with a warning
  // instead of being silently forwarded.
  const genericKey = read(env, "api_key") ?? null;
  const homeCreds = genericKey === null ? readFileCredentials(resolveCredentialsPath(env), warnings) : {};
  // Install-scoped credential plant: hook transports sanitize operator env
  // and HOME, but the resolved data dir is always reachable — it is where
  // the hook already reads and writes. A supervised install (or the
  // qualification harness) may plant `credentials` there (0600 JSON, same
  // fields). It only supplements the user-level file: explicit env and the
  // home credentials file keep their precedence.
  let fileCreds = homeCreds;
  if (genericKey === null) {
    // Always consult the resolved data dir (it does not depend on hook-env
    // passthrough: resolveDataDir already did the env/HOME search). Env-based
    // lookups above may see a sanitized transport env, but the data dir is
    // where this process reads and writes, so a supervised plant there is
    // reliably visible.
    const planted = readFileCredentials(join(earlyDataDir, "credentials"), warnings);
    fileCreds = { ...planted, ...homeCreds };
  }
  const openRouterKey =
    read(env, "api_key", "OPENROUTER_API_KEY") ?? fileCreds.OPENROUTER_API_KEY ?? null;
  const typesafeKey =
    read(env, "api_key", "TYPESAFE_API_KEY") ?? fileCreds.TYPESAFE_API_KEY ?? null;
  let apiKey = jevGateway ? null : genericKey;
  if (apiKey === null && !jevGateway) {
    apiKey = openRouter ? openRouterKey : typesafeKey;
    if (openRouter && apiKey === null && typesafeKey !== null) {
      warnings.push(
        "ignoring TYPESAFE_API_KEY: it does not belong to the selected openrouter backend; " +
          "set OPENROUTER_API_KEY instead.",
      );
    }
    if (!openRouter && apiKey === null && openRouterKey !== null) {
      warnings.push(
        "ignoring OPENROUTER_API_KEY: it does not belong to the selected native backend; " +
          "set TYPESAFE_API_KEY instead.",
      );
    }
  }
  if (openRouter && apiKey !== null && apiKey !== genericKey && !apiKey.startsWith("sk-or-")) {
    warnings.push(
      "the selected OPENROUTER_API_KEY does not have the usual sk-or- prefix; " +
        "it may belong to a different provider.",
    );
  }
  // An explicitly selected backend with no credential anywhere is a config
  // problem, not a network problem: name the backend so `/jev:status` does
  // not send anyone debugging reachability. No backend selected and no key is
  // silence — the hooks simply run uncredentialled.
  if (apiKey === null && !jevGateway && (backend === "openrouter" || backend === "typesafe" || backend === "native")) {
    const want = backend === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
    warnings.push(
      `backend ${JSON.stringify(backend)} is selected but no ${want} credential was found ` +
        `(missing credentials — the backend was never contacted); set ${want} or add it to the credentials file.`,
    );
  }
  const auto = readNumber(env, "auto_threshold", dirCfg.autoThreshold ?? HOOK_DEFAULTS.autoThreshold, 0.01, 0.99, warnings, "JEV_AUTO_THRESHOLD");
  const review = readNumber(
    env,
    "review_threshold",
    Math.min(dirCfg.reviewThreshold ?? HOOK_DEFAULTS.reviewThreshold, auto),
    0.01,
    0.99,
    warnings,
    "JEV_REVIEW_THRESHOLD",
  );
  const model = read(env, "model", "JEV_MODEL") ?? dirCfg.model ?? defaultModel;
  const closureQuestionHash = hashQuestions({ closure: MISSION_CLOSURE_QUESTION });
  const closureCalibration = dirCfg.missionClosure;
  const closureModelMatches = closureCalibration?.modelVersion === model ||
    (jevGateway && closureCalibration?.modelVersion.startsWith(`${model}-`) === true) ||
    (openRouter && typeof closureCalibration?.modelVersion === "string" && closureCalibration.modelVersion.trim().length > 0);
  const closureMinConfidence = closureCalibration?.minConfidence ?? 0.9;
  // A configured qualification manifest must verify against the active
  // deployment identity and recomputed artifacts before the calibrated
  // claim is honored. Any verification failure degrades to uncalibrated
  // with a warning — never to an exception, and never to calibrated.
  let closureManifestAuthorizes = false;
  if (closureCalibration?.qualificationManifest !== undefined) {
    closureManifestAuthorizes = verifyMissionClosureManifest(
      earlyDataDir,
      closureCalibration.qualificationManifest,
      {
        backend: jevGateway ? "jev-gateway" : openRouter ? "openrouter" : "typesafe",
        model,
        modelVersion: closureCalibration.modelVersion,
        questionHash: closureQuestionHash,
        minConfidence: closureMinConfidence,
        calibrationVersion: closureCalibration?.calibrationVersion ?? "",
      },
      warnings,
    );
  } else if (closureCalibration?.calibrated === true) {
    warnings.push("mission_closure calibration claim has no qualification manifest; closure remains uncalibrated.");
  }
  const missionClosurePolicy: MissionClosurePolicy = {
    policyVersion: MISSION_CLOSURE_POLICY_VERSION,
    minConfidence: closureMinConfidence,
    calibrated:
      closureCalibration?.calibrated === true &&
      closureModelMatches &&
      closureCalibration.questionHash === closureQuestionHash &&
      closureManifestAuthorizes,
    backend: jevGateway ? "jev-gateway" : openRouter ? "openrouter" : "typesafe",
    model,
    modelVersion: closureCalibration?.modelVersion ?? model,
    questionHash: closureCalibration?.questionHash ?? closureQuestionHash,
    calibrationVersion: closureCalibration?.calibrationVersion ?? "",
    ...(closureCalibration?.adversarialCalibrationVersion === undefined
      ? {}
      : { adversarialCalibrationVersion: closureCalibration.adversarialCalibrationVersion }),
  };

  return {
    apiKey,
    backend: jevGateway ? "jev-gateway" : openRouter ? "openrouter" : "typesafe",
    // Explicit operator env wins when set; otherwise the install-scoped
    // file (same trust boundary as the planted credentials). Default deny.
    allowCustomRelay: readBool(
      env,
      "allow_custom_relay",
      dirCfg.allowCustomRelay ?? false,
      warnings,
      "JEV_ALLOW_CUSTOM_RELAY",
    ),
    baseUrl: (read(env, "base_url", jevGateway ? "JEV_GATEWAY_BASE_URL" : "TYPESAFE_BASE_URL", ...(openRouter ? ["OPENROUTER_BASE_URL"] : [])) ??
      dirCfg.baseUrl ??
      defaultBaseUrl
    ).replace(/\/+$/, ""),
    model,
    missionClosurePolicy,
    timeoutMs: readNumber(env, "timeout_ms", fileTimeoutMs, 100, 10_000, warnings, "JEV_HOOK_TIMEOUT_MS"),
    maxRetries: HOOK_DEFAULTS.maxRetries,
    gate,
    commitEnforcement,
    askOnTrip: readBool(env, "ask_on_trip", dirCfg.askOnTrip ?? HOOK_DEFAULTS.askOnTrip, warnings, "JEV_ASK_ON_TRIP"),
    stopCheck: readBool(env, "stop_check", dirCfg.stopCheck ?? HOOK_DEFAULTS.stopCheck, warnings, "JEV_STOP_CHECK"),
    screenResults: readBool(env, "screen_results", dirCfg.screenResults ?? HOOK_DEFAULTS.screenResults, warnings, "JEV_SCREEN_RESULTS"),
    routePrompts: readBool(env, "route_prompts", dirCfg.routePrompts ?? HOOK_DEFAULTS.routePrompts, warnings, "JEV_ROUTE_PROMPTS"),
    lint: readLint(env, warnings, dirCfg.lint ?? HOOK_DEFAULTS.lint),
    lintConventions: readBool(env, "lint_conventions", dirCfg.lintConventions ?? HOOK_DEFAULTS.lintConventions, warnings, "JEV_LINT_CONVENTIONS"),
    verifyClaims: readBool(env, "verify_claims", dirCfg.verifyClaims ?? HOOK_DEFAULTS.verifyClaims, warnings, "JEV_VERIFY_CLAIMS"),
    adversarialClosure: readBool(env, "adversarial_closure", dirCfg.adversarialClosure ?? HOOK_DEFAULTS.adversarialClosure, warnings, "JEV_ADVERSARIAL_CLOSURE"),
    autoThreshold: auto,
    reviewThreshold: Math.min(review, auto),
    confidenceThreshold: readNumber(
      env,
      "confidence_threshold",
      dirCfg.confidenceThreshold ?? HOOK_DEFAULTS.confidenceThreshold,
      0.5,
      0.99,
      warnings,
      "JEV_CONFIDENCE_THRESHOLD",
    ),
    // Port 0 is allowed and means "ask the OS": the tests use it so they never
    // touch the real port, and nothing in a normal install sets it.
    daemonPort: readNumber(env, "daemon_port", dirCfg.daemonPort ?? HOOK_DEFAULTS.daemonPort, 0, 65_535, warnings, "JEV_DAEMON_PORT"),
    daemonIdleMs: readNumber(
      env,
      "daemon_idle_ms",
      dirCfg.daemonIdleMs ?? HOOK_DEFAULTS.daemonIdleMs,
      1000,
      24 * 60 * 60 * 1000,
      warnings,
      "JEV_DAEMON_IDLE_MS",
    ),
    evidenceRetentionDays: readNumber(
      env,
      "evidence_retention_days",
      dirCfg.evidenceRetentionDays ?? HOOK_DEFAULTS.evidenceRetentionDays,
      1,
      3650,
      warnings,
      "JEV_EVIDENCE_RETENTION_DAYS",
    ),
    evidenceMaxRecords: Math.floor(readNumber(
      env,
      "evidence_max_records",
      dirCfg.evidenceMaxRecords ?? HOOK_DEFAULTS.evidenceMaxRecords,
      10_000,
      10_000_000,
      warnings,
      "JEV_EVIDENCE_MAX_RECORDS",
    )),
    dataDir: earlyDataDir,
    masterSwitchPath: protectedMasterSwitchPath(env),
    disabled: readBool(env, "hooks_disable", false, warnings, "JEV_HOOKS_DISABLE"),
    warnings,
  };
}
