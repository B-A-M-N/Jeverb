#!/usr/bin/env tsx
/**
 * Jev calibration bench.
 *
 * Runs a labeled JSONL dataset through a DecisionModel (OpenRouter adapter
 * by default, native client with --native) and reports raw-answer accuracy
 * plus a noul threshold sweep (TP/FP/TN/FN, TPR, FPR, precision, recall).
 *
 * Every row records model id/version, the running hook version as adapter
 * identity, question hash, and
 * dataset revision, so a changed question/model/dataset invalidates any
 * "calibrated" marker derived from the output. Thresholds are reported, not
 * applied: nothing here writes policy config.
 *
 * Dataset line format:
 * {"id":"...","state":{...},"questions":{...},
 *  "expected":{"<qid>":{"noul":[lo,hi],"label":true|false} |
 *                         {"choice":"<option>"} |
 *                         {"score":[lo,hi]}}}
 *
 * Usage:
 *   npx tsx scripts/jev-calibrate.ts bench/datasets/jev-calib-v1.jsonl \
 *     --model-version <deployed-version> --adapter-version <HOOK_VERSION> \
 *     [--native] [--model <id>] [--out <receipts.jsonl>]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  calibrationFailure,
  parseCalibrationDataset,
  noulCalibrationMetrics,
  summarizeCalibration,
  type CalibrationExpected,
  type CalibrationJudgmentRow,
} from "../src/jev/calibration.js";
import { HOOK_VERSION } from "../src/hooks/version.js";
import { isOpenRouterJevModel, OpenRouterDecisionModel, OpenRouterJevDecisionModel } from "../src/jev/openrouter.js";
import { JevDecisionModel } from "../src/jev/client.js";
import type { Answer, DecisionModel, Question } from "../src/decision/types.js";
import { PROVIDER_OPENROUTER, PROVIDER_TYPESAFE } from "../src/decision/types.js";
import { hashQuestions } from "../src/decision/provenance.js";
import { assertOutputPathAvailable, writeNewArtifact } from "./artifact-output.js";

const CALIBRATION_BENCH_VERSION = "jev-calibration/2";
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const datasetPath = args[0];
if (!datasetPath) {
  console.error("usage: jev-calibrate.ts <dataset.jsonl> [--native] [--model <id>] [--out <file>]");
  process.exit(2);
}
const modelFlag = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : undefined;
const modelVersion = process.argv.includes("--model-version") ? process.argv[process.argv.indexOf("--model-version") + 1] : undefined;
const adapterVersion = process.argv.includes("--adapter-version") ? process.argv[process.argv.indexOf("--adapter-version") + 1] : undefined;
const outPath = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
if (outPath !== undefined) assertOutputPathAvailable(outPath);
if (!modelVersion || !adapterVersion) {
  console.error("jev-calibrate: --model-version and --adapter-version are required for qualification-grade receipts");
  process.exit(2);
}
if (adapterVersion !== HOOK_VERSION) {
  console.error(`jev-calibrate: --adapter-version must match running hook version ${HOOK_VERSION}`);
  process.exit(2);
}

const datasetText = readFileSync(datasetPath, "utf8");
const datasetRevision = createHash("sha256").update(datasetText, "utf8").digest("hex");
let cases;
try {
  cases = parseCalibrationDataset(datasetText);
} catch (error) {
  console.error(`jev-calibrate: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

let model: DecisionModel;
if (flags.has("--native")) {
  const apiKey = process.env.TYPESAFE_API_KEY ?? "";
  if (!apiKey) {
    console.error("jev-calibrate: TYPESAFE_API_KEY is not set");
    process.exit(2);
  }
  model = new JevDecisionModel({ apiKey, ...(modelFlag ? { model: modelFlag } : {}) });
} else {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) {
    console.error("jev-calibrate: OPENROUTER_API_KEY is not set");
    process.exit(2);
  }
  const openRouterOptions = {
    apiKey,
    model: modelFlag ?? "typesafe/jev-latest",
    // Keep the development evaluation ceiling to one upstream call per case.
    maxRetries: 0,
  };
  model = isOpenRouterJevModel(openRouterOptions.model)
    ? new OpenRouterJevDecisionModel(openRouterOptions)
    : new OpenRouterDecisionModel(openRouterOptions);
}
const provider = flags.has("--native") ? PROVIDER_TYPESAFE : PROVIDER_OPENROUTER;

function questionDefinitionHash(q: Question): string {
  return createHash("sha256").update(JSON.stringify(q), "utf8").digest("hex");
}

function inRange(answer: Answer, exp: CalibrationExpected): boolean | null {
  if (answer.type === "noul" && exp.noul) {
    return answer.noul >= exp.noul[0] && answer.noul <= exp.noul[1] &&
      (exp.label === undefined || (answer.noul >= 0.5) === exp.label);
  }
  if (answer.type === "choice" && exp.choice !== undefined) return answer.choice === exp.choice;
  if (answer.type === "score" && exp.score) return answer.score >= exp.score[0] && answer.score <= exp.score[1];
  return null;
}

type Receipt = CalibrationJudgmentRow & Record<string, unknown>;

function minimalAnswer(answer: Answer): CalibrationJudgmentRow["answer"] {
  if (answer.type === "noul") return { type: "noul", noul: answer.noul };
  if (answer.type === "choice") return { type: "choice", choice: answer.choice };
  return { type: "score", score: answer.score };
}

const receipts: Receipt[] = [];
let missingAnswers = 0;
let modelMismatches = 0;
const observedModels = new Set<string>();
const observedProviders = new Set<string>();
const observedQuestionHashes = new Set<string>();
let casesRun = 0;
let stopReason: string | undefined;

for (const c of cases) {
  try {
    const result = await model.evaluate({ state: c.state as never, questions: c.questions });
    casesRun += 1;
    observedModels.add(result.model);
    observedProviders.add(result.provider);
    observedQuestionHashes.add(result.questionHash);
    const identityMatches = result.provider === provider && result.model === modelVersion &&
      result.questionHash === hashQuestions(c.questions);
    if (!identityMatches) modelMismatches += 1;
    for (const qid of Object.keys(c.questions)) {
      if (result.answers[qid] !== undefined) continue;
      missingAnswers += 1;
      receipts.push({
        case: c.id,
        question: qid,
        model: result.model,
        modelVersion,
        adapterVersion,
        provider: result.provider,
        questionHash: result.questionHash,
        questionDefinitionHash: questionDefinitionHash(c.questions[qid]!),
        dataset: datasetRevision,
        expected: c.expected[qid],
        inRange: false,
        error: "answer missing from model result",
        latency_ms: result.latency_ms,
        usage: { ...result.usage },
      });
    }
    for (const [qid, answer] of Object.entries(result.answers)) {
      const exp = c.expected[qid];
      if (!exp) continue;
      const ok = inRange(answer as Answer, exp);
      receipts.push({
        case: c.id,
        question: qid,
        model: result.model,
        modelVersion,
        adapterVersion,
        provider: result.provider,
        questionHash: result.questionHash,
        questionDefinitionHash: questionDefinitionHash(c.questions[qid]!),
        dataset: datasetRevision,
        answer: minimalAnswer(answer as Answer),
        expected: exp,
        inRange: ok,
        latency_ms: result.latency_ms,
        usage: { ...result.usage },
      });
    }
    if (!identityMatches) {
      stopReason = "provider, serving-model, or question binding mismatch";
      break;
    }
    if (observedModels.size > 1 || observedProviders.size > 1 || observedQuestionHashes.size > 1) {
      stopReason = "response identity changed during the run";
      break;
    }
  } catch (err) {
    casesRun += 1;
    const failure = calibrationFailure(err);
    // One failure entry per expected question: a failed multi-question case
    // must not collapse into a single failed answer. Plus one case-level
    // error record for traceability.
    for (const qid of Object.keys(c.questions)) {
      receipts.push({
        case: c.id,
        question: qid,
        model: model.name,
        modelVersion,
        adapterVersion,
        provider,
        questionHash: hashQuestions(c.questions),
        dataset: datasetRevision,
        expected: c.expected[qid],
        inRange: false,
        error: failure.type,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        ...(failure.code === undefined ? {} : { code: failure.code }),
        ...(failure.meta === undefined ? {} : { meta: failure.meta }),
      });
    }
    receipts.push({
      case: c.id,
      question: "",
      caseError: true,
      dataset: datasetRevision,
      model: model.name,
      modelVersion,
      adapterVersion,
      provider,
      questionHash: hashQuestions(c.questions),
      error: failure.type,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.code === undefined ? {} : { code: failure.code }),
      ...(failure.meta === undefined ? {} : { meta: failure.meta }),
    });
    stopReason = failure.type;
    break;
  }
}

const tallied = summarizeCalibration(cases, receipts);
const noulSamples = tallied.noulSamples;
const thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const sweep = thresholds.map((t) => {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const s of noulSamples) {
    const positive = s.p >= t;
    if (positive && s.label) tp++;
    else if (positive) fp++;
    else if (s.label) fn++;
    else tn++;
  }
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  return { threshold: t, tp, fp, tn, fn, tpr: recall, fpr: fp + tn === 0 ? null : fp / (fp + tn), precision, recall };
});

const summary = {
  dataset: datasetPath,
  datasetRevision,
  configuredModel: model.name,
  benchmarkVersion: CALIBRATION_BENCH_VERSION,
  observedModels: [...observedModels].sort(),
  observedProviders: [...observedProviders].sort(),
  questionSetHashes: [...observedQuestionHashes].sort(),
  calibrationRevision: createHash("sha256").update(JSON.stringify({
    datasetRevision,
    benchmarkVersion: CALIBRATION_BENCH_VERSION,
    configuredModel: model.name,
    observedModels: [...observedModels].sort(),
    observedProviders: [...observedProviders].sort(),
    questionSetHashes: [...observedQuestionHashes].sort(),
  }), "utf8").digest("hex"),
  cases: tallied.cases,
  casesRun,
  stoppedEarly: stopReason !== undefined,
  ...(stopReason === undefined ? {} : { stopReason }),
  successfulCases: tallied.successfulCases,
  failedCases: tallied.failedCases,
  expectedAnswers: tallied.expectedAnswers,
  missingAnswers,
  modelMismatches,
  answerable: tallied.answerable,
  inRange: tallied.inRange,
  invalidJudgments: tallied.invalidJudgments,
  /** Inclusive question-level accuracy: failed calls count against every expected judgment. */
  accuracy: tallied.accuracy,
  /** Success-only diagnostic: valid answers only in the denominator. */
  answeredAccuracy: tallied.answeredAccuracy,
  caseSuccessRate: tallied.caseSuccessRate,
  caseExactMatchRate: tallied.caseExactMatchRate,
  systemDecisionAccuracy: tallied.systemDecisionAccuracy,
  systemDecisionQuestion: tallied.systemDecisionQuestion,
  confusion: tallied.confusion,
  failuresByCode: tallied.failuresByCode,
  noulSamples: noulSamples.length,
  noulCalibration: noulCalibrationMetrics(noulSamples),
  sweep,
};
console.log(JSON.stringify(summary, null, 2));
if (outPath) {
  writeNewArtifact(outPath, receipts.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.error(`receipts: ${receipts.length} rows -> ${outPath}`);
}
if (stopReason !== undefined) process.exitCode = 1;
