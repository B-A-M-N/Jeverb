import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitRoutingQualification,
  CONSEQUENTIAL_ROUTING_RELEASE_POLICY,
  consequentialRoutingFloorSatisfied,
  questionSetHashFor,
  verifyQualificationManifest,
  type QualificationActiveIdentity,
  type QualificationManifest,
} from "../../src/jev/qualification.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

const QUESTION_HASH = "e".repeat(64);
const QUESTION_SET_HASH = questionSetHashFor([QUESTION_HASH]);
const POLICY_HASH = "f".repeat(64);
const THRESHOLDS = { minAccuracy: 0.9, minCases: 60 };

const fixtureDirectories: string[] = [];
afterEach(() => {
  for (const dir of fixtureDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function caseRow(id: string): string {
  return JSON.stringify({
    id,
    state: { objective: `route ${id}` },
    questions: {
      route: {
        type: "choice",
        instructions: "Choose the route.",
        criteria: { local: "stay local", remote: "go remote" },
      },
    },
    expected: { route: { choice: "local" } },
  });
}

function receiptRow(datasetHash: string, id: string, choice: string): string {
  return JSON.stringify({
    case: id,
    question: "route",
    model: "route-model",
    modelVersion: "route-v1",
    adapterVersion: "adapter/1",
    provider: "route-backend",
    questionHash: QUESTION_HASH,
    dataset: datasetHash,
    answer: { type: "choice", choice },
    inRange: choice === "local",
    latency_ms: 5,
  });
}

function setup(options: { cases: number; wrong: number }): {
  datasetPath: string; developmentDatasetPath: string; validationDatasetPath: string; receiptsPath: string;
  datasetHash: string; developmentDatasetHash: string; validationDatasetHash: string; evaluationHash: string;
  correct: number;
} {
  const dir = mkdtempSync(join(tmpdir(), "jev-qualify-routing-"));
  fixtureDirectories.push(dir);
  const ids = Array.from({ length: options.cases }, (_, i) => `route-case-${i}`);
  const dataset = `${ids.map(caseRow).join("\n")}\n`;
  const development = `${caseRow("development-only")}\n`;
  const validation = `${caseRow("validation-only")}\n`;
  const datasetHash = sha(dataset);
  const receipts =
    `${ids.map((id, i) => receiptRow(datasetHash, id, i < options.wrong ? "remote" : "local")).join("\n")}\n`;
  const datasetPath = join(dir, "bench.jsonl");
  const developmentDatasetPath = join(dir, "development.jsonl");
  const validationDatasetPath = join(dir, "validation.jsonl");
  const receiptsPath = join(dir, "receipts.jsonl");
  writeFileSync(datasetPath, dataset);
  writeFileSync(developmentDatasetPath, development);
  writeFileSync(validationDatasetPath, validation);
  writeFileSync(receiptsPath, receipts);
  return {
    datasetPath, developmentDatasetPath, validationDatasetPath, receiptsPath,
    datasetHash, developmentDatasetHash: sha(development),
    validationDatasetHash: sha(validation), evaluationHash: sha(receipts),
    correct: options.cases - options.wrong,
  };
}

function manifestFor(
  fixture: { datasetHash: string; developmentDatasetHash: string; validationDatasetHash: string; evaluationHash: string },
  correct: number,
  total: number,
  overrides: Partial<QualificationManifest> = {},
): QualificationManifest {
  return {
    family: "consequential-routing",
    backend: "route-backend",
    model: "route-model",
    modelVersion: "route-v1",
    adapterVersion: "adapter/1",
    questionSetHash: QUESTION_SET_HASH,
    policyHash: POLICY_HASH,
    datasetHash: fixture.datasetHash,
    developmentDatasetHash: fixture.developmentDatasetHash,
    validationDatasetHash: fixture.validationDatasetHash,
    evaluationHash: fixture.evaluationHash,
    datasetSplit: "lockbox",
    expectedJudgments: total,
    correctJudgments: correct,
    invalidJudgments: 0,
    thresholds: { ...THRESHOLDS },
    calibratedAt: new Date().toISOString(),
    decision: "qualified",
    ...overrides,
  };
}

function active(thresholds: Record<string, number> = { ...THRESHOLDS }): QualificationActiveIdentity {
  return {
    backend: "route-backend",
    model: "route-model",
    modelVersion: "route-v1",
    adapterVersion: "adapter/1",
    questionSetHash: QUESTION_SET_HASH,
    policyHash: POLICY_HASH,
    thresholds,
  };
}

describe("consequential-routing release criteria are explicit and measured", () => {
  it("authorizes a qualified lockbox manifest meeting the release floor", () => {
    const fixture = setup({ cases: 60, wrong: 0 });
    const manifest = manifestFor(fixture, 60, 60);
    const verification = verifyQualificationManifest(manifest, fixture, active());
    expect(verification.ok).toBe(true);
    expect(verification.authorizes).toBe(true);
    expect(verification.reasons.join("; ")).toMatch(/routing judgment accuracy 60\/60/);
    const admitted = admitRoutingQualification(manifest, verification);
    expect(admitted).toMatchObject({
      verified: true,
      family: "consequential-routing",
      backend: "route-backend",
      modelVersion: "route-v1",
      questionFamily: QUESTION_SET_HASH,
      policyHash: POLICY_HASH,
      qualified: true,
    });
    expect(typeof admitted?.qualificationId).toBe("string");
  });

  it("refuses to authorize below-threshold routing accuracy", () => {
    const fixture = setup({ cases: 60, wrong: 10 });
    const manifest = manifestFor(fixture, 50, 60);
    const verification = verifyQualificationManifest(manifest, fixture, active());
    expect(verification.ok).toBe(true);
    expect(verification.authorizes).toBe(false);
    expect(verification.reasons.join("; ")).toMatch(/83\.33%/);
    expect(admitRoutingQualification(manifest, verification)).toBeUndefined();
  });

  it("rejects a qualified decision measured against weakened bars (floor, not gate)", () => {
    const weak = { minAccuracy: 0.5, minCases: 10 };
    const fixture = setup({ cases: 60, wrong: 0 });
    const manifest = manifestFor(fixture, 60, 60, { thresholds: weak, decision: "qualified" });
    const verification = verifyQualificationManifest(manifest, fixture, active(weak));
    expect(verification.ok).toBe(false);
    expect(verification.authorizes).toBe(false);
    expect(verification.reasons.join("; ")).toMatch(/release policy floor/);
    expect(admitRoutingQualification(manifest, verification)).toBeUndefined();
  });

  it("requires explicit thresholds with no silent defaults", () => {
    const fixture = setup({ cases: 60, wrong: 0 });
    const manifest = manifestFor(fixture, 60, 60, { thresholds: {} });
    const verification = verifyQualificationManifest(manifest, fixture, active({}));
    // A qualified decision with no bars at all is rejected outright by the
    // floor — there is nothing weaker for the gate to merely fail.
    expect(verification.ok).toBe(false);
    expect(verification.authorizes).toBe(false);
    expect(verification.reasons.join("; ")).toMatch(/release policy floor/);
  });

  it("never brands mission-closure qualification as routing admission", () => {
    const fixture = setup({ cases: 60, wrong: 0 });
    const manifest = manifestFor(fixture, 60, 60, { family: "mission-closure" });
    const verification = verifyQualificationManifest(manifest, fixture, active());
    expect(verification.authorizes).toBe(false);
    expect(admitRoutingQualification(manifest, verification)).toBeUndefined();
  });

  it("never brands rejected or unmeasured decisions", () => {
    const fixture = setup({ cases: 60, wrong: 0 });
    const rejected = manifestFor(fixture, 60, 60, { decision: "rejected" });
    const rejectedVerification = verifyQualificationManifest(rejected, fixture, active());
    expect(rejectedVerification.authorizes).toBe(false);
    expect(admitRoutingQualification(rejected, rejectedVerification)).toBeUndefined();
  });

  it("reports missing thresholds at the gate for non-qualified records", () => {
    const fixture = setup({ cases: 60, wrong: 0 });
    const manifest = manifestFor(fixture, 60, 60, { thresholds: {}, decision: "rejected" });
    const verification = verifyQualificationManifest(manifest, fixture, active({}));
    expect(verification.ok).toBe(true);
    expect(verification.authorizes).toBe(false);
    expect(verification.reasons.join("; ")).toMatch(/no defaults are approved/);
  });
});

describe("consequential-routing release floor", () => {
  it("matches the documented operator floor and only strengthens", () => {
    expect({ ...CONSEQUENTIAL_ROUTING_RELEASE_POLICY }).toEqual({ minAccuracy: 0.9, minCases: 60 });
    expect(consequentialRoutingFloorSatisfied({ minAccuracy: 0.95, minCases: 149 }).ok).toBe(true);
    expect(consequentialRoutingFloorSatisfied({ minAccuracy: 0.9, minCases: 60 }).ok).toBe(true);
    const weakened = consequentialRoutingFloorSatisfied({ minAccuracy: 0.89, minCases: 59 });
    expect(weakened.ok).toBe(false);
    expect(weakened.reasons).toHaveLength(2);
  });
});
