#!/usr/bin/env node
/**
 * Frozen A/B evaluation: one global mission judgment versus one isolated Jev
 * request per criterion. `preflight` is offline; `run` requires an explicit
 * request-cap flag and complete blind annotations. No result is terminal
 * authority, and the candidate's question family has no inherited pin.
 */
import { createHash, verify as verifySignature } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DecisionModel } from "../src/decision/types.js";
import { hashQuestions } from "../src/decision/provenance.js";
import { affirmativeRequest, DAG_LOCAL_CRITERION_QUESTION_V1, dagLocalCriterionRequest, evaluateDagLocalCriterion, aggregateDagLocalCriterionJudgments, MISSION_CLOSURE_QUESTION_V2, MISSION_CLOSURE_REQUEST_PROFILE_V2, type DagLocalCriterionJudgment, type MissionClosureEvidence, type SemanticFulfillmentChoice } from "../src/mission/closure.js";
import { OpenRouterJevDecisionModel } from "../src/jev/openrouter.js";
import { buildCase, plans } from "./jev-semantic-paired-dev.js";

const ROOT = process.cwd();
const DATASET = resolve(ROOT, "bench/datasets/mission-dag-local-dev-v1");
const PINNED_FREEZE = resolve(ROOT, "bench/analysis/mission-dag-local-dev-v1-freeze.json");
const LATEST_FREEZE = resolve(ROOT, "bench/analysis/mission-dag-local-dev-v1-jev-latest-freeze.json");
const REVIEWER_A = resolve(ROOT, "bench/annotation/mission-dag-local-review-v1-reviewer-a.json");
const REVIEWER_B = resolve(ROOT, "bench/annotation/mission-dag-local-review-v1-reviewer-b.json");
const CRITERION_LABELS = resolve(ROOT, "bench/annotation/mission-dag-local-criterion-labels-v1.json");
const ADJUDICATION = resolve(ROOT, "bench/annotation/mission-dag-local-adjudication-v1.json");
const PROFILE = process.env.JEV_DAG_LOCAL_PROFILE ?? "jev-1.14-pinned";
if (PROFILE !== "jev-1.14-pinned" && PROFILE !== "jev-latest") throw new Error("JEV_DAG_LOCAL_PROFILE must be jev-1.14-pinned or jev-latest");
const IS_LATEST_PROFILE = PROFILE === "jev-latest";
const FREEZE = IS_LATEST_PROFILE ? LATEST_FREEZE : PINNED_FREEZE;
const OUTPUT = resolve(ROOT, IS_LATEST_PROFILE ? "bench/results/mission-dag-local-dev-v1-jev-latest.openrouter-results.json" : "bench/results/mission-dag-local-dev-v1.openrouter-results.json");
const MODEL = IS_LATEST_PROFILE ? "typesafe/jev-latest" : "typesafe/jev-1.14-20261014";
const REQUIRED_RETURNED_MODEL = "typesafe/jev-1.14-20261014";
const ALIAS_RECEIPT_SUMMARY = resolve(ROOT, "bench/results/mission-completion-dev-v3.openrouter-jev-latest-2026-11-03.summary.json");
const PROVIDER = "openrouter";
const HARD_COST_CAP_USD = 0.01;

type CaseRow = { id: string; evidence: MissionClosureEvidence };
type LabelSet = {
  schema: string;
  reviewerIds: [string, string];
  reviewStatus: "AI-generated; not human-reviewed";
  sourceCaseSha256: string;
  adjudicationSha256?: string;
  disagreements?: Array<{ caseRef: string; criterionId: string; reviewerA: string; reviewerB: string; adjudicator: string; rationale: string }>;
  cases: Record<string, {
    objectiveCoverage: "covered" | "omitted" | "unresolved";
    expectedOverall: SemanticFulfillmentChoice;
    criteria: Record<string, SemanticFulfillmentChoice>;
    evidenceSufficiency: Record<string, boolean>;
    reviewerIds: [string, string];
    adjudicated: true;
    adjudications?: Array<{ criterionId: string; adjudicatorId: string }>;
  }>;
};
type ReviewRecord = {
  schema: string;
  reviewerId: string;
  reviewStatus: "AI-generated; not human-reviewed";
  coverageCases: Array<{ caseRef: string; objective: string; criteria: Array<{ criterionId: string; requirement: string }>; objectiveCoverage: { expected: string; rationale: string; omittedRequirements: string[]; ambiguities: string[] } }>;
  criterionCases: Array<{ caseRef: string; criterionId: string; isolatedEvidenceContext: Record<string, unknown>; expected: SemanticFulfillmentChoice; rationale: string; evidenceSufficient: boolean }>;
  assignmentRecord?: { reviewerId: string; context: string; modelOutputsExposed: boolean; otherReviewerAnswersExposed: boolean; caseOrPolicyAuthorship: boolean; attestation: string };
  independenceAttestation?: IndependenceAttestation;
};
type AdjudicationRecord = {
  schema: string;
  reviewerId: string;
  reviewStatus: "AI-generated; not human-reviewed";
  criterionCases: Array<{ caseRef: string; criterionId: string; expected: SemanticFulfillmentChoice; rationale: string; resolvesDisagreement: string }>;
  disagreements?: Array<{ caseRef: string; criterionId: string; reviewerA: string; reviewerB: string; adjudicator: string; rationale: string }>;
  independenceAttestation?: IndependenceAttestation;
};
type IndependenceAttestation = {
  schema: "jev-dag-local-independence-attestation/1";
  reviewerId: string;
  reviewStatus: "AI-generated; not human-reviewed";
  annotationSha256: string;
  declaration: string;
  keyType: "Ed25519";
  publicKeyPem: string;
  signatureBase64: string;
  humanSignature: false;
};
type Freeze = {
  dataset: { caseSha256: string; provenanceSha256: string; caseCount: number; criterionCount: number; annotationSha256?: string | null; reviewerASha256?: string | null; reviewerBSha256?: string | null; adjudicationSha256?: string | null; reviewerAPacketSha256?: string | null; reviewerBPacketSha256?: string | null };
  baseline: { questionHash: string };
  candidate: { questionHash: string };
  execution: { totalRequestCeiling: number; hardCostCeilingUsd: number; concurrency: number; retries: number };
  provider: { requestedModel: string; requiredReturnedModel: string };
  qualification?: Record<string, unknown>;
};

/** Apply the unchanged production confidence floor to the global backstop. */
export function globalBackstopDisposition(choice: string, confidence: number, completeProbability: number): SemanticFulfillmentChoice {
  if (choice === "COMPLETE") {
    return confidence >= 0.9 && completeProbability >= 0.9 ? "FULFILLED" : "UNCERTAIN";
  }
  if (choice === "INCOMPLETE") return "NOT_FULFILLED";
  return "UNCERTAIN";
}

/** Local evidence aggregation can veto completion; only global Jev can affirm it. */
export function combineWithGlobalBackstop(
  localDisposition: SemanticFulfillmentChoice,
  globalDisposition: SemanticFulfillmentChoice,
): SemanticFulfillmentChoice {
  if (localDisposition === "NOT_FULFILLED") return "NOT_FULFILLED";
  if (localDisposition === "UNCERTAIN") return "UNCERTAIN";
  return globalDisposition;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function reviewAnswerProjection(review: ReviewRecord): { coverageCases: unknown[]; criterionCases: unknown[] } {
  return {
    coverageCases: review.coverageCases.map((entry) => ({
      caseRef: entry.caseRef,
      objectiveCoverage: {
        expected: entry.objectiveCoverage.expected,
        rationale: entry.objectiveCoverage.rationale,
        omittedRequirements: entry.objectiveCoverage.omittedRequirements,
        ambiguities: entry.objectiveCoverage.ambiguities,
      },
    })),
    criterionCases: review.criterionCases.map((entry) => ({
      caseRef: entry.caseRef,
      criterionId: entry.criterionId,
      expected: entry.expected,
      rationale: entry.rationale,
      evidenceSufficient: entry.evidenceSufficient,
    })),
  };
}

function attestationValid(attestation: IndependenceAttestation | undefined, reviewerId: string, annotationSha256: string): boolean {
  if (attestation === undefined || attestation.schema !== "jev-dag-local-independence-attestation/1" ||
      attestation.reviewerId !== reviewerId || attestation.reviewStatus !== "AI-generated; not human-reviewed" ||
      attestation.annotationSha256 !== annotationSha256 || attestation.keyType !== "Ed25519" ||
      attestation.humanSignature !== false || !attestation.declaration.includes("not human-reviewed")) return false;
  const payload = JSON.stringify({
    schema: attestation.schema,
    reviewerId: attestation.reviewerId,
    reviewStatus: attestation.reviewStatus,
    annotationSha256: attestation.annotationSha256,
    declaration: attestation.declaration,
  });
  try {
    return verifySignature(null, Buffer.from(payload), attestation.publicKeyPem, Buffer.from(attestation.signatureBase64, "base64"));
  } catch {
    return false;
  }
}

function adjudicationAttestationValid(adjudication: AdjudicationRecord): boolean {
  const annotationSha256 = sha256(JSON.stringify({ criterionCases: adjudication.criterionCases }));
  return attestationValid(adjudication.independenceAttestation, adjudication.reviewerId, annotationSha256);
}

function read<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function calculateRequestCeiling(rows: readonly CaseRow[]): { baseline: number; candidate: number; total: number; criterionCount: number } {
  const criterionCount = rows.reduce((count, row) => count + row.evidence.criteria.length, 0);
  return { baseline: rows.length, candidate: criterionCount, total: rows.length + criterionCount, criterionCount };
}

async function prepareDagLocal(): Promise<number> {
  if (IS_LATEST_PROFILE) throw new Error("the DAG-local source corpus is frozen; do not regenerate it for the alias profile");
  if (existsSync(DATASET) || existsSync(REVIEWER_A) || existsSync(REVIEWER_B)) throw new Error("refusing to overwrite the DAG-local evidence corpus or blind review material");
  mkdirSync(DATASET, { recursive: false, mode: 0o700 });
  const receiptDir = resolve(DATASET, "receipts");
  const journalDir = resolve(DATASET, "journals");
  mkdirSync(receiptDir, { mode: 0o700 });
  mkdirSync(journalDir, { mode: 0o700 });
  const built = [];
  for (const plan of plans()) built.push(await buildCase(plan, receiptDir, journalDir));
  const rows = built.map((entry) => entry.row);
  const provenance = built.map((entry) => entry.provenance);
  const casesBytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const provenanceBytes = Buffer.from(`${provenance.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(resolve(DATASET, "cases.jsonl"), casesBytes, { flag: "wx", mode: 0o600 });
  writeFileSync(resolve(DATASET, "provenance.jsonl"), provenanceBytes, { flag: "wx", mode: 0o600 });
  const reviewPacket = (reviewer: "A" | "B") => ({
    schema: "jev-blind-dag-local-review/1",
    reviewer,
    reviewerId: null as string | null,
    instructions: "Independently compare each original objective with its declared criteria, then judge each isolated criterion only from its host graph/verifier context. Do not consult provisional case labels, model outputs, or another reviewer's packet. Record all omitted/ambiguous scope and choose FULFILLED, NOT_FULFILLED, or UNCERTAIN per criterion.",
    coverageCases: rows.map((row) => ({
      caseRef: sha256(row.id).slice(0, 16),
      objective: row.evidence.objective,
      criteria: row.evidence.criteria.map(({ id, statement }) => ({ criterionId: id, requirement: statement })),
      objectiveCoverage: { expected: null, omittedRequirements: [], ambiguities: [] },
    })),
    criterionCases: rows.flatMap((row) => row.evidence.criteria.map((criterion) => ({
      caseRef: sha256(row.id).slice(0, 16),
      criterionId: criterion.id,
      isolatedEvidenceContext: dagLocalCriterionRequest(row.evidence, criterion.id)?.state ?? null,
      expected: null,
      rationale: null,
    }))),
  });
  writeFileSync(REVIEWER_A, `${JSON.stringify(reviewPacket("A"), null, 2)}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(REVIEWER_B, `${JSON.stringify(reviewPacket("B"), null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const requests = calculateRequestCeiling(rows);
  const manifest = {
    schema: "jev-mission-dag-local-paired-development-freeze/1",
    status: "frozen-development-awaiting-blind-adjudication",
    split: "development-only",
    baseline: { family: "existing-global-mission-closure", policyVersion: "mission-closure/1", questionHash: hashQuestions(affirmativeRequest(rows[0]!.evidence).questions), requestsPerCase: 1, terminalGateQualification: "not bound in this freeze; semantic-only baseline comparison" },
    candidate: { family: "criterion-isolated-dag-local-semantic/v1", profile: "mission-dag-local-criterion/v1", questionHash: hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 }), requestsPerCase: "one per declared criterion", terminalAuthority: "always false" },
    dataset: {
      source: "bench/datasets/mission-dag-local-dev-v1", caseCount: rows.length,
      criterionCount: requests.criterionCount, criteriaPerCase: [...new Set(rows.map((row) => row.evidence.criteria.length))],
      caseSha256: sha256(casesBytes), provenanceSha256: sha256(provenanceBytes), annotationSha256: null, reviewerASha256: null, reviewerBSha256: null,
      provisionalLabelsExcluded: true,
    },
    provider: { name: PROVIDER, requestedModel: MODEL, requiredReturnedModel: MODEL, exactVersionMatch: true },
    execution: { baselineRequests: requests.baseline, candidateRequests: requests.candidate, totalRequestCeiling: requests.total, concurrency: 1, retries: 0, hardCostCeilingUsd: HARD_COST_CAP_USD, estimatedCostUsd: 0.00307692, estimateBasis: "36 multiplied by the highest retained per-request cost of $0.00008547; not a guarantee" },
    qualification: { productionThreshold: 0.9, thresholdChanged: false, newQuestionCalibration: "required; no inherited qualification", objectiveCoverage: "two independent blind reviewers pending", criterionGroundTruth: "two independent blind reviewers pending", liveInferenceAuthorized: false, liveDagTransitionValidation: "not included" },
  };
  writeFileSync(FREEZE, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "w", mode: 0o600 });
  console.log(JSON.stringify({ status: "prepared-awaiting-blind-adjudication", dataset: DATASET, reviewerA: REVIEWER_A, reviewerB: REVIEWER_B, freeze: FREEZE, requestCeiling: requests, inferenceRequests: 0 }, null, 2));
  return 0;
}

async function prepareJevLatestFreeze(): Promise<number> {
  if (IS_LATEST_PROFILE) throw new Error("create the alias freeze from the pinned freeze with JEV_DAG_LOCAL_PROFILE unset");
  if (existsSync(LATEST_FREEZE)) throw new Error("refusing to overwrite the existing Jev-latest freeze");
  const state = loadAndCheck();
  if (state.blockers.length > 0) throw new Error(`source freeze is not valid: ${state.blockers.join("; ")}`);
  const aliasSummary = read<Record<string, unknown>>(ALIAS_RECEIPT_SUMMARY);
  const aliasRows = readFileSync(resolve(ROOT, "bench/results/mission-completion-dev-v3.openrouter-jev-latest-2026-11-03.receipts.jsonl"), "utf8")
    .trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
  const resolved = "typesafe/jev-1.14-20261014";
  const servedIds = new Set<string>();
  for (const row of aliasRows) {
    const policy = row.policy as Record<string, unknown> | undefined;
    for (const value of [row.observedModel, row.modelVersion, (row.modelCall as Record<string, unknown> | undefined)?.model, (row.integratedCall as Record<string, unknown> | undefined)?.model]) {
      if (typeof value === "string") servedIds.add(value);
    }
    if (policy?.model !== "typesafe/jev-latest") throw new Error("retained alias receipts do not all request typesafe/jev-latest");
  }
  const requestAccounting = aliasSummary.requestAccounting as Record<string, unknown> | undefined;
  if (aliasSummary.requestedModel !== "typesafe/jev-latest" || aliasSummary.servedModel !== resolved ||
      aliasSummary.endpoint !== "https://openrouter.ai/api/alpha/decisions" || requestAccounting?.responsesMeasured !== 55 ||
      requestAccounting?.retries !== 0 || servedIds.size !== 1 || !servedIds.has(resolved)) {
    throw new Error("retained alias evidence does not establish one concrete OpenRouter model identity");
  }
  const sourceFreezeBytes = readFileSync(PINNED_FREEZE);
  const aliasReceiptsPath = resolve(ROOT, "bench/results/mission-completion-dev-v3.openrouter-jev-latest-2026-11-03.receipts.jsonl");
  const freeze = read<Freeze>(PINNED_FREEZE);
  const aliasFreeze = {
    ...freeze,
    schema: "jev-mission-dag-local-paired-development-freeze/2",
    experimentId: "mission-dag-local-dev-v1-jev-latest",
    status: "frozen-development-awaiting-live-inference-authorization",
    sourceFreezeSha256: sha256(sourceFreezeBytes),
    candidate: {
      ...freeze.candidate,
      qualificationIdentity: "mission-dag-local-criterion/jev-latest/v1",
      terminalAuthority: "always false",
    },
    dataset: {
      ...freeze.dataset,
      sourceFreezeSha256: sha256(sourceFreezeBytes),
      caseSha256: sha256(readFileSync(resolve(DATASET, "cases.jsonl"))),
      provenanceSha256: sha256(readFileSync(resolve(DATASET, "provenance.jsonl"))),
      annotationSha256: sha256(readFileSync(CRITERION_LABELS)),
      reviewerASha256: sha256(readFileSync(REVIEWER_A)),
      reviewerBSha256: sha256(readFileSync(REVIEWER_B)),
      adjudicationSha256: sha256(readFileSync(ADJUDICATION)),
      reviewerAPacketSha256: sha256(readFileSync(resolve(ROOT, "bench/annotation/mission-dag-local-review-v1-reviewer-a.blind-packet.json"))),
      reviewerBPacketSha256: sha256(readFileSync(resolve(ROOT, "bench/annotation/mission-dag-local-review-v1-reviewer-b.blind-packet.json"))),
    },
    provider: {
      name: PROVIDER,
      requestedModel: "typesafe/jev-latest",
      wireModel: "~typesafe/jev-latest",
      requiredReturnedModel: resolved,
      resolutionEvidence: {
        source: "bench/results/mission-completion-dev-v3.openrouter-jev-latest-2026-11-03.summary.json",
        sourceSha256: sha256(readFileSync(ALIAS_RECEIPT_SUMMARY)),
        receipts: "bench/results/mission-completion-dev-v3.openrouter-jev-latest-2026-11-03.receipts.jsonl",
        receiptsSha256: sha256(readFileSync(aliasReceiptsPath)),
        responsesMeasured: 55,
        uniqueReturnedModels: [resolved],
        recheckEveryResponseAcrossBothArms: true,
      },
    },
    qualification: {
      ...freeze.qualification,
      liveInferenceAuthorized: false,
      aliasResolutionMustMatchBothArms: resolved,
    },
  };
  writeFileSync(LATEST_FREEZE, `${JSON.stringify(aliasFreeze, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: "jev-latest-freeze-created", freeze: LATEST_FREEZE, freezeSha256: sha256(readFileSync(LATEST_FREEZE)), sourceFreezeSha256: sha256(sourceFreezeBytes), requestedModel: "typesafe/jev-latest", wireModel: "~typesafe/jev-latest", requiredReturnedModel: resolved, historicalResponses: 55, inferenceRequests: 0 }, null, 2));
  return 0;
}

function loadAndCheck(): { rows: CaseRow[]; freeze: Freeze; labels?: LabelSet; blockers: string[]; requests: ReturnType<typeof calculateRequestCeiling> } {
  if (!existsSync(FREEZE) || !existsSync(resolve(DATASET, "cases.jsonl")) || !existsSync(resolve(DATASET, "provenance.jsonl"))) {
    return { rows: [], freeze: read<Freeze>(FREEZE), blockers: ["run prepare-dag-local to create the separately frozen trusted-evidence corpus"], requests: { baseline: 0, candidate: 0, total: 0, criterionCount: 0 } };
  }
  const casesBytes = readFileSync(resolve(DATASET, "cases.jsonl"));
  const provenanceBytes = readFileSync(resolve(DATASET, "provenance.jsonl"));
  const rows = casesBytes.toString("utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as CaseRow);
  const freeze = read<Freeze>(FREEZE);
  const blockers: string[] = [];
  if (sha256(casesBytes) !== freeze.dataset.caseSha256) blockers.push("case evidence hash differs from freeze");
  if (sha256(provenanceBytes) !== freeze.dataset.provenanceSha256) blockers.push("provenance hash differs from freeze");
  if (rows.length !== freeze.dataset.caseCount) blockers.push("case count differs from freeze");
  if (freeze.execution.concurrency !== 1 || freeze.execution.retries !== 0 || freeze.execution.hardCostCeilingUsd !== HARD_COST_CAP_USD) blockers.push("request concurrency/retry/cost guard differs from frozen limits");
  if (freeze.provider.requestedModel !== MODEL || freeze.provider.requiredReturnedModel !== REQUIRED_RETURNED_MODEL) blockers.push("requested alias/concrete returned model identity differs from runner profile");
  const requests = calculateRequestCeiling(rows);
  if (requests.criterionCount !== freeze.dataset.criterionCount || requests.total !== freeze.execution.totalRequestCeiling) blockers.push("computed request count differs from freeze");
  const localHash = hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 });
  for (const row of rows) {
    if (row.evidence.requestProfile !== MISSION_CLOSURE_REQUEST_PROFILE_V2) blockers.push(`${row.id}: not a trusted v2 snapshot`);
    const coverage = row.evidence.objectiveCoverage;
    if (coverage?.status !== "attested" || coverage.source !== "user-prompt-objective-coverage" ||
        coverage.missionRevision !== row.evidence.missionRevision || !/^[0-9a-f]{64}$/.test(coverage.promptHash ?? "")) {
      blockers.push(`${row.id}: host-bound original-objective coverage is missing; reviewer labels cannot substitute`);
    }
    const baselineHash = hashQuestions(affirmativeRequest(row.evidence).questions);
    if (baselineHash !== freeze.baseline.questionHash) blockers.push(`${row.id}: baseline question hash differs from freeze`);
    for (const criterion of row.evidence.criteria) {
      if (criterion.proofObligation === undefined) blockers.push(`${row.id}/${criterion.id}: frozen evidence has no host-built proof obligation; candidate cannot evaluate the required unit`);
      else if (criterion.proofObligation.codeStructure === undefined) blockers.push(`${row.id}/${criterion.id}: proof obligation has no bound AST/code-structure evidence`);
      const request = dagLocalCriterionRequest(row.evidence, criterion.id);
      if (request === undefined) {
        blockers.push(`${row.id}/${criterion.id}: criterion request cannot be built from the frozen host evidence`);
        continue;
      }
      if (hashQuestions(request.questions) !== freeze.candidate.questionHash || localHash !== freeze.candidate.questionHash) blockers.push(`${row.id}/${criterion.id}: local question hash differs from freeze`);
      if (request.verifier.observationState !== "observed") blockers.push(`${row.id}/${criterion.id}: receipt-backed observed verifier result is missing`);
      if (request.graphNodeIds.some((node) => node.bindingState === "bound" && (node.status !== "succeeded" || !node.attemptId || node.provenance !== "host:journal-projection/v2"))) blockers.push(`${row.id}/${criterion.id}: graph attempt or host provenance is missing`);
    }
  }
  let labels: LabelSet | undefined;
  try {
    labels = read<LabelSet>(CRITERION_LABELS);
  } catch {
    blockers.push("independent per-criterion ground-truth file is absent");
  }
  let reviewerA: ReviewRecord | undefined;
  let reviewerB: ReviewRecord | undefined;
  let adjudication: AdjudicationRecord | undefined;
  try { reviewerA = read<ReviewRecord>(REVIEWER_A); } catch { blockers.push("reviewer A annotation file is absent or malformed"); }
  try { reviewerB = read<ReviewRecord>(REVIEWER_B); } catch { blockers.push("reviewer B annotation file is absent or malformed"); }
  try { adjudication = read<AdjudicationRecord>(ADJUDICATION); } catch { blockers.push("independent adjudication record is absent or malformed"); }
  if (labels !== undefined && reviewerA !== undefined && reviewerB !== undefined && adjudication !== undefined) {
    const validCoverage = new Set(["covered", "omitted", "unresolved"]);
    const labelRows = Object.keys(labels.cases ?? {});
    if (labelRows.length !== rows.length) blockers.push("adjudicated label case count differs from the frozen corpus");
    if (labels.reviewStatus !== "AI-generated; not human-reviewed") blockers.push("label provenance does not disclose AI-generated, not human-reviewed status");
    if (labels.sourceCaseSha256 !== freeze.dataset.caseSha256) blockers.push("adjudicated labels are not bound to the frozen evidence case hash");
    if (labels.adjudicationSha256 !== sha256(readFileSync(ADJUDICATION))) blockers.push("label file does not bind the adjudication record hash");
    if (!reviewerA.reviewerId || !reviewerB.reviewerId || reviewerA.reviewerId === reviewerB.reviewerId ||
        labels.reviewerIds?.[0] !== reviewerA.reviewerId || labels.reviewerIds?.[1] !== reviewerB.reviewerId) blockers.push("reviewer identities are missing, reused, or not bound to labels");
    if (reviewerA.reviewStatus !== "AI-generated; not human-reviewed" || reviewerB.reviewStatus !== "AI-generated; not human-reviewed" ||
        reviewerA.assignmentRecord?.modelOutputsExposed !== false || reviewerB.assignmentRecord?.modelOutputsExposed !== false ||
        reviewerA.assignmentRecord?.otherReviewerAnswersExposed !== false || reviewerB.assignmentRecord?.otherReviewerAnswersExposed !== false ||
        reviewerA.assignmentRecord?.caseOrPolicyAuthorship !== false || reviewerB.assignmentRecord?.caseOrPolicyAuthorship !== false) blockers.push("review assignment provenance is incomplete or does not attest to blind independent contexts");
    const reviewerAHash = sha256(JSON.stringify(reviewAnswerProjection(reviewerA)));
    const reviewerBHash = sha256(JSON.stringify(reviewAnswerProjection(reviewerB)));
    if (!attestationValid(reviewerA.independenceAttestation, reviewerA.reviewerId, reviewerAHash) ||
        !attestationValid(reviewerB.independenceAttestation, reviewerB.reviewerId, reviewerBHash)) blockers.push("reviewer AI self-signature or signed annotation digest is invalid");
    if (reviewerA.coverageCases.length !== rows.length || reviewerB.coverageCases.length !== rows.length ||
        reviewerA.criterionCases.length !== requests.criterionCount || reviewerB.criterionCases.length !== requests.criterionCount) blockers.push("reviewer annotation count differs from 12 cases / 24 criteria");
    if (adjudication.schema !== "jev-dag-local-adjudication/1" || adjudication.reviewStatus !== "AI-generated; not human-reviewed" ||
        !adjudication.reviewerId || [reviewerA.reviewerId, reviewerB.reviewerId].includes(adjudication.reviewerId) || !adjudicationAttestationValid(adjudication)) blockers.push("adjudicator identity, provenance, or AI self-signature is invalid");
    const adjudications = new Map(adjudication.criterionCases.map((item) => [`${item.caseRef}/${item.criterionId}`, item]));
    const seenA = new Set<string>();
    const seenB = new Set<string>();
    for (const row of rows) {
      const caseRef = sha256(row.id).slice(0, 16);
      const label = labels.cases[row.id];
      const coverageA = reviewerA.coverageCases.find((item) => item.caseRef === caseRef);
      const coverageB = reviewerB.coverageCases.find((item) => item.caseRef === caseRef);
      if (coverageA === undefined || coverageB === undefined || label === undefined) {
        blockers.push(`${row.id}: reviewer coverage or adjudicated label is missing`);
        continue;
      }
      const coverage = coverageA.objectiveCoverage.expected;
      if (!validCoverage.has(coverage) || coverage !== coverageB.objectiveCoverage.expected || label.objectiveCoverage !== coverage ||
          !coverageA.objectiveCoverage.rationale?.trim() || !coverageB.objectiveCoverage.rationale?.trim()) blockers.push(`${row.id}: coverage labels disagree, are invalid, or lack rationale`);
      if (coverageA.objective !== row.evidence.objective || coverageB.objective !== row.evidence.objective ||
          JSON.stringify(coverageA.criteria) !== JSON.stringify(row.evidence.criteria.map(({ id, statement }) => ({ criterionId: id, requirement: statement }))) ||
          JSON.stringify(coverageB.criteria) !== JSON.stringify(row.evidence.criteria.map(({ id, statement }) => ({ criterionId: id, requirement: statement })))) blockers.push(`${row.id}: blind coverage packet no longer matches frozen objective/criteria`);
      if (label.adjudicated !== true || label.reviewerIds?.[0] !== reviewerA.reviewerId || label.reviewerIds?.[1] !== reviewerB.reviewerId) blockers.push(`${row.id}: final labels do not bind both distinct reviewers`);
      const expectedIds = row.evidence.criteria.map((criterion) => criterion.id).sort();
      const labelIds = Object.keys(label.criteria ?? {}).sort();
      if (JSON.stringify(labelIds) !== JSON.stringify(expectedIds) || JSON.stringify(Object.keys(label.evidenceSufficiency ?? {}).sort()) !== JSON.stringify(expectedIds)) blockers.push(`${row.id}: final criterion IDs or evidence-sufficiency labels do not exactly match source criteria`);
      const criterionChoices: SemanticFulfillmentChoice[] = [];
      for (const criterion of row.evidence.criteria) {
        const key = `${caseRef}/${criterion.id}`;
        const itemA = reviewerA.criterionCases.find((item) => item.caseRef === caseRef && item.criterionId === criterion.id);
        const itemB = reviewerB.criterionCases.find((item) => item.caseRef === caseRef && item.criterionId === criterion.id);
        const expected = label.criteria[criterion.id];
        if (itemA === undefined || itemB === undefined) {
          blockers.push(`${row.id}/${criterion.id}: reviewer criterion judgment is missing`);
          continue;
        }
        seenA.add(key); seenB.add(key);
        const boundRequest = dagLocalCriterionRequest(row.evidence, criterion.id);
        if (JSON.stringify(itemA.isolatedEvidenceContext) !== JSON.stringify(boundRequest?.state) || JSON.stringify(itemB.isolatedEvidenceContext) !== JSON.stringify(boundRequest?.state)) blockers.push(`${row.id}/${criterion.id}: reviewer evidence context differs from the frozen criterion request`);
        if (!itemA.rationale?.trim() || !itemB.rationale?.trim() || typeof itemA.evidenceSufficient !== "boolean" || typeof itemB.evidenceSufficient !== "boolean") blockers.push(`${row.id}/${criterion.id}: reviewer rationale or evidence-sufficiency judgment is missing`);
        const adjudicated = adjudications.get(key);
        if (itemA.expected !== itemB.expected) {
          if (adjudicated === undefined || !adjudicated.rationale?.trim() || !adjudicated.resolvesDisagreement?.trim() || expected !== adjudicated.expected) blockers.push(`${row.id}/${criterion.id}: reviewer disagreement lacks explicit adjudicator resolution`);
          else if (label.adjudications?.some((entry) => entry.criterionId === criterion.id && entry.adjudicatorId === adjudication.reviewerId) !== true) blockers.push(`${row.id}/${criterion.id}: label file does not reference its adjudicator`);
        } else if (adjudicated !== undefined || expected !== itemA.expected) blockers.push(`${row.id}/${criterion.id}: consensus label conflicts with reviewers or has an unnecessary adjudication`);
        if (expected === undefined || !["FULFILLED", "NOT_FULFILLED", "UNCERTAIN"].includes(expected) || typeof label.evidenceSufficiency[criterion.id] !== "boolean") blockers.push(`${row.id}/${criterion.id}: final label or evidence-sufficiency value is invalid`);
        if (label.evidenceSufficiency[criterion.id] !== itemA.evidenceSufficient && label.evidenceSufficiency[criterion.id] !== itemB.evidenceSufficient) blockers.push(`${row.id}/${criterion.id}: final evidence-sufficiency disposition is not supported by reviewers`);
        if (expected !== undefined) criterionChoices.push(expected);
      }
      const expectedOverall: SemanticFulfillmentChoice = coverage === "omitted" || criterionChoices.includes("NOT_FULFILLED") ? "NOT_FULFILLED" :
        coverage === "unresolved" || criterionChoices.includes("UNCERTAIN") ? "UNCERTAIN" :
        criterionChoices.length === row.evidence.criteria.length && criterionChoices.every((choice) => choice === "FULFILLED") ? "FULFILLED" : "UNCERTAIN";
      if (label.expectedOverall !== expectedOverall) blockers.push(`${row.id}: overall label does not match coverage and adjudicated criterion judgments`);
    }
    if (seenA.size !== requests.criterionCount || seenB.size !== requests.criterionCount) blockers.push("reviewer criterion IDs contain duplicates, extras, or omissions");
    if (adjudications.size !== 1 || adjudications.size !== labels.disagreements?.length ||
        JSON.stringify(labels.disagreements) !== JSON.stringify(adjudication.disagreements)) blockers.push("adjudication/disagreement record is incomplete or includes unrecorded disputes");
  }
  if (freeze.dataset.annotationSha256 == null) blockers.push("freeze does not yet bind completed independent annotations");
  else if (existsSync(CRITERION_LABELS) && sha256(readFileSync(CRITERION_LABELS)) !== freeze.dataset.annotationSha256) blockers.push("independent annotation hash differs from freeze");
  else if (!existsSync(CRITERION_LABELS)) blockers.push("independent criterion ground truth is absent");
  if (freeze.dataset.reviewerASha256 == null || !existsSync(REVIEWER_A) || sha256(readFileSync(REVIEWER_A)) !== freeze.dataset.reviewerASha256) blockers.push("reviewer A annotation hash differs from freeze");
  if (freeze.dataset.reviewerBSha256 == null || !existsSync(REVIEWER_B) || sha256(readFileSync(REVIEWER_B)) !== freeze.dataset.reviewerBSha256) blockers.push("reviewer B annotation hash differs from freeze");
  if (freeze.dataset.adjudicationSha256 == null || !existsSync(ADJUDICATION) || sha256(readFileSync(ADJUDICATION)) !== freeze.dataset.adjudicationSha256) blockers.push("adjudication hash differs from freeze");
  const packetA = resolve(ROOT, "bench/annotation/mission-dag-local-review-v1-reviewer-a.blind-packet.json");
  const packetB = resolve(ROOT, "bench/annotation/mission-dag-local-review-v1-reviewer-b.blind-packet.json");
  if (freeze.dataset.reviewerAPacketSha256 == null || !existsSync(packetA) || sha256(readFileSync(packetA)) !== freeze.dataset.reviewerAPacketSha256) blockers.push("reviewer A original blind-packet hash differs from freeze");
  if (freeze.dataset.reviewerBPacketSha256 == null || !existsSync(packetB) || sha256(readFileSync(packetB)) !== freeze.dataset.reviewerBPacketSha256) blockers.push("reviewer B original blind-packet hash differs from freeze");
  return { rows, freeze, ...(labels === undefined ? {} : { labels }), blockers: [...new Set(blockers)], requests };
}

function freezeAnnotations(): number {
  if (IS_LATEST_PROFILE) throw new Error("annotation freeze is shared and immutable; prepare labels under the pinned source profile only");
  const freeze = read<Freeze>(FREEZE);
  const labels = read<LabelSet>(CRITERION_LABELS);
  const reviewerA = read<ReviewRecord>(REVIEWER_A);
  const reviewerB = read<ReviewRecord>(REVIEWER_B);
  const adjudication = read<AdjudicationRecord>(ADJUDICATION);
  const rows = readFileSync(resolve(DATASET, "cases.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as CaseRow);
  const errors: string[] = [];
  if (!reviewerA.reviewerId?.trim() || !reviewerB.reviewerId?.trim() || reviewerA.reviewerId === reviewerB.reviewerId ||
      reviewerA.reviewStatus !== "AI-generated; not human-reviewed" || reviewerB.reviewStatus !== "AI-generated; not human-reviewed") errors.push("reviewer identities or AI provenance are missing/invalid");
  if (!attestationValid(reviewerA.independenceAttestation, reviewerA.reviewerId, sha256(JSON.stringify(reviewAnswerProjection(reviewerA)))) ||
      !attestationValid(reviewerB.independenceAttestation, reviewerB.reviewerId, sha256(JSON.stringify(reviewAnswerProjection(reviewerB)))) ||
      !adjudicationAttestationValid(adjudication)) errors.push("reviewer/adjudicator AI self-signature or signed annotation digest is invalid");
  if (reviewerA.coverageCases.length !== rows.length || reviewerB.coverageCases.length !== rows.length ||
      reviewerA.criterionCases.length !== freeze.dataset.criterionCount || reviewerB.criterionCases.length !== freeze.dataset.criterionCount || rows.length !== 12 ||
      adjudication.reviewStatus !== "AI-generated; not human-reviewed" || !adjudication.reviewerId ||
      [reviewerA.reviewerId, reviewerB.reviewerId].includes(adjudication.reviewerId)) errors.push("review/adjudication identity or count differs from the frozen evidence set");
  const adjudications = new Map(adjudication.criterionCases.map((item) => [`${item.caseRef}/${item.criterionId}`, item]));
  const observedDisagreements: Array<{ caseRef: string; criterionId: string; reviewerA: string; reviewerB: string; adjudicator: string; rationale: string }> = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const caseRef = sha256(row.id).slice(0, 16);
    const reviewA = reviewerA.coverageCases.find((entry) => entry.caseRef === caseRef);
    const reviewB = reviewerB.coverageCases.find((entry) => entry.caseRef === caseRef);
    const label = labels.cases[row.id];
    if (reviewA === undefined || reviewB === undefined || label === undefined) {
      errors.push(`${row.id}: review/label identity is missing or mismatched`);
      continue;
    }
    if (label.reviewerIds[0] !== reviewerA.reviewerId || label.reviewerIds[1] !== reviewerB.reviewerId || label.adjudicated !== true) errors.push(`${row.id}: adjudication does not identify both independent reviewers`);
    const coverage = reviewA.objectiveCoverage.expected;
    if (!coverage || coverage !== reviewB.objectiveCoverage.expected || !["covered", "omitted", "unresolved"].includes(coverage) ||
        !reviewA.objectiveCoverage.rationale?.trim() || !reviewB.objectiveCoverage.rationale?.trim()) errors.push(`${row.id}: independent objective coverage labels disagree, are invalid, or lack rationale`);
    if (label.objectiveCoverage !== coverage) errors.push(`${row.id}: final objective coverage label differs from independent reviews`);
    const criterionChoices: SemanticFulfillmentChoice[] = [];
    for (const criterion of row.evidence.criteria) {
      const itemA = reviewerA.criterionCases.find((entry) => entry.caseRef === caseRef && entry.criterionId === criterion.id);
      const itemB = reviewerB.criterionCases.find((entry) => entry.caseRef === caseRef && entry.criterionId === criterion.id);
      let expected = label.criteria[criterion.id];
      if (itemA === undefined || itemB === undefined || !itemA.expected || !itemB.expected || !itemA.rationale?.trim() || !itemB.rationale?.trim() ||
          typeof itemA.evidenceSufficient !== "boolean" || typeof itemB.evidenceSufficient !== "boolean") {
        errors.push(`${row.id}/${criterion.id}: independent criterion judgments/rationales/evidence-sufficiency are incomplete`);
        continue;
      }
      if (itemA.expected !== itemB.expected) {
        const resolution = adjudications.get(`${caseRef}/${criterion.id}`);
        if (resolution === undefined || !resolution.rationale?.trim() || !resolution.resolvesDisagreement?.trim() || expected !== resolution.expected) {
          errors.push(`${row.id}/${criterion.id}: independent disagreement lacks explicit adjudication`);
        } else {
          expected = resolution.expected;
          observedDisagreements.push({ caseRef, criterionId: criterion.id, reviewerA: itemA.expected, reviewerB: itemB.expected, adjudicator: resolution.expected, rationale: resolution.rationale });
          if (label.adjudications?.some((entry) => entry.criterionId === criterion.id && entry.adjudicatorId === adjudication.reviewerId) !== true) errors.push(`${row.id}/${criterion.id}: label lacks adjudicator reference`);
        }
      } else if (expected !== itemA.expected || adjudications.has(`${caseRef}/${criterion.id}`)) {
        errors.push(`${row.id}/${criterion.id}: consensus label differs from reviewers or has unnecessary adjudication`);
      }
      const sufficient = itemA.evidenceSufficient === itemB.evidenceSufficient ? itemA.evidenceSufficient : false;
      if (label.evidenceSufficiency?.[criterion.id] !== sufficient) errors.push(`${row.id}/${criterion.id}: evidence-sufficiency label does not resolve reviewer assessments`);
      if (expected !== undefined) criterionChoices.push(expected);
    }
    const expectedOverall: SemanticFulfillmentChoice = coverage === "omitted" || criterionChoices.includes("NOT_FULFILLED")
      ? "NOT_FULFILLED"
      : coverage === "unresolved" || criterionChoices.includes("UNCERTAIN")
        ? "UNCERTAIN"
        : criterionChoices.length === row.evidence.criteria.length && criterionChoices.every((choice) => choice === "FULFILLED")
          ? "FULFILLED"
          : "UNCERTAIN";
    if (label.expectedOverall !== expectedOverall) errors.push(`${row.id}: deterministic case label does not match independent criterion/coverage annotations`);
  }
  if (observedDisagreements.length !== adjudications.size || JSON.stringify(observedDisagreements) !== JSON.stringify(labels.disagreements)) errors.push("adjudication record does not exactly match the observed reviewer disagreements");
  if (labels.sourceCaseSha256 !== freeze.dataset.caseSha256 || labels.adjudicationSha256 !== sha256(readFileSync(ADJUDICATION))) errors.push("adjudicated labels are not bound to frozen source and adjudication record");
  if (errors.length > 0) {
    console.error(JSON.stringify({ frozen: false, blockers: errors, inferenceRequests: 0 }, null, 2));
    return 2;
  }
  freeze.dataset.annotationSha256 = sha256(readFileSync(CRITERION_LABELS));
  freeze.dataset.reviewerASha256 = sha256(readFileSync(REVIEWER_A));
  freeze.dataset.reviewerBSha256 = sha256(readFileSync(REVIEWER_B));
  freeze.dataset.adjudicationSha256 = sha256(readFileSync(ADJUDICATION));
  freeze.dataset.reviewerAPacketSha256 = sha256(readFileSync(resolve(ROOT, "bench/annotation/mission-dag-local-review-v1-reviewer-a.blind-packet.json")));
  freeze.dataset.reviewerBPacketSha256 = sha256(readFileSync(resolve(ROOT, "bench/annotation/mission-dag-local-review-v1-reviewer-b.blind-packet.json")));
  (freeze as Freeze & { status?: string }).status = "frozen-awaiting-live-inference-authorization";
  writeFileSync(FREEZE, `${JSON.stringify(freeze, null, 2)}\n`, { flag: "w", mode: 0o600 });
  console.log(JSON.stringify({ frozen: true, freeze: FREEZE, annotationSha256: freeze.dataset.annotationSha256, reviewerASha256: freeze.dataset.reviewerASha256, reviewerBSha256: freeze.dataset.reviewerBSha256, adjudicationSha256: freeze.dataset.adjudicationSha256, inferenceRequests: 0 }, null, 2));
  return 0;
}

function preflight(): number {
  const state = loadAndCheck();
  console.log(JSON.stringify({
    ready: state.blockers.length === 0,
    blockers: state.blockers,
    requestCeiling: state.requests,
    concurrency: state.freeze.execution.concurrency,
    retries: state.freeze.execution.retries,
    hardCostCeilingUsd: state.freeze.execution.hardCostCeilingUsd,
    requestedModel: state.freeze.provider.requestedModel,
    requiredReturnedModel: state.freeze.provider.requiredReturnedModel,
    inferenceRequests: 0,
  }, null, 2));
  return state.blockers.length === 0 ? 0 : 2;
}

async function run(): Promise<number> {
  if (process.argv[3] !== "--authorized-inference-36") throw new Error("run requires the explicit --authorized-inference-36 flag");
  const state = loadAndCheck();
  if (state.blockers.length > 0) {
    console.error(JSON.stringify({ ready: false, blockers: state.blockers, inferenceRequests: 0 }, null, 2));
    return 2;
  }
  if (state.requests.total !== 36 || state.freeze.execution.hardCostCeilingUsd !== HARD_COST_CAP_USD) throw new Error("frozen safety ceilings do not match this runner");
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is missing; no request sent");
  const model: DecisionModel = new OpenRouterJevDecisionModel({ apiKey, model: state.freeze.provider.requestedModel, maxRetries: 0, timeoutMs: 20_000 });
  const results: Array<Record<string, unknown>> = [];
  const baselineCounts = { correct: 0, falseComplete: 0, falseRejection: 0, positiveRecognized: 0, abstained: 0 };
  const candidateCounts = { correct: 0, falseComplete: 0, falseRejection: 0, positiveRecognized: 0, abstained: 0, criterionCorrect: 0, criterionTotal: 0 };
  const hybridCounts = { correct: 0, falseComplete: 0, falseRejection: 0, positiveRecognized: 0, abstained: 0 };
  const accounting = {
    baseline: { costUsd: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0, requests: 0 },
    candidate: { costUsd: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0, requests: 0 },
  };
  let requests = 0;
  let costUsd = 0;
  for (const row of state.rows) {
    const baseline = affirmativeRequest(row.evidence);
    requests += 1;
    const baselineResult = await model.evaluate({ state: baseline.state as never, questions: baseline.questions });
    if (baselineResult.model !== state.freeze.provider.requiredReturnedModel || baselineResult.provider !== PROVIDER) throw new Error("baseline returned provider/model mismatch; batch aborted");
    if (baselineResult.questionHash !== state.freeze.baseline.questionHash) throw new Error("baseline question identity mismatch; batch aborted");
    if (baselineResult.usage.cost_usd === undefined) throw new Error("provider omitted request cost; hard cost ceiling cannot be enforced");
    costUsd += baselineResult.usage.cost_usd;
    accounting.baseline.costUsd += baselineResult.usage.cost_usd;
    accounting.baseline.latencyMs += baselineResult.latency_ms;
    accounting.baseline.inputTokens += baselineResult.usage.input_tokens;
    accounting.baseline.outputTokens += baselineResult.usage.output_tokens;
    accounting.baseline.requests += 1;
    if (costUsd > HARD_COST_CAP_USD) throw new Error("hard inference cost ceiling exceeded; batch aborted");
    const criterionJudgments: DagLocalCriterionJudgment[] = [];
    for (const criterion of row.evidence.criteria) {
      requests += 1;
      const judgment = await evaluateDagLocalCriterion(model, row.evidence, criterion.id);
      if (judgment === undefined || judgment.model !== state.freeze.provider.requiredReturnedModel || judgment.provider !== PROVIDER) throw new Error("criterion response invalid or provider/model mismatch; batch aborted");
      if (judgment.questionHash !== state.freeze.candidate.questionHash) throw new Error("criterion question identity mismatch; batch aborted");
      if (judgment.costUsd === undefined) throw new Error("provider omitted request cost; hard cost ceiling cannot be enforced");
      costUsd += judgment.costUsd;
      accounting.candidate.costUsd += judgment.costUsd;
      accounting.candidate.latencyMs += judgment.latencyMs;
      accounting.candidate.inputTokens += judgment.inputTokens;
      accounting.candidate.outputTokens += judgment.outputTokens;
      accounting.candidate.requests += 1;
      if (costUsd > HARD_COST_CAP_USD) throw new Error("hard inference cost ceiling exceeded; batch aborted");
      criterionJudgments.push(judgment);
    }
    const label = state.labels!.cases[row.id]!;
    const aggregate = aggregateDagLocalCriterionJudgments({
      evidence: row.evidence,
      judgments: criterionJudgments,
      expectedProvider: PROVIDER,
      expectedModel: state.freeze.provider.requiredReturnedModel,
      expectedQuestionHash: state.freeze.candidate.questionHash,
    });
    const rawBaseline = baselineResult.answers.closure;
    const baselineChoice = rawBaseline?.type === "choice" ? rawBaseline.choice : "INVALID";
    const baselineSemanticChoice: SemanticFulfillmentChoice = baselineChoice === "COMPLETE"
      ? "FULFILLED"
      : baselineChoice === "INCOMPLETE" ? "NOT_FULFILLED" : "UNCERTAIN";
    const baselineGateDisposition = globalBackstopDisposition(
      baselineChoice,
      rawBaseline?.type === "choice" ? rawBaseline.confidence : 0,
      rawBaseline?.type === "choice" ? rawBaseline.probabilities.COMPLETE ?? 0 : 0,
    );
    // The global judgment remains a distinct final semantic backstop for B.
    // It is the same frozen global request already measured for arm A; it is
    // never inferred from or replaced by the criterion aggregate.
    const hybridDisposition = combineWithGlobalBackstop(aggregate.disposition, baselineGateDisposition);
    const baselineCorrect = baselineSemanticChoice === label.expectedOverall;
    const candidateCorrect = aggregate.semanticDisposition === label.expectedOverall;
    const hybridCorrect = hybridDisposition === label.expectedOverall;
    baselineCounts.correct += Number(baselineCorrect);
    baselineCounts.falseComplete += Number(label.expectedOverall !== "FULFILLED" && baselineChoice === "COMPLETE");
    baselineCounts.falseRejection += Number(label.expectedOverall === "FULFILLED" && baselineSemanticChoice !== "FULFILLED");
    baselineCounts.positiveRecognized += Number(label.expectedOverall === "FULFILLED" && baselineSemanticChoice === "FULFILLED");
    baselineCounts.abstained += Number(baselineSemanticChoice === "UNCERTAIN");
    candidateCounts.correct += Number(candidateCorrect);
    candidateCounts.falseComplete += Number(label.expectedOverall !== "FULFILLED" && aggregate.semanticDisposition === "FULFILLED");
    candidateCounts.falseRejection += Number(label.expectedOverall === "FULFILLED" && aggregate.semanticDisposition !== "FULFILLED");
    candidateCounts.positiveRecognized += Number(label.expectedOverall === "FULFILLED" && aggregate.semanticDisposition === "FULFILLED");
    candidateCounts.abstained += Number(aggregate.semanticDisposition === "UNCERTAIN");
    hybridCounts.correct += Number(hybridCorrect);
    hybridCounts.falseComplete += Number(label.expectedOverall !== "FULFILLED" && hybridDisposition === "FULFILLED");
    hybridCounts.falseRejection += Number(label.expectedOverall === "FULFILLED" && hybridDisposition !== "FULFILLED");
    hybridCounts.positiveRecognized += Number(label.expectedOverall === "FULFILLED" && hybridDisposition === "FULFILLED");
    hybridCounts.abstained += Number(hybridDisposition === "UNCERTAIN");
    for (const judgment of criterionJudgments) {
      candidateCounts.criterionTotal += 1;
      candidateCounts.criterionCorrect += Number(judgment.choice === label.criteria[judgment.criterionId]);
    }
    results.push({
      caseId: row.id,
      expectedOverall: label.expectedOverall,
      baseline: { semanticChoice: baselineSemanticChoice, confidenceGatedDisposition: baselineGateDisposition, rawChoice: baselineChoice, correct: baselineCorrect, model: baselineResult.model, provider: baselineResult.provider, questionHash: baselineResult.questionHash, answers: baselineResult.answers, usage: baselineResult.usage, latencyMs: baselineResult.latency_ms },
      criterionJudgments,
      candidateAggregate: {
        ...aggregate,
        correct: candidateCorrect,
        semanticDispositionCorrect: aggregate.semanticDisposition === label.expectedOverall,
        hybridDisposition,
        hybridCorrect,
        independentlyReviewedObjectiveCoverage: label.objectiveCoverage,
      },
    });
  }
  const output = {
    schema: "jev-mission-dag-local-paired-results/1", provider: PROVIDER,
    requestedModel: state.freeze.provider.requestedModel, returnedModel: state.freeze.provider.requiredReturnedModel,
    requests, concurrency: 1, retries: 0, costUsd, hardCostCeilingUsd: HARD_COST_CAP_USD,
    semanticMetrics: { cases: results.length, baseline: baselineCounts, criterionLocal: candidateCounts, hybridWithGlobalBackstop: hybridCounts },
    armAccounting: accounting,
    enforcementMetrics: {
      candidateConfidenceGateDispositionCounts: results.reduce<Record<SemanticFulfillmentChoice, number>>((counts, row) => {
        const disposition = (row.candidateAggregate as { disposition: SemanticFulfillmentChoice }).disposition;
        counts[disposition] += 1;
        return counts;
      }, { FULFILLED: 0, NOT_FULFILLED: 0, UNCERTAIN: 0 }),
      candidateTerminalAuthorizations: 0,
      baselineTerminalGateEvaluated: false,
      globalBackstopUsedForHybrid: true,
      reason: "criterion-local dispositions are advisory; the frozen global response remains the separate final semantic backstop for the hybrid comparison; the candidate still has no terminal authority and the question family is unqualified",
    },
    terminalAuthorization: false, cases: results,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: "completed-development-evaluation", output: OUTPUT, requests, costUsd, terminalAuthorization: false }, null, 2));
  return 0;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2];
  if (mode === "prepare-dag-local") process.exitCode = await prepareDagLocal();
  else if (mode === "freeze-jev-latest") process.exitCode = await prepareJevLatestFreeze();
  else if (mode === "freeze-annotations") process.exitCode = freezeAnnotations();
  else if (mode === "preflight") process.exitCode = preflight();
  else if (mode === "run") process.exitCode = await run();
  else throw new Error("usage: tsx scripts/jev-dag-local-paired-dev.ts prepare-dag-local | freeze-jev-latest | freeze-annotations | preflight | run --authorized-inference-36 (set JEV_DAG_LOCAL_PROFILE=jev-latest for alias freeze/preflight/run)");
}
