import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalPolicyHash,
  questionSetHashFor,
  verifyQualificationManifest,
  type QualificationActiveIdentity,
} from "../jev/qualification.js";
import type { PolicyConfig } from "./policy.js";
import type { CheckDef } from "./questions.js";

export type ReviewConfigStatus = "ready" | "absent" | "partial" | "invalid" | "uncalibrated";

export interface ReviewCalibration {
  backend?: string;
  model?: string;
  modelVersion?: string;
  calibrationVersion?: string;
  datasetRevision?: string;
  evaluationHash?: string;
  calibrated: boolean;
}

export interface LoadedReviewConfig {
  checks: CheckDef[];
  policy: PolicyConfig;
  status: ReviewConfigStatus;
  /** Set for absent/partial/invalid: the caller must fail closed. */
  invalid?: string;
  /** Machine-readable provenance for calibration binding. */
  calibration: ReviewCalibration;
  /** sha256 over the canonical checks+policy, for calibration pinning. */
  configHash: string;
  /**
   * sha256 over the canonical check definitions. Protected-operation
   * review requires this to match the question hash the thresholds were
   * measured against: editing a question invalidates calibration.
   */
  questionHash: string;
  /** Absolute path of the checks file that supplied this config. */
  source?: string;
}

/**
 * Canonical question-set hash for a check list. Uses the same plain-JSON
 * serialization as `configHash` so the loader, the service, and the
 * recorded `calibration.question_hash` all compare identical strings.
 */
export function hashReviewChecks(checks: CheckDef[]): string {
  return createHash("sha256").update(JSON.stringify(checks)).digest("hex");
}

const FALLBACK_POLICY = {
  policy_version: "1",
  thresholds: { block: 0.85, security_review: 0.6 },
} as PolicyConfig;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Every check must be fully specified: a unique id, the noul answer type,
 * verbatim instructions (question/inspect/focus — calibration is measured
 * against these exact strings), and a criteria map. A check missing any of
 * these cannot be judged or calibrated, so the whole config is invalid.
 * Returns the error, or undefined when the checks are usable.
 */
function validateChecks(raw: unknown): string | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return "checks.json defines no checks: an empty rule set can never review";
  }
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const check = raw[index] as Partial<CheckDef> | null | undefined;
    const where = `checks[${index}]`;
    if (typeof check !== "object" || check === null) return `${where} is not an object`;
    if (!isNonEmptyString(check.id)) return `${where} has no id`;
    if (seen.has(check.id)) return `${where} duplicates check id ${JSON.stringify(check.id)}`;
    seen.add(check.id);
    if (check.type !== "noul") return `${where} (${check.id}) has unsupported type ${JSON.stringify((check as { type?: unknown }).type)}: expected "noul"`;
    const instructions = check.instructions as { question?: unknown; inspect?: unknown; focus?: unknown } | undefined;
    for (const field of ["question", "inspect", "focus"] as const) {
      if (!isNonEmptyString(instructions?.[field])) {
        return `${where} (${check.id}) is missing instructions.${field}: calibration is measured against the exact strings`;
      }
    }
    const criteria = check.criteria as { true?: unknown; false?: unknown } | undefined;
    if (typeof criteria !== "object" || criteria === null) {
      return `${where} (${check.id}) is missing criteria: judgments need a testable true/false rubric`;
    }
    // Both noul answer keys must be present and non-empty: a check whose
    // expected answer has no rubric cannot be judged or calibrated.
    for (const key of ["true", "false"] as const) {
      if (!isNonEmptyString(criteria[key])) {
        return `${where} (${check.id}) is missing criteria.${key}: every expected answer key needs a non-empty rubric`;
      }
    }
  }
  return undefined;
}

/**
 * Canonical policy hash for the review family: the enforcement boundary
 * recomputes this over the live policy version, question hash, and
 * thresholds, so any policy change invalidates the manifest. The qualify
 * script accepts the same fields via `--policy-fields`.
 */
export function reviewPolicyHash(
  policyVersion: string,
  questionHash: string,
  thresholds: Record<string, number>,
): string {
  return canonicalPolicyHash({ policyVersion, questionHash, thresholds });
}

export interface ReviewManifestActiveIdentity {
  backend: string;
  model: string;
  modelVersion: string;
  adapterVersion: string;
}

/**
 * Enforce a configured review qualification manifest. When the policy
 * provenance names one, it must verify against the active deployment
 * identity and recomputed artifacts; any failure degrades the config to
 * uncalibrated with a warning, never to an exception or to ready.
 */
export function gateReviewOnManifest(
  loaded: LoadedReviewConfig,
  active: ReviewManifestActiveIdentity,
  warn: (message: string) => void,
): LoadedReviewConfig {
  const manifestPath = loaded.policy.provenance?.qualificationManifest;
  const uncalibrated = (reason: string): LoadedReviewConfig => {
    warn(`review qualification manifest: ${reason}; review remains uncalibrated`);
    return { ...loaded, status: "uncalibrated", calibration: { ...loaded.calibration, calibrated: false } };
  };
  if (manifestPath === undefined || manifestPath.trim() === "") {
    return loaded.calibration.calibrated
      ? uncalibrated("calibrated policy has no qualification manifest")
      : loaded;
  }
  if (loaded.source === undefined) return uncalibrated("no checks file to resolve the manifest against");
  const manifestFile = resolve(dirname(loaded.source), manifestPath);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as unknown;
  } catch {
    return uncalibrated(`manifest at ${manifestFile} cannot be read`);
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return uncalibrated(`manifest at ${manifestFile} is not an object`);
  }
  const record = manifest as Record<string, unknown>;
  if (record["family"] !== "review") {
    return uncalibrated(`manifest at ${manifestFile} is for family ${JSON.stringify(record["family"])}`);
  }
  if (
    typeof record["datasetPath"] !== "string" || typeof record["receiptsPath"] !== "string" ||
    typeof record["developmentDatasetPath"] !== "string"
  ) {
    return uncalibrated(`manifest at ${manifestFile} names no dataset/development/receipts artifacts`);
  }
  if (record["datasetSplit"] === "lockbox" && typeof record["validationDatasetPath"] !== "string") {
    return uncalibrated(`lockbox manifest at ${manifestFile} names no validation dataset artifact`);
  }
  const manifestDir = dirname(manifestFile);
  const identity: QualificationActiveIdentity = {
    backend: active.backend,
    model: active.model,
    modelVersion: active.modelVersion,
    adapterVersion: active.adapterVersion,
    questionSetHash: questionSetHashFor([loaded.questionHash]),
    thresholds: {
      block: loaded.policy.thresholds.block,
      security_review: loaded.policy.thresholds.security_review,
    },
    policyHash: reviewPolicyHash(loaded.policy.policy_version, loaded.questionHash, {
      block: loaded.policy.thresholds.block,
      security_review: loaded.policy.thresholds.security_review,
    }),
  };
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
    identity,
  );
  if (!verification.ok) {
    return uncalibrated(`verification failed (${verification.reasons.join("; ")})`);
  }
  if (!verification.authorizes) {
    return uncalibrated(
      `manifest decision is ${JSON.stringify(record["decision"])}; ${verification.reasons.join("; ")}`,
    );
  }
  return loaded;
}

function empty(status: ReviewConfigStatus, invalid: string): LoadedReviewConfig {
  return {
    checks: [],
    policy: FALLBACK_POLICY,
    status,
    invalid,
    calibration: { calibrated: false },
    configHash: createHash("sha256").update(JSON.stringify({ checks: [], policy: FALLBACK_POLICY })).digest("hex"),
    questionHash: hashReviewChecks([]),
  };
}

function hashConfig(checks: CheckDef[], policy: PolicyConfig): string {
  return createHash("sha256").update(JSON.stringify({ checks, policy })).digest("hex");
}

function defaultRoots(): string[] {
  const roots: string[] = [];
  let moduleRootUsable = false;
  try {
    const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    if (statSync(moduleRoot).isDirectory()) {
      roots.push(moduleRoot);
      moduleRootUsable = true;
    }
  } catch {
    /* ignore: non-file module URL or unreadable package root */
  }
  // The CWD fallback exists only for module URLs that cannot resolve to a
  // package directory. When the module root exists, resolution stays inside
  // it: an installed bundle missing config/review must report absent, never
  // silently substitute the current working directory's review policy.
  if (!moduleRootUsable) roots.push(process.cwd());
  return roots;
}

/**
 * Review config resolution that works both from a repo checkout (vitest,
 * tsx) and from the bundled hook (plugin/dist/hook.mjs, installed plugin
 * cache): every Jeverb module collapses into one bundle file, so a path
 * relative to this module's URL lands on the package root in both cases.
 *
 * Five states, never a silent empty rule set:
 * - ready: both files present, valid, non-empty, thresholds sane, calibrated.
 * - absent: neither file found. Callers must fail closed for protected ops.
 * - partial: exactly one file found. The found half is NOT merged with
 *   defaults; the whole config is unusable.
 * - invalid: a present file is unparseable, shapeless, empty, or has
 *   out-of-range thresholds.
 * - uncalibrated: valid files, but the policy is not marked calibrated
 *   (or not for this backend/model). Advisory use only until measured.
 */
export function loadReviewConfig(searchRoots?: string[]): LoadedReviewConfig {
  const names = ["checks.json", "policy.json"] as const;
  const found: Partial<Record<(typeof names)[number], { path: string; text: string }>> = {};

  for (const root of searchRoots ?? defaultRoots()) {
    let allPresent = true;
    for (const name of names) {
      if (found[name] !== undefined) continue;
      const path = resolve(root, "config", "review", name);
      try {
        found[name] = { path, text: readFileSync(path, "utf8") };
      } catch {
        allPresent = false;
      }
    }
    if (allPresent) break;
  }

  if (found["checks.json"] === undefined && found["policy.json"] === undefined) {
    return empty("absent", "review config absent: no config/review/checks.json or policy.json found");
  }
  if (found["checks.json"] === undefined || found["policy.json"] === undefined) {
    const missing = found["checks.json"] === undefined ? "checks.json" : "policy.json";
    return empty("partial", `review config partially installed: ${missing} missing; refusing to merge with defaults`);
  }

  let checksRaw: { checks?: unknown };
  let policyRaw: PolicyConfig;
  try {
    checksRaw = JSON.parse(found["checks.json"].text) as { checks?: unknown };
    policyRaw = JSON.parse(found["policy.json"].text) as PolicyConfig;
  } catch (err) {
    return empty("invalid", `review config unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const checksError = validateChecks(checksRaw.checks);
  if (checksError !== undefined) {
    return empty("invalid", checksError);
  }
  const thresholds = policyRaw?.thresholds;
  if (
    typeof policyRaw?.policy_version !== "string" ||
    typeof thresholds?.block !== "number" ||
    typeof thresholds?.security_review !== "number" ||
    !(thresholds.block > 0 && thresholds.block < 1) ||
    !(thresholds.security_review > 0 && thresholds.security_review < 1) ||
    !(thresholds.block >= thresholds.security_review)
  ) {
    return empty("invalid", "policy.json thresholds must satisfy 0 < security_review <= block < 1");
  }

  const checks = checksRaw.checks as CheckDef[];
  const provenance = policyRaw.provenance;
  const calibration: ReviewCalibration = {
    ...(isNonEmptyString(provenance?.backend) ? { backend: provenance.backend } : {}),
    ...(isNonEmptyString(provenance?.model) ? { model: provenance.model } : {}),
    ...(isNonEmptyString(provenance?.modelVersion) ? { modelVersion: provenance.modelVersion } : {}),
    ...(isNonEmptyString(provenance?.calibrationVersion) ? { calibrationVersion: provenance.calibrationVersion } : {}),
    ...(isNonEmptyString(provenance?.datasetRevision) ? { datasetRevision: provenance.datasetRevision } : {}),
    ...(isNonEmptyString(provenance?.evaluationHash) ? { evaluationHash: provenance.evaluationHash } : {}),
    calibrated: provenance?.calibrated === true,
  };
  const base = {
    checks,
    policy: policyRaw,
    calibration,
    configHash: hashConfig(checks, policyRaw),
    questionHash: hashReviewChecks(checks),
    source: found["checks.json"].path,
  };
  if (!calibration.calibrated) {
    return { ...base, status: "uncalibrated" };
  }
  return { ...base, status: "ready" };
}
