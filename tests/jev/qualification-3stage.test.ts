import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashQuestions } from "../../src/decision/provenance.js";
import type { DecisionModel } from "../../src/decision/types.js";
import type { CalibrationCase } from "../../src/jev/calibration.js";
import { lockboxPolicy, scoreLockboxCase, type LockboxCaseScore } from "../../src/jev/lockbox.js";
import {
  canonicalPolicyHash,
  MISSION_CLOSURE_RELEASE_POLICY,
  missionClosure3StageGate,
  questionSetHashFor,
  threeStageMetrics,
  verifyThreeStageManifest,
  type QualificationActiveIdentity,
  type QualificationManifest,
} from "../../src/jev/qualification.js";
import { MISSION_CLOSURE_QUESTION } from "../../src/mission/closure.js";

const DATASET = "test-dataset-revision";
const QUESTIONS = { closure: MISSION_CLOSURE_QUESTION } as CalibrationCase["questions"];
const POLICY_OPTS = {
  policyVersion: "mission-closure/1",
  minConfidence: 0.9,
  backend: "jev-gateway",
  model: "m",
  modelVersion: "m",
};

function policy() {
  return lockboxPolicy(QUESTIONS, POLICY_OPTS);
}

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

/** Stub whose binding always matches the policy: provider, version, live question hash. */
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

function lockboxCase(id: string, caseState: unknown, expected: string): CalibrationCase {
  return { id, state: caseState, questions: QUESTIONS, expected: { closure: { choice: expected } } };
}

const missing = () => state({
  acceptanceCriteria: [{ id: "retry", statement: "Retry with backoff is implemented" }],
});

async function twoCaseRun(): Promise<{ cases: CalibrationCase[]; rows: LockboxCaseScore[]; datasetText: string }> {
  const cases = [
    lockboxCase("pos", state(), "COMPLETE"),
    lockboxCase("neg", missing(), "INCOMPLETE"),
  ];
  const datasetText = cases.map((c) => JSON.stringify({ id: c.id, state: c.state, questions: c.questions, expected: c.expected })).join("\n") + "\n";
  const datasetRevision = createHash("sha256").update(datasetText, "utf8").digest("hex");
  const rows = [
    await scoreLockboxCase(votingModel("COMPLETE"), cases[0]!, policy(), datasetRevision),
    await scoreLockboxCase(votingModel("COMPLETE"), cases[1]!, policy(), datasetRevision),
  ];
  return { cases, rows, datasetText };
}

const THRESHOLDS = { minLiveness: 0.5, minPositives: 1, minNegatives: 1 };
const POLICY_THRESHOLDS: Record<string, number> = { ...MISSION_CLOSURE_RELEASE_POLICY };

describe("mission-closure-3stage gate", () => {
  it("does not qualify narrative-only rows that never reach semantic review", async () => {
    const { rows } = await twoCaseRun();
    const gate = missionClosure3StageGate(rows, THRESHOLDS);
    expect(gate.pass).toBe(false);
    expect(gate.detail).toContain("false terminal completions 0/1");
    expect(gate.detail).toContain("positives terminally completed 0/1 (0.00%)");
    expect(gate.detail).toContain("preflight stops 2");
  });

  it("fails a false terminal completion", async () => {
    const cases = [lockboxCase("neg", state(), "INCOMPLETE")];
    const rows = [await scoreLockboxCase(votingModel("COMPLETE"), cases[0]!, policy(), DATASET)];
    const gate = missionClosure3StageGate(rows, { minLiveness: 0.5, minPositives: 0 + 1, minNegatives: 1 });
    expect(gate.pass).toBe(false);
    expect(gate.detail).toContain("false terminal completions 0/1");
    expect(gate.detail).toContain("preflight stops 1");
  });

  it("fails liveness below the bar", async () => {
    const cases = [lockboxCase("pos", state(), "COMPLETE")];
    const rows = [await scoreLockboxCase(votingModel("INCOMPLETE"), cases[0]!, policy(), DATASET)];
    const gate = missionClosure3StageGate(rows, { minLiveness: 0.95, minPositives: 1, minNegatives: 0 + 1 });
    expect(gate.pass).toBe(false);
    expect(gate.detail).toContain("0/1 (0.00%)");
  });

  it("fails an undersized population", async () => {
    const { rows } = await twoCaseRun();
    expect(missionClosure3StageGate(rows, { ...THRESHOLDS, minPositives: 60 }).pass).toBe(false);
    expect(missionClosure3StageGate(rows, { ...THRESHOLDS, minNegatives: 149 }).pass).toBe(false);
  });

  it("requires explicit thresholds", async () => {
    const { rows } = await twoCaseRun();
    expect(missionClosure3StageGate(rows, {}).pass).toBe(false);
  });
});

describe("three-stage manifest verification", () => {
  function files(rows: LockboxCaseScore[], cases: CalibrationCase[], datasetText: string) {
    const dir = mkdtempSync(join(tmpdir(), "jev-3stage-"));
    const datasetPath = join(dir, "ds.jsonl");
    writeFileSync(datasetPath, datasetText);
    const rowsPath = join(dir, "rows.jsonl");
    writeFileSync(rowsPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const devPath = join(dir, "dev.jsonl");
    writeFileSync(devPath, JSON.stringify({ id: "dev-1", state: {}, questions: QUESTIONS, expected: { closure: { choice: "COMPLETE" } } }) + "\n");
    const valPath = join(dir, "val.jsonl");
    writeFileSync(valPath, JSON.stringify({ id: "val-1", state: {}, questions: QUESTIONS, expected: { closure: { choice: "COMPLETE" } } }) + "\n");
    return { dir, datasetPath, rowsPath, devPath, valPath };
  }

  async function policyScaleRun(): Promise<{ cases: CalibrationCase[]; rows: LockboxCaseScore[]; datasetText: string }> {
    const cases: CalibrationCase[] = [];
    for (let index = 0; index < 60; index += 1) cases.push(lockboxCase(`pos-${index}`, state(), "COMPLETE"));
    for (let index = 0; index < 149; index += 1) cases.push(lockboxCase(`neg-${index}`, missing(), "INCOMPLETE"));
    const datasetText = cases.map((c) => JSON.stringify({ id: c.id, state: c.state, questions: c.questions, expected: c.expected })).join("\n") + "\n";
    const datasetRevision = createHash("sha256").update(datasetText, "utf8").digest("hex");
    const rows: LockboxCaseScore[] = [];
    for (const c of cases) rows.push(await scoreLockboxCase(votingModel("COMPLETE"), c, policy(), datasetRevision));
    return { cases, rows, datasetText };
  }

  function manifestFor(
    rows: LockboxCaseScore[],
    f: ReturnType<typeof files>,
    decision: "qualified" | "rejected",
    thresholds: Record<string, number> = THRESHOLDS,
  ): QualificationManifest {
    const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
    const datasetText = readFileSync(f.datasetPath, "utf8");
    const questionHash = hashQuestions(QUESTIONS);
    return {
      family: "mission-closure-3stage",
      backend: "jev-gateway",
      model: "m",
      modelVersion: "m",
      adapterVersion: "0.6.3",
      questionSetHash: questionSetHashFor([questionHash]),
      policyHash: canonicalPolicyHash({ policyVersion: "mission-closure/1", questionHash, minConfidence: 0.9 }),
      datasetHash: sha(datasetText),
      developmentDatasetHash: sha(readFileSync(f.devPath, "utf8")),
      validationDatasetHash: sha(readFileSync(f.valPath, "utf8")),
      evaluationHash: sha(readFileSync(f.rowsPath, "utf8")),
      datasetSplit: "lockbox",
      expectedJudgments: rows.length,
      correctJudgments: rows.filter((r) => r.integratedCorrect).length,
      invalidJudgments: 0,
      thresholds,
      metrics: { ...threeStageMetrics(rows) },
      calibrationVersion: "mission-lockbox/1",
      calibratedAt: new Date().toISOString(),
      decision,
    };
  }

  function active(thresholds: Record<string, number> = THRESHOLDS): QualificationActiveIdentity {
    const questionHash = hashQuestions(QUESTIONS);
    return {
      backend: "jev-gateway",
      model: "m",
      modelVersion: "m",
      adapterVersion: "0.6.3",
      questionSetHash: questionSetHashFor([questionHash]),
      policyHash: canonicalPolicyHash({ policyVersion: "mission-closure/1", questionHash, minConfidence: 0.9 }),
      thresholds,
    };
  }

  it("refuses policy-scale narrative-only rows even when their counts meet release floors", async () => {
    const { cases, rows, datasetText } = await policyScaleRun();
    const f = files(rows, cases, datasetText);
    const m = manifestFor(rows, f, "qualified", POLICY_THRESHOLDS);
    const result = verifyThreeStageManifest(m, {
      datasetPath: f.datasetPath,
      developmentDatasetPath: f.devPath,
      validationDatasetPath: f.valPath,
      receiptsPath: f.rowsPath,
    }, active(POLICY_THRESHOLDS), policy());
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
    const detail = result.reasons.join(" ");
    expect(detail).toContain("preflight stops 209");
    expect(detail).toContain("0/60 (0.00%)");
  });

  it("counts the four narrative-only cases as preflight stops, not model outcomes", async () => {
    const scored = await scoreLockboxCase(
      votingModel("COMPLETE"),
      lockboxCase("pos", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    expect(scored.integratedOutcome).toBeUndefined();
    const held = await scoreLockboxCase(
      votingModel("COMPLETE", 0.79),
      lockboxCase("held", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    expect(held.integratedOutcome).toBeUndefined();
    const refused = await scoreLockboxCase(
      votingModel("INCOMPLETE"),
      lockboxCase("refused", state(), "INCOMPLETE"),
      policy(),
      DATASET,
    );
    expect(refused.integratedOutcome).toBeUndefined();
    const flaky = await scoreLockboxCase(
      {
        ...votingModel("COMPLETE"),
        evaluate: (() => { throw new Error("socket hang up"); }) as never,
      },
      lockboxCase("flaky", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    expect(flaky.integratedOutcome).toBeUndefined();
    const m = threeStageMetrics([scored, held, refused, flaky]);
    expect(m).toMatchObject({
      positivesTotal: 3,
      positivesCompleted: 0,
      negativesTotal: 1,
      falseTerminalCompletions: 0,
      thresholdHolds: 0,
      semanticRefusals: 0,
      modelErrors: 1,
      preflightStops: 4,
    });
  });

  it("keeps the legacy miss buckets for rows without an outcome", async () => {
    const held = await scoreLockboxCase(
      votingModel("COMPLETE", 0.79),
      lockboxCase("held", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    const legacy = { ...held };
    delete legacy.integratedOutcome;
    delete legacy.integratedFailure;
    const m = threeStageMetrics([legacy]);
    expect(m.thresholdHolds).toBe(0);
    expect(m.modelErrors).toBe(0);
    expect(m.preflightStops).toBe(1);
    const flaky = await scoreLockboxCase(
      {
        ...votingModel("COMPLETE"),
        evaluate: (() => { throw new Error("socket hang up"); }) as never,
      },
      lockboxCase("flaky", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    const legacyFlaky = { ...flaky };
    delete legacyFlaky.integratedOutcome;
    delete legacyFlaky.integratedFailure;
    const m2 = threeStageMetrics([legacyFlaky]);
    expect(m2.modelErrors).toBe(1);
    expect(m2.positivesCompleted).toBe(0);
  });

  it("rejects a qualified manifest whose thresholds sit below the release policy floor", async () => {
    const { cases, rows, datasetText } = await twoCaseRun();
    const f = files(rows, cases, datasetText);
    const m = manifestFor(rows, f, "qualified");
    const result = verifyThreeStageManifest(m, {
      datasetPath: f.datasetPath,
      developmentDatasetPath: f.devPath,
      validationDatasetPath: f.valPath,
      receiptsPath: f.rowsPath,
    }, active(), policy());
    expect(result.ok).toBe(false);
    expect(result.authorizes).toBe(false);
  });

  it("records but never authorizes a rejected decision", async () => {
    const { cases, rows, datasetText } = await twoCaseRun();
    const f = files(rows, cases, datasetText);
    const m = manifestFor(rows, f, "rejected");
    const result = verifyThreeStageManifest(m, {
      datasetPath: f.datasetPath,
      developmentDatasetPath: f.devPath,
      validationDatasetPath: f.valPath,
      receiptsPath: f.rowsPath,
    }, active(), policy());
    expect(result.ok).toBe(true);
    expect(result.authorizes).toBe(false);
  });

  it("fails a manifest whose counts disagree with recomputation", async () => {
    const { cases, rows, datasetText } = await twoCaseRun();
    const f = files(rows, cases, datasetText);
    const m = { ...manifestFor(rows, f, "qualified", POLICY_THRESHOLDS), correctJudgments: 999 };
    const result = verifyThreeStageManifest(m, {
      datasetPath: f.datasetPath,
      developmentDatasetPath: f.devPath,
      validationDatasetPath: f.valPath,
      receiptsPath: f.rowsPath,
    }, active(POLICY_THRESHOLDS), policy());
    expect(result.ok).toBe(false);
    expect(result.authorizes).toBe(false);
  });

  it("fails a tampered policy binding", async () => {
    const { cases, rows, datasetText } = await twoCaseRun();
    const f = files(rows, cases, datasetText);
    const m = manifestFor(rows, f, "qualified", POLICY_THRESHOLDS);
    const otherPolicy = { ...policy(), modelVersion: "other" };
    const result = verifyThreeStageManifest(m, {
      datasetPath: f.datasetPath,
      developmentDatasetPath: f.devPath,
      validationDatasetPath: f.valPath,
      receiptsPath: f.rowsPath,
    }, active(POLICY_THRESHOLDS), otherPolicy);
    expect(result.ok).toBe(false);
  });
});
