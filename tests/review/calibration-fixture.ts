import { hashReviewChecks } from "../../src/review/load-config.js";

/** Complete synthetic binding for tests that intentionally exercise inference. */
export function calibratedReviewFixture(checks: unknown[]) {
  const questionHash = hashReviewChecks(checks as never);
  const manifest = {
    modelVersion: "jev-1.14.0+build.2",
    calibrationVersion: "test-bench-v1",
    datasetRevision: "fixture-dataset-v1",
    evaluationHash: "a".repeat(64),
  };
  return {
    policy: {
      policy_version: "1",
      thresholds: { block: 0.85, security_review: 0.6 },
      provenance: {
        backend: "typesafe",
        model: "jev-1.14.0",
        calibrated: true,
        questionHash,
        ...manifest,
      },
    },
    expectedCalibration: {
      backend: "typesafe",
      model: "jev-1.14.0",
      questionHash,
      ...manifest,
    },
  };
}
