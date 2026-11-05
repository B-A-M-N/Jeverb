/**
 * Qualification manifests at the mission-closure enforcement boundary.
 * A configured manifest must verify against the active deployment
 * identity and recomputed artifacts before `calibrated: true` is
 * honored. Every failure degrades to uncalibrated with a warning.
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHookConfig } from "../../src/hooks/config.js";
import { HOOK_VERSION } from "../../src/hooks/version.js";
import { lockboxPolicy, scoreLockboxCase } from "../../src/jev/lockbox.js";
import {
  canonicalPolicyHash,
  MISSION_CLOSURE_RELEASE_POLICY,
  questionSetHashFor,
  threeStageMetrics,
  type QualificationManifest,
} from "../../src/jev/qualification.js";
import { hashQuestions } from "../../src/decision/provenance.js";
import { MISSION_CLOSURE_POLICY_VERSION, MISSION_CLOSURE_QUESTION } from "../../src/mission/closure.js";

const LIVE_QUESTION_HASH = hashQuestions({ closure: MISSION_CLOSURE_QUESTION });
const MIN_CONFIDENCE = 0.9;

function choiceQuestion(): Record<string, unknown> {
  return {
    closure: {
      type: "choice",
      instructions: "Choose COMPLETE when done, INCOMPLETE otherwise.",
      criteria: { COMPLETE: "done", INCOMPLETE: "not done" },
    },
  };
}

function datasetText(): string {
  const cases = [
    { id: "one", state: {}, questions: choiceQuestion(), expected: { closure: { choice: "COMPLETE" } } },
    { id: "two", state: {}, questions: choiceQuestion(), expected: { closure: { choice: "INCOMPLETE" } } },
  ];
  return `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`;
}

function receiptsText(datasetHash: string, questionHash: string, model: string, backend: string): string {
  const row = (c: string, choice: string, inRange: boolean): string => JSON.stringify({
    case: c,
    question: "closure",
    model,
    modelVersion: model,
    adapterVersion: HOOK_VERSION,
    provider: backend,
    questionHash,
    dataset: datasetHash,
    answer: { type: "choice", choice },
    expected: { choice: c === "one" ? "COMPLETE" : "INCOMPLETE" },
    inRange,
    latency_ms: 3,
  });
  return `${row("one", "COMPLETE", true)}\n${row("two", "INCOMPLETE", true)}\n`;
}

function shaFile(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface Fixture {
  dataDir: string;
  model: string;
  backend: string;
  modelVersion?: string;
  env?: Record<string, string>;
}

function baseConfig(dataDir: string): Record<string, string> {
  return { JEV_HOOKS_DATA_DIR: dataDir };
}

function writeClosureConfig(
  dataDir: string,
  model: string,
  manifestName?: string,
  calibrationVersion = "cal/1",
  modelVersion = model,
): void {
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({
      mission_closure: {
        calibrated: true,
        min_confidence: MIN_CONFIDENCE,
        model_version: modelVersion,
        question_hash: LIVE_QUESTION_HASH,
        calibration_version: calibrationVersion,
        ...(manifestName === undefined ? {} : { qualification_manifest: manifestName }),
      },
    }),
  );
}

function writeArtifacts(dataDir: string, fixture: Fixture): string {
  const dataset = datasetText();
  const developmentDataset = dataset.replaceAll('"one"', '"development-one"').replaceAll('"two"', '"development-two"');
  const validationDataset = dataset.replaceAll('"one"', '"validation-one"').replaceAll('"two"', '"validation-two"');
  const datasetHash = shaFile(dataset);
  const receipts = receiptsText(datasetHash, LIVE_QUESTION_HASH, fixture.model, fixture.backend);
  const files = { dataset, receipts };
  writeFileSync(join(dataDir, "bench.jsonl"), files.dataset);
  writeFileSync(join(dataDir, "development.jsonl"), developmentDataset);
  writeFileSync(join(dataDir, "validation.jsonl"), validationDataset);
  const finalReceipts = files.receipts;
  writeFileSync(join(dataDir, "receipts.jsonl"), finalReceipts);
  const manifest = {
    family: "mission-closure",
    backend: fixture.backend,
    model: fixture.model,
    modelVersion: fixture.model,
    adapterVersion: HOOK_VERSION,
    questionSetHash: questionSetHashFor([LIVE_QUESTION_HASH]),
    policyHash: canonicalPolicyHash({
      policyVersion: MISSION_CLOSURE_POLICY_VERSION,
      questionHash: LIVE_QUESTION_HASH,
      minConfidence: MIN_CONFIDENCE,
    }),
    datasetHash: shaFile(files.dataset),
    developmentDatasetHash: shaFile(developmentDataset),
    validationDatasetHash: shaFile(validationDataset),
    evaluationHash: shaFile(finalReceipts),
    datasetSplit: "lockbox",
    expectedJudgments: 2,
    correctJudgments: 2,
    invalidJudgments: 0,
    thresholds: { minConfidence: MIN_CONFIDENCE },
    calibratedAt: new Date().toISOString(),
    decision: "qualified",
    datasetPath: "bench.jsonl",
    developmentDatasetPath: "development.jsonl",
    validationDatasetPath: "validation.jsonl",
    receiptsPath: "receipts.jsonl",
  };
  writeFileSync(join(dataDir, "manifest.json"), JSON.stringify(manifest));
  return "manifest.json";
}

function setup(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "jev-manifest-"));
  const probe = loadHookConfig(baseConfig(dataDir));
  return { dataDir, model: probe.model, backend: probe.backend };
}

function setupOpenRouter(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "jev-openrouter-manifest-"));
  const env = {
    JEV_HOOKS_DATA_DIR: dataDir,
    JEV_BACKEND: "openrouter",
    JEV_MODEL: "typesafe/jev-latest",
    OPENROUTER_API_KEY: "test-key",
  };
  const probe = loadHookConfig(env);
  return {
    dataDir,
    model: probe.model,
    backend: probe.backend,
    modelVersion: "typesafe/jev-latest-20261103",
    env,
  };
}

function configFor(fixture: Fixture) {
  return loadHookConfig(fixture.env ?? baseConfig(fixture.dataDir));
}

describe("mission-closure qualification manifest boundary", () => {
  it("reads a legacy safety-only manifest as history but grants it no production authority", () => {
    const fixture = setup();
    const manifestName = writeArtifacts(fixture.dataDir, fixture);
    writeClosureConfig(fixture.dataDir, fixture.model, manifestName);
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("legacy safety-only"))).toBe(true);
  });

  it("degrades to uncalibrated when the receipts were modified", () => {
    const fixture = setup();
    writeArtifacts(fixture.dataDir, fixture);
    // The manifest binds the written receipts; appending a byte afterwards
    // breaks the evaluation hash and must fail verification.
    appendFileSync(join(fixture.dataDir, "receipts.jsonl"), " ");
    writeClosureConfig(fixture.dataDir, fixture.model, "manifest.json");
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("qualification manifest"))).toBe(true);
  });

  it("degrades to uncalibrated when the manifest is missing", () => {
    const fixture = setup();
    writeClosureConfig(fixture.dataDir, fixture.model, "absent.json");
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("cannot be read"))).toBe(true);
  });

  it("degrades to uncalibrated when the manifest records another decision", () => {
    const fixture = setup();
    const manifestName = writeArtifacts(fixture.dataDir, fixture);
    const manifestPath = join(fixture.dataDir, manifestName);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest["decision"] = "inconclusive";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeClosureConfig(fixture.dataDir, fixture.model, manifestName);
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("inconclusive"))).toBe(true);
  });

  it("keeps an unverified calibration claim advisory when no manifest is configured", () => {
    const fixture = setup();
    writeClosureConfig(fixture.dataDir, fixture.model);
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("no qualification manifest"))).toBe(true);
  });
});

describe("mission-closure-3stage qualification manifest boundary", () => {
  const QUESTIONS = { closure: MISSION_CLOSURE_QUESTION };
  const THRESHOLDS = { minLiveness: 0.5, minPositives: 1, minNegatives: 1 };

  function completeState(): Record<string, unknown> {
    return {
      objective: "Add retry with backoff to the sync client",
      acceptanceCriteria: [
        { id: "retry", statement: "Retry with backoff is implemented", outcome: "implemented", evidenceRef: "verifier:v:40" },
      ],
      tests: { passed: true, independent: true, evidenceRef: "verifier:v:40" },
      operations: { pending: 0, uncertain: 0 },
      blockers: [],
      graphRuns: [],
      missionRevision: "mission-r10",
      evidenceRevision: "evidence-r20",
    };
  }

  function incompleteState(): Record<string, unknown> {
    return {
      ...completeState(),
      acceptanceCriteria: [{ id: "retry", statement: "Retry with backoff is implemented" }],
    };
  }

  function votingModel(fixture: Fixture) {
    return {
      name: fixture.model,
      evaluate: async (input: { questions: unknown }) => ({
        model: fixture.modelVersion ?? fixture.model,
        correlationId: "gen-config-test",
        provider: fixture.backend,
        questionHash: hashQuestions(input.questions as Parameters<typeof hashQuestions>[0]),
        answers: {
          closure: {
            type: "choice",
            choice: "COMPLETE",
            confidence: 0.97,
            probabilities: { COMPLETE: 0.97, INCOMPLETE: 0.01, BLOCKED: 0.01, INSUFFICIENT_EVIDENCE: 0.01 },
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
        latency_ms: 1,
      }),
      choice: async () => { throw new Error("unused"); },
      score: async () => { throw new Error("unused"); },
      probability: async () => { throw new Error("unused"); },
    };
  }

  async function writePolicyScaleArtifacts(dataDir: string, fixture: Fixture): Promise<string> {
    const cases: Array<{ id: string; state: Record<string, unknown>; expected: { closure: { choice: string } } }> = [];
    for (let index = 0; index < 60; index += 1) {
      cases.push({ id: `pos-${index}`, state: completeState(), expected: { closure: { choice: "COMPLETE" } } });
    }
    for (let index = 0; index < 149; index += 1) {
      cases.push({ id: `neg-${index}`, state: incompleteState(), expected: { closure: { choice: "INCOMPLETE" } } });
    }
    const fullCases = cases.map((c) => ({ ...c, questions: QUESTIONS }));
    const datasetText = `${fullCases.map((c) => JSON.stringify(c)).join("\n")}\n`;
    const datasetRevision = shaFile(datasetText);
    const policy = lockboxPolicy(QUESTIONS, {
      policyVersion: MISSION_CLOSURE_POLICY_VERSION,
      minConfidence: MIN_CONFIDENCE,
      backend: fixture.backend,
      model: fixture.model,
      modelVersion: fixture.modelVersion ?? fixture.model,
    });
    const rows = [];
    for (const c of fullCases) {
      rows.push(await scoreLockboxCase(votingModel(fixture) as never, c as never, policy, datasetRevision));
    }
    const rowsText = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    const developmentText =
      `${JSON.stringify({ id: "dev-1", state: {}, questions: QUESTIONS, expected: { closure: { choice: "COMPLETE" } } })}\n`;
    const validationText =
      `${JSON.stringify({ id: "val-1", state: {}, questions: QUESTIONS, expected: { closure: { choice: "COMPLETE" } } })}\n`;
    writeFileSync(join(dataDir, "lockbox.jsonl"), datasetText);
    writeFileSync(join(dataDir, "development.jsonl"), developmentText);
    writeFileSync(join(dataDir, "validation.jsonl"), validationText);
    writeFileSync(join(dataDir, "stage-rows.jsonl"), rowsText);
    const questionHash = hashQuestions(QUESTIONS);
    const manifest = {
      family: "mission-closure-3stage",
      backend: fixture.backend,
      model: fixture.model,
      modelVersion: fixture.modelVersion ?? fixture.model,
      adapterVersion: HOOK_VERSION,
      questionSetHash: questionSetHashFor([questionHash]),
      policyHash: canonicalPolicyHash({
        policyVersion: MISSION_CLOSURE_POLICY_VERSION,
        questionHash,
        minConfidence: MIN_CONFIDENCE,
      }),
      datasetHash: shaFile(datasetText),
      developmentDatasetHash: shaFile(developmentText),
      validationDatasetHash: shaFile(validationText),
      evaluationHash: shaFile(rowsText),
      datasetSplit: "lockbox",
      expectedJudgments: rows.length,
      correctJudgments: rows.filter((r) => r.integratedCorrect).length,
      invalidJudgments: 0,
      thresholds: { ...MISSION_CLOSURE_RELEASE_POLICY },
      metrics: { ...threeStageMetrics(rows) },
      calibrationVersion: "mission-lockbox/1",
      calibratedAt: new Date().toISOString(),
      decision: "qualified",
      datasetPath: "lockbox.jsonl",
      developmentDatasetPath: "development.jsonl",
      validationDatasetPath: "validation.jsonl",
      receiptsPath: "stage-rows.jsonl",
    };
    writeFileSync(join(dataDir, "manifest-3stage.json"), JSON.stringify(manifest));
    return "manifest-3stage.json";
  }

  async function writeThreeStageArtifacts(
    dataDir: string,
    fixture: Fixture,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const cases = [
      { id: "pos", state: completeState(), questions: QUESTIONS, expected: { closure: { choice: "COMPLETE" } } },
      { id: "neg", state: incompleteState(), questions: QUESTIONS, expected: { closure: { choice: "INCOMPLETE" } } },
    ];
    const datasetText = `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`;
    const datasetRevision = shaFile(datasetText);
    const policy = lockboxPolicy(QUESTIONS, {
      policyVersion: MISSION_CLOSURE_POLICY_VERSION,
      minConfidence: MIN_CONFIDENCE,
      backend: fixture.backend,
      model: fixture.model,
      modelVersion: fixture.modelVersion ?? fixture.model,
    });
    const rows = [
      await scoreLockboxCase(votingModel(fixture) as never, cases[0]!, policy, datasetRevision),
      await scoreLockboxCase(votingModel(fixture) as never, cases[1]!, policy, datasetRevision),
    ];
    const rowsText = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    const developmentText =
      `${JSON.stringify({ id: "dev-1", state: {}, questions: QUESTIONS, expected: { closure: { choice: "COMPLETE" } } })}\n`;
    const validationText =
      `${JSON.stringify({ id: "val-1", state: {}, questions: QUESTIONS, expected: { closure: { choice: "COMPLETE" } } })}\n`;
    writeFileSync(join(dataDir, "lockbox.jsonl"), datasetText);
    writeFileSync(join(dataDir, "development.jsonl"), developmentText);
    writeFileSync(join(dataDir, "validation.jsonl"), validationText);
    writeFileSync(join(dataDir, "stage-rows.jsonl"), rowsText);
    const questionHash = hashQuestions(QUESTIONS);
    const manifest: QualificationManifest & Record<string, unknown> = {
      family: "mission-closure-3stage",
      backend: fixture.backend,
      model: fixture.model,
      modelVersion: fixture.model,
      adapterVersion: HOOK_VERSION,
      questionSetHash: questionSetHashFor([questionHash]),
      policyHash: canonicalPolicyHash({
        policyVersion: MISSION_CLOSURE_POLICY_VERSION,
        questionHash,
        minConfidence: MIN_CONFIDENCE,
      }),
      datasetHash: shaFile(datasetText),
      developmentDatasetHash: shaFile(developmentText),
      validationDatasetHash: shaFile(validationText),
      evaluationHash: shaFile(rowsText),
      datasetSplit: "lockbox",
      expectedJudgments: 2,
      correctJudgments: rows.filter((r) => r.integratedCorrect).length,
      invalidJudgments: 0,
      thresholds: THRESHOLDS,
      metrics: { ...threeStageMetrics(rows) },
      calibrationVersion: "mission-lockbox/1",
      calibratedAt: new Date().toISOString(),
      decision: "qualified",
      datasetPath: "lockbox.jsonl",
      developmentDatasetPath: "development.jsonl",
      validationDatasetPath: "validation.jsonl",
      receiptsPath: "stage-rows.jsonl",
      ...overrides,
    };
    writeFileSync(join(dataDir, "manifest-3stage.json"), JSON.stringify(manifest));
    return "manifest-3stage.json";
  }

  it("keeps policy-scale narrative-only rows uncalibrated despite matching identity", async () => {
    const fixture = setup();
    const manifestName = await writePolicyScaleArtifacts(fixture.dataDir, fixture);
    writeClosureConfig(fixture.dataDir, fixture.model, manifestName, "mission-lockbox/1");
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("qualification manifest"))).toBe(true);
  });

  it("keeps OpenRouter narrative-only rows uncalibrated despite resolved serving identity", async () => {
    const fixture = setupOpenRouter();
    const manifestName = await writePolicyScaleArtifacts(fixture.dataDir, fixture);
    writeClosureConfig(
      fixture.dataDir,
      fixture.model,
      manifestName,
      "mission-lockbox/1",
      fixture.modelVersion,
    );
    const config = configFor(fixture);
    expect(config.backend).toBe("openrouter");
    expect(config.model).toBe("typesafe/jev-latest");
    expect(config.missionClosurePolicy).toMatchObject({
      calibrated: false,
      backend: "openrouter",
      model: "typesafe/jev-latest",
      modelVersion: "typesafe/jev-latest-20261103",
    });
    expect(config.warnings.some((w) => w.includes("qualification manifest"))).toBe(true);
  });

  it("keeps OpenRouter closure uncalibrated without its own verified manifest", () => {
    const fixture = setupOpenRouter();
    writeClosureConfig(fixture.dataDir, fixture.model, undefined, "mission-lockbox/1", fixture.modelVersion);
    const config = configFor(fixture);
    expect(config.missionClosurePolicy).toMatchObject({ backend: "openrouter", calibrated: false });
    expect(config.warnings.some((w) => w.includes("no qualification manifest"))).toBe(true);
  });

  it("refuses to activate production from a 2-case qualified fixture below the policy floor", async () => {
    const fixture = setup();
    const manifestName = await writeThreeStageArtifacts(fixture.dataDir, fixture);
    writeClosureConfig(fixture.dataDir, fixture.model, manifestName, "mission-lockbox/1");
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("release policy floor"))).toBe(true);
  });

  it("degrades to uncalibrated when the 3stage manifest records a rejected decision", async () => {
    const fixture = setup();
    const manifestName = await writeThreeStageArtifacts(fixture.dataDir, fixture, { decision: "rejected" });
    writeClosureConfig(fixture.dataDir, fixture.model, manifestName, "mission-lockbox/1");
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("does not authorize closure"))).toBe(true);
  });

  it("degrades to uncalibrated when the 3stage stage rows were tampered", async () => {
    const fixture = setup();
    await writeThreeStageArtifacts(fixture.dataDir, fixture);
    appendFileSync(join(fixture.dataDir, "stage-rows.jsonl"), " ");
    writeClosureConfig(fixture.dataDir, fixture.model, "manifest-3stage.json", "mission-lockbox/1");
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("qualification manifest"))).toBe(true);
  });

  it("degrades to uncalibrated when the 3stage manifest is missing", async () => {
    const fixture = setup();
    writeClosureConfig(fixture.dataDir, fixture.model, "absent-3stage.json");
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("cannot be read"))).toBe(true);
  });

  it("degrades to uncalibrated when the 3stage manifest is stale for another model", async () => {
    const fixture = setup();
    const manifestName = await writeThreeStageArtifacts(fixture.dataDir, fixture, {
      model: "stale-model",
      modelVersion: "stale-model",
    });
    writeClosureConfig(fixture.dataDir, fixture.model, manifestName, "mission-lockbox/1");
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("qualification manifest"))).toBe(true);
  });

  it("degrades to uncalibrated when the runtime calibration version does not match the manifest", async () => {
    const fixture = setup();
    const manifestName = await writeThreeStageArtifacts(fixture.dataDir, fixture);
    writeClosureConfig(fixture.dataDir, fixture.model, manifestName);
    const config = loadHookConfig(baseConfig(fixture.dataDir));
    expect(config.missionClosurePolicy.calibrated).toBe(false);
    expect(config.warnings.some((w) => w.includes("calibration version"))).toBe(true);
  });
});
