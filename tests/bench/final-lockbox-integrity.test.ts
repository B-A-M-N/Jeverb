import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCalibrationDataset } from "../../src/jev/calibration.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const datasetsDir = join(root, "bench", "datasets");

function load(name: string): string {
  return readFileSync(join(datasetsDir, name), "utf8");
}

function labels(name: string): Record<string, { category: string; rationale: string; expected: string; preflight: string }> {
  return JSON.parse(load(name)) as Record<string, { category: string; rationale: string; expected: string; preflight: string }>;
}

describe("final lockbox integrity (offline: no model, no network)", () => {
  it("dev and validation sets parse with balanced, labeled coverage", () => {
    for (const base of ["mission-completion-dev-v3", "mission-completion-validation-v3"]) {
      const cases = parseCalibrationDataset(load(`${base}.jsonl`));
      expect(cases.length).toBe(32);
      const byLabel = new Map<string, number>();
      for (const c of cases) byLabel.set(c.expected.closure?.choice ?? "?", (byLabel.get(c.expected.closure?.choice ?? "?") ?? 0) + 1);
      expect(byLabel.get("COMPLETE")).toBe(12);
      expect(cases.length - (byLabel.get("COMPLETE") ?? 0)).toBe(20);
      const lab = labels(`${base}.labels.json`);
      expect(Object.keys(lab).sort()).toEqual(cases.map((c) => c.id).sort());
    }
  });

  it("sealed final lockbox meets the 60/149 population floor with full label coverage", () => {
    const cases = parseCalibrationDataset(load("mission-completion-lockbox-v3.jsonl"));
    const positives = cases.filter((c) => c.expected.closure?.choice === "COMPLETE");
    const negatives = cases.filter((c) => c.expected.closure?.choice !== "COMPLETE");
    expect(cases.length).toBe(217);
    expect(positives.length).toBe(64);
    expect(negatives.length).toBe(153);
    expect(positives.length).toBeGreaterThanOrEqual(60);
    expect(negatives.length).toBeGreaterThanOrEqual(149);
    const lab = labels("mission-completion-lockbox-v3.labels.json");
    expect(Object.keys(lab).sort()).toEqual(cases.map((c) => c.id).sort());
    const categories = new Map<string, number>();
    for (const entry of Object.values(lab)) categories.set(entry.category, (categories.get(entry.category) ?? 0) + 1);
    for (const required of [
      "full-complete", "unresolved-blocker", "pending-operations", "uncertain-operations",
      "missing-evidence-ref", "missing-outcome", "tests-failed", "tests-not-independent",
      "tests-ref-missing", "empty-objective", "duplicate-criterion-ids", "narrow-outcome",
      "contradictory-outcome", "missing-scope", "vague-outcome", "ambiguous-outcome",
      "contradictory-pair", "stale-build", "pending-item",
    ]) {
      expect(categories.get(required), `category ${required}`).toBeGreaterThan(0);
    }
    expect(categories.get("full-complete")).toBe(64);
  });

  it("all three new splits are id-disjoint from each other and from v1/v2/dev-v1/heldout", () => {
    const seen = new Map<string, string>();
    const check = (file: string, split: string): void => {
      for (const c of parseCalibrationDataset(load(file))) {
        expect(seen.has(c.id), `${split}: duplicate id ${c.id} (first in ${seen.get(c.id)})`).toBe(false);
        seen.set(c.id, split);
      }
    };
    check("mission-completion-lockbox-v1.jsonl", "v1");
    check("mission-completion-lockbox-v2.jsonl", "v2");
    check("development-mission-completion-v1.jsonl", "dev-v1");
    check("heldout-mission-completion.jsonl", "heldout");
    check("mission-completion-dev-v3.jsonl", "dev-v3");
    check("mission-completion-validation-v3.jsonl", "validation-v3");
    check("mission-completion-lockbox-v3.jsonl", "lockbox-v3");
  });

  it("freeze record matches the dataset bytes on disk", async () => {
    const { createHash } = await import("node:crypto");
    const freeze = JSON.parse(load("mission-completion-lockbox-v3.freeze.json")) as {
      files: Record<string, string>;
      counts: { final: { cases: number; positives: number; negatives: number } };
    };
    for (const [file, hash] of Object.entries(freeze.files)) {
      if (file.endsWith(".freeze.json")) continue;
      const actual = createHash("sha256").update(load(file), "utf8").digest("hex");
      expect(actual, file).toBe(hash);
    }
    expect(freeze.counts.final.cases).toBe(217);
    expect(freeze.counts.final.positives).toBe(64);
    expect(freeze.counts.final.negatives).toBe(153);
  });
});
