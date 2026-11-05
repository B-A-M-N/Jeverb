/**
 * Review qualification manifest gate. When policy provenance names a
 * manifest, `gateReviewOnManifest` re-verifies it against the active
 * deployment identity and recomputed artifacts; any failure degrades
 * the config to uncalibrated, never to an exception or to ready.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_VERSION } from "../../src/hooks/version.js";
import {
  gateReviewOnManifest,
  hashReviewChecks,
  loadReviewConfig,
  reviewPolicyHash,
} from "../../src/review/load-config.js";

const BACKEND = "typesafe";
const MODEL = "jev-test-1";
const MODEL_VERSION = "jev-test-1-20240101";

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function checksJson(): string {
  return JSON.stringify({
    checks: [{
      id: "test-check",
      type: "noul",
      instructions: {
        question: "Is this bad?",
        inspect: "diff",
        focus: "Judge only the diff.",
      },
      criteria: { true: "bad", false: "fine" },
    }],
  });
}

function questionHashForChecks(): string {
  const parsed = JSON.parse(checksJson()) as { checks: Parameters<typeof hashReviewChecks>[0] };
  return hashReviewChecks(parsed.checks);
}

function datasetText(): string {
  const q = {
    id: "r1",
    state: {},
    questions: { r1: { type: "choice", instructions: "Pick.", criteria: { a: "A", b: "B" } } },
    expected: { r1: { choice: "a" } },
  };
  return `${JSON.stringify(q)}\n`;
}

function receiptsText(datasetHash: string, questionHash: string): string {
  return `${JSON.stringify({
    case: "r1",
    question: "r1",
    model: MODEL,
    modelVersion: MODEL_VERSION,
    adapterVersion: HOOK_VERSION,
    provider: BACKEND,
    questionHash,
    dataset: datasetHash,
    answer: { type: "choice", choice: "a" },
    expected: { choice: "a" },
    inRange: true,
    latency_ms: 2,
  })}\n`;
}

interface GateFixture {
  root: string;
  questionHash: string;
  modelVersion: string;
}

function setup(manifestDecision: string): GateFixture {
  const root = mkdtempSync(join(tmpdir(), "jev-review-manifest-"));
  const reviewDir = join(root, "config", "review");
  mkdirSync(reviewDir, { recursive: true });
  const questionHash = questionHashForChecks();
  writeFileSync(join(reviewDir, "checks.json"), checksJson());
  const dataset = datasetText();
  const developmentDataset = dataset.replace('"id":"r1"', '"id":"development-r1"');
  const validationDataset = dataset.replace('"id":"r1"', '"id":"validation-r1"');
  const datasetHash = sha(dataset);
  const receipts = receiptsText(datasetHash, questionHash);
  const finalDatasetHash = sha(dataset);
  const finalReceipts = receipts;
  writeFileSync(join(reviewDir, "bench.jsonl"), dataset);
  writeFileSync(join(reviewDir, "development.jsonl"), developmentDataset);
  writeFileSync(join(reviewDir, "validation.jsonl"), validationDataset);
  writeFileSync(join(reviewDir, "receipts.jsonl"), finalReceipts);
  const manifest = {
    family: "review",
    backend: BACKEND,
    model: MODEL,
    modelVersion: MODEL_VERSION,
    adapterVersion: HOOK_VERSION,
    questionSetHash: sha(JSON.stringify([questionHash])),
    policyHash: reviewPolicyHash("1", questionHash, { block: 0.85, security_review: 0.6 }),
    datasetHash: finalDatasetHash,
    developmentDatasetHash: sha(developmentDataset),
    validationDatasetHash: sha(validationDataset),
    evaluationHash: sha(finalReceipts),
    datasetSplit: "lockbox",
    expectedJudgments: 1,
    correctJudgments: 1,
    invalidJudgments: 0,
    thresholds: { block: 0.85, security_review: 0.6 },
    calibratedAt: new Date().toISOString(),
    decision: manifestDecision,
    datasetPath: "bench.jsonl",
    developmentDatasetPath: "development.jsonl",
    validationDatasetPath: "validation.jsonl",
    receiptsPath: "receipts.jsonl",
  };
  writeFileSync(join(reviewDir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(reviewDir, "policy.json"), JSON.stringify({
    policy_version: "1",
    thresholds: { block: 0.85, security_review: 0.6 },
    provenance: {
      backend: BACKEND,
      model: MODEL,
      calibrated: true,
      questionHash,
      calibrationVersion: "cal/1",
      datasetRevision: finalDatasetHash,
      evaluationHash: sha(finalReceipts),
      modelVersion: MODEL_VERSION,
      qualificationManifest: "manifest.json",
    },
  }));
  return { root, questionHash, modelVersion: MODEL_VERSION };
}

function gate(fixture: GateFixture, warnings: string[]): ReturnType<typeof gateReviewOnManifest> {
  const loaded = loadReviewConfig([fixture.root]);
  expect(loaded.status).toBe("ready");
  return gateReviewOnManifest(
    loaded,
    { backend: BACKEND, model: MODEL, modelVersion: fixture.modelVersion, adapterVersion: HOOK_VERSION },
    (message) => warnings.push(message),
  );
}

describe("review qualification manifest gate", () => {
  it("degrades a calibrated config claim when no qualification manifest is configured", () => {
    const fixture = setup("qualified");
    try {
      const reviewDir = join(fixture.root, "config", "review");
      const policyPath = join(reviewDir, "policy.json");
      const policy = JSON.parse(readFileSync(policyPath, "utf8")) as { provenance: Record<string, unknown> };
      delete policy.provenance["qualificationManifest"];
      writeFileSync(policyPath, JSON.stringify(policy));
      const loaded = loadReviewConfig([fixture.root]);
      expect(loaded.status).toBe("ready");
      const warnings: string[] = [];
      const gated = gateReviewOnManifest(
        loaded,
        { backend: BACKEND, model: MODEL, modelVersion: fixture.modelVersion, adapterVersion: HOOK_VERSION },
        (message) => warnings.push(message),
      );
      expect(gated.status).toBe("uncalibrated");
      expect(gated.calibration.calibrated).toBe(false);
      expect(warnings.some((warning) => warning.includes("has no qualification manifest"))).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("degrades manifests for families without a release policy", () => {
    const fixture = setup("qualified");
    try {
      const warnings: string[] = [];
      const gated = gate(fixture, warnings);
      expect(gated.status).toBe("uncalibrated");
      expect(warnings.some((w) => w.includes("no independent release policy"))).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("degrades to uncalibrated when the receipts were modified", () => {
    const fixture = setup("qualified");
    try {
      const warnings: string[] = [];
      const loaded = loadReviewConfig([fixture.root]);
      expect(loaded.status).toBe("ready");
      const reviewDir = join(fixture.root, "config", "review");
      writeFileSync(join(reviewDir, "receipts.jsonl"), `${"x".repeat(10)}\n`);
      const gated = gateReviewOnManifest(
        loaded,
        { backend: BACKEND, model: MODEL, modelVersion: fixture.modelVersion, adapterVersion: HOOK_VERSION },
        (message) => warnings.push(message),
      );
      expect(gated.status).toBe("uncalibrated");
      expect(gated.calibration.calibrated).toBe(false);
      expect(warnings.some((w) => w.includes("qualification manifest"))).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("degrades to uncalibrated when the manifest records another decision", () => {
    const fixture = setup("inconclusive");
    try {
      const warnings: string[] = [];
      const gated = gate(fixture, warnings);
      expect(gated.status).toBe("uncalibrated");
      expect(warnings.some((w) => w.includes("inconclusive"))).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("degrades to uncalibrated when the active backend differs", () => {
    const fixture = setup("qualified");
    try {
      const warnings: string[] = [];
      const loaded = loadReviewConfig([fixture.root]);
      const gated = gateReviewOnManifest(
        loaded,
        { backend: "openrouter", model: MODEL, modelVersion: fixture.modelVersion, adapterVersion: HOOK_VERSION },
        (message) => warnings.push(message),
      );
      expect(gated.status).toBe("uncalibrated");
      expect(warnings.some((w) => w.includes("backend"))).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
