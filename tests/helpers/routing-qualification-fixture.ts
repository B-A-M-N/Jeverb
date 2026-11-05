/**
 * Synthetic consequential-routing qualification fixtures for tool-level tests.
 *
 * Builds a genuinely verifying manifest (real dataset + receipts bytes,
 * recomputed hashes, lockbox split) measured on the live question-set hash
 * the test graph will actually ask, so `resolveRoutingAdmission` admits the
 * route through the production verification path. Nothing here is a
 * production qualification: the datasets are programmatic labels, the
 * decisions are synthetic, and the fixture only ever lands in a temp dir.
 * No live inference is involved.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { questionSetHashFor } from "../../src/jev/qualification.js";
import { policyHash, type OperatorRoutingProvision } from "../../src/tools/execute-graph.js";
import type { ExecutionPolicy } from "../../src/graph/policy.js";

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export interface RoutingFixtureOptions {
  /** Temp dataDir the tool run will use. */
  dataDir: string;
  /** The exact execution policy object the tool run will use. */
  policy: ExecutionPolicy;
  /** Pinned deployment identity (must match the answering model). */
  backend: string;
  model: string;
  modelVersion: string;
  /** The actual question-set hash the graph's Jev nodes will answer. */
  liveQuestionHash: string;
  /** Measured population (default 60, the release floor). */
  cases?: number | undefined;
  /** Wrong judgments to plant (default 0). Planted misses keep the fixture verifying but fail the gate. */
  wrong?: number | undefined;
  thresholds?: { minAccuracy: number; minCases: number } | undefined;
}

function caseRow(id: string): string {
  return JSON.stringify({
    id,
    state: { objective: `route ${id}` },
    questions: {
      route: { type: "noul", instructions: "Should the consequential route be taken?" },
    },
    expected: { route: { noul: [0.8, 1.0] } },
  });
}

function receiptRow(datasetHash: string, questionHash: string, id: string, correct: boolean): string {
  return JSON.stringify({
    case: id,
    question: "route",
    model: "route-model",
    modelVersion: "route-v1",
    adapterVersion: "adapter/1",
    provider: "route-backend",
    questionHash,
    dataset: datasetHash,
    answer: { type: "noul", noul: correct ? 0.9 : 0.1 },
    inRange: correct,
    latency_ms: 5,
  });
}

/**
 * Write dataset + receipts + operator provision into the dataDir. Returns
 * the pinned question family so tests can assert the binding.
 */
export function writeRoutingFixture(options: RoutingFixtureOptions): { questionFamily: string } {
  const cases = options.cases ?? 60;
  const wrong = options.wrong ?? 0;
  const thresholds = options.thresholds ?? { minAccuracy: 0.9, minCases: 60 };
  const ids = Array.from({ length: cases }, (_, i) => `route-case-${i}`);
  const dataset = `${ids.map(caseRow).join("\n")}\n`;
  const development = `${caseRow("development-only")}\n`;
  const validation = `${caseRow("validation-only")}\n`;
  const datasetHash = sha(dataset);
  const receipts =
    `${ids.map((id, i) => receiptRow(datasetHash, options.liveQuestionHash, id, i >= wrong)).join("\n")}\n`;
  const benchDir = join(options.dataDir, "routing-bench");
  const datasetPath = join(benchDir, "bench.jsonl");
  const developmentDatasetPath = join(benchDir, "development.jsonl");
  const validationDatasetPath = join(benchDir, "validation.jsonl");
  const receiptsPath = join(benchDir, "receipts.jsonl");
  mkdirSync(benchDir, { recursive: true });
  writeFileSync(datasetPath, dataset);
  writeFileSync(developmentDatasetPath, development);
  writeFileSync(validationDatasetPath, validation);
  writeFileSync(receiptsPath, receipts);
  const questionFamily = questionSetHashFor([options.liveQuestionHash]);
  const provision: OperatorRoutingProvision = {
    backend: options.backend,
    model: options.model,
    modelVersion: options.modelVersion,
    adapterVersion: "adapter/1",
    questionFamily,
    manifest: {
      family: "consequential-routing",
      backend: options.backend,
      model: options.model,
      modelVersion: options.modelVersion,
      adapterVersion: "adapter/1",
      questionSetHash: questionFamily,
      policyHash: policyHash(options.policy),
      datasetHash,
      developmentDatasetHash: sha(development),
      validationDatasetHash: sha(validation),
      evaluationHash: sha(receipts),
      datasetSplit: "lockbox",
      expectedJudgments: cases,
      correctJudgments: cases - wrong,
      invalidJudgments: 0,
      thresholds: { ...thresholds },
      calibratedAt: new Date().toISOString(),
      decision: "qualified",
    },
    evidence: {
      datasetPath: "routing-bench/bench.jsonl",
      developmentDatasetPath: "routing-bench/development.jsonl",
      validationDatasetPath: "routing-bench/validation.jsonl",
      receiptsPath: "routing-bench/receipts.jsonl",
    },
  };
  writeFileSync(join(options.dataDir, "routing-qualification.json"), JSON.stringify(provision));
  return { questionFamily };
}
