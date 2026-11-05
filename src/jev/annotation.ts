/**
 * Purpose: blind-label closure and routing choice cases before independent evaluation.
 * Ownership: benchmark annotation packet and rater reconciliation only.
 * Forbidden: model scoring, automatic ground-truth invention, or release qualification.
 */
import { randomUUID, createHash } from "node:crypto";
import { parseCalibrationDataset, type CalibrationCase } from "./calibration.js";

export interface BlindAnnotationCase {
  annotationId: string;
  state: unknown;
  questions: CalibrationCase["questions"];
}

export interface BlindAnnotationPacket {
  schema: "jev-blind-annotation/1";
  sourceHash: string;
  cases: BlindAnnotationCase[];
}

export interface BlindAnnotationKey {
  schema: "jev-blind-annotation-key/1";
  sourceHash: string;
  cases: Array<{ annotationId: string; sourceId: string }>;
}

export interface HumanAnswer {
  choice: string;
  rationale: string;
  evidenceRefs: string[];
}

export interface HumanAnnotation {
  reviewerId: string;
  annotationId: string;
  answers: Record<string, HumanAnswer>;
}

export interface Reconciliation {
  unanimous: boolean;
  resolved: boolean;
  sourceHash: string;
  packetHash: string;
  reviewers: { first: string; second: string; adjudicator?: string };
  cases: number;
  judgments: number;
  agreements: number;
  disagreements: Array<{ annotationId: string; question: string; choices: [string, string] }>;
  audit?: Array<{ sourceId: string; question: string; consensus: HumanAnswer; first: HumanAnswer; second: HumanAnswer; adjudicator?: HumanAnswer }>;
  labeledDataset?: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseAnnotationSource(sourceText: string): CalibrationCase[] {
  const validationLines: string[] = [];
  for (const [index, line] of sourceText.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { throw new Error(`annotation source line ${index + 1}: invalid JSON`); }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`annotation source line ${index + 1}: expected an object`);
    const item = row as Record<string, unknown>;
    if (item.expected !== undefined) {
      validationLines.push(JSON.stringify(item));
      continue;
    }
    if (!item.questions || typeof item.questions !== "object" || Array.isArray(item.questions)) throw new Error(`annotation source line ${index + 1}: questions are required`);
    const questions = item.questions as Record<string, unknown>;
    const expected: Record<string, { choice: string }> = {};
    for (const [qid, rawQuestion] of Object.entries(questions)) {
      if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) throw new Error(`annotation source line ${index + 1}: question ${qid} is invalid`);
      const question = rawQuestion as Record<string, unknown>;
      if (question.type !== "choice" || !question.criteria || typeof question.criteria !== "object" || Array.isArray(question.criteria)) {
        throw new Error(`annotation source line ${index + 1}: question ${qid} must be a choice question with criteria`);
      }
      const firstChoice = Object.keys(question.criteria as Record<string, unknown>)[0];
      if (!firstChoice) throw new Error(`annotation source line ${index + 1}: question ${qid} has no choices`);
      expected[qid] = { choice: firstChoice };
    }
    validationLines.push(JSON.stringify({ ...item, expected }));
  }
  return parseCalibrationDataset(`${validationLines.join("\n")}\n`);
}

function choiceOnlyCases(cases: CalibrationCase[]): void {
  for (const item of cases) {
    for (const [qid, question] of Object.entries(item.questions)) {
      if (question.type !== "choice") {
        throw new Error(`case ${item.id}, question ${qid}: blind annotation currently supports choice questions only`);
      }
    }
  }
}

/** Build an answer-free packet and a separately retained source-ID key. */
export function prepareBlindAnnotation(sourceText: string, uuid: () => string = randomUUID): {
  packet: BlindAnnotationPacket;
  key: BlindAnnotationKey;
} {
  const cases = parseAnnotationSource(sourceText);
  choiceOnlyCases(cases);
  const seen = new Set<string>();
  const mapping: BlindAnnotationKey["cases"] = [];
  const packetCases = cases.map((item) => {
    const annotationId = uuid();
    if (seen.has(annotationId)) throw new Error("blind annotation id generator returned a duplicate");
    seen.add(annotationId);
    mapping.push({ annotationId, sourceId: item.id });
    return { annotationId, state: item.state, questions: item.questions };
  });
  // Randomize order independently from source ordering.
  for (let i = packetCases.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [packetCases[i], packetCases[j]] = [packetCases[j]!, packetCases[i]!];
  }
  const sourceHash = sha256(sourceText);
  return {
    packet: { schema: "jev-blind-annotation/1", sourceHash, cases: packetCases },
    key: { schema: "jev-blind-annotation-key/1", sourceHash, cases: mapping },
  };
}

function parseAnnotations(text: string, packet: BlindAnnotationPacket, who: string): { reviewerId: string; rows: Map<string, HumanAnnotation> } {
  const byId = new Map<string, HumanAnnotation>();
  let reviewerId: string | undefined;
  const allowed = new Map(packet.cases.map((item) => [item.annotationId, item]));
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`${who} annotation line ${index + 1}: invalid JSON`); }
    const row = value as Record<string, unknown>;
    if (typeof row.reviewerId !== "string" || row.reviewerId.trim() === "") throw new Error(`${who} annotation line ${index + 1}: reviewerId is required`);
    if (reviewerId !== undefined && reviewerId !== row.reviewerId) throw new Error(`${who} annotations must have one consistent reviewerId`);
    reviewerId = row.reviewerId.trim();
    if (typeof row.annotationId !== "string" || !allowed.has(row.annotationId)) throw new Error(`${who} annotation line ${index + 1}: unknown annotationId`);
    if (byId.has(row.annotationId)) throw new Error(`${who} annotation line ${index + 1}: duplicate annotationId`);
    if (!row.answers || typeof row.answers !== "object" || Array.isArray(row.answers)) throw new Error(`${who} annotation line ${index + 1}: answers must be an object`);
    const sourceCase = allowed.get(row.annotationId)!;
    const rawAnswers = row.answers as Record<string, unknown>;
    const questionIds = Object.keys(sourceCase.questions);
    if (Object.keys(rawAnswers).length !== questionIds.length || questionIds.some((qid) => !Object.hasOwn(rawAnswers, qid))) {
      throw new Error(`${who} annotation ${row.annotationId}: answers must cover every question exactly`);
    }
    const answers: Record<string, HumanAnswer> = {};
    for (const qid of questionIds) {
      const question = sourceCase.questions[qid]!;
      if (question.type !== "choice") throw new Error(`${who} annotation ${row.annotationId}, ${qid}: only choice questions are supported`);
      const answer = rawAnswers[qid];
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error(`${who} annotation ${row.annotationId}, ${qid}: answer must be an object`);
      const candidate = answer as Record<string, unknown>;
      const options = Object.keys(question.criteria);
      if (typeof candidate.choice !== "string" || !options.includes(candidate.choice)) throw new Error(`${who} annotation ${row.annotationId}, ${qid}: choice must name a listed criterion`);
      if (typeof candidate.rationale !== "string" || candidate.rationale.trim().length < 12) throw new Error(`${who} annotation ${row.annotationId}, ${qid}: rationale must contain at least 12 characters`);
      if (!Array.isArray(candidate.evidenceRefs) || candidate.evidenceRefs.length === 0 || candidate.evidenceRefs.some((ref) => typeof ref !== "string" || ref.trim() === "")) {
        throw new Error(`${who} annotation ${row.annotationId}, ${qid}: cite at least one evidence field or reference`);
      }
      answers[qid] = { choice: candidate.choice, rationale: candidate.rationale.trim(), evidenceRefs: candidate.evidenceRefs as string[] };
    }
    byId.set(row.annotationId, { reviewerId, annotationId: row.annotationId as string, answers });
  }
  if (byId.size !== packet.cases.length) throw new Error(`${who} annotations cover ${byId.size}/${packet.cases.length} cases`);
  return { reviewerId: reviewerId!, rows: byId };
}

/** Compare two blind raters; emit a benchmark dataset only on unanimous labels. */
export function reconcileBlindAnnotations(args: {
  sourceText: string;
  packet: BlindAnnotationPacket;
  key: BlindAnnotationKey;
  firstText: string;
  secondText: string;
  adjudicatorText?: string;
}): Reconciliation {
  const sourceHash = sha256(args.sourceText);
  if (args.packet.schema !== "jev-blind-annotation/1" || args.key.schema !== "jev-blind-annotation-key/1" ||
      args.packet.sourceHash !== sourceHash || args.key.sourceHash !== sourceHash) {
    throw new Error("source, packet, and key hashes must match");
  }
  const cases = parseAnnotationSource(args.sourceText);
  choiceOnlyCases(cases);
  const packetIds = args.packet.cases.map((item) => item.annotationId).sort();
  const keyIds = args.key.cases.map((item) => item.annotationId).sort();
  if (new Set(packetIds).size !== packetIds.length || JSON.stringify(packetIds) !== JSON.stringify(keyIds)) throw new Error("annotation packet and key coverage differ");
  const sourceById = new Map(cases.map((item) => [item.id, item]));
  const mappedSourceIds = args.key.cases.map((item) => item.sourceId);
  if (args.key.cases.length !== cases.length || new Set(mappedSourceIds).size !== cases.length || mappedSourceIds.some((id) => !sourceById.has(id))) {
    throw new Error("annotation key must map every source case exactly once");
  }
  const packetById = new Map(args.packet.cases.map((item) => [item.annotationId, item]));
  for (const mapping of args.key.cases) {
    const original = sourceById.get(mapping.sourceId)!;
    const blinded = packetById.get(mapping.annotationId)!;
    if (JSON.stringify(blinded.state) !== JSON.stringify(original.state) || JSON.stringify(blinded.questions) !== JSON.stringify(original.questions)) {
      throw new Error(`annotation packet case ${mapping.annotationId} differs from the source case`);
    }
  }
  const first = parseAnnotations(args.firstText, args.packet, "first rater");
  const second = parseAnnotations(args.secondText, args.packet, "second rater");
  if (first.reviewerId === second.reviewerId) throw new Error("independent raters must use distinct reviewerId values");
  const adjudicator = args.adjudicatorText === undefined ? undefined : parseAnnotations(args.adjudicatorText, args.packet, "adjudicator");
  if (adjudicator && [first.reviewerId, second.reviewerId].includes(adjudicator.reviewerId)) throw new Error("adjudicator must have a reviewerId distinct from both raters");
  const disagreements: Reconciliation["disagreements"] = [];
  let judgments = 0;
  let agreements = 0;
  for (const item of args.packet.cases) {
    const a = first.rows.get(item.annotationId)!;
    const b = second.rows.get(item.annotationId)!;
    for (const qid of Object.keys(item.questions)) {
      judgments += 1;
      if (a.answers[qid]!.choice === b.answers[qid]!.choice) agreements += 1;
      else disagreements.push({ annotationId: item.annotationId, question: qid, choices: [a.answers[qid]!.choice, b.answers[qid]!.choice] });
    }
  }
  const provenance = {
    sourceHash,
    packetHash: sha256(JSON.stringify(args.packet)),
    reviewers: { first: first.reviewerId, second: second.reviewerId, ...(adjudicator ? { adjudicator: adjudicator.reviewerId } : {}) },
  };
  if (disagreements.length > 0 && adjudicator === undefined) return { ...provenance, unanimous: false, resolved: false, cases: cases.length, judgments, agreements, disagreements };
  const labelsBySourceId = new Map<string, Record<string, { choice: string }>>();
  const audit: NonNullable<Reconciliation["audit"]> = [];
  for (const item of args.key.cases) {
    const blind = first.rows.get(item.annotationId)!;
    const secondBlind = second.rows.get(item.annotationId)!;
    labelsBySourceId.set(item.sourceId, Object.fromEntries(Object.entries(blind.answers).map(([qid, answer]) => [qid, { choice: answer.choice }])));
    for (const [qid, answer] of Object.entries(blind.answers)) {
      const secondAnswer = secondBlind.answers[qid]!;
      const adjudicatorAnswer = adjudicator?.rows.get(item.annotationId)!.answers[qid];
      const consensus = answer.choice === secondAnswer.choice ? answer : adjudicatorAnswer ?? answer;
      audit.push({ sourceId: item.sourceId, question: qid, consensus, first: answer, second: secondAnswer, ...(adjudicatorAnswer ? { adjudicator: adjudicatorAnswer } : {}) });
      labelsBySourceId.get(item.sourceId)![qid] = { choice: consensus.choice };
    }
  }
  const labeledDataset = cases.map((item) => JSON.stringify({ id: item.id, state: item.state, questions: item.questions, expected: labelsBySourceId.get(item.id)! })).join("\n") + "\n";
  return { ...provenance, unanimous: disagreements.length === 0, resolved: true, cases: cases.length, judgments, agreements, disagreements, audit, labeledDataset };
}
