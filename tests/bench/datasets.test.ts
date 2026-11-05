import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCalibrationDataset } from "../../src/jev/calibration.js";
import { MISSION_CLOSURE_QUESTION } from "../../src/mission/closure.js";
import { STOP_QUESTIONS } from "../../src/hooks/handlers/stop.js";
import { nextStepRequest } from "../../src/tools/next-step.js";

const dir = join(import.meta.dirname, "..", "..", "bench", "datasets");

function load(name: string): string {
  return readFileSync(join(dir, name), "utf8");
}

describe("focused calibration datasets", () => {
  const files = [
    "mission-completion-v1.jsonl",
    "corrective-action-v1.jsonl",
    "stop-intervention-v1.jsonl",
    "adversarial-review-v1.jsonl",
  ];
  const minimums: Record<string, number> = {
    "mission-completion-v1.jsonl": 50,
    "corrective-action-v1.jsonl": 50,
    "stop-intervention-v1.jsonl": 50,
    "adversarial-review-v1.jsonl": 50,
  };
  const heldoutMinimums: Record<string, number> = {
    "mission-completion-v1.jsonl": 11,
    "corrective-action-v1.jsonl": 11,
    "stop-intervention-v1.jsonl": 11,
    "adversarial-review-v1.jsonl": 26,
  };
  for (const file of files) {
    it(`${file} parses and carries its full case load`, () => {
      const cases = parseCalibrationDataset(load(file));
      expect(cases.length).toBeGreaterThanOrEqual(minimums[file] ?? 10);
      expect(cases.filter((c) => c.id.startsWith("heldout-")).length).toBeGreaterThanOrEqual(
        heldoutMinimums[file] ?? 0,
      );
    });
  }

  it("completion covers all four dispositions including hard negatives", () => {
    const cases = parseCalibrationDataset(load("mission-completion-v1.jsonl"));
    const choices = new Set(cases.map((c) => (c.expected.closure as { choice: string }).choice));
    expect(choices).toEqual(new Set(["COMPLETE", "INCOMPLETE", "BLOCKED", "INSUFFICIENT_EVIDENCE"]));
    const ids = cases.map((c) => c.id);
    for (const hard of ["stale-test-after-edit", "test-on-unrelated-candidate", "confidence-only-claim", "conflicting-claim-vs-ledger", "forged-verifier-receipt", "receipt-predates-reissue", "duplicate-complete-after-complete"]) {
      expect(ids).toContain(hard);
    }
  });

  it("reproduces the standalone heldout completion dataset from the canonical set", () => {
    const canonical = load("mission-completion-v1.jsonl");
    const heldout = load("heldout-mission-completion.jsonl");
    const heldoutLines = canonical
      .trimEnd()
      .split("\n")
      .filter((line) => (JSON.parse(line) as { id: string }).id.startsWith("heldout-"));
    expect(heldoutLines).toHaveLength(11);
    expect(`${heldoutLines.join("\n")}\n`).toBe(heldout);
  });

  it("emits disjoint development and validation files that cover each calibration pool", () => {
    const splits = [
      ["mission-completion-v1.jsonl", "development-mission-completion-v1.jsonl", "heldout-mission-completion.jsonl", 39, 11],
      ["corrective-action-v1.jsonl", "development-corrective-action-v1.jsonl", "heldout-corrective-action.jsonl", 39, 11],
      ["stop-intervention-v1.jsonl", "development-stop-intervention-v1.jsonl", "heldout-stop-intervention.jsonl", 39, 11],
      ["adversarial-review-v1.jsonl", "development-adversarial-review-v1.jsonl", "heldout-adversarial-review.jsonl", 24, 26],
    ] as const;
    for (const [poolName, developmentName, validationName, expectedDevelopment, expectedValidation] of splits) {
      const cases = (name: string) => parseCalibrationDataset(load(name));
      const pool = cases(poolName);
      const development = cases(developmentName);
      const validation = cases(validationName);
      const developmentIds = development.map((item) => item.id);
      const validationIds = validation.map((item) => item.id);
      expect(developmentIds.every((id) => !id.startsWith("heldout-")), developmentName).toBe(true);
      expect(validationIds.every((id) => id.startsWith("heldout-")), validationName).toBe(true);
      expect(development).toHaveLength(expectedDevelopment);
      expect(validation).toHaveLength(expectedValidation);
      expect(developmentIds.filter((id) => validationIds.includes(id))).toEqual([]);
      expect([...development, ...validation].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        pool.sort((a, b) => a.id.localeCompare(b.id)),
      );
    }
  });

  it("keeps adversarial prompts unique across the pool and its held-out split", () => {
    const promptKey = (item: { state: unknown; questions: unknown }) =>
      JSON.stringify([item.state, item.questions]);
    const pool = parseCalibrationDataset(load("adversarial-review-v1.jsonl"));
    const development = parseCalibrationDataset(load("development-adversarial-review-v1.jsonl"));
    const validation = parseCalibrationDataset(load("heldout-adversarial-review.jsonl"));
    const poolPrompts = pool.map(promptKey);
    const developmentPrompts = new Set(development.map(promptKey));

    expect(new Set(poolPrompts).size).toBe(pool.length);
    expect(validation.map(promptKey).filter((prompt) => developmentPrompts.has(prompt))).toEqual([]);
    expect((pool.find((item) => item.id === "mixed-gap-unknown")?.expected.gap_docs as { choice: string }))
      .toEqual({ choice: "NO_GAP" });
  });

  it("corrective action covers all five choices", () => {
    const cases = parseCalibrationDataset(load("corrective-action-v1.jsonl"));
    const choices = new Set(cases.map((c) => (c.expected.next as { choice: string } | undefined)?.choice).filter(Boolean));
    expect(choices).toEqual(new Set(["continue", "retry", "change_approach", "ask_user", "done"]));
  });

  it("stop intervention labels both genuine admissions and offers", () => {
    const cases = parseCalibrationDataset(load("stop-intervention-v1.jsonl"));
    const labels = cases.flatMap((c) =>
      ["says_part_not_done", "says_step_deferred", "says_check_failing", "asks_user"].map(
        (qid) => (c.expected[qid] as { label: boolean }).label,
      ),
    );
    expect(labels).toContain(true);
    expect(labels).toContain(false);
    const ids = cases.map((c) => c.id);
    expect(ids.filter((id) => id.startsWith("offer-")).length).toBeGreaterThanOrEqual(9);
  });

  it("adversarial review covers gap, no-gap, and unknown", () => {
    const cases = parseCalibrationDataset(load("adversarial-review-v1.jsonl"));
    const gaps = new Set(cases.map((c) => (c.expected.gap as { choice: string }).choice));
    expect(gaps).toEqual(new Set(["SUPPORTED_GAP", "NO_GAP_FOUND", "UNKNOWN"]));
  });

  it("completion fixtures match the production Jev A request shape", () => {
    const cases = parseCalibrationDataset(load("mission-completion-v1.jsonl"));
    for (const c of cases) {
      const state = c.state as Record<string, unknown>;
      const expectedKeys = [
        "acceptanceCriteria",
        "blockers",
        "evidenceRevision",
        "missionRevision",
        "objective",
        "operations",
        "tests",
      ].concat(Object.hasOwn(state, "graphRuns") ? ["graphRuns"] : []);
      expect(Object.keys(state).sort()).toEqual(expectedKeys.sort());
      expect(Object.keys(state)).not.toContain("verifiedOutcomes");
      expect(Object.keys(c.questions)).toEqual(["closure"]);
      expect(c.questions.closure).toEqual(MISSION_CLOSURE_QUESTION);
      expect(Object.keys(c.expected)).toEqual(["closure"]);
      // Production Jev A state carries only the verifiable outcome surface —
      // no `verified` flags and no revision fields. Revision binding stays a
      // deterministic preflight concern, never model-judged text.
      for (const criterion of (state.acceptanceCriteria as Array<Record<string, unknown>>)) {
        expect(Object.keys(criterion).sort()).toEqual(
          ["id", "statement"].concat(
            criterion.outcome === undefined ? [] : ["outcome"],
            criterion.evidenceRef === undefined ? [] : ["evidenceRef"],
          ).sort(),
        );
      }
    }
  });

  it("stop fixtures match the production seven-question request shape", () => {
    const cases = parseCalibrationDataset(load("stop-intervention-v1.jsonl"));
    const productionKeys = Object.keys(STOP_QUESTIONS).sort();
    expect(productionKeys).toEqual(
      ["addresses_request", "asks_user", "claims_complete", "claims_verified", "says_check_failing", "says_part_not_done", "says_step_deferred"],
    );
    for (const c of cases) {
      const state = c.state as Record<string, unknown>;
      expect(Object.keys(state).sort()).toEqual(["final_message", "request"]);
      const request = state.request as Record<string, unknown>;
      expect(Object.keys(request).sort()).toEqual(["latest", "previous"]);
      expect(Object.keys(c.questions).sort()).toEqual(productionKeys);
      expect(c.questions).toEqual(STOP_QUESTIONS);
      expect(Object.keys(c.expected).sort()).toEqual(productionKeys);
    }
    const ids = cases.map((c) => c.id);
    expect(ids).not.toContain("defer-perf-pass");
    expect(ids).toContain("offer-perf-pass");
  });

  it("corrective fixtures match the production five-question request shape", () => {
    const cases = parseCalibrationDataset(load("corrective-action-v1.jsonl"));
    const productionKeys = Object.keys(nextStepRequest({ goal: "g", last_step: "s", result: "r" }).questions).sort();
    expect(productionKeys).toEqual(
      ["error_is_transient", "goal_complete", "next", "result_relevant", "step_succeeded"],
    );
    for (const c of cases) {
      const state = c.state as Record<string, unknown>;
      const productionRequest = nextStepRequest(state as { goal: string; last_step: string; result: string });
      expect(Object.keys(state).sort()).toEqual(["goal", "last_step", "result"]);
      expect(state).toEqual(productionRequest.state);
      expect(Object.keys(c.questions).sort()).toEqual(productionKeys);
      expect(c.questions).toEqual(productionRequest.questions);
      expect(Object.keys(c.expected).sort()).toEqual(productionKeys);
    }
  });

  it("adversarial fixtures match the production Jev B request shape", () => {
    const cases = parseCalibrationDataset(load("adversarial-review-v1.jsonl"));
    for (const c of cases) {
      const state = c.state as Record<string, unknown>;
      const expectedKeys = [
        "acceptanceCriteria",
        "blockers",
        "evidenceRevision",
        "missionRevision",
        "objective",
        "operations",
        "tests",
      ].concat(Object.hasOwn(state, "graphRuns") ? ["graphRuns"] : []);
      expect(Object.keys(state).sort()).toEqual(expectedKeys.sort());
      for (const criterion of (state.acceptanceCriteria as Array<Record<string, unknown>>)) {
        expect(criterion).toHaveProperty("verified");
      }
      const criteria = state.acceptanceCriteria as Array<{ id: string }>;
      expect(Object.keys(c.questions).sort()).toEqual(
        ["gap", ...criteria.map((item) => `gap_${item.id}`)].sort(),
      );
      expect(Object.keys(c.expected).sort()).toEqual(Object.keys(c.questions).sort());
    }
  });
});
