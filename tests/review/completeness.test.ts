import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashReviewChecks, loadReviewConfig } from "../../src/review/load-config.js";
import { isProtectedReviewSatisfied, PROTECTED_GATE_REASONS } from "../../src/review/policy.js";
import type { CheckDef } from "../../src/review/questions.js";
import { ReviewService } from "../../src/review/service.js";

const CHECK = {
  id: "c1",
  type: "noul",
  instructions: { question: "Safe?", inspect: "diff", focus: "diff text only" },
  criteria: { true: "Change is unsafe.", false: "Change is safe." },
};

function writeConfigDir(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "review-complete-"));
  mkdirSync(join(root, "config", "review"), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(root, "config", "review", name), JSON.stringify(value));
  }
  return root;
}

const CALIBRATION_EVIDENCE = {
  modelVersion: "jev-1.14.0+build.2",
  calibrationVersion: "bench-2026-10-01",
  datasetRevision: "labeled-suite@sha256:0123456789abcdef",
  evaluationHash: "a".repeat(64),
};

const CALIBRATED_POLICY = () => ({
  policy_version: "1",
  thresholds: { block: 0.85, security_review: 0.6 },
  provenance: {
    backend: "typesafe",
    model: "jev-1.14.0",
    calibrated: true,
    questionHash: hashReviewChecks([{ ...CHECK } as unknown as CheckDef]),
    ...CALIBRATION_EVIDENCE,
  },
});

function serviceWith(
  model: unknown,
  overrides: Record<string, unknown> = {},
  policyOverrides: Record<string, unknown> = {},
) {
  return new ReviewService(model as never, {
    checks: [{ ...CHECK } as unknown as CheckDef],
    policy: { ...CALIBRATED_POLICY(), ...policyOverrides } as never,
    status: "ready",
    expectedCalibration: {
      backend: "typesafe",
      model: "jev-1.14.0",
      questionHash: hashReviewChecks([{ ...CHECK } as unknown as CheckDef]),
      ...CALIBRATION_EVIDENCE,
    },
    ...overrides,
  } as never);
}

describe("review completeness invariants", () => {
  it("rejects duplicate check ids on load", () => {
    const root = writeConfigDir({
      "checks.json": { checks: [CHECK, { ...CHECK }] },
      "policy.json": CALIBRATED_POLICY(),
    });
    const loaded = loadReviewConfig([root]);
    expect(loaded.status).toBe("invalid");
    expect(loaded.checks).toHaveLength(0);
    expect(loaded.invalid).toMatch(/duplicate/i);
  });

  it("loads model and calibration version pins from policy provenance", () => {
    const root = writeConfigDir({
      "checks.json": { checks: [CHECK] },
      "policy.json": {
        ...CALIBRATED_POLICY(),
        provenance: {
          backend: "typesafe",
          model: "jev-1.14.0",
          calibrated: true,
          modelVersion: "jev-1.14.0+build.2",
          calibrationVersion: "bench-2026-10-01",
          questionHash: hashReviewChecks([{ ...CHECK } as unknown as CheckDef]),
          datasetRevision: CALIBRATION_EVIDENCE.datasetRevision,
          evaluationHash: CALIBRATION_EVIDENCE.evaluationHash,
        },
      },
    });
    expect(loadReviewConfig([root]).calibration).toMatchObject({
      backend: "typesafe",
      model: "jev-1.14.0",
      modelVersion: "jev-1.14.0+build.2",
      calibrationVersion: "bench-2026-10-01",
      calibrated: true,
    });
  });

  it("rejects empty criteria and a missing expected answer key", () => {
    const variants: Array<[string, unknown]> = [
      ["empty true rubric", [{ ...CHECK, criteria: { true: "", false: "Safe." } }]],
      ["empty false rubric", [{ ...CHECK, criteria: { true: "Unsafe.", false: "" } }]],
      ["missing false key", [{ ...CHECK, criteria: { true: "Unsafe." } }]],
      ["missing true key", [{ ...CHECK, criteria: { false: "Safe." } }]],
      ["missing criteria", [{ ...CHECK, criteria: undefined }]],
      ["wrong answer type", [{ ...CHECK, type: "choice" }]],
    ];
    for (const [name, checks] of variants) {
      const root = writeConfigDir({ "checks.json": { checks }, "policy.json": CALIBRATED_POLICY() });
      const loaded = loadReviewConfig([root]);
      expect(loaded.status, name).toBe("invalid");
      expect(loaded.checks, name).toHaveLength(0);
    }
  });

  it("rejects an incomplete result: every configured check id must be present", async () => {
    const model = { async evaluate() { return { answers: {} }; } };
    const result = await serviceWith(model).review({ diff: "benign", files: [] });
    expect(result.lane).toBe("UNAVAILABLE");
    expect(result.lane).not.toBe("MERGE");
    expect(result.findings[0]?.id).toBe("review:model-error");
  });

  it("rejects out-of-range and non-finite probabilities as review-unavailable", async () => {
    for (const noul of [1.5, -0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const model = { async evaluate() { return { answers: { c1: { type: "noul", noul } } }; } };
      const result = await serviceWith(model).review({ diff: "benign", files: [] });
      expect(result.lane, `noul=${String(noul)}`).toBe("UNAVAILABLE");
      expect(result.lane, `noul=${String(noul)}`).not.toBe("MERGE");
    }
  });

  it("keeps the checked-in policy uncalibrated and fails protected review closed", async () => {
    const loaded = loadReviewConfig();
    expect(loaded.policy.provenance?.calibrated).toBe(false);
    expect(loaded.status).toBe("uncalibrated");
    let calls = 0;
    const model = {
      async evaluate(): Promise<never> {
        calls++;
        throw new Error("must not be called");
      },
    };
    const review = new ReviewService(model as never, {
      checks: loaded.checks as never,
      policy: loaded.policy,
      status: loaded.status,
      expectedCalibration: { backend: "typesafe", model: "jev-1.14.0" },
    });
    const result = await review.review({ diff: "benign", files: [] });
    expect(calls).toBe(0);
    expect(result.lane).toBe("UNAVAILABLE");
    expect(result.findings[0]?.id).toBe("config:uncalibrated-review-policy");
    expect(result.findings[0]?.message).toMatch(/review-unavailable:uncalibrated/);
    expect(isProtectedReviewSatisfied(result)).toEqual({
      ok: false,
      reason: expect.stringMatching(/review-unavailable:/),
    });
  });

  it("does not accept calibrated=true without the full calibration evidence binding", async () => {
    const model = {
      async evaluate() {
        return { provider: "typesafe", model: "jev-1.14.0", answers: { c1: { type: "noul", noul: 0.01 } } };
      },
    };
    const result = await serviceWith(model, {}, {
      provenance: { backend: "typesafe", model: "jev-1.14.0", calibrated: true },
    }).review({ diff: "benign", files: [] });
    expect(result.lane).toBe("UNAVAILABLE");
    expect(result.findings[0]?.id).toBe("config:uncalibrated-review-policy");
  });

  it("attaches calibration pinning fields to judged results", async () => {
    const model = {
      async evaluate() {
        return { provider: "typesafe", model: "jev-1.14.0", answers: { c1: { type: "noul", noul: 0.01 } } };
      },
    };
    const result = await serviceWith(model).review({ diff: "benign", files: [] });
    expect(result.lane).toBe("MERGE");
    expect(result.calibration).toMatchObject({
      provider: "typesafe",
      model: "jev-1.14.0",
      calibrated: true,
      advisory: false,
    });
    expect(typeof result.calibration?.modelVersion).toBe("string");
    expect(result.calibration?.questionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof result.calibration?.calibrationVersion).toBe("string");
    expect(result.calibration?.questionHash).toBe(hashReviewChecks([{ ...CHECK } as unknown as CheckDef]));
  });

  it("labels OpenRouter probabilities uncalibrated/advisory and never satisfies the gate", async () => {
    const model = {
      async evaluate() {
        return { provider: "openrouter", model: "typesafe/jev-router", answers: { c1: { type: "noul", noul: 0.01 } } };
      },
    };
    const result = await serviceWith(model).review({ diff: "benign", files: [] });
    expect(result.lane).toBe("UNAVAILABLE");
    expect(result.calibration?.provider).toBe("openrouter");
    expect(result.calibration?.calibrated).toBe(false);
    expect(result.calibration?.advisory).toBe(true);
    const gate = isProtectedReviewSatisfied(result);
    expect(gate).toEqual({ ok: false, reason: PROTECTED_GATE_REASONS.advisoryProvider });
  });

  it("fails closed when the question hash does not match the calibrated set", async () => {
    let calls = 0;
    const model = {
      async evaluate(): Promise<never> {
        calls++;
        throw new Error("must not be called");
      },
    };
    const review = serviceWith(model, {
      expectedCalibration: { backend: "typesafe", model: "jev-1.14.0", questionHash: "0".repeat(64) },
    });
    const result = await review.review({ diff: "benign", files: [] });
    expect(calls).toBe(0);
    expect(result.lane).toBe("UNAVAILABLE");
    expect(result.findings[0]?.id).toBe("config:question-hash-mismatch");
    expect(isProtectedReviewSatisfied(result)).toEqual({
      ok: false,
      reason: expect.stringMatching(/review-unavailable:/),
    });
  });

  it("refuses a MERGE when the answering model differs from the calibrated model", async () => {
    const model = {
      async evaluate() {
        return { provider: "typesafe", model: "jev-1.13.0", answers: { c1: { type: "noul", noul: 0.01 } } };
      },
    };
    const result = await serviceWith(model).review({ diff: "benign", files: [] });
    expect(result.lane).toBe("UNAVAILABLE");
    expect(result.findings[0]?.id).toBe("review:calibration-pin-mismatch");
    expect(result.calibration).toMatchObject({ model: "jev-1.13.0", calibrated: false });
    expect(result.calibration?.reason).toBe(PROTECTED_GATE_REASONS.modelMismatch);
  });

  it("requires exact measured model and calibration version pins when requested", async () => {
    const model = {
      async evaluate() {
        return { provider: "typesafe", model: "jev-1.14.0", answers: { c1: { type: "noul", noul: 0.01 } } };
      },
    };
    const expectedCalibration = {
      backend: "typesafe",
      model: "jev-1.14.0",
      modelVersion: "jev-1.14.0+build.2",
      calibrationVersion: "bench-2026-10-01",
    };
    const missingPins = await serviceWith(model, { expectedCalibration }, {
      provenance: {
        backend: "typesafe",
        model: "jev-1.14.0",
        calibrated: true,
        questionHash: hashReviewChecks([{ ...CHECK } as unknown as CheckDef]),
        datasetRevision: CALIBRATION_EVIDENCE.datasetRevision,
        evaluationHash: CALIBRATION_EVIDENCE.evaluationHash,
      },
    }).review({ diff: "benign", files: [] });
    expect(missingPins.lane).toBe("UNAVAILABLE");
    expect(missingPins.findings[0]?.id).toBe("config:uncalibrated-review-policy");
    expect(missingPins.calibration?.modelVersion).not.toBe(expectedCalibration.modelVersion);

    const good = await serviceWith(
      model,
      { expectedCalibration },
      {
        provenance: {
          backend: "typesafe",
          model: "jev-1.14.0",
          calibrated: true,
          modelVersion: "jev-1.14.0+build.2",
          calibrationVersion: "bench-2026-10-01",
          questionHash: hashReviewChecks([{ ...CHECK } as unknown as CheckDef]),
          datasetRevision: CALIBRATION_EVIDENCE.datasetRevision,
          evaluationHash: CALIBRATION_EVIDENCE.evaluationHash,
        },
      },
    ).review({ diff: "benign", files: [] });
    expect(good.lane).toBe("MERGE");
    expect(good.calibration).toMatchObject({
      modelVersion: expectedCalibration.modelVersion,
      calibrationVersion: expectedCalibration.calibrationVersion,
      calibrated: true,
    });

    const wrongCalibrationVersion = await serviceWith(
      model,
      { expectedCalibration },
      {
        provenance: {
          backend: "typesafe",
          model: "jev-1.14.0",
          calibrated: true,
          modelVersion: "jev-1.14.0+build.2",
          calibrationVersion: "bench-2026-09-01",
          questionHash: hashReviewChecks([{ ...CHECK } as unknown as CheckDef]),
          datasetRevision: CALIBRATION_EVIDENCE.datasetRevision,
          evaluationHash: CALIBRATION_EVIDENCE.evaluationHash,
        },
      },
    ).review({ diff: "benign", files: [] });
    expect(wrongCalibrationVersion.lane).toBe("UNAVAILABLE");
    expect(wrongCalibrationVersion.calibration?.reason).toBe(PROTECTED_GATE_REASONS.calibrationVersionMismatch);
  });

  it("requires calibrated=true for the exact backend/model/question-hash in use", async () => {
    const model = {
      async evaluate() {
        return { provider: "typesafe", model: "jev-1.14.0", answers: { c1: { type: "noul", noul: 0.01 } } };
      },
    };
    const good = await serviceWith(model).review({ diff: "benign", files: [] });
    const hash = good.calibration?.questionHash ?? "";
    expect(isProtectedReviewSatisfied(good, { backend: "typesafe", model: "jev-1.14.0", questionHash: hash })).toEqual({
      ok: true,
    });
    // Wrong backend, wrong model, and wrong hash each fail closed.
    expect(isProtectedReviewSatisfied(good, { backend: "openrouter" }).ok).toBe(false);
    expect(isProtectedReviewSatisfied(good, { model: "jev-9.9.9" }).ok).toBe(false);
    expect(isProtectedReviewSatisfied(good, { questionHash: "f".repeat(64) })).toEqual({
      ok: false,
      reason: PROTECTED_GATE_REASONS.questionHashMismatch,
    });
    // A MERGE lane without a calibrated pin never satisfies the gate.
    const { calibration: _dropped, ...unpinnned } = good;
    expect(isProtectedReviewSatisfied(unpinnned).ok).toBe(false);
  });
});
