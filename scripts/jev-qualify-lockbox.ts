#!/usr/bin/env tsx
/**
 * Bind a qualification manifest for one verified three-stage lockbox run.
 *
 * Takes labeled dataset bytes, recorded three-stage rows, and an explicit
 * operator policy, then independently replays the methodology verifier
 * before writing anything: missing, inconsistent, duplicate, or mismatched
 * records refuse the bind. Release tallies come from the verifier's
 * recomputation, never from the benchmark's counters, and the safety /
 * liveness gate is evaluated against operator-supplied thresholds — there
 * are no approved silent defaults, so every threshold flag is required.
 *
 * The release decision stays human: `--decision qualified` is an explicit
 * operator act, it requires the lockbox split, and it is refused unless the
 * gate passes. The enforcement boundary re-verifies the manifest before
 * honoring it.
 *
 * Usage:
 *   npx tsx scripts/jev-qualify-lockbox.ts \
 *     --dataset bench/datasets/<name>.jsonl --stage-rows bench/results/<name>.receipts.jsonl \
 *     --development-dataset bench/datasets/<development>.jsonl \
 *     --validation-dataset bench/datasets/<validation>.jsonl \
 *     --backend jev-gateway --model typesafe/jev-1.14 --model-version <pinned> \
 *     --adapter-version <HOOK_VERSION> --policy-version mission-closure/1 \
 *     --min-confidence 0.9 --require-liveness 0.95 --min-positives 60 --min-negatives 149 \
 *     --split lockbox --decision rejected --out bench/results/<name>.manifest.json
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { HOOK_VERSION } from "../src/hooks/version.js";
import { hashQuestions } from "../src/decision/provenance.js";
import { parseCalibrationDataset } from "../src/jev/calibration.js";
import { LOCKBOX_BENCH_VERSION, lockboxPolicy, verifyLockboxRun, type LockboxCaseScore } from "../src/jev/lockbox.js";
import {
  canonicalPolicyHash,
  missionClosure3StageGate,
  questionSetHashFor,
  releasePolicyFloorSatisfied,
  threeStageMetrics,
  type QualificationManifest,
} from "../src/jev/qualification.js";
import { assertOutputPathAvailable, writeNewArtifact } from "./artifact-output.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = flag(name);
  if (value === undefined || value === "") {
    console.error(`jev-qualify-lockbox: missing required ${name}`);
    process.exit(2);
  }
  return value;
}

const datasetPath = required("--dataset");
const rowsPath = required("--stage-rows");
const developmentDatasetPath = flag("--development-dataset");
const validationDatasetPath = flag("--validation-dataset");
const backend = required("--backend");
const model = required("--model");
const modelVersion = required("--model-version");
const adapterVersion = required("--adapter-version");
const outPath = required("--out");
if (adapterVersion !== HOOK_VERSION) {
  console.error(`jev-qualify-lockbox: --adapter-version must match running hook version ${HOOK_VERSION}`);
  process.exit(2);
}
const policyVersion = required("--policy-version");
const minConfidence = parseFloat(required("--min-confidence"));
const calibrationVersion = flag("--calibration-version");
if (calibrationVersion !== undefined) {
  console.error("jev-qualify-lockbox: --calibration-version is not supported; the bench premise is fixed to the lockbox bench version so manifests stay verifiable");
  process.exit(2);
}
const minLiveness = parseFloat(required("--require-liveness"));
const minPositives = parseInt(required("--min-positives"), 10);
const minNegatives = parseInt(required("--min-negatives"), 10);
const split = flag("--split") ?? "development";
const decision = flag("--decision") ?? "inconclusive";

if (split !== "development" && split !== "validation" && split !== "lockbox") {
  console.error(`jev-qualify-lockbox: --split must be development, validation, or lockbox`);
  process.exit(2);
}
if (decision !== "qualified" && decision !== "rejected" && decision !== "inconclusive") {
  console.error(`jev-qualify-lockbox: --decision must be qualified, rejected, or inconclusive`);
  process.exit(2);
}
if (decision === "qualified" && split !== "lockbox") {
  console.error("jev-qualify-lockbox: only lockbox evidence can be marked qualified");
  process.exit(2);
}
if (decision === "qualified") {
  const floor = releasePolicyFloorSatisfied({ minLiveness, minPositives, minNegatives });
  if (!floor.ok) {
    console.error(`jev-qualify-lockbox: refusing qualified below the release policy floor:\n- ${floor.reasons.join("\n- ")}`);
    process.exit(2);
  }
}
if (split !== "development" && (developmentDatasetPath === undefined || developmentDatasetPath === "")) {
  console.error("jev-qualify-lockbox: held-out qualification requires --development-dataset for overlap checking");
  process.exit(2);
}
if (split === "lockbox" && (validationDatasetPath === undefined || validationDatasetPath === "")) {
  console.error("jev-qualify-lockbox: lockbox qualification requires --validation-dataset for independence checking");
  process.exit(2);
}
if (!Number.isFinite(minConfidence) || minConfidence <= 0 || minConfidence > 1) {
  console.error("jev-qualify-lockbox: --min-confidence must be in (0, 1]");
  process.exit(2);
}

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const datasetText = readFileSync(datasetPath, "utf8");
const developmentDatasetText = developmentDatasetPath === undefined ? undefined : readFileSync(developmentDatasetPath, "utf8");
const validationDatasetText = validationDatasetPath === undefined ? undefined : readFileSync(validationDatasetPath, "utf8");
const rowsText = readFileSync(rowsPath, "utf8");

const cases = parseCalibrationDataset(datasetText);
if (developmentDatasetText !== undefined) {
  const developmentIds = new Set(parseCalibrationDataset(developmentDatasetText).map((item) => item.id));
  const overlap = cases.find((item) => developmentIds.has(item.id));
  if (overlap !== undefined) {
    console.error(`jev-qualify-lockbox: case ${overlap.id} overlaps development and ${split} splits; refusing`);
    process.exit(1);
  }
}
if (validationDatasetText !== undefined) {
  const validationCases = parseCalibrationDataset(validationDatasetText);
  const validationIds = new Set(validationCases.map((item) => item.id));
  const overlap = cases.find((item) => validationIds.has(item.id));
  if (overlap !== undefined) {
    console.error(`jev-qualify-lockbox: case ${overlap.id} overlaps validation and ${split} splits; refusing`);
    process.exit(1);
  }
  if (developmentDatasetText !== undefined) {
    const developmentIds = new Set(parseCalibrationDataset(developmentDatasetText).map((item) => item.id));
    const crossOverlap = validationCases.find((item) => developmentIds.has(item.id));
    if (crossOverlap !== undefined) {
      console.error(`jev-qualify-lockbox: case ${crossOverlap.id} overlaps development and validation splits; refusing`);
      process.exit(1);
    }
  }
}
const questionHash = hashQuestions(cases[0]!.questions);
for (const c of cases) {
  if (hashQuestions(c.questions) !== questionHash) {
    console.error(`jev-qualify-lockbox: refusing — case ${c.id} uses a different question set; one run binds one question set`);
    process.exit(2);
  }
}
const policy = lockboxPolicy(cases[0]!.questions, {
  policyVersion,
  minConfidence,
  backend,
  model,
  modelVersion,
});

const rows = rowsText.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as LockboxCaseScore);
const datasetRevision = sha256Hex(datasetText);
const verification = verifyLockboxRun(cases, rows, policy, datasetRevision);
if (!verification.ok) {
  console.error(`jev-qualify-lockbox: records do not verify; refusing:\n- ${verification.errors.slice(0, 10).join("\n- ")}`);
  process.exit(1);
}
const observedModels = new Set(rows.map((row) => row.observedModel));
if (observedModels.size !== 1 || observedModels.has(undefined as never) || [...observedModels][0] !== modelVersion) {
  console.error("jev-qualify-lockbox: rows span models or were not answered by the pinned policy model version; refusing");
  process.exit(1);
}

const thresholds = { minLiveness, minPositives, minNegatives };
const gate = missionClosure3StageGate(rows, thresholds);
const metrics = threeStageMetrics(rows);
if (decision === "qualified" && !gate.pass) {
  console.error(`jev-qualify-lockbox: gate fails, refusing qualified; use rejected:\n${gate.detail}`);
  process.exit(1);
}
if (outPath !== undefined) assertOutputPathAvailable(outPath);

const manifest: QualificationManifest = {
  family: "mission-closure-3stage",
  backend,
  model,
  modelVersion,
  adapterVersion,
  questionSetHash: questionSetHashFor([policy.questionHash]),
  policyHash: canonicalPolicyHash({ policyVersion, questionHash: policy.questionHash, minConfidence }),
  datasetHash: sha256Hex(datasetText),
  ...(developmentDatasetText === undefined ? {} : { developmentDatasetHash: sha256Hex(developmentDatasetText) }),
  ...(validationDatasetText === undefined ? {} : { validationDatasetHash: sha256Hex(validationDatasetText) }),
  evaluationHash: sha256Hex(rowsText),
  datasetSplit: split as QualificationManifest["datasetSplit"],
  expectedJudgments: cases.length,
  correctJudgments: verification.recomputed.integratedCorrect,
  invalidJudgments: 0,
  thresholds,
  metrics: { ...metrics },
  calibrationVersion: LOCKBOX_BENCH_VERSION,
  calibratedAt: new Date().toISOString(),
  decision: decision as QualificationManifest["decision"],
  datasetPath: relative(dirname(resolve(outPath)), resolve(datasetPath)),
  ...(developmentDatasetPath === undefined
    ? {}
    : { developmentDatasetPath: relative(dirname(resolve(outPath)), resolve(developmentDatasetPath)) }),
  ...(validationDatasetPath === undefined
    ? {}
    : { validationDatasetPath: relative(dirname(resolve(outPath)), resolve(validationDatasetPath)) }),
  receiptsPath: relative(dirname(resolve(outPath)), resolve(rowsPath)),
};
writeNewArtifact(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.error(
  `manifest: mission-closure-3stage ${cases.length} cases (${verification.recomputed.integratedCorrect} integrated-correct), ` +
  `gate ${gate.pass ? "PASS" : "FAIL"}, decision=${decision} -> ${outPath}\n` +
  `gate: ${gate.detail}`,
);
