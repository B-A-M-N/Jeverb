/**
 * Provenance helpers for evaluation results.
 *
 * `hashQuestions` pins the exact question set a result was produced from:
 * instructions, criteria, and option order all feed the hash, because
 * changing any of them can shift calibrated probabilities. Review and
 * calibration code compares this hash against the hash recorded when
 * thresholds were measured; a mismatch means "uncalibrated", never "ready".
 *
 * Key order is significant on purpose: choice criteria are presented to the
 * model in insertion order, so reordering options is a question change, not
 * a no-op. This matches the review config loader, which hashes its
 * checks+policy with plain JSON serialization.
 */
import { createHash } from "node:crypto";
import type { Question } from "./types.js";

/** sha256 over the JSON serialization of the question set. */
export function hashQuestions(questions: Record<string, Question>): string {
  return createHash("sha256").update(JSON.stringify(questions)).digest("hex");
}
