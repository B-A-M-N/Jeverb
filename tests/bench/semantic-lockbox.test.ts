import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCalibrationDataset } from "../../src/jev/calibration.js";
import { lockboxEvidence, lockboxLegacyEvidence, lockboxPolicy } from "../../src/jev/lockbox.js";
import {
  MISSION_CLOSURE_CHOICES,
  preflightMissionClosure,
  preflightReachedReview,
} from "../../src/mission/closure.js";

const dir = join(import.meta.dirname, "..", "..", "bench", "datasets");

/**
 * The semantic-veto lockbox (v2) is historical narrative evidence. The
 * current production boundary requires host-owned objective coverage and
 * verifier receipts that these legacy rows do not contain, so they must
 * stop before semantic review. This pins the artifact and that fail-closed
 * behavior; it does not qualify the historical cases for current release.
 */
describe("semantic-veto lockbox v2", () => {
  const cases = parseCalibrationDataset(
    readFileSync(join(dir, "mission-completion-lockbox-v2.jsonl"), "utf8"),
  );
  const labels = JSON.parse(
    readFileSync(join(dir, "mission-completion-lockbox-v2.labels.json"), "utf8"),
  ) as Record<string, { category: string; rationale: string; expected: string }>;

  const policy = lockboxPolicy(cases[0]!.questions, {
    policyVersion: "mission-closure/1",
    minConfidence: 0.9,
    backend: "jev-gateway",
    model: "dataset-check",
    modelVersion: "dataset-check",
  });

  it("carries 20 labeled cases across the veto families", () => {
    expect(cases.length).toBe(20);
    expect(Object.keys(labels).length).toBe(20);
    const byLabel = new Map<string, number>();
    for (const c of cases) {
      const expected = c.expected.closure?.choice;
      expect((MISSION_CLOSURE_CHOICES as readonly string[]).includes(expected ?? "")).toBe(true);
      expect(labels[c.id]?.expected).toBe(expected);
      expect(labels[c.id]?.rationale.length).toBeGreaterThan(0);
      byLabel.set(expected!, (byLabel.get(expected!) ?? 0) + 1);
    }
    expect(byLabel.get("COMPLETE")).toBe(4);
    expect(byLabel.get("INCOMPLETE")).toBe(12);
    expect(byLabel.get("INSUFFICIENT_EVIDENCE")).toBe(4);
  });

  it("uses fresh mission ids disjoint from the v1 lockbox", () => {
    const v1 = parseCalibrationDataset(
      readFileSync(join(dir, "mission-completion-lockbox-v1.jsonl"), "utf8"),
    );
    const v1ids = new Set(v1.map((c) => c.id));
    for (const c of cases) {
      expect(c.id.startsWith("lockbox2-")).toBe(true);
      expect(v1ids.has(c.id)).toBe(false);
    }
  });

  it("emits no duplicate model-visible prompts", () => {
    const prompts = new Set<string>();
    for (const c of cases) {
      const prompt = JSON.stringify([c.state, c.questions]);
      expect(prompts.has(prompt)).toBe(false);
      prompts.add(prompt);
    }
  });

  it("keeps legacy narrative cases out of semantic review", () => {
    for (const c of cases) {
      const evidence = lockboxLegacyEvidence(c.id, c.state);
      const preflight = preflightMissionClosure(evidence, policy);
      expect(preflightReachedReview(preflight)).toBe(false);
      expect(preflight.reasons[0]).toMatch(/objective coverage attestation is missing or stale/);
    }
  });

  it("does not treat benchmark prose or reference strings as verified host outcomes", () => {
    const c = cases.find((item) => item.expected.closure?.choice === "COMPLETE")!;
    const evidence = lockboxEvidence(c.id, c.state);
    expect(evidence.criteria.every((criterion) => criterion.verified === false)).toBe(true);
    expect(evidence.requestProfile).toBeUndefined();
  });
});
