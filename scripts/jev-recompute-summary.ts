#!/usr/bin/env tsx
/**
 * Recompute a stored calibration summary with inclusive accounting, without
 * spending additional model tokens.
 *
 * Old receipts recorded one error row per failed *case*. A failed
 * multi-question case must count each of its expected questions as failed,
 * so this script expands per-case errors into per-question failure rows
 * using a documented label-recovery map, then tallies with
 * `summarizeCalibration` — the same function the live harness uses.
 *
 * Usage:
 *   npx tsx scripts/jev-recompute-summary.ts \
 *     bench/results/mission-completion-v1.summary.json \
 *     bench/results/mission-completion-v1.receipts.jsonl \
 *     bench/results/round2-failed-labels.json
 *
 * The original summary is preserved as `<name>.summary.pre-inclusive.json`; the
 * corrected summary replaces `<name>.summary.json` with
 * `accountingVersion: "inclusive/1"` and identical dataset/result hashes.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertOutputPathAvailable, replaceDerivedArtifact, writeNewArtifact } from "./artifact-output.js";
import {
  summarizeCalibration,
  type CalibrationCase,
  type CalibrationJudgmentRow,
} from "../src/jev/calibration.js";

const [summaryPath, receiptsPath, labelsPath] = process.argv.slice(2);
if (!summaryPath || !receiptsPath || !labelsPath) {
  console.error("usage: jev-recompute-summary.ts <summary.json> <receipts.jsonl> <failed-labels.json>");
  process.exit(2);
}
if (!summaryPath.endsWith(".summary.json")) {
  throw new Error(`summary path must end with .summary.json: ${summaryPath}`);
}
const backupPath = summaryPath.replace(/\.summary\.json$/, ".summary.pre-inclusive.json");
assertOutputPathAvailable(backupPath);

interface FailedLabels {
  provenance: string;
  cases: Record<string, { questions: Record<string, { type: "choice" | "noul"; choice?: string; label?: boolean } & { label: boolean }> }>;
}

const originalSummary = readFileSync(summaryPath, "utf8");
const summary = JSON.parse(originalSummary) as Record<string, unknown>;
const failed = JSON.parse(readFileSync(labelsPath, "utf8")) as FailedLabels;
const receiptRows = readFileSync(receiptsPath, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

// Reconstruct the evaluated case list from receipts: every receipted case ran
// against the stored dataset revision, so per-case question sets come from
// answer rows, with failed cases recovered from the documented label map.
const byCase = new Map<string, Record<string, unknown>[]>();
for (const row of receiptRows) {
  const id = row.case as string;
  byCase.set(id, [...(byCase.get(id) ?? []), row]);
}

const cases: CalibrationCase[] = [];
const rows: CalibrationJudgmentRow[] = [];
for (const [id, caseRows] of byCase) {
  const answerRows = caseRows.filter((row) => row.answer !== undefined);
  const errorRow = caseRows.find((row) => row.answer === undefined);
  if (errorRow !== undefined && answerRows.length > 0) {
    throw new Error(`case ${id}: mixes answer and error rows; cannot recompute`);
  }
  if (errorRow !== undefined) {
    const recovered = failed.cases[id];
    if (recovered === undefined) throw new Error(`case ${id}: no recovered labels in ${labelsPath}`);
    const questions: CalibrationCase["questions"] = {};
    const expected: CalibrationCase["expected"] = {};
    for (const [qid, label] of Object.entries(recovered.questions)) {
      questions[qid] =
        label.type === "choice"
          ? { type: "choice", instructions: "recovered", criteria: { [label.choice!]: "recovered" } }
          : { type: "noul", instructions: "recovered" };
      expected[qid] =
        label.type === "choice" ? { choice: label.choice! } : { noul: [0, 1], label: label.label };
    }
    cases.push({ id, state: {}, questions, expected });
    for (const qid of Object.keys(questions)) {
      rows.push({
        case: id,
        question: qid,
        expected: expected[qid],
        inRange: false,
        error: errorRow.error as string,
      });
    }
    rows.push({ case: id, question: "", caseError: true, error: errorRow.error as string });
    continue;
  }
  const questions: CalibrationCase["questions"] = {};
  const expected: CalibrationCase["expected"] = {};
  for (const row of answerRows) {
    const qid = row.question as string;
    const answer = row.answer as { type: string; noul?: number; choice?: string; score?: number };
    const exp = row.expected as CalibrationCase["expected"][string];
    questions[qid] =
      answer.type === "choice"
        ? { type: "choice", instructions: "recovered", criteria: {} }
        : answer.type === "noul"
          ? { type: "noul", instructions: "recovered" }
          : { type: "score", instructions: "recovered", criteria: ["low", "high"] };
    expected[qid] = exp;
    rows.push({
      case: id,
      question: qid,
      answer: { type: answer.type, noul: answer.noul, choice: answer.choice, score: answer.score },
      expected: exp,
      inRange: row.inRange as boolean,
    });
  }
  cases.push({ id, state: {}, questions, expected });
}

const tallied = summarizeCalibration(cases, rows);

// Cross-check against the stored summary: same cases, same valid answers.
if (tallied.cases !== summary.cases) throw new Error("case count mismatch with stored summary");
if (tallied.answerable !== summary.answerable) throw new Error("answerable count mismatch with stored summary");
if (tallied.inRange !== summary.inRange) throw new Error("in-range count mismatch with stored summary");

const corrected = {
  ...summary,
  expectedAnswers: tallied.expectedAnswers,
  answerable: tallied.answerable,
  inRange: tallied.inRange,
  invalidJudgments: tallied.invalidJudgments,
  /** Inclusive question-level accuracy: every expected judgment counts. */
  accuracy: tallied.accuracy,
  /** Success-only diagnostic: valid answers only in the denominator. */
  answeredAccuracy: tallied.answeredAccuracy,
  caseSuccessRate: tallied.caseSuccessRate,
  caseExactMatchRate: tallied.caseExactMatchRate,
  systemDecisionAccuracy: tallied.systemDecisionAccuracy,
  systemDecisionQuestion: tallied.systemDecisionQuestion,
  confusion: tallied.confusion,
  failuresByCode: tallied.failuresByCode,
  accountingVersion: "inclusive/1",
  accountingProvenance: `recomputed from stored receipts without new model calls; failed-case labels recovered per ${failed.provenance}`,
};

const serialized = `${JSON.stringify(corrected, null, 2)}\n`;
writeNewArtifact(backupPath, originalSummary);
replaceDerivedArtifact(summaryPath, serialized);
console.log(
  `${summaryPath}: accuracy=${tallied.accuracy} answeredAccuracy=${tallied.answeredAccuracy} ` +
    `evaluationHash=${createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 12)}`,
);
