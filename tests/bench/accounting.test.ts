import { describe, expect, it } from "vitest";
import {
  calibrationFailure,
  summarizeCalibration,
  type CalibrationCase,
  type CalibrationJudgmentRow,
} from "../../src/jev/calibration.js";
import { JevValidationError } from "../../src/jev/errors.js";

const choiceQ = (labels: string[]) => ({
  type: "choice" as const,
  instructions: "pick one",
  criteria: Object.fromEntries(labels.map((label) => [label, `${label} outcome`])),
});

function choiceCase(id: string, labels: string[], expected: string): CalibrationCase {
  return {
    id,
    state: {},
    questions: { verdict: choiceQ(labels) },
    expected: { verdict: { choice: expected } },
  };
}

describe("inclusive calibration accounting", () => {
  it("counts every expected question of a failed three-question case as a failure", () => {
    const labels = ["COMPLETE", "INCOMPLETE", "BLOCKED"];
    const cases: CalibrationCase[] = [
      {
        id: "failed-trio",
        state: {},
        questions: { a: choiceQ(labels), b: choiceQ(labels), c: choiceQ(labels) },
        expected: { a: { choice: "COMPLETE" }, b: { choice: "INCOMPLETE" }, c: { choice: "BLOCKED" } },
      },
    ];
    const rows: CalibrationJudgmentRow[] = ["a", "b", "c"].map((question) => ({
      case: "failed-trio",
      question,
      expected: cases[0]!.expected[question],
      inRange: false,
      error: "JevValidationError",
      code: "EMPTY_CONTENT",
    }));
    rows.push({ case: "failed-trio", question: "", caseError: true, error: "JevValidationError", code: "EMPTY_CONTENT" });

    const summary = summarizeCalibration(cases, rows);
    expect(summary.expectedAnswers).toBe(3);
    expect(summary.answerable).toBe(0);
    expect(summary.inRange).toBe(0);
    expect(summary.accuracy).toBe(0);
    expect(summary.answeredAccuracy).toBeNull();
    expect(summary.cases).toBe(1);
    expect(summary.successfulCases).toBe(0);
    expect(summary.failedCases).toBe(1);
    expect(summary.invalidJudgments).toBe(3);
    expect(summary.caseExactMatchRate).toBe(0);
    expect(summary.systemDecisionAccuracy).toBeNull();
    expect(summary.failuresByCode).toEqual({ "JevValidationError:EMPTY_CONTENT": 3 });
    for (const qid of ["a", "b", "c"]) {
      const actual = cases[0]!.expected[qid]!.choice!;
      expect(summary.confusion[qid]!.matrix[actual]!.__invalid__).toBe(1);
    }
  });

  it("keeps inclusive accuracy below answered accuracy when failures exist", () => {
    const cases = [choiceCase("good", ["COMPLETE", "INCOMPLETE"], "COMPLETE"), choiceCase("bad", ["COMPLETE", "INCOMPLETE"], "INCOMPLETE")];
    const rows: CalibrationJudgmentRow[] = [
      { case: "good", question: "verdict", answer: { type: "choice", choice: "COMPLETE" }, expected: { choice: "COMPLETE" }, inRange: true },
      { case: "bad", question: "verdict", expected: { choice: "INCOMPLETE" }, inRange: false, error: "JevTimeoutError" },
      { case: "bad", question: "", caseError: true, error: "JevTimeoutError" },
    ];
    const summary = summarizeCalibration(cases, rows);
    expect(summary.accuracy).toBe(0.5);
    expect(summary.answeredAccuracy).toBe(1);
    expect(summary.systemDecisionAccuracy).toBeNull();
    expect(summary.caseExactMatchRate).toBe(0.5);
    expect(summary.confusion.verdict!.perClass.INCOMPLETE!.recall).toBe(0);
    expect(summary.confusion.verdict!.perClass.COMPLETE!.precision).toBe(1);
  });

  it("computes system decision accuracy on the primary closure question", () => {
    const cases = [choiceCase("done", ["COMPLETE", "INCOMPLETE"], "COMPLETE")];
    cases[0]!.questions = { closure: choiceQ(["COMPLETE", "INCOMPLETE"]) };
    cases[0]!.expected = { closure: { choice: "COMPLETE" } };
    const rows: CalibrationJudgmentRow[] = [
      { case: "done", question: "closure", answer: { type: "choice", choice: "COMPLETE" }, expected: { choice: "COMPLETE" }, inRange: true },
    ];
    const summary = summarizeCalibration(cases, rows);
    expect(summary.systemDecisionQuestion).toBe("closure");
    expect(summary.systemDecisionAccuracy).toBe(1);
    expect(summary.caseExactMatchRate).toBe(1);
  });
});

describe("calibration failure diagnostics", () => {
  it("preserves the machine-readable code and sanitized metadata", () => {
    const failure = calibrationFailure(
      new JevValidationError("OpenRouter returned no message content.", {
        code: "EMPTY_CONTENT",
        body: { inputTruncated: false, attempt: 1, finishReason: "stop", outputTokens: 4 },
      }),
    );
    expect(failure).toEqual({
      type: "JevValidationError",
      code: "EMPTY_CONTENT",
      meta: { inputTruncated: false, attempt: 1, finishReason: "stop", outputTokens: 4 },
    });
  });

  it("never carries provider output text", () => {
    const failure = calibrationFailure(new JevValidationError("answer \"closure\" picks an unknown option"));
    expect(JSON.stringify(failure)).not.toContain("unknown option");
    expect(failure.code).toBeUndefined();
  });
});
