#!/usr/bin/env tsx
/**
 * Independently verify one recorded three-stage lockbox run.
 *
 * Recomputes release tallies from the labeled dataset, the recorded rows,
 * and the authoritative policy binding — never from the runner's own
 * counters. Rejects missing, extra, duplicate, or mismatched records;
 * unreproducible preflights; illegal stage transitions; and any
 * disagreement between recorded and recomputed correctness. Exits nonzero
 * when the run cannot support a qualification claim.
 *
 * Usage:
 *   npx tsx scripts/jev-verify-lockbox.ts <dataset.jsonl> <rows.jsonl> \
 *     --policy-version <v> --backend <b> --model <m> --model-version <v> \
 *     [--min-confidence 0.9] [--calibration-version <v>]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hashQuestions } from "../src/decision/provenance.js";
import { parseCalibrationDataset } from "../src/jev/calibration.js";
import {
  LOCKBOX_BENCH_VERSION,
  lockboxPolicy,
  verifyLockboxRun,
  type LockboxCaseScore,
} from "../src/jev/lockbox.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [datasetPath, rowsPath] = args;
if (!datasetPath || !rowsPath) {
  console.error("usage: jev-verify-lockbox.ts <dataset.jsonl> <rows.jsonl> --policy-version <v> --backend <b> --model <m> --model-version <v> [options]");
  process.exit(2);
}
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const policyVersion = flag("--policy-version");
const backend = flag("--backend");
const model = flag("--model");
const modelVersion = flag("--model-version");
const minConfidence = parseFloat(flag("--min-confidence") ?? "0.9");
const calibrationVersion = flag("--calibration-version");
if (!policyVersion || !backend || !model || !modelVersion) {
  console.error("jev-verify-lockbox: --policy-version, --backend, --model, and --model-version are required");
  process.exit(2);
}
if (!Number.isFinite(minConfidence) || minConfidence <= 0 || minConfidence > 1) {
  console.error("jev-verify-lockbox: --min-confidence must be in (0, 1]");
  process.exit(2);
}

const datasetText = readFileSync(datasetPath, "utf8");
const datasetRevision = createHash("sha256").update(datasetText, "utf8").digest("hex");
const cases = parseCalibrationDataset(datasetText);
if (cases.length === 0) {
  console.error("jev-verify-lockbox: no cases in dataset");
  process.exit(2);
}
const questionHash = hashQuestions(cases[0]!.questions);
for (const c of cases) {
  if (hashQuestions(c.questions) !== questionHash) {
    console.error(`jev-verify-lockbox: refusing — case ${c.id} uses a different question set`);
    process.exit(2);
  }
}
const policy = lockboxPolicy(cases[0]!.questions, {
  policyVersion,
  minConfidence,
  backend,
  model,
  modelVersion,
  ...(calibrationVersion === undefined ? {} : { calibrationVersion }),
});

const rows = readFileSync(rowsPath, "utf8").split("\n").filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as LockboxCaseScore);
const verdict = verifyLockboxRun(cases, rows, policy, datasetRevision);
console.log(JSON.stringify({
  dataset: datasetPath,
  rows: rowsPath,
  datasetRevision,
  benchVersion: LOCKBOX_BENCH_VERSION,
  questionHash,
  binding: { policyVersion, backend, model, modelVersion, minConfidence },
  ok: verdict.ok,
  errors: verdict.errors,
  recomputed: verdict.recomputed,
}, null, 2));
if (!verdict.ok) process.exit(1);
