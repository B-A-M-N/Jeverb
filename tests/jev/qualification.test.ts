import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifyQualificationManifest,
  type QualificationActiveIdentity,
  type QualificationManifest,
} from "../../src/jev/qualification.js";
import { HOOK_VERSION } from "../../src/hooks/version.js";

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const QUESTION_HASH = "a".repeat(64);
const QUESTION_SET_HASH = sha(JSON.stringify([QUESTION_HASH]));
const fixtureDirectories: string[] = [];

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function datasetText(): string {
  return [
    JSON.stringify({
      id: "case-one",
      state: { objective: "do one" },
      questions: {
        closure: {
          type: "choice",
          instructions: "Choose COMPLETE when done, INCOMPLETE otherwise.",
          criteria: { COMPLETE: "done", INCOMPLETE: "not done" },
        },
      },
      expected: { closure: { choice: "COMPLETE" } },
    }),
    JSON.stringify({
      id: "case-two",
      state: { objective: "do two" },
      questions: {
        closure: {
          type: "choice",
          instructions: "Choose COMPLETE when done, INCOMPLETE otherwise.",
          criteria: { COMPLETE: "done", INCOMPLETE: "not done" },
        },
      },
      expected: { closure: { choice: "INCOMPLETE" } },
    }),
  ].join("\n") + "\n";
}

function receiptsText(datasetHash: string, overrides: Record<string, unknown> = {}): string {
    const row = (c: string, choice: string, inRange: boolean): string => JSON.stringify({
    case: c,
    question: "closure",
    model: "test-model",
    modelVersion: "test-model-v1",
    adapterVersion: "adapter/1",
    provider: "test-backend",
    questionHash: QUESTION_HASH,
    dataset: datasetHash,
    answer: { type: "choice", choice },
    expected: { choice: c === "case-one" ? "COMPLETE" : "INCOMPLETE" },
    inRange,
    latency_ms: 5,
    ...overrides,
  });
  return `${row("case-one", "COMPLETE", true)}\n${row("case-two", "INCOMPLETE", true)}\n`;
}

function setup(rows?: string): {
  dir: string; datasetPath: string; developmentDatasetPath: string; validationDatasetPath: string; receiptsPath: string;
  datasetHash: string; developmentDatasetHash: string; validationDatasetHash: string; evaluationHash: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "jev-qualify-"));
  fixtureDirectories.push(dir);
  const datasetPath = join(dir, "bench.jsonl");
  const developmentDatasetPath = join(dir, "development.jsonl");
  const validationDatasetPath = join(dir, "validation.jsonl");
  const receiptsPath = join(dir, "receipts.jsonl");
  const dataset = datasetText();
  const developmentDataset = dataset.replaceAll("case-one", "development-one").replaceAll("case-two", "development-two");
  const validationDataset = dataset.replaceAll("case-one", "validation-one").replaceAll("case-two", "validation-two");
  writeFileSync(datasetPath, dataset);
  writeFileSync(developmentDatasetPath, developmentDataset);
  writeFileSync(validationDatasetPath, validationDataset);
  const receipts = rows ?? receiptsText(sha(dataset));
  writeFileSync(receiptsPath, receipts);
  return {
    dir, datasetPath, developmentDatasetPath, validationDatasetPath, receiptsPath,
    datasetHash: sha(dataset), developmentDatasetHash: sha(developmentDataset),
    validationDatasetHash: sha(validationDataset), evaluationHash: sha(receipts),
  };
}

function setupCustom(dataset: unknown[], receiptRows: Record<string, unknown>[]): {
  datasetPath: string; developmentDatasetPath: string; validationDatasetPath: string; receiptsPath: string;
  datasetHash: string; developmentDatasetHash: string; validationDatasetHash: string; evaluationHash: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "jev-qualify-custom-"));
  fixtureDirectories.push(dir);
  const datasetPath = join(dir, "bench.jsonl");
  const developmentDatasetPath = join(dir, "development.jsonl");
  const validationDatasetPath = join(dir, "validation.jsonl");
  const receiptsPath = join(dir, "receipts.jsonl");
  const datasetContents = `${dataset.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const first = dataset[0] as Record<string, unknown>;
  const developmentContents = `${JSON.stringify({ ...first, id: "development-only" })}\n`;
  const validationContents = `${JSON.stringify({ ...first, id: "validation-only" })}\n`;
  const datasetHash = sha(datasetContents);
  const receipts = `${receiptRows.map((row) => JSON.stringify({ dataset: datasetHash, ...row })).join("\n")}\n`;
  writeFileSync(datasetPath, datasetContents);
  writeFileSync(developmentDatasetPath, developmentContents);
  writeFileSync(validationDatasetPath, validationContents);
  writeFileSync(receiptsPath, receipts);
  return {
    datasetPath, developmentDatasetPath, validationDatasetPath, receiptsPath,
    datasetHash, developmentDatasetHash: sha(developmentContents),
    validationDatasetHash: sha(validationContents), evaluationHash: sha(receipts),
  };
}

function manifestFor(fixture: {
  datasetHash: string; developmentDatasetHash: string; validationDatasetHash: string; evaluationHash: string;
}, overrides: Partial<QualificationManifest> = {}): QualificationManifest {
  return {
    family: "mission-closure",
    backend: "test-backend",
    model: "test-model",
    modelVersion: "test-model-v1",
    adapterVersion: "adapter/1",
    questionSetHash: QUESTION_SET_HASH,
    policyHash: "b".repeat(64),
    datasetHash: fixture.datasetHash,
    developmentDatasetHash: fixture.developmentDatasetHash,
    validationDatasetHash: fixture.validationDatasetHash,
    evaluationHash: fixture.evaluationHash,
    datasetSplit: "lockbox",
    expectedJudgments: 2,
    correctJudgments: 2,
    invalidJudgments: 0,
    thresholds: { minConfidence: 0.9 },
    calibratedAt: new Date().toISOString(),
    decision: "qualified",
    developmentDatasetPath: "development.jsonl",
    validationDatasetPath: "validation.jsonl",
    ...overrides,
  };
}

function active(thresholds: Record<string, number> = { minConfidence: 0.9 }): QualificationActiveIdentity {
  return {
    backend: "test-backend",
    model: "test-model",
    modelVersion: "test-model-v1",
    adapterVersion: "adapter/1",
    questionSetHash: QUESTION_SET_HASH,
    policyHash: "b".repeat(64),
    thresholds,
  };
}

describe("qualification manifest verification", () => {
  it("parses a legacy safety-only completion manifest as history but never authorizes it", () => {
    const fixture = setup();
    const result = verifyQualificationManifest(
      manifestFor(fixture),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
    expect(result.reasons.join(" ")).toContain("legacy safety-only mission-closure family cannot authorize production");
  });

  it("records evidence without authorizing when the decision is not qualified", () => {
    const fixture = setup();
    const result = verifyQualificationManifest(
      manifestFor(fixture, { decision: "inconclusive" }),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
  });

  it("fails when the manifest counts do not match the receipts", () => {
    const fixture = setup();
    const result = verifyQualificationManifest(
      manifestFor(fixture, { correctJudgments: 1 }),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("correct");
  });

  it("does not authorize a correctly hashed manifest with a false COMPLETE on an INCOMPLETE case", () => {
    const altered = receiptsText(sha(datasetText())).split("\n").filter(Boolean).map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row["case"] === "case-two") {
        row["answer"] = { type: "choice", choice: "COMPLETE" };
        row["inRange"] = false;
      }
      return JSON.stringify(row);
    }).join("\n") + "\n";
    const fixture = setup(altered);
    const result = verifyQualificationManifest(
      manifestFor(fixture, { correctJudgments: 1 }),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
    expect(result.reasons.join(" ")).toContain("false terminal completions 1/1");
  });

  it("rejects receipts whose inRange flag contradicts the independently labeled answer", () => {
    const fixture = setup(receiptsText(sha(datasetText())).replace('"inRange":true', '"inRange":false'));
    const result = verifyQualificationManifest(
      manifestFor(fixture),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("inRange value inconsistent");
  });

  it("does not qualify a case with both complete judgments and a case-level failure", () => {
    const datasetHash = sha(datasetText());
    const receipts = `${receiptsText(datasetHash)}${JSON.stringify({
      case: "case-one",
      question: "",
      caseError: true,
      dataset: datasetHash,
      error: "JevValidationError",
    })}\n`;
    const fixture = setup(receipts);
    const result = verifyQualificationManifest(
      manifestFor(fixture),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.authorizes).toBe(false);
    expect(result.reasons.join(" ")).toContain("case-one has answerable judgments and a case-level error");
  });

  it("qualification CLI refuses contradictory case-level failure evidence", () => {
    const datasetHash = sha(datasetText());
    const receipts = `${receiptsText(datasetHash, { adapterVersion: HOOK_VERSION })}${JSON.stringify({
      case: "case-one",
      question: "",
      caseError: true,
      dataset: datasetHash,
      error: "JevValidationError",
    })}\n`;
    const fixture = setup(receipts);
    const summaryPath = join(fixture.dir, "summary.json");
    const manifestPath = join(fixture.dir, "manifest.json");
    writeFileSync(summaryPath, JSON.stringify({ expectedAnswers: 2, inRange: 2, invalidJudgments: 0 }));
    const script = fileURLToPath(new URL("../../scripts/jev-qualify.ts", import.meta.url));
    const result = spawnSync(process.execPath, [
      "--import", "tsx", script,
      "--summary", summaryPath,
      "--dataset", fixture.datasetPath,
      "--development-dataset", fixture.developmentDatasetPath,
      "--validation-dataset", fixture.validationDatasetPath,
      "--receipts", fixture.receiptsPath,
      "--family", "mission-closure",
      "--model-version", "test-model-v1",
      "--adapter-version", HOOK_VERSION,
      "--policy-hash", "b".repeat(64),
      "--thresholds", "{}",
      "--split", "lockbox",
      "--decision", "qualified",
      "--out", manifestPath,
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("case-one has answerable judgments and a case-level error");
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("qualification CLI refuses to mark a validation split qualified", () => {
    const fixture = setup();
    const summaryPath = join(fixture.dir, "summary.json");
    const manifestPath = join(fixture.dir, "manifest.json");
    writeFileSync(summaryPath, JSON.stringify({ expectedAnswers: 2, inRange: 2, invalidJudgments: 0 }));
    const script = fileURLToPath(new URL("../../scripts/jev-qualify.ts", import.meta.url));
    const result = spawnSync(process.execPath, [
      "--import", "tsx", script,
      "--summary", summaryPath,
      "--dataset", fixture.datasetPath,
      "--development-dataset", fixture.developmentDatasetPath,
      "--receipts", fixture.receiptsPath,
      "--family", "mission-closure",
      "--model-version", "test-model-v1",
      "--adapter-version", HOOK_VERSION,
      "--policy-hash", "b".repeat(64),
      "--thresholds", "{}",
      "--split", "validation",
      "--decision", "qualified",
      "--out", manifestPath,
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("only lockbox evidence can be marked qualified");
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("qualification CLI refuses receipt metadata for a different adapter before writing a manifest", () => {
    const fixture = setup(receiptsText(sha(datasetText()), { adapterVersion: "forged-adapter" }));
    const summaryPath = join(fixture.dir, "summary.json");
    const manifestPath = join(fixture.dir, "manifest.json");
    writeFileSync(summaryPath, JSON.stringify({ expectedAnswers: 2, inRange: 2, invalidJudgments: 0 }));
    const script = fileURLToPath(new URL("../../scripts/jev-qualify.ts", import.meta.url));
    const result = spawnSync(process.execPath, [
      "--import", "tsx", script,
      "--summary", summaryPath,
      "--dataset", fixture.datasetPath,
      "--development-dataset", fixture.developmentDatasetPath,
      "--validation-dataset", fixture.validationDatasetPath,
      "--receipts", fixture.receiptsPath,
      "--family", "mission-closure",
      "--model-version", "test-model-v1",
      "--adapter-version", "forged-adapter",
      "--policy-hash", "b".repeat(64),
      "--thresholds", "{}",
      "--split", "lockbox",
      "--decision", "qualified",
      "--out", manifestPath,
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain(`must match running hook version ${HOOK_VERSION}`);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("calibration CLI rejects an adapter mismatch before provider initialization", () => {
    const fixture = setup();
    const outputPath = join(fixture.dir, "calibration.receipts.jsonl");
    const script = fileURLToPath(new URL("../../scripts/jev-calibrate.ts", import.meta.url));
    const result = spawnSync(process.execPath, [
      "--import", "tsx", script,
      fixture.datasetPath,
      "--model-version", "test-model-v1",
      "--adapter-version", "forged-adapter",
      "--out", outputPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, OPENROUTER_API_KEY: "", TYPESAFE_API_KEY: "" },
    });
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain(`must match running hook version ${HOOK_VERSION}`);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("does not authorize a development split", () => {
    const fixture = setup();
    const result = verifyQualificationManifest(
      manifestFor(fixture, { datasetSplit: "development" }),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
    expect(result.reasons.join(" ")).toContain("development split cannot qualify");
  });

  it("does not let validation evidence authorize a release", () => {
    const fixture = setup();
    const result = verifyQualificationManifest(
      manifestFor(fixture, { datasetSplit: "validation" }),
      {
        datasetPath: fixture.datasetPath,
        developmentDatasetPath: fixture.developmentDatasetPath,
        validationDatasetPath: fixture.validationDatasetPath,
        receiptsPath: fixture.receiptsPath,
      },
      active(),
    );
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
    expect(result.reasons.join(" ")).toContain("validation split cannot authorize a release");
  });

  it("rejects a held-out dataset that reuses development case identities", () => {
    const fixture = setup();
    writeFileSync(fixture.developmentDatasetPath, datasetText());
    const result = verifyQualificationManifest(
      manifestFor(fixture, { developmentDatasetHash: sha(datasetText()) }),
      {
        datasetPath: fixture.datasetPath,
        developmentDatasetPath: fixture.developmentDatasetPath,
        validationDatasetPath: fixture.validationDatasetPath,
        receiptsPath: fixture.receiptsPath,
      },
      active(),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("overlaps development and lockbox splits");
  });

  it("fails closed for a decision family without an independent release policy", () => {
    const fixture = setup();
    const result = verifyQualificationManifest(
      manifestFor(fixture, { family: "adversarial-review" }),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
    expect(result.reasons.join(" ")).toContain("no independent release policy");
  });

  it("counts BLOCKED and INSUFFICIENT_EVIDENCE as terminal-completion negatives", () => {
    const choices = ["INCOMPLETE", "BLOCKED", "INSUFFICIENT_EVIDENCE"];
    const cases = choices.map((choice, index) => ({
      id: `terminal-negative-${index}`,
      state: {},
      questions: {
        closure: {
          type: "choice",
          instructions: "Select the authoritative mission outcome.",
          criteria: {
            COMPLETE: "all requirements have been independently verified",
            INCOMPLETE: "required work remains",
            BLOCKED: "an external dependency prevents progress",
            INSUFFICIENT_EVIDENCE: "available evidence cannot establish completion",
          },
        },
      },
      expected: { closure: { choice } },
    }));
    const receiptRows = cases.map((item, index) => {
      const answer = index === 0 ? "INCOMPLETE" : "COMPLETE";
      return {
        case: item.id,
        question: "closure",
        model: "test-model",
        modelVersion: "test-model-v1",
        adapterVersion: "adapter/1",
        provider: "test-backend",
        questionHash: QUESTION_HASH,
        answer: { type: "choice", choice: answer },
        inRange: answer === choices[index],
      };
    });
    const fixture = setupCustom(cases, receiptRows);
    const result = verifyQualificationManifest(
      manifestFor(fixture, {
        family: "mission-closure",
        expectedJudgments: 3,
        correctJudgments: 1,
        invalidJudgments: 0,
      }),
      {
        datasetPath: fixture.datasetPath,
        developmentDatasetPath: fixture.developmentDatasetPath,
        validationDatasetPath: fixture.validationDatasetPath,
        receiptsPath: fixture.receiptsPath,
      },
      active(),
    );

    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
    expect(result.reasons.join(" ")).toContain("false terminal completions 2/3 non-COMPLETE cases");
  });

  it("rejects corrective-action accuracy below the fixed 95% release threshold", () => {
    const cases = ["continue", "repair"].map((choice, i) => ({
      id: `action-${i}`,
      state: {},
      questions: { next: { type: "choice", instructions: "Pick the next action.", criteria: { continue: "continue", repair: "repair" } } },
      expected: { next: { choice } },
    }));
    const receiptRows = cases.map((c, i) => ({
      case: c.id, question: "next", model: "test-model", modelVersion: "test-model-v1", adapterVersion: "adapter/1",
      provider: "test-backend", questionHash: QUESTION_HASH,
      answer: { type: "choice", choice: i === 0 ? "continue" : "continue" },
      inRange: i === 0,
    }));
    const fixture = setupCustom(cases, receiptRows);
    const manifest = manifestFor(fixture, {
      family: "corrective-action", expectedJudgments: 2, correctJudgments: 1, invalidJudgments: 0,
    });
    const result = verifyQualificationManifest(
      manifest, { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath }, active(),
    );
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
    expect(result.reasons.join(" ")).toContain("50.00%); required >=95%");
  });

  it("requires at least 149 negative examples before stop false-block rate can qualify", () => {
    const cases = Array.from({ length: 148 }, (_, i) => ({
      id: `stop-negative-${i}`,
      state: {},
      questions: Object.fromEntries(["says_part_not_done", "says_step_deferred", "says_check_failing", "asks_user"].map((id) => [
        id, { type: "noul", instructions: "Score this signal.", criteria: ["low", "high"] },
      ])),
      expected: Object.fromEntries(["says_part_not_done", "says_step_deferred", "says_check_failing", "asks_user"].map((id) => [
        id, { noul: [0, 0.2], label: false },
      ])),
    }));
    const receiptRows = cases.flatMap((c) => Object.keys(c.questions).map((question) => ({
      case: c.id, question, model: "test-model", modelVersion: "test-model-v1", adapterVersion: "adapter/1",
      provider: "test-backend", questionHash: QUESTION_HASH,
      answer: { type: "noul", noul: 0.1 }, inRange: true,
    })));
    const fixture = setupCustom(cases, receiptRows);
    const manifest = manifestFor(fixture, {
      family: "stop-intervention", expectedJudgments: receiptRows.length,
      correctJudgments: receiptRows.length, invalidJudgments: 0,
      thresholds: { autoThreshold: 0.85 },
    });
    const result = verifyQualificationManifest(
      manifest, { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath }, active({ autoThreshold: 0.85 }),
    );
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
    expect(result.reasons.join(" ")).toContain("required zero false blocks, upper bound <=2%, and >=149 negatives");
  });

  it("authorizes stop intervention with zero false blocks across 149 negatives", () => {
    const ids = ["says_part_not_done", "says_step_deferred", "says_check_failing", "asks_user"];
    const cases = Array.from({ length: 149 }, (_, i) => ({
      id: `stop-negative-${i}`,
      state: {},
      questions: Object.fromEntries(ids.map((id) => [id, { type: "noul", instructions: "Score this signal.", criteria: ["low", "high"] }])),
      expected: Object.fromEntries(ids.map((id) => [id, { noul: [0, 0.2], label: false }])),
    }));
    const receiptRows = cases.flatMap((c) => ids.map((question) => {
      const p = 0.1;
      return {
        case: c.id, question, model: "test-model", modelVersion: "test-model-v1", adapterVersion: "adapter/1",
        provider: "test-backend", questionHash: QUESTION_HASH,
        answer: { type: "noul", noul: p }, inRange: p <= 0.2,
      };
    }));
    const fixture = setupCustom(cases, receiptRows);
    const manifest = manifestFor(fixture, {
      family: "stop-intervention", expectedJudgments: receiptRows.length,
      correctJudgments: receiptRows.length, invalidJudgments: 0,
      thresholds: { autoThreshold: 0.85 },
    });
    const result = verifyQualificationManifest(
      manifest,
      {
        datasetPath: fixture.datasetPath,
        developmentDatasetPath: fixture.developmentDatasetPath,
        validationDatasetPath: fixture.validationDatasetPath,
        receiptsPath: fixture.receiptsPath,
      },
      active({ autoThreshold: 0.85 }),
    );
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(true);
    expect(result.reasons.join(" ")).toContain("false blocks 0/149 negative cases (0.00%)");
    expect(result.reasons.join(" ")).toContain("one-sided 95% upper bound 1.99%");
  });

  it("rejects even one false block in 149 negatives", () => {
    const ids = ["says_part_not_done", "says_step_deferred", "says_check_failing", "asks_user"];
    const cases = Array.from({ length: 149 }, (_, i) => ({
      id: `stop-negative-${i}`,
      state: {},
      questions: Object.fromEntries(ids.map((id) => [id, { type: "noul", instructions: "Score this signal.", criteria: ["low", "high"] }])),
      expected: Object.fromEntries(ids.map((id) => [id, { noul: [0, 0.2], label: false }])),
    }));
    const receiptRows = cases.flatMap((c) => ids.map((question) => {
      const p = c.id === "stop-negative-0" && question === "says_part_not_done" ? 0.9 : 0.1;
      return {
        case: c.id, question, model: "test-model", modelVersion: "test-model-v1", adapterVersion: "adapter/1",
        provider: "test-backend", questionHash: QUESTION_HASH,
        answer: { type: "noul", noul: p }, inRange: p <= 0.2,
      };
    }));
    const fixture = setupCustom(cases, receiptRows);
    const manifest = manifestFor(fixture, {
      family: "stop-intervention", expectedJudgments: receiptRows.length,
      correctJudgments: receiptRows.length - 1, invalidJudgments: 0,
      thresholds: { autoThreshold: 0.85 },
    });
    const result = verifyQualificationManifest(
      manifest,
      {
        datasetPath: fixture.datasetPath,
        developmentDatasetPath: fixture.developmentDatasetPath,
        validationDatasetPath: fixture.validationDatasetPath,
        receiptsPath: fixture.receiptsPath,
      },
      active({ autoThreshold: 0.85 }),
    );
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
    expect(result.reasons.join(" ")).toContain("false blocks 1/149 negative cases (0.67%)");
  });

  it("fails when the receipts file was modified after the manifest", () => {
    const fixture = setup();
    const tampered = `${receiptsText(fixture.datasetHash)}\n`;
    const tamperedPath = join(fixture.dir, "tampered.jsonl");
    writeFileSync(tamperedPath, tampered);
    const result = verifyQualificationManifest(
      manifestFor(fixture),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: tamperedPath },
      active(),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("evaluationHash");
  });

  it("fails when the dataset file was modified after the manifest", () => {
    const fixture = setup();
    const tamperedPath = join(fixture.dir, "tampered-dataset.jsonl");
    writeFileSync(tamperedPath, `${datasetText()}${datasetText()}`);
    const result = verifyQualificationManifest(
      manifestFor(fixture),
      { datasetPath: tamperedPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("datasetHash");
  });

  it("fails when the active model version differs", () => {
    const fixture = setup();
    const result = verifyQualificationManifest(
      manifestFor(fixture),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      { ...active(), modelVersion: "test-model-v2" },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("model version");
  });

  it("fails when the active question set differs", () => {
    const fixture = setup();
    const result = verifyQualificationManifest(
      manifestFor(fixture),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      { ...active(), questionSetHash: "c".repeat(64) },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("question set");
  });

  it("fails when the active policy differs", () => {
    const fixture = setup();
    const result = verifyQualificationManifest(
      manifestFor(fixture),
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      { ...active(), policyHash: "d".repeat(64) },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("policy");
  });

  it("fails when receipts span more than one model", () => {
    const dataset = datasetText();
    const datasetHash = sha(dataset);
    const mixed = receiptsText(datasetHash).replace("test-model", "other-model");
    const fixture = setup(mixed);
    const manifest = manifestFor({ datasetHash: fixture.datasetHash, developmentDatasetHash: fixture.developmentDatasetHash, validationDatasetHash: fixture.validationDatasetHash, evaluationHash: fixture.evaluationHash });
    const result = verifyQualificationManifest(
      manifest,
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("more than one model");
  });

  it("fails when a row is missing its runtime question-set hash", () => {
    const dataset = datasetText();
    const datasetHash = sha(dataset);
    const rows = receiptsText(datasetHash).split("\n").filter((line) => line !== "").map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      delete row["questionHash"];
      return JSON.stringify(row);
    });
    const fixture = setup(`${rows.join("\n")}\n`);
    const manifest = manifestFor({ datasetHash: fixture.datasetHash, developmentDatasetHash: fixture.developmentDatasetHash, validationDatasetHash: fixture.validationDatasetHash, evaluationHash: fixture.evaluationHash });
    const result = verifyQualificationManifest(
      manifest,
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("question-set hash");
  });

  it("counts failed calls as invalid, never as correct", () => {
    const dataset = datasetText();
    const datasetHash = sha(dataset);
    const failed = JSON.stringify({
      case: "case-two",
      question: "closure",
      dataset: datasetHash,
      expected: { choice: "INCOMPLETE" },
      inRange: false,
      error: "JevValidationError",
      code: "EMPTY_CONTENT",
    });
    const good = receiptsText(datasetHash).split("\n").filter((line) => line.includes("case-one"));
    const fixture = setup(`${good.join("\n")}\n${failed}\n`);
    const manifest = manifestFor(
      { datasetHash: fixture.datasetHash, developmentDatasetHash: fixture.developmentDatasetHash, validationDatasetHash: fixture.validationDatasetHash, evaluationHash: fixture.evaluationHash },
      { expectedJudgments: 2, correctJudgments: 1, invalidJudgments: 1 },
    );
    const result = verifyQualificationManifest(
      manifest,
      { datasetPath: fixture.datasetPath, developmentDatasetPath: fixture.developmentDatasetPath, validationDatasetPath: fixture.validationDatasetPath, receiptsPath: fixture.receiptsPath },
      active(),
    );
    expect(result.ok).toBe(false);
    // The failure row carries no model attribution or runtime question
    // hash, so binding fails closed rather than silently accepting an
    // unbound judgment as either correct or invalid.
    expect(result.reasons.join(" ")).toMatch(/model, version, adapter, or provider attribution|question-set hash/);
  });
});
