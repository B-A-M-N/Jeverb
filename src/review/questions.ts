import type { Question } from "../decision/types.js";
import type { DiffChunk } from "./chunk.js";

export interface CheckDef {
  id: string;
  type: "noul";
  instructions: { question: string; inspect: string; focus: string };
  criteria: { true?: string; false?: string };
}

export function buildReviewQuestions(chunk: DiffChunk, checks: CheckDef[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const check of checks) {
    // Pass the configured criteria and inspect target through verbatim.
    // Rebuilding or dropping them would silently change what the judgments
    // mean and invalidate any calibration measured against these checks.
    questions[check.id] = {
      type: "noul",
      instructions: {
        question: check.instructions.question,
        inspect: check.instructions.inspect,
        focus: check.instructions.focus,
        diff: chunk.text,
      },
      criteria: check.criteria,
    };
  }
  return questions;
}
