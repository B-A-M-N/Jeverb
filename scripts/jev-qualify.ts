#!/usr/bin/env tsx
/**
 * Build a qualification manifest from existing calibration artifacts.
 *
 * Binds a bench summary, its dataset, and its receipts into one
 * release record. Performs no model calls: it recomputes every count
 * and hash from the artifact bytes and refuses when the summary does
 * not reconcile with the receipts. The release decision stays human:
 * `--decision qualified` is an explicit operator act, and the
 * enforcement boundary re-verifies the manifest before honoring it.
 *
 * Usage:
 *   npx tsx scripts/jev-qualify.ts --summary bench/results/<name>.summary.json \
 *     --dataset bench/datasets/<name>.jsonl --receipts bench/results/<name>.receipts.jsonl \
 *     --development-dataset bench/datasets/<development>.jsonl \
 *     --validation-dataset bench/datasets/<validation>.jsonl \
 *     --family mission-closure --model-version <id> --adapter-version <HOOK_VERSION> \
 *     --policy-fields '{"policyVersion":"mission-closure/1","questionHash":"<hex>","minConfidence":0.9}' \
 *     --thresholds '{"minConfidence":0.9}' \
 *     --split lockbox --decision qualified --out bench/results/<name>.manifest.json
 *
 * For family mission-closure, --policy-fields must carry exactly
 * { policyVersion, questionHash, minConfidence }: the enforcement
 * boundary recomputes the canonical hash over the same fields, so any
 * policy change invalidates the manifest. For family review, use
 * { policyVersion, questionHash, thresholds } with the review policy
 * version, checks hash, and block/security_review thresholds.
 * --policy-hash accepts a precomputed sha256 for other families.
 * Held-out qualification requires development evidence; lockbox qualification
 * also requires validation evidence. The verifier checks all case identities
 * for overlap before considering release metrics.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { HOOK_VERSION } from "../src/hooks/version.js";
import { parseCalibrationDataset } from "../src/jev/calibration.js";
import { canonicalPolicyHash, caseErrorConsistencyIssue, questionSetHashFor } from "../src/jev/qualification.js";
import type { QualificationManifest, QualificationSplit } from "../src/jev/qualification.js";
import { writeNewArtifact } from "./artifact-output.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = flag(name);
  if (value === undefined || value === "") {
    console.error(`jev-qualify: missing required ${name}`);
    process.exit(2);
  }
  return value;
}

const summaryPath = required("--summary");
const datasetPath = required("--dataset");
const developmentDatasetPath = flag("--development-dataset");
const validationDatasetPath = flag("--validation-dataset");
const receiptsPath = required("--receipts");
const family = required("--family");
const modelVersion = required("--model-version");
const adapterVersion = required("--adapter-version");
const outPath = required("--out");
if (adapterVersion !== HOOK_VERSION) {
  console.error(`jev-qualify: --adapter-version must match running hook version ${HOOK_VERSION}`);
  process.exit(2);
}
const policyHashFlag = flag("--policy-hash");
const policyFieldsRaw = flag("--policy-fields");
let policyHash: string;
if (policyHashFlag !== undefined && policyFieldsRaw !== undefined) {
  console.error(`jev-qualify: use only one of --policy-hash or --policy-fields`);
  process.exit(2);
} else if (policyHashFlag !== undefined) {
  if (!/^[0-9a-f]{64}$/.test(policyHashFlag)) {
    console.error(`jev-qualify: --policy-hash must be a sha256 hex digest`);
    process.exit(2);
  }
  policyHash = policyHashFlag;
} else if (policyFieldsRaw !== undefined) {
  try {
    const fields: unknown = JSON.parse(policyFieldsRaw);
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new Error("not an object");
    policyHash = canonicalPolicyHash(fields as Record<string, unknown>);
  } catch (error) {
    console.error(`jev-qualify: --policy-fields is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
} else {
  console.error(`jev-qualify: missing required --policy-hash or --policy-fields`);
  process.exit(2);
}
const split = flag("--split") ?? "development";
const decision = flag("--decision") ?? "inconclusive";
const thresholdsRaw = flag("--thresholds") ?? "{}";

if (split !== "development" && split !== "validation" && split !== "lockbox") {
  console.error(`jev-qualify: --split must be development, validation, or lockbox`);
  process.exit(2);
}
if (decision !== "qualified" && decision !== "rejected" && decision !== "inconclusive") {
  console.error(`jev-qualify: --decision must be qualified, rejected, or inconclusive`);
  process.exit(2);
}
if (decision === "qualified" && split !== "lockbox") {
  console.error("jev-qualify: only lockbox evidence can be marked qualified; validation evidence is for selection");
  process.exit(2);
}
if (split !== "development" && (developmentDatasetPath === undefined || developmentDatasetPath === "")) {
  console.error("jev-qualify: held-out qualification requires --development-dataset for overlap checking");
  process.exit(2);
}
if (split === "lockbox" && (validationDatasetPath === undefined || validationDatasetPath === "")) {
  console.error("jev-qualify: lockbox qualification requires --validation-dataset for independence checking");
  process.exit(2);
}
let thresholds: Record<string, number>;
try {
  const parsed: unknown = JSON.parse(thresholdsRaw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("threshold values must be finite numbers");
  }
  thresholds = parsed as Record<string, number>;
} catch (error) {
  console.error(`jev-qualify: --thresholds is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as unknown as Record<string, unknown>;
const datasetText = readFileSync(datasetPath, "utf8");
const developmentDatasetText = developmentDatasetPath === undefined ? undefined : readFileSync(developmentDatasetPath, "utf8");
const validationDatasetText = validationDatasetPath === undefined ? undefined : readFileSync(validationDatasetPath, "utf8");
const receiptsText = readFileSync(receiptsPath, "utf8");

const cases = parseCalibrationDataset(datasetText);
if (developmentDatasetText !== undefined) {
  const developmentCases = parseCalibrationDataset(developmentDatasetText);
  const developmentIds = new Set(developmentCases.map((item) => item.id));
  const overlap = cases.find((item) => developmentIds.has(item.id));
  if (overlap !== undefined) {
    console.error(`jev-qualify: case ${overlap.id} overlaps development and ${split} splits; refusing`);
    process.exit(1);
  }
}
if (validationDatasetText !== undefined) {
  const validationCases = parseCalibrationDataset(validationDatasetText);
  const validationIds = new Set(validationCases.map((item) => item.id));
  const overlap = cases.find((item) => validationIds.has(item.id));
  if (overlap !== undefined) {
    console.error(`jev-qualify: case ${overlap.id} overlaps validation and ${split} splits; refusing`);
    process.exit(1);
  }
  if (developmentDatasetText !== undefined) {
    const developmentIds = new Set(parseCalibrationDataset(developmentDatasetText).map((item) => item.id));
    const crossOverlap = validationCases.find((item) => developmentIds.has(item.id));
    if (crossOverlap !== undefined) {
      console.error(`jev-qualify: case ${crossOverlap.id} overlaps development and validation splits; refusing`);
      process.exit(1);
    }
  }
}
const expectedFromDataset = cases.reduce((sum, c) => sum + Object.keys(c.questions).length, 0);
const rows = receiptsText.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
const caseErrorIssue = caseErrorConsistencyIssue(cases, rows);
if (caseErrorIssue !== undefined) {
  console.error(`jev-qualify: ${caseErrorIssue}; refusing`);
  process.exit(1);
}
const questionRows = rows.filter((row) => row["caseError"] !== true);
if (questionRows.length !== expectedFromDataset) {
  console.error(
    `jev-qualify: receipts cover ${questionRows.length} judgments but the dataset defines ${expectedFromDataset}; refusing`,
  );
  process.exit(1);
}
const answerable = questionRows.filter((row) => row["answer"] !== undefined && typeof row["inRange"] === "boolean");
const correct = answerable.filter((row) => row["inRange"] === true).length;
const invalid = expectedFromDataset - answerable.length;

const checkSummary = (key: string, value: number): void => {
  if (summary[key] !== value) {
    console.error(`jev-qualify: summary ${key}=${String(summary[key])} does not reconcile with recomputed ${value}; refusing`);
    process.exit(1);
  }
};
checkSummary("expectedAnswers", expectedFromDataset);
checkSummary("inRange", correct);
checkSummary("invalidJudgments", invalid);

const backends = [...new Set(questionRows.map((row) => row["provider"]))];
// Success rows carry the bare model id while failure rows carry the adapter's
// `provider:id` display name for the same deployment. Canonicalize the
// provider prefix so one deployment with failures still binds; genuinely
// different model ids still refuse below.
const canonicalModelId = (value: unknown): unknown =>
  typeof value === "string" ? value.replace(/^(openrouter|typesafe):/, "") : value;
const models = [...new Set(questionRows.map((row) => canonicalModelId(row["model"])))];
const observedModelVersions = [...new Set(questionRows.map((row) => row["modelVersion"]))];
const observedAdapterVersions = [...new Set(questionRows.map((row) => row["adapterVersion"]))];
if (backends.length !== 1 || typeof backends[0] !== "string") {
  console.error(`jev-qualify: receipts span ${backends.length} providers; a mixed run cannot qualify`);
  process.exit(1);
}
if (models.length !== 1 || typeof models[0] !== "string") {
  console.error(`jev-qualify: receipts span ${models.length} models; a mixed run cannot qualify`);
  process.exit(1);
}
if (observedModelVersions.length !== 1 || observedModelVersions[0] !== modelVersion) {
  console.error("jev-qualify: receipt model versions are missing, mixed, or differ from --model-version; refusing");
  process.exit(1);
}
if (observedAdapterVersions.length !== 1 || observedAdapterVersions[0] !== adapterVersion) {
  console.error("jev-qualify: receipt adapter versions are missing, mixed, or differ from --adapter-version; refusing");
  process.exit(1);
}
const hashes = new Set<string>();
for (const row of questionRows) {
  if (typeof row["questionHash"] !== "string" || !/^[0-9a-f]{64}$/.test(row["questionHash"])) {
    console.error(`jev-qualify: row ${String(row["case"])}/${String(row["question"])} lacks its runtime question-set hash; refusing`);
    process.exit(1);
  }
  hashes.add(row["questionHash"]);
}

const manifest: QualificationManifest = {
  family,
  backend: backends[0] as string,
  model: models[0] as string,
  modelVersion,
  adapterVersion,
  questionSetHash: questionSetHashFor([...hashes]),
  policyHash,
  datasetHash: sha256Hex(datasetText),
  ...(developmentDatasetText === undefined ? {} : { developmentDatasetHash: sha256Hex(developmentDatasetText) }),
  ...(validationDatasetText === undefined ? {} : { validationDatasetHash: sha256Hex(validationDatasetText) }),
  evaluationHash: sha256Hex(receiptsText),
  datasetSplit: split as QualificationSplit,
  expectedJudgments: expectedFromDataset,
  correctJudgments: correct,
  invalidJudgments: invalid,
  thresholds,
  calibratedAt: new Date().toISOString(),
  decision: decision as QualificationManifest["decision"],
  datasetPath: relative(dirname(resolve(outPath)), resolve(datasetPath)),
  ...(developmentDatasetPath === undefined
    ? {}
    : { developmentDatasetPath: relative(dirname(resolve(outPath)), resolve(developmentDatasetPath)) }),
  ...(validationDatasetPath === undefined
    ? {}
    : { validationDatasetPath: relative(dirname(resolve(outPath)), resolve(validationDatasetPath)) }),
  receiptsPath: relative(dirname(resolve(outPath)), resolve(receiptsPath)),
};
writeNewArtifact(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.error(
  `manifest: ${family} ${expectedFromDataset} judgments (${correct} correct, ${invalid} invalid), ` +
  `decision=${decision} -> ${outPath}`,
);
