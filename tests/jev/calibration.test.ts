import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calibrationFailure, noulCalibrationMetrics, parseCalibrationDataset } from "../../src/jev/calibration.js";
import { JevValidationError } from "../../src/jev/errors.js";
import { PROMPT_CLASSIFICATION_QUESTIONS } from "../../src/hooks/handlers/user-prompt-submit.js";

const dataset = JSON.stringify({
  id: "simple",
  state: { diff: "+ x" },
  questions: { risk: { type: "noul", instructions: "Risk?" } },
  expected: { risk: { noul: [0.6, 1], label: true } },
});

describe("Jev calibration dataset and probability metrics", () => {
  it("keeps provider response text and credentials out of failure receipts", () => {
    const result = calibrationFailure(new JevValidationError("provider echoed sk-test-secret", { status: 422 }));
    expect(result).toEqual({ type: "JevValidationError", status: 422 });
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
  });

  it("validates the committed calibration corpus before provider calls", () => {
    const contents = readFileSync(new URL("../../bench/datasets/jev-calib-v1.jsonl", import.meta.url), "utf8");
    expect(parseCalibrationDataset(contents)).toHaveLength(8);
  });

  it("keeps prompt-routing benchmark questions pinned to the live hook and covers every label", () => {
    const contents = readFileSync(new URL("../../bench/datasets/prompt-routing-v1.jsonl", import.meta.url), "utf8");
    const cases = parseCalibrationDataset(contents);
    const classCounts = new Map<string, number>();
    const ambiguityLevels = new Set<number>();
    for (const item of cases) {
      expect(item.questions).toEqual(PROMPT_CLASSIFICATION_QUESTIONS);
      const kind = item.expected.kind?.choice;
      expect(kind).toBeDefined();
      classCounts.set(kind!, (classCounts.get(kind!) ?? 0) + 1);
      const scoreRange = item.expected.ambiguity?.score;
      expect(scoreRange).toBeDefined();
      for (let level = scoreRange![0]; level <= scoreRange![1]; level += 1) ambiguityLevels.add(level);
    }
    expect(cases).toHaveLength(16);
    const kindQuestion = PROMPT_CLASSIFICATION_QUESTIONS.kind;
    expect(kindQuestion?.type).toBe("choice");
    expect([...classCounts.keys()].sort()).toEqual(Object.keys((kindQuestion as { criteria: Record<string, string> }).criteria).sort());
    expect([...classCounts.values()].every((count) => count === 2)).toBe(true);
    expect([...ambiguityLevels].sort()).toEqual([0, 1, 2]);
  });

  it("rejects malformed targets and duplicate case identities", () => {
    expect(() => parseCalibrationDataset(`${dataset}\n${dataset}`)).toThrow(/duplicate case id/);
    expect(() => parseCalibrationDataset(JSON.stringify({
      id: "bad",
      state: {},
      questions: { risk: { type: "noul", instructions: "Risk?" } },
      expected: { risk: { noul: [0.8, 0.2] } },
    }))).toThrow(/finite, ordered/);
    expect(() => parseCalibrationDataset(JSON.stringify({
      id: "bad-choice",
      state: {},
      questions: { lane: { type: "choice", instructions: "Lane?", criteria: { MERGE: "safe" } } },
      expected: { lane: { choice: "BLOCK" } },
    }))).toThrow(/valid choice option/);
    expect(() => parseCalibrationDataset(JSON.stringify({
      id: "short-score",
      state: {},
      questions: { rating: { type: "score", instructions: "Rate", criteria: ["low"] } },
      expected: { rating: { score: [0, 0] } },
    }))).toThrow(/invalid criteria/);
  });

  it("preserves prototype-looking question ids as ordinary data", () => {
    const questions = JSON.parse('{"__proto__":{"type":"noul","instructions":"Risk?"}}');
    const expected = JSON.parse('{"__proto__":{"noul":[0,1],"label":true}}');
    const parsed = parseCalibrationDataset(JSON.stringify({ id: "prototype-key", state: {}, questions, expected }));
    expect(Object.hasOwn(parsed[0]!.expected, "__proto__")).toBe(true);
    expect(parsed[0]!.expected["__proto__"]).toEqual({ noul: [0, 1], label: true });
  });

  it("reports proper scores and empirical reliability separately from classification accuracy", () => {
    const metrics = noulCalibrationMetrics([
      { p: 0.9, label: true },
      { p: 0.8, label: false },
      { p: 0.2, label: false },
      { p: 0.1, label: true },
    ]);
    expect(metrics.count).toBe(4);
    expect(metrics.brier).toBeCloseTo(0.375, 8);
    expect(metrics.ece).toBeCloseTo(0.5, 8);
    expect(metrics.logLoss).toBeGreaterThan(0);
    expect(metrics.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(4);
  });

  it("handles empty calibration labels explicitly", () => {
    expect(noulCalibrationMetrics([])).toEqual({ count: 0, brier: null, logLoss: null, ece: null, bins: [] });
  });
});
