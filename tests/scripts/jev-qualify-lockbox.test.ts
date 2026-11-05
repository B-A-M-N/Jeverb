import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hashQuestions } from "../../src/decision/provenance.js";
import type { DecisionModel } from "../../src/decision/types.js";
import type { CalibrationCase } from "../../src/jev/calibration.js";
import { lockboxPolicy, scoreLockboxCase } from "../../src/jev/lockbox.js";
import { MISSION_CLOSURE_QUESTION } from "../../src/mission/closure.js";

const run = promisify(execFile);
const REPO = "/home/bamn/Jeverb";

const QUESTIONS = { closure: MISSION_CLOSURE_QUESTION } as CalibrationCase["questions"];

function state(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function votingModel(pick: string, confidence = 0.97): DecisionModel {
  const distribution: Record<string, number> = {
    COMPLETE: 0.01,
    INCOMPLETE: 0.01,
    BLOCKED: 0.01,
    INSUFFICIENT_EVIDENCE: 0.01,
  };
  distribution[pick] = confidence;
  const rest = (1 - confidence) / 3;
  for (const k of Object.keys(distribution)) if (k !== pick) distribution[k] = rest;
  return {
    name: "m",
    evaluate: async (input) => ({
      model: "m",
      provider: "jev-gateway",
      questionHash: hashQuestions(input.questions as CalibrationCase["questions"]),
      answers: { closure: { type: "choice", choice: pick, confidence, probabilities: distribution } },
      usage: { input_tokens: 1, output_tokens: 1 },
      latency_ms: 1,
    }) as never,
    choice: async () => { throw new Error("unused"); },
    score: async () => { throw new Error("unused"); },
    probability: async () => { throw new Error("unused"); },
  };
}

async function writeRun(dir: string, votes: Array<{ id: string; state: unknown; expected: string; pick: string }>): Promise<{ dataset: string; rows: string }> {
  const cases: CalibrationCase[] = votes.map((v) => ({
    id: v.id,
    state: v.state,
    questions: QUESTIONS,
    expected: { closure: { choice: v.expected } },
  }));
  const datasetText = cases.map((c) => JSON.stringify({ id: c.id, state: c.state, questions: c.questions, expected: c.expected })).join("\n") + "\n";
  const datasetRevision = (await import("node:crypto")).createHash("sha256").update(datasetText, "utf8").digest("hex");
  const policy = lockboxPolicy(QUESTIONS, {
    policyVersion: "mission-closure/1",
    minConfidence: 0.9,
    backend: "jev-gateway",
    model: "m",
    modelVersion: "m",
  });
  const rows = [];
  for (const [i, v] of votes.entries()) {
    rows.push(await scoreLockboxCase(votingModel(v.pick), cases[i]!, policy, datasetRevision));
  }
  const dataset = join(dir, "ds.jsonl");
  const rowsPath = join(dir, "rows.jsonl");
  writeFileSync(dataset, datasetText);
  writeFileSync(rowsPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const other = (id: string) => [{ id, state: {}, questions: QUESTIONS, expected: { closure: { choice: "COMPLETE" } } }];
  writeFileSync(join(dir, "dev.jsonl"), other("dev-1").map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(dir, "val.jsonl"), other("val-1").map((c) => JSON.stringify(c)).join("\n") + "\n");
  return { dataset, rows: rowsPath };
}

async function qualifyLockbox(dir: string, dataset: string, rows: string, extra: string[]): Promise<{ code: number; stderr: string; manifest: string }> {
  const out = join(dir, "m.json");
  const base = [
    "tsx", join(REPO, "scripts/jev-qualify-lockbox.ts"),
    "--dataset", dataset, "--stage-rows", rows,
    "--development-dataset", join(dir, "dev.jsonl"),
    "--validation-dataset", join(dir, "val.jsonl"),
    "--backend", "jev-gateway", "--model", "m", "--model-version", "m",
    "--adapter-version", "0.6.3", "--policy-version", "mission-closure/1",
    "--min-confidence", "0.9",
    "--out", out,
  ];
  try {
    await run("npx", [...base, ...extra], { cwd: REPO, timeout: 55000 });
    return { code: 0, stderr: "", manifest: out };
  } catch (error) {
    const err = error as { code?: number; stderr?: string };
    return { code: err.code ?? 99, stderr: String(err.stderr ?? error), manifest: out };
  }
}

const missing = () => state({
  acceptanceCriteria: [{ id: "retry", statement: "Retry with backoff is implemented" }],
});

describe("jev-qualify-lockbox binding", () => {
  it("refuses qualified below the release policy floor without binding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-qual-lockbox-"));
    const { dataset, rows } = await writeRun(dir, [
      { id: "pos", state: state(), expected: "COMPLETE", pick: "COMPLETE" },
      { id: "neg", state: missing(), expected: "INCOMPLETE", pick: "COMPLETE" },
    ]);
    const result = await qualifyLockbox(dir, dataset, rows, [
      "--require-liveness", "0.5", "--min-positives", "1", "--min-negatives", "1",
      "--split", "lockbox", "--decision", "qualified",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("release policy floor");
  });

  it("refuses qualification when policy-scale rows still lack trusted preflight evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-qual-lockbox-"));
    const votes: Array<{ id: string; state: unknown; expected: string; pick: string }> = [];
    for (let index = 0; index < 60; index += 1) {
      votes.push({ id: `pos-${index}`, state: state(), expected: "COMPLETE", pick: "COMPLETE" });
    }
    for (let index = 0; index < 149; index += 1) {
      votes.push({ id: `neg-${index}`, state: missing(), expected: "INCOMPLETE", pick: "COMPLETE" });
    }
    const { dataset, rows } = await writeRun(dir, votes);
    const result = await qualifyLockbox(dir, dataset, rows, [
      "--require-liveness", "0.95", "--min-positives", "60", "--min-negatives", "149",
      "--split", "lockbox", "--decision", "qualified",
    ]);
    expect(result.stderr).toContain("gate fails, refusing qualified");
    expect(result.stderr).toContain("preflight stops 209");
    expect(result.code).not.toBe(0);
    expect(() => readFileSync(result.manifest, "utf8")).toThrow();
  });

  it("refuses qualified when the gate fails but binds rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-qual-lockbox-"));
    const { dataset, rows } = await writeRun(dir, [
      { id: "pos", state: state(), expected: "COMPLETE", pick: "INCOMPLETE" },
      { id: "neg", state: missing(), expected: "INCOMPLETE", pick: "COMPLETE" },
    ]);
    const refused = await qualifyLockbox(dir, dataset, rows, [
      "--require-liveness", "0.95", "--min-positives", "60", "--min-negatives", "149",
      "--split", "lockbox", "--decision", "qualified",
    ]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("gate fails");
    const accepted = await qualifyLockbox(dir, dataset, rows, [
      "--require-liveness", "0.95", "--min-positives", "60", "--min-negatives", "149",
      "--split", "lockbox", "--decision", "rejected",
    ]);
    expect(accepted.code).toBe(0);
  });

  it("refuses unverifiable records without binding anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-qual-lockbox-"));
    const { dataset, rows } = await writeRun(dir, [
      { id: "pos", state: state(), expected: "COMPLETE", pick: "COMPLETE" },
    ]);
    const tampered = JSON.parse(`[${readFileSync(rows, "utf8").trim().split("\n").map((l) => l).join(",")}]`) as Array<Record<string, unknown>>;
    tampered[0]!.integratedCorrect = !(tampered[0]!.integratedCorrect as boolean);
    writeFileSync(rows, tampered.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const result = await qualifyLockbox(dir, dataset, rows, [
      "--require-liveness", "0.5", "--min-positives", "1", "--min-negatives", "1",
      "--split", "lockbox", "--decision", "rejected",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("do not verify");
  });
});
