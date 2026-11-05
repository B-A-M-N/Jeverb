import type { Question } from "../decision/types.js";
import { JevError } from "./errors.js";

export interface CalibrationExpected {
  noul?: [number, number];
  label?: boolean;
  choice?: string;
  score?: [number, number];
}

export interface CalibrationCase {
  id: string;
  state: unknown;
  questions: Record<string, Question>;
  expected: Record<string, CalibrationExpected>;
}

export interface CalibrationFailureMeta {
  inputTruncated?: boolean;
  attempt?: number;
  finishReason?: string;
  outputTokens?: number;
}

/** Safe failure metadata for durable benchmark output; provider text is never retained. */
export function calibrationFailure(error: unknown): {
  type: string;
  status?: number;
  code?: string;
  meta?: CalibrationFailureMeta;
} {
  if (error instanceof JevError) {
    const meta =
      error.body !== undefined &&
      typeof error.body === "object" &&
      error.body !== null &&
      ("inputTruncated" in error.body || "attempt" in error.body || "finishReason" in error.body)
        ? (error.body as CalibrationFailureMeta)
        : undefined;
    return {
      type: error.name,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(meta === undefined ? {} : { meta }),
    };
  }
  return { type: error instanceof Error ? "Error" : "UnknownError" };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericRange(value: unknown, line: number, label: string): [number, number] {
  if (
    !Array.isArray(value) || value.length !== 2 ||
    !value.every((item) => typeof item === "number" && Number.isFinite(item)) ||
    value[0] < 0 || value[1] < value[0]
  ) throw new Error(`dataset line ${line}: ${label} must be a finite, ordered, non-negative range`);
  return [value[0] as number, value[1] as number];
}

function validateCase(value: unknown, line: number): CalibrationCase {
  if (!record(value)) throw new Error(`dataset line ${line}: case must be an object`);
  if (typeof value.id !== "string" || value.id.trim() === "") throw new Error(`dataset line ${line}: id is required`);
  if (!Object.hasOwn(value, "state")) throw new Error(`dataset line ${line}: state is required`);
  if (!record(value.questions) || Object.keys(value.questions).length === 0) {
    throw new Error(`dataset line ${line}: questions must be a non-empty object`);
  }
  if (!record(value.expected) || Object.keys(value.expected).length === 0) {
    throw new Error(`dataset line ${line}: expected must be a non-empty object`);
  }

  const questions = value.questions as Record<string, Question>;
  const expected = Object.create(null) as Record<string, CalibrationExpected>;
  const questionIds = Object.keys(questions).sort();
  const expectedIds = Object.keys(value.expected).sort();
  if (questionIds.length !== expectedIds.length || questionIds.some((id, index) => id !== expectedIds[index])) {
    throw new Error(`dataset line ${line}: expected question ids must exactly match questions`);
  }

  for (const qid of questionIds) {
    const question = questions[qid];
    const exp = value.expected[qid];
    if (!record(question) || !["noul", "choice", "score"].includes(question.type)) {
      throw new Error(`dataset line ${line}: question ${qid} has an unsupported type`);
    }
    if (qid.trim() === "") throw new Error(`dataset line ${line}: question id must not be empty`);
    const instructions = question.instructions;
    if (
      instructions === undefined ||
      !(typeof instructions === "string" || Array.isArray(instructions) || record(instructions))
    ) throw new Error(`dataset line ${line}: question ${qid} has invalid instructions`);
    if (
      (question.type === "choice" && (!record(question.criteria) || Object.keys(question.criteria).length === 0)) ||
      (question.type === "score" && (!Array.isArray(question.criteria) || question.criteria.length < 2))
    ) throw new Error(`dataset line ${line}: question ${qid} has invalid criteria`);
    if (!record(exp)) throw new Error(`dataset line ${line}: expected.${qid} must be an object`);
    const item: CalibrationExpected = {};
    if (Object.hasOwn(exp, "noul")) {
      if (question.type !== "noul") throw new Error(`dataset line ${line}: ${qid}.noul requires a noul question`);
      const range = numericRange(exp.noul, line, `${qid}.noul`);
      if (range[1] > 1) throw new Error(`dataset line ${line}: ${qid}.noul must be within [0,1]`);
      item.noul = range;
    }
    if (Object.hasOwn(exp, "score")) {
      if (question.type !== "score") throw new Error(`dataset line ${line}: ${qid}.score requires a score question`);
      const range = numericRange(exp.score, line, `${qid}.score`);
      if (range[1] > Math.max(0, question.criteria.length - 1)) {
        throw new Error(`dataset line ${line}: ${qid}.score exceeds the score question range`);
      }
      item.score = range;
    }
    if (Object.hasOwn(exp, "choice")) {
      if (question.type !== "choice" || typeof exp.choice !== "string" || !Object.hasOwn(question.criteria, exp.choice)) {
        throw new Error(`dataset line ${line}: ${qid}.choice must name a valid choice option`);
      }
      item.choice = exp.choice;
    }
    if (Object.hasOwn(exp, "label")) {
      if (question.type !== "noul" || typeof exp.label !== "boolean") {
        throw new Error(`dataset line ${line}: ${qid}.label requires a boolean on a noul question`);
      }
      item.label = exp.label;
    }
    if (Object.keys(item).length === 0) throw new Error(`dataset line ${line}: expected.${qid} has no supported target`);
    expected[qid] = item;
  }

  return { id: value.id, state: value.state, questions, expected };
}

/** Parse and validate the complete labeled benchmark before making any provider calls. */
export function parseCalibrationDataset(contents: string): CalibrationCase[] {
  const cases: CalibrationCase[] = [];
  const ids = new Set<string>();
  for (const [index, text] of contents.split(/\r?\n/).entries()) {
    if (text.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`dataset line ${index + 1}: invalid JSON`);
    }
    const item = validateCase(value, index + 1);
    if (ids.has(item.id)) throw new Error(`dataset line ${index + 1}: duplicate case id ${JSON.stringify(item.id)}`);
    ids.add(item.id);
    cases.push(item);
  }
  if (cases.length === 0) throw new Error("dataset contains no cases");
  return cases;
}

export interface NoulSample {
  p: number;
  label: boolean;
}

/**
 * One evaluated benchmark judgment. Answer rows carry a validated model
 * answer; failure rows carry the machine-readable failure instead of an
 * answer. A failed case emits one failure row per expected question (each
 * expected judgment counts as failed) plus a single case-level error row.
 */
export interface CalibrationJudgmentRow {
  case: string;
  question: string;
  answer?: { type: string; noul?: number | undefined; choice?: string | undefined; score?: number | undefined } | undefined;
  expected?: CalibrationExpected | undefined;
  inRange?: boolean | null | undefined;
  error?: string | undefined;
  code?: string | undefined;
  caseError?: boolean | undefined;
}

export interface ChoiceConfusion {
  classes: string[];
  /** matrix[actual][predicted]; failures land in the "__invalid__" column. */
  matrix: Record<string, Record<string, number>>;
  perClass: Record<string, { precision: number | null; recall: number | null; support: number }>;
}

export interface CalibrationSummary {
  expectedAnswers: number;
  answerable: number;
  inRange: number;
  /** Inclusive question-level accuracy: every expected judgment counts. */
  accuracy: number | null;
  /** Success-only diagnostic: valid answers only in the denominator. */
  answeredAccuracy: number | null;
  cases: number;
  successfulCases: number;
  failedCases: number;
  caseSuccessRate: number | null;
  caseExactMatchRate: number | null;
  systemDecisionAccuracy: number | null;
  systemDecisionQuestion: string | null;
  confusion: Record<string, ChoiceConfusion>;
  failuresByCode: Record<string, number>;
  invalidJudgments: number;
  noulSamples: NoulSample[];
}

/** Primary decision question for system-level accuracy, when the suite has one. */
function primaryQuestion(expected: Record<string, CalibrationExpected>): string | null {
  for (const qid of ["closure", "next", "gap"]) {
    if (Object.hasOwn(expected, qid)) return qid;
  }
  return null;
}

/**
 * Summarize benchmark judgments with inclusive accounting: the denominator
 * is every expected judgment, and failed cases count each of their expected
 * questions as a failure. Never divides valid answers by valid answers and
 * calls it accuracy.
 */
export function summarizeCalibration(cases: CalibrationCase[], rows: CalibrationJudgmentRow[]): CalibrationSummary {
  const byCase = new Map<string, CalibrationJudgmentRow[]>();
  for (const row of rows) {
    if (row.caseError === true) continue;
    const list = byCase.get(row.case) ?? [];
    list.push(row);
    byCase.set(row.case, list);
  }
  const caseErrored = new Set(rows.filter((row) => row.caseError === true).map((row) => row.case));

  let expectedAnswers = 0;
  let answerable = 0;
  let inRange = 0;
  let successfulCases = 0;
  let exactMatchCases = 0;
  let decisionCorrect = 0;
  let decisionTotal = 0;
  let systemDecisionQuestion: string | null = null;
  const failuresByCode: Record<string, number> = {};
  const confusionAcc: Record<string, { actual: string[]; predicted: (string | null)[] }> = {};
  const noulSamples: NoulSample[] = [];

  for (const c of cases) {
    const qids = Object.keys(c.questions);
    expectedAnswers += qids.length;
    const perQuestion = new Map<string, CalibrationJudgmentRow>();
    for (const row of byCase.get(c.id) ?? []) perQuestion.set(row.question, row);
    const errored = caseErrored.has(c.id);
    if (!errored) successfulCases += 1;
    let exact = !errored;
    for (const qid of qids) {
      const row = perQuestion.get(qid);
      const exp = c.expected[qid]!;
      if (row?.answer !== undefined && typeof row.inRange === "boolean") {
        answerable += 1;
        if (row.inRange) inRange += 1;
        else exact = false;
        if (row.answer.type === "choice" && exp.choice !== undefined) {
          const acc = confusionAcc[qid] ?? { actual: [], predicted: [] };
          acc.actual.push(exp.choice);
          acc.predicted.push(row.answer.choice ?? null);
          confusionAcc[qid] = acc;
        }
        if (row.answer.type === "noul" && typeof row.answer.noul === "number" && typeof exp.label === "boolean") {
          noulSamples.push({ p: row.answer.noul, label: exp.label });
        }
      } else {
        exact = false;
        const key = `${row?.error ?? "missing"}${row?.code === undefined ? "" : `:${row.code}`}`;
        failuresByCode[key] = (failuresByCode[key] ?? 0) + 1;
        if (c.questions[qid]?.type === "choice" && exp.choice !== undefined) {
          const acc = confusionAcc[qid] ?? { actual: [], predicted: [] };
          acc.actual.push(exp.choice);
          acc.predicted.push(null);
          confusionAcc[qid] = acc;
        }
      }
    }
    if (exact) exactMatchCases += 1;
    const primary = primaryQuestion(c.expected);
    if (primary !== null) {
      systemDecisionQuestion = systemDecisionQuestion ?? primary;
      decisionTotal += 1;
      const row = perQuestion.get(primary);
      if (!errored && row?.answer !== undefined && row.inRange === true) decisionCorrect += 1;
    }
  }

  const confusion: Record<string, ChoiceConfusion> = {};
  for (const [qid, acc] of Object.entries(confusionAcc)) {
    const classes = [...new Set(acc.actual)].sort();
    const matrix: Record<string, Record<string, number>> = {};
    for (const actual of classes) {
      matrix[actual] = {};
      for (const predicted of [...classes, "__invalid__"]) matrix[actual][predicted] = 0;
    }
    acc.actual.forEach((actual, i) => {
      const predicted = acc.predicted[i] ?? "__invalid__";
      matrix[actual]![classes.includes(predicted) ? predicted : "__invalid__"]! += 1;
    });
    const perClass: ChoiceConfusion["perClass"] = {};
    for (const cls of classes) {
      const tp = matrix[cls]![cls]!;
      const predictedAs = classes.reduce((n, actual) => n + matrix[actual]![cls]!, 0);
      const support = [...classes, "__invalid__"].reduce((n, predicted) => n + matrix[cls]![predicted]!, 0);
      perClass[cls] = {
        precision: predictedAs === 0 ? null : tp / predictedAs,
        recall: support === 0 ? null : tp / support,
        support,
      };
    }
    confusion[qid] = { classes, matrix, perClass };
  }

  return {
    expectedAnswers,
    answerable,
    inRange,
    accuracy: expectedAnswers === 0 ? null : inRange / expectedAnswers,
    answeredAccuracy: answerable === 0 ? null : inRange / answerable,
    cases: cases.length,
    successfulCases,
    failedCases: cases.length - successfulCases,
    caseSuccessRate: cases.length === 0 ? null : successfulCases / cases.length,
    caseExactMatchRate: cases.length === 0 ? null : exactMatchCases / cases.length,
    systemDecisionAccuracy: decisionTotal === 0 ? null : decisionCorrect / decisionTotal,
    systemDecisionQuestion,
    confusion,
    failuresByCode,
    invalidJudgments: expectedAnswers - answerable,
    noulSamples,
  };
}

/** Proper probability scores and a reliability diagram for labeled Noul answers. */
export function noulCalibrationMetrics(samples: NoulSample[], binCount = 10) {
  if (!Number.isSafeInteger(binCount) || binCount < 1 || binCount > 100) throw new Error("binCount must be an integer in [1,100]");
  if (samples.length === 0) return { count: 0, brier: null, logLoss: null, ece: null, bins: [] };
  const epsilon = 1e-15;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: index / binCount,
    upper: (index + 1) / binCount,
    count: 0,
    meanProbability: 0,
    observedRate: 0,
  }));
  let brier = 0;
  let logLoss = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.p) || sample.p < 0 || sample.p > 1) throw new Error("Noul sample probability must be within [0,1]");
    const outcome = sample.label ? 1 : 0;
    brier += (sample.p - outcome) ** 2;
    const p = Math.max(epsilon, Math.min(1 - epsilon, sample.p));
    logLoss -= outcome === 1 ? Math.log(p) : Math.log(1 - p);
    const index = Math.min(binCount - 1, Math.floor(sample.p * binCount));
    const bin = bins[index]!;
    bin.count += 1;
    bin.meanProbability += sample.p;
    bin.observedRate += outcome;
  }
  let ece = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    bin.meanProbability /= bin.count;
    bin.observedRate /= bin.count;
    ece += (bin.count / samples.length) * Math.abs(bin.meanProbability - bin.observedRate);
  }
  return {
    count: samples.length,
    brier: brier / samples.length,
    logLoss: logLoss / samples.length,
    ece,
    bins,
  };
}
