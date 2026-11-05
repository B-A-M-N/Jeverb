import { describe, expect, it } from "vitest";
import { hashQuestions } from "../../src/decision/provenance.js";
import type { DecisionModel } from "../../src/decision/types.js";
import type { CalibrationCase } from "../../src/jev/calibration.js";
import {
  LOCKBOX_ROW_VERSION,
  lockboxPolicy,
  scoreLockboxCase,
  summarizeLockbox,
  verifyLockboxRun,
  type LockboxCaseScore,
} from "../../src/jev/lockbox.js";
import { MISSION_CLOSURE_QUESTION } from "../../src/mission/closure.js";

const DATASET = "test-dataset-revision";
const QUESTIONS = { closure: MISSION_CLOSURE_QUESTION } as CalibrationCase["questions"];

function policy() {
  return lockboxPolicy(QUESTIONS, {
    policyVersion: "mission-closure/1",
    minConfidence: 0.9,
    backend: "jev-gateway",
    model: "m",
    modelVersion: "m",
  });
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

describe("three-stage lockbox scoring", () => {
  it("lets preflight stop a wrongful model COMPLETE on missing criterion proof", async () => {
    const score = await scoreLockboxCase(
      votingModel("COMPLETE"),
      lockboxCase("missing-proof", missing(), "INCOMPLETE"),
      policy(),
      DATASET,
    );
    expect(score.rowVersion).toBe(LOCKBOX_ROW_VERSION);
    expect(score.dataset).toBe(DATASET);
    expect(score.policy).toMatchObject({ backend: "jev-gateway", model: "m", modelVersion: "m" });
    expect(score.preflightReady).toBe(false);
    expect(score.observedModel).toBe("m");
    expect(score.modelChoice).toBe("COMPLETE");
    expect(score.modelCorrect).toBe(false);
    expect(score.integratedComplete).toBe(false);
    expect(score.integratedChoice).toBe("INCOMPLETE");
    expect(score.integratedConfidence).toBeUndefined();
    expect(score.integratedCorrect).toBe(true);
  });

  it("keeps legacy narrative proof strings out of the integrated semantic path", async () => {
    const score = await scoreLockboxCase(
      votingModel("COMPLETE"),
      lockboxCase("full", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    expect(score.preflightReady).toBe(false);
    expect(score.preflightReason).toMatch(/objective coverage attestation is missing or stale/);
    expect(score.modelCorrect).toBe(true);
    expect(score.modelConfidence).toBe(0.97);
    expect(score.modelProbabilities?.COMPLETE).toBe(0.97);
    expect(score.modelCall).toMatchObject({
      provider: "jev-gateway",
      model: "m",
      questionHash: hashQuestions(QUESTIONS),
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(score.integratedComplete).toBe(false);
    expect(score.integratedConfidence).toBeUndefined();
    expect(score.integratedCall).toBeUndefined();
    expect(score.integratedReason).toMatch(/objective coverage attestation is missing or stale/);
  });

  it("respects a model INCOMPLETE vote on mechanically complete evidence", async () => {
    const score = await scoreLockboxCase(
      votingModel("INCOMPLETE"),
      lockboxCase("semantic-gap", state(), "INCOMPLETE"),
      policy(),
      DATASET,
    );
    expect(score.preflightReady).toBe(false);
    expect(score.modelCorrect).toBe(true);
    expect(score.integratedComplete).toBe(false);
    expect(score.integratedConfidence).toBeUndefined();
  });

  it("does not send an integrated request after a model-only identity mismatch when fail-fast is enabled", async () => {
    const base = votingModel("COMPLETE");
    let calls = 0;
    const mismatched: DecisionModel = {
      ...base,
      evaluate: async (input) => {
        calls += 1;
        const result = await base.evaluate(input);
        return { ...result, model: "other-model" } as never;
      },
    };
    const score = await scoreLockboxCase(
      mismatched,
      lockboxCase("identity-drift", state(), "COMPLETE"),
      policy(),
      DATASET,
      { stopAfterModelOnlyFailureOrBindingMismatch: true },
    );
    expect(calls).toBe(1);
    expect(score.integratedOutcome).toBeUndefined();
    expect(score.integratedCall).toBeUndefined();
  });

  it("tallies the stages separately", async () => {
    const scores = [
      await scoreLockboxCase(votingModel("COMPLETE"), lockboxCase("a", missing(), "INCOMPLETE"), policy(), DATASET),
      await scoreLockboxCase(votingModel("COMPLETE"), lockboxCase("b", state(), "COMPLETE"), policy(), DATASET),
    ];
    const summary = summarizeLockbox(scores);
    expect(summary.cases).toBe(2);
    expect(summary.modelCorrect).toBe(1);
    expect(summary.integratedCorrect).toBe(1);
    expect(summary.preflightReadyOnCompleteExpected).toEqual({ ready: 0, total: 1 });
    expect(summary.preflightStoppedOnNonCompleteExpected).toEqual({ stopped: 1, total: 1 });
  });
});

describe("independent lockbox verification", () => {
  async function validRun(): Promise<{ cases: CalibrationCase[]; rows: LockboxCaseScore[] }> {
    const cases = [
      lockboxCase("a", missing(), "INCOMPLETE"),
      lockboxCase("b", state(), "COMPLETE"),
    ];
    const rows = [
      await scoreLockboxCase(votingModel("COMPLETE"), cases[0]!, policy(), DATASET),
      await scoreLockboxCase(votingModel("COMPLETE"), cases[1]!, policy(), DATASET),
    ];
    return { cases, rows };
  }

  it("accepts a faithful run and recomputes its tallies", async () => {
    const { cases, rows } = await validRun();
    const verdict = verifyLockboxRun(cases, rows, policy(), DATASET);
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.recomputed.cases).toBe(2);
    expect(verdict.recomputed.modelCorrect).toBe(1);
    expect(verdict.recomputed.integratedCorrect).toBe(1);
  });

  it("rejects a flipped correctness boolean", async () => {
    const { cases, rows } = await validRun();
    const tampered = rows.map((r) => ({ ...r, integratedCorrect: !r.integratedCorrect }));
    const verdict = verifyLockboxRun(cases, tampered, policy(), DATASET);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.includes("disagree with recomputation"))).toBe(true);
  });

  it("rejects missing, duplicate, and unknown rows", async () => {
    const { cases, rows } = await validRun();
    expect(verifyLockboxRun(cases, rows.slice(1), policy(), DATASET).errors.some((e) => e.includes("missing recorded row"))).toBe(true);
    expect(verifyLockboxRun(cases, [...rows, rows[0]!], policy(), DATASET).errors.some((e) => e.includes("duplicate recorded row"))).toBe(true);
    expect(verifyLockboxRun(cases, [...rows, { ...rows[0]!, caseId: "ghost" }], policy(), DATASET).errors.some((e) => e.includes("unknown case"))).toBe(true);
  });

  it("rejects binding mismatches", async () => {
    const { cases, rows } = await validRun();
    expect(verifyLockboxRun(cases, rows, policy(), "other-dataset").errors.some((e) => e.includes("dataset binding"))).toBe(true);
    const wrongPolicy = { ...policy(), modelVersion: "other" };
    expect(verifyLockboxRun(cases, rows, wrongPolicy, DATASET).errors.some((e) => e.includes("binding"))).toBe(true);
  });

  it("rejects a preflight that does not reproduce", async () => {
    const { cases, rows } = await validRun();
    const tampered = rows.map((r) => (r.caseId === "a" ? { ...r, preflightReady: true } : r));
    const verdict = verifyLockboxRun(cases, tampered, policy(), DATASET);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.includes("recorded preflight does not reproduce"))).toBe(true);
  });

  it("rejects a stopped case carrying a semantic vote", async () => {
    const { cases, rows } = await validRun();
    const tampered = rows.map((r) => (r.caseId === "a"
      ? { ...r, integratedConfidence: 0.97, integratedProbabilities: { COMPLETE: 0.97, INCOMPLETE: 0.01, BLOCKED: 0.01, INSUFFICIENT_EVIDENCE: 0.01 } }
      : r));
    const verdict = verifyLockboxRun(cases, tampered, policy(), DATASET);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.includes("no semantic vote"))).toBe(true);
  });

  it("accepts a threshold-held COMPLETE vote recorded as the preflight outcome", async () => {
    const cases = [lockboxCase("held", state(), "COMPLETE")];
    const rows = [await scoreLockboxCase(votingModel("COMPLETE", 0.79), cases[0]!, policy(), DATASET)];
    expect(rows[0]!.integratedComplete).toBe(false);
    const verdict = verifyLockboxRun(cases, rows, policy(), DATASET);
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("rejects a narrative-only case that claims terminal completion", async () => {
    const { cases, rows } = await validRun();
    const tampered = rows.map((r) => (r.caseId === "b" ? { ...r, integratedComplete: true } : r));
    const verdict = verifyLockboxRun(cases, tampered, policy(), DATASET);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.includes("preflight-stopped case must record the preflight outcome"))).toBe(true);
  });

  it("rejects a reviewed case with no recorded vote", async () => {
    const { cases, rows } = await validRun();
    const tampered = rows.map((r) => (r.caseId === "b"
      ? { ...r, integratedRequestId: "forged-semantic-request" }
      : r));
    const verdict = verifyLockboxRun(cases, tampered, policy(), DATASET);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.includes("preflight-stopped case must record the preflight outcome"))).toBe(true);
  });

  it("rejects unlabeled cases", async () => {
    const cases = [{ id: "u", state: state(), questions: QUESTIONS, expected: {} }];
    const verdict = verifyLockboxRun(cases, [], policy(), DATASET);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.includes("no labeled closure choice"))).toBe(true);
  });
});

describe("stage-separated failure accounting", () => {
  /** Scripted transport: throw on the listed call indexes, vote COMPLETE otherwise. */
  function flakyModel(throwOn: number[], thrown: unknown = new Error("socket hang up")): DecisionModel {
    const base = votingModel("COMPLETE");
    let calls = 0;
    return {
      ...base,
      evaluate: (async (input: unknown) => {
        const index = calls;
        calls += 1;
        if (throwOn.includes(index)) throw thrown;
        return (base.evaluate as (request: never) => Promise<never>)(input as never);
      }) as never,
    };
  }

  function malformedModel(): DecisionModel {
    const base = votingModel("COMPLETE");
    return {
      ...base,
      evaluate: (async (input: unknown) => {
        const result = await (base.evaluate as (request: never) => Promise<never>)(input as never) as unknown as {
          answers: { closure: { probabilities: Record<string, number> } };
        };
        result.answers.closure.probabilities = { COMPLETE: 0.01, INCOMPLETE: 0.97, BLOCKED: 0.01, INSUFFICIENT_EVIDENCE: 0.01 };
        return result as never;
      }) as never,
    };
  }

  it("records the failed raw baseline and never completes a preflight-stopped case", async () => {
    const score = await scoreLockboxCase(
      flakyModel([0]),
      lockboxCase("flaky-first", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    expect(score.modelChoice).toBeUndefined();
    expect(score.modelOnlyError?.kind).toBe("transport");
    expect(score.modelError).toContain("transport");
    expect(score.integratedOutcome).toBeUndefined();
    expect(score.integratedCall).toBeUndefined();
    expect(score.integratedComplete).toBe(false);
    expect(score.integratedConfidence).toBeUndefined();
    const verdict = verifyLockboxRun(
      [lockboxCase("flaky-first", state(), "COMPLETE")], [score], policy(), DATASET,
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("does not issue a second request when preflight stops the case", async () => {
    const score = await scoreLockboxCase(
      flakyModel([1]),
      lockboxCase("flaky-second", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    expect(score.modelChoice).toBe("COMPLETE");
    expect(score.modelOnlyError).toBeUndefined();
    expect(score.integratedOutcome).toBeUndefined();
    expect(score.integratedComplete).toBe(false);
    expect(score.integratedConfidence).toBeUndefined();
    const verdict = verifyLockboxRun(
      [lockboxCase("flaky-second", state(), "COMPLETE")], [score], policy(), DATASET,
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("stops after one failed raw-baseline request when evidence preflight blocks", async () => {
    const score = await scoreLockboxCase(
      flakyModel([0, 1]),
      lockboxCase("flaky-both", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    expect(score.modelOnlyError?.kind).toBe("transport");
    expect(score.integratedOutcome).toBeUndefined();
    expect(score.integratedComplete).toBe(false);
  });

  it("does not treat a raw baseline distribution as an integrated semantic vote", async () => {
    const score = await scoreLockboxCase(
      malformedModel(),
      lockboxCase("malformed", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    expect(score.modelChoice).toBe("COMPLETE");
    expect(score.integratedOutcome).toBeUndefined();
    expect(score.integratedConfidence).toBeUndefined();
    expect(score.integratedComplete).toBe(false);
  });

  it("rejects terminal completion on a preflight-stopped case even if the raw baseline answers COMPLETE", async () => {
    const score = await scoreLockboxCase(
      flakyModel([1]),
      lockboxCase("flaky-second", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    expect(score.integratedOutcome).toBeUndefined();
    const tampered = [{ ...score, integratedComplete: true }];
    const verdict = verifyLockboxRun(
      [lockboxCase("flaky-second", state(), "COMPLETE")], tampered, policy(), DATASET,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.includes("preflight-stopped case must record the preflight outcome"))).toBe(true);
  });

  it("rejects a tampered bench version", async () => {
    const score = await scoreLockboxCase(
      votingModel("COMPLETE"),
      lockboxCase("pos", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    const tampered = [{ ...score, benchVersion: "mission-lockbox/0" }];
    const verdict = verifyLockboxRun(
      [lockboxCase("pos", state(), "COMPLETE")], tampered, policy(), DATASET,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.includes("unsupported bench version"))).toBe(true);
  });

  it("binds sanitized provider request ids to the measured candidate and model", async () => {
    const base = votingModel("COMPLETE");
    const identified = {
      ...base,
      evaluate: (async (input: unknown) => {
        const result = await (base.evaluate as (request: never) => Promise<never>)(input as never) as unknown as Record<string, unknown>;
        return { ...result, correlationId: "req-abc-123" } as never;
      }) as never,
    };
    const score = await scoreLockboxCase(
      identified,
      lockboxCase("pos", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    expect(score.modelRequestId).toBe("req-abc-123");
    expect(score.integratedRequestId).toBeUndefined();
    const verdict = verifyLockboxRun(
      [lockboxCase("pos", state(), "COMPLETE")], [score], policy(), DATASET,
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("rejects malformed provider request ids instead of persisting them", async () => {
    const score = await scoreLockboxCase(
      votingModel("COMPLETE"),
      lockboxCase("pos", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    const tampered = [{ ...score, integratedRequestId: "req 123\ninject" }];
    const verdict = verifyLockboxRun(
      [lockboxCase("pos", state(), "COMPLETE")], tampered, policy(), DATASET,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.includes("malformed integrated provider request id"))).toBe(true);
  });

  it("rejects v3 rows whose recorded call identity or usage was tampered", async () => {
    const score = await scoreLockboxCase(
      votingModel("COMPLETE"),
      lockboxCase("pos", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    const tampered = [{
      ...score,
      modelCall: { ...score.modelCall!, provider: "openrouter" },
    }];
    const verdict = verifyLockboxRun(
      [lockboxCase("pos", state(), "COMPLETE")], tampered, policy(), DATASET,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.includes("model-only response identity or telemetry"))).toBe(true);
  });

  it("rejects invalid provider-reported cost and still verifies prior v2 rows", async () => {
    const caseRecord = lockboxCase("pos", state(), "COMPLETE");
    const score = await scoreLockboxCase(votingModel("COMPLETE"), caseRecord, policy(), DATASET);
    const badCost = [{
      ...score,
      modelCall: { ...score.modelCall!, usage: { ...score.modelCall!.usage, cost_usd: -1 } },
    }];
    const invalid = verifyLockboxRun([caseRecord], badCost, policy(), DATASET);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.some((e) => e.includes("model-only response identity or telemetry"))).toBe(true);

    const previousV2 = [{
      ...score,
      rowVersion: "mission-lockbox-row/2",
      modelCall: { ...score.modelCall!, usage: { input_tokens: 1, output_tokens: 1 } },
      ...(score.integratedCall === undefined
        ? {}
        : { integratedCall: { ...score.integratedCall, usage: { input_tokens: 1, output_tokens: 1 } } }),
    }];
    expect(verifyLockboxRun([caseRecord], previousV2, policy(), DATASET).ok).toBe(true);
  });

  it("rejects an integrated request id on a preflight-stopped case", async () => {
    const score = await scoreLockboxCase(
      votingModel("INCOMPLETE"),
      lockboxCase("neg", missing(), "INCOMPLETE"),
      policy(),
      DATASET,
    );
    expect(score.preflightReady).toBe(false);
    const tampered = [{ ...score, integratedRequestId: "req-abc-123" }];
    const verdict = verifyLockboxRun(
      [lockboxCase("neg", missing(), "INCOMPLETE")], tampered, policy(), DATASET,
    );
    expect(verdict.ok).toBe(false);
  });

  it("accepts a missing model-only result beside a correctly measured integrated result", async () => {
    const score = await scoreLockboxCase(
      flakyModel([0]),
      lockboxCase("flaky-first", state(), "COMPLETE"),
      policy(),
      DATASET,
    );
    expect(score.modelOnlyError).toBeDefined();
    const verdict = verifyLockboxRun(
      [lockboxCase("flaky-first", state(), "COMPLETE")], [score], policy(), DATASET,
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});
