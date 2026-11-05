import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadReviewConfig } from "../../src/review/load-config.js";
import { ReviewService } from "../../src/review/service.js";
import { calibratedReviewFixture } from "../review/calibration-fixture.js";

const CHECKS = {
  checks: [
    {
      id: "c1",
      type: "noul",
      instructions: { question: "Safe?", inspect: "diff", focus: "diff text only" },
      criteria: { true: "Change is unsafe.", false: "Change is safe." },
    },
  ],
};
const POLICY = (overrides: Record<string, unknown> = {}) => ({
  policy_version: "1",
  thresholds: { block: 0.85, security_review: 0.6 },
  provenance: calibratedReviewFixture(CHECKS.checks).policy.provenance,
  ...overrides,
});

function writeConfigDir(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "jeverb-review-"));
  mkdirSync(join(root, "config", "review"), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(root, "config", "review", name), JSON.stringify(value));
  }
  return root;
}

describe("review config resolution", () => {
  it("loads checks and policy from the checkout", () => {
    const loaded = loadReviewConfig();
    expect(loaded.invalid).toBeUndefined();
    expect(loaded.checks.length).toBeGreaterThan(0);
    expect(typeof loaded.policy.thresholds.block).toBe("number");
    expect(typeof loaded.policy.thresholds.security_review).toBe("number");
  });

  it("fails closed without calling the model when config is invalid", async () => {
    let calls = 0;
    const model = {
      async evaluate(_input: never): Promise<never> {
        calls++;
        throw new Error("must not be called");
      },
    };
    const review = new ReviewService(model as never, {
      checks: [],
      policy: { policy_version: "1", thresholds: { block: 0.85, security_review: 0.6 } },
      invalid: "test corruption",
    });
    const result = await review.review({ diff: "benign", files: [] });
    expect(result.lane).toBe("BLOCK");
    expect(calls).toBe(0);
  });

  it("distinguishes absent, partial, invalid, uncalibrated, and ready", () => {
    const empty = mkdtempSync(join(tmpdir(), "jeverb-review-empty-"));
    expect(loadReviewConfig([empty]).status).toBe("absent");

    const onlyChecks = writeConfigDir({ "checks.json": CHECKS });
    const partial = loadReviewConfig([onlyChecks]);
    expect(partial.status).toBe("partial");
    expect(partial.checks).toHaveLength(0);

    const badJson = writeConfigDir({ "checks.json": CHECKS });
    writeFileSync(join(badJson, "config", "review", "policy.json"), "{nope");
    expect(loadReviewConfig([badJson]).status).toBe("invalid");

    const emptyChecks = writeConfigDir({ "checks.json": { checks: [] }, "policy.json": POLICY() });
    expect(loadReviewConfig([emptyChecks]).status).toBe("invalid");

    const badThresholds = writeConfigDir({
      "checks.json": CHECKS,
      "policy.json": POLICY({ thresholds: { block: 0.4, security_review: 0.6 } }),
    });
    expect(loadReviewConfig([badThresholds]).status).toBe("invalid");

    const unmarked = writeConfigDir({
      "checks.json": CHECKS,
      "policy.json": { policy_version: "1", thresholds: { block: 0.85, security_review: 0.6 } },
    });
    const uncal = loadReviewConfig([unmarked]);
    expect(uncal.status).toBe("uncalibrated");
    expect(uncal.checks).toHaveLength(1);

    const ready = loadReviewConfig([writeConfigDir({ "checks.json": CHECKS, "policy.json": POLICY() })]);
    expect(ready.status).toBe("ready");
    expect(ready.calibration).toMatchObject({
      backend: "typesafe",
      model: "jev-1.14.0",
      calibrated: true,
      modelVersion: "jev-1.14.0+build.2",
      calibrationVersion: "test-bench-v1",
      datasetRevision: "fixture-dataset-v1",
      evaluationHash: "a".repeat(64),
    });
    expect(ready.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects underspecified checks: duplicates, wrong type, missing instructions/criteria", () => {
    const base = {
      id: "c1",
      type: "noul",
      instructions: { question: "Safe?", inspect: "diff", focus: "diff text only" },
      criteria: { true: "Unsafe.", false: "Safe." },
    };
    const variants: Array<[string, unknown]> = [
      ["duplicate id", [base, { ...base }]],
      ["wrong type", [{ ...base, type: "yesno" }]],
      ["missing focus", [{ ...base, instructions: { question: "Safe?", inspect: "diff" } }]],
      ["missing criteria", [{ ...base, criteria: undefined }]],
      ["missing id", [{ ...base, id: undefined }]],
      ["empty list", []],
    ];
    for (const [name, checks] of variants) {
      const root = writeConfigDir({ "checks.json": { checks }, "policy.json": POLICY() });
      const loaded = loadReviewConfig([root]);
      expect(loaded.status, name).toBe("invalid");
      expect(loaded.checks, name).toHaveLength(0);
    }
  });

  it("fails closed on absent config without calling the model", async () => {
    let calls = 0;
    const model = {
      async evaluate(_input: never): Promise<never> {
        calls++;
        throw new Error("must not be called");
      },
    };
    const review = new ReviewService(model as never, {
      checks: [],
      policy: { policy_version: "1", thresholds: { block: 0.85, security_review: 0.6 } },
      status: "absent",
      invalid: "review config absent",
    });
    const result = await review.review({ diff: "benign", files: [] });
    expect(result.lane).toBe("BLOCK");
    expect(result.findings[0]?.message).toMatch(/absent/);
    expect(calls).toBe(0);
  });

  it("refuses to judge with an uncalibrated policy (UNAVAILABLE, no model call)", async () => {
    let calls = 0;
    const model = {
      async evaluate(_input: never): Promise<never> {
        calls++;
        throw new Error("must not be called");
      },
    };
    const review = new ReviewService(model as never, {
      checks: [{ id: "c1" } as never],
      policy: {
        policy_version: "1",
        thresholds: { block: 0.85, security_review: 0.6 },
        provenance: { backend: "typesafe", model: "jev-1.14.0", calibrated: false },
      },
      status: "uncalibrated",
      expectedCalibration: { backend: "typesafe", model: "jev-1.14.0" },
    });
    const result = await review.review({ diff: "benign", files: [] });
    expect(result.lane).toBe("UNAVAILABLE");
    expect(result.findings[0]?.id).toBe("config:uncalibrated-review-policy");
    expect(calls).toBe(0);
  });

  it("refuses to judge when the calibration backend does not match", async () => {
    let calls = 0;
    const model = {
      async evaluate(_input: never): Promise<never> {
        calls++;
        throw new Error("must not be called");
      },
    };
    const review = new ReviewService(model as never, {
      checks: [{ id: "c1" } as never],
      policy: {
        policy_version: "1",
        thresholds: { block: 0.85, security_review: 0.6 },
        provenance: { backend: "typesafe", model: "jev-1.14.0", calibrated: true },
      },
      status: "ready",
      expectedCalibration: { backend: "openrouter", model: "typesafe/jev-router" },
    });
    const result = await review.review({ diff: "benign", files: [] });
    expect(result.lane).toBe("UNAVAILABLE");
    expect(calls).toBe(0);
  });

  it("keeps the keyless path advisory (no model, no block)", async () => {
    const review = new ReviewService(null, {
      checks: [],
      policy: { policy_version: "1", thresholds: { block: 0.85, security_review: 0.6 } },
      status: "uncalibrated",
    });
    const result = await review.review({ diff: "benign", files: [] });
    expect(result.lane).toBe("UNAVAILABLE");
  });

  it("judges a complete in-range answer set (MERGE)", async () => {
    const model = {
      async evaluate() {
        return { answers: { c1: { type: "noul", noul: 0.01 } } };
      },
    };
    const review = new ReviewService(model as never, {
      checks: (CHECKS.checks as unknown as import("../../src/review/questions.js").CheckDef[]),
      policy: POLICY(),
      status: "ready",
      expectedCalibration: calibratedReviewFixture(CHECKS.checks).expectedCalibration,
    });
    const result = await review.review({ diff: "benign", files: [] });
    expect(result.lane).toBe("MERGE");
    expect(result.judged?.checks["c1"]?.p).toBe(0.01);
  });

  it("refuses a partial answer set (UNAVAILABLE, never MERGE)", async () => {
    const model = {
      async evaluate() {
        return { answers: {} };
      },
    };
    const review = new ReviewService(model as never, {
      checks: (CHECKS.checks as unknown as import("../../src/review/questions.js").CheckDef[]),
      policy: POLICY(),
      status: "ready",
      expectedCalibration: { backend: "typesafe", model: "jev-1.14.0" },
    });
    const result = await review.review({ diff: "benign", files: [] });
    expect(result.lane).toBe("UNAVAILABLE");
    expect(result.findings[0]?.id).toBe("review:model-error");
  });

  it("refuses an out-of-range probability (UNAVAILABLE, never MERGE)", async () => {
    const model = {
      async evaluate() {
        return { answers: { c1: { type: "noul", noul: 1.5 } } };
      },
    };
    const review = new ReviewService(model as never, {
      checks: (CHECKS.checks as unknown as import("../../src/review/questions.js").CheckDef[]),
      policy: POLICY(),
      status: "ready",
      expectedCalibration: { backend: "typesafe", model: "jev-1.14.0" },
    });
    const result = await review.review({ diff: "benign", files: [] });
    expect(result.lane).toBe("UNAVAILABLE");
  });
});
