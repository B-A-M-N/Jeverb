#!/usr/bin/env node
/**
 * Build and run the frozen 12-case paired Jev semantic-closure development
 * experiment. `prepare` uses the existing host-owned verifier pipeline and
 * makes no model calls. `run` is deliberately gated by an explicit
 * `--authorized-inference-24` flag and performs at most 24 serial OpenRouter
 * Decisions API requests with retries disabled.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { hashQuestions } from "../src/decision/provenance.js";
import type { DecisionModel, Question } from "../src/decision/types.js";
import { EvidenceLedger } from "../src/evidence/ledger.js";
import { FileJournal } from "../src/graph/journal.js";
import { Store } from "../src/hooks/store.js";
import { HOOK_VERSION } from "../src/hooks/version.js";
import {
  affirmativeRequest,
  MISSION_CLOSURE_QUESTION_V2,
  MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2,
  MISSION_SEMANTIC_FULFILLMENT_PROFILE_V2,
  preflightMissionClosure,
  preflightReachedReview,
  semanticFulfillmentCandidateRequest,
  type MissionClosureEvidence,
  type MissionClosurePolicy,
  type SemanticFulfillmentChoice,
} from "../src/mission/closure.js";
import { parseMissionAttestation, parseMissionContract, addMissionAttestations } from "../src/mission/contract.js";
import { createSessionMissionClosureSource } from "../src/mission/session-source.js";
import { produceHostVerificationInputs } from "../src/mission/runtime.js";
import { verificationReceiptIds } from "../src/mission/verifiers.js";
import { OpenRouterJevDecisionModel, probeOpenRouterJevEndpoint } from "../src/jev/openrouter.js";
import { JevConnectionError, JevError, type TransportDiagnostic } from "../src/jev/errors.js";
import { scoreSemanticQuestionPair, type SemanticQuestionPairScore } from "../src/jev/lockbox.js";
import { assertOutputPathAvailable, writeNewArtifact } from "./artifact-output.js";

const ROOT = process.cwd();
const BASE = join(ROOT, "bench/datasets/mission-semantic-fulfillment-dev-v2");
const CASES_PATH = join(BASE, "cases.jsonl");
const LABELS_PATH = join(BASE, "labels.json");
const MANIFEST_PATH = join(BASE, "manifest.json");
const FREEZE_PATH = join(ROOT, "bench/analysis/semantic-fulfillment-candidate-v2-freeze-2026-11-03.json");
const RESULTS_PATH = join(ROOT, "bench/results/mission-semantic-fulfillment-dev-v2.transport-fixed.openrouter-results.json");
const REQUEST_CAP = 24;
const EXPECTED_MODEL = "typesafe/jev-1.14-20261014";
const REQUESTED_MODEL = "typesafe/jev-latest";
const PROVIDER = "openrouter";
const MIN_CONFIDENCE = 0.9;
const CLOSURE_POLICY_VERSION = "mission-closure/1";
const CANDIDATE_POLICY_VERSION = MISSION_SEMANTIC_FULFILLMENT_PROFILE_V2;
const PREP_TIME = 1_800_000_000_000;
const SMOKE_QUESTION = {
  state: { probe: "transport-smoke", proposition: "2 is greater than 1." },
  questions: {
    result: {
      type: "noul" as const,
      instructions: "Is the proposition in `proposition` true?",
      criteria: { true: "The stated arithmetic proposition is true.", false: "The stated arithmetic proposition is false." },
    },
  },
};

export function createFailFastDecisionModel(model: DecisionModel): {
  model: DecisionModel;
  readonly attemptedRequests: number;
  readonly transportFailure: TransportDiagnostic | undefined;
} {
  let attemptedRequests = 0;
  let transportFailure: TransportDiagnostic | undefined;
  const guarded = new Proxy(model, {
    get(target, property, receiver) {
      if (property === "evaluate") return async (request: Parameters<DecisionModel["evaluate"]>[0]) => {
        if (transportFailure !== undefined) {
          throw new JevConnectionError("Batch stopped after a prior provider transport failure.", {
            code: transportFailure.code,
            transportDiagnostic: transportFailure,
          });
        }
        attemptedRequests += 1;
        try {
          return await target.evaluate(request);
        } catch (error) {
          if (error instanceof JevError && error.transportDiagnostic !== undefined) {
            transportFailure = error.transportDiagnostic;
          }
          throw error;
        }
      };
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    model: guarded,
    get attemptedRequests() { return attemptedRequests; },
    get transportFailure() { return transportFailure; },
  };
}

export type CriterionPlan = { statement: string; outcome: string; observedArtifact: string };
export type CasePlan = {
  id: string;
  family: string;
  expected: SemanticFulfillmentChoice;
  rationale: string;
  objective: string;
  criteria: CriterionPlan[];
};
type EvidenceRow = { id: string; evidence: MissionClosureEvidence };
type LabelSet = { schema: string; cases: Record<string, { expected: SemanticFulfillmentChoice; family: string; rationale: string }> };
type ProvenanceRow = {
  id: string;
  candidateDigest: string;
  missionRevision: string;
  evidenceRevision: string;
  baselineQuestionHash: string;
  candidateQuestionHash: string;
  verifierIds: string[];
  verifierReceiptIds: string[];
  receiptPath: string;
  receiptSha256: string;
  graphJournalPath: string;
  graphJournalSha256: string;
  hostCheckOutputSha256: string;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

function require(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`jev-semantic-paired-dev: ${detail}`);
}

export function plans(): CasePlan[] {
  return [
    { id: "p01-config-policy", family: "configuration", expected: "FULFILLED", rationale: "Both requested settings are present at their exact required values in host-read files.", objective: "Create a service configuration with three retries and a 250 millisecond timeout.", criteria: [
      { statement: "The retry limit is three.", outcome: "Observed config value: retries=3.", observedArtifact: "retries=3\n" },
      { statement: "The request timeout is 250 milliseconds.", outcome: "Observed config value: timeout_ms=250.", observedArtifact: "timeout_ms=250\n" },
    ] },
    { id: "p02-auth-scope", family: "authorization", expected: "FULFILLED", rationale: "The host-observed role matrix contains the requested read and write grants and excludes the unrequested admin grant.", objective: "Allow the operator role to read and write reports while denying administrative access.", criteria: [
      { statement: "Operator report reads are allowed.", outcome: "Host-observed matrix: operator/read_reports=allow.", observedArtifact: "operator/read_reports=allow\n" },
      { statement: "Operator report writes are allowed and admin actions are denied.", outcome: "Host-observed matrix: operator/write_reports=allow; operator/admin=deny.", observedArtifact: "operator/write_reports=allow\noperator/admin=deny\n" },
    ] },
    { id: "p03-backup", family: "backup-and-restore", expected: "FULFILLED", rationale: "The backup schedule, encryption marker, and measured restore time satisfy every requested condition.", objective: "Run encrypted backups nightly and restore a full account in under one hour.", criteria: [
      { statement: "A nightly backup is produced with encryption enabled.", outcome: "Host-observed backup record: schedule=nightly; encryption=enabled.", observedArtifact: "schedule=nightly\nencryption=enabled\n" },
      { statement: "The full-account restore completes in less than 60 minutes.", outcome: "Host-observed restore duration: 42 minutes.", observedArtifact: "restore_minutes=42\nscope=full_account\n" },
    ] },
    { id: "p04-search-index", family: "search", expected: "FULFILLED", rationale: "Freshness and exact-title ranking measurements cover both requirements in the objective.", objective: "Index all submitted documents within one minute and rank exact title matches first.", criteria: [
      { statement: "Index freshness remains below one minute.", outcome: "Host-observed freshness probe: maximum lag=38 seconds.", observedArtifact: "max_lag_seconds=38\n" },
      { statement: "Exact title matches rank first in the query fixture.", outcome: "Host-observed rank check: exact_title_position=1 for every fixture query.", observedArtifact: "exact_title_position=1\nqueries_checked=24\n" },
    ] },
    { id: "p05-notification", family: "notifications", expected: "FULFILLED", rationale: "The host-observed delivery and retry records cover both notification delivery and retry behavior requested.", objective: "Deliver account alerts and retry transient delivery failures at most twice.", criteria: [
      { statement: "Account alerts reach the configured delivery sink.", outcome: "Host-observed delivery record: alert=delivered.", observedArtifact: "alert=delivered\n" },
      { statement: "Transient failures are retried no more than twice.", outcome: "Host-observed retry record: transient_retries=2; terminal=delivered.", observedArtifact: "transient_retries=2\nterminal=delivered\n" },
    ] },
    { id: "p06-api-migration", family: "api-migration", expected: "FULFILLED", rationale: "The host-observed route and sunset records jointly satisfy coexistence, writes, and migration notice.", objective: "Serve API v2 reads and writes alongside v1 and give six months notice before v1 sunset.", criteria: [
      { statement: "API v2 reads and writes succeed during coexistence.", outcome: "Host-observed route probes: v2_read=200; v2_write=201; v1=available.", observedArtifact: "v2_read=200\nv2_write=201\nv1=available\n" },
      { statement: "The v1 sunset notice is at least six months.", outcome: "Host-observed notice interval: 183 days.", observedArtifact: "sunset_notice_days=183\n" },
    ] },
    { id: "n01-backup-regions", family: "omitted-requirement", expected: "NOT_FULFILLED", rationale: "The objective requires every region, while the only verified record covers the primary region; secondary regions are omitted.", objective: "Create encrypted nightly backups in every region and verify a full-account restore under one hour.", criteria: [
      { statement: "A nightly encrypted backup record is available.", outcome: "Host-observed record covers the primary region only; secondary regions are not represented.", observedArtifact: "region=primary\nschedule=nightly\nencryption=enabled\n" },
      { statement: "A primary-region restore measurement is recorded.", outcome: "Host-observed primary-region restore duration: 41 minutes; no secondary-region restore was measured.", observedArtifact: "region=primary\nrestore_minutes=41\n" },
    ] },
    { id: "n02-api-partial", family: "partial-fulfillment", expected: "NOT_FULFILLED", rationale: "The objective requires v2 read and write support, but the observed route report shows reads pass and writes are unavailable.", objective: "Serve API v2 reads and writes alongside v1 during migration.", criteria: [
      { statement: "The v2 read route probe is recorded.", outcome: "Host-observed route result: v2_read=200.", observedArtifact: "v2_read=200\n" },
      { statement: "The v2 write route probe result is recorded.", outcome: "Host-observed route result: v2_write=unavailable; the requested write capability is not demonstrated.", observedArtifact: "v2_write=unavailable\n" },
    ] },
    { id: "n03-redaction-conflict", family: "contradictory-evidence", expected: "UNCERTAIN", rationale: "Two current host-verified samples conflict about whether the same token was redacted, so the evidence cannot establish the requested property.", objective: "Redact every access token from audit records while preserving actor identity.", criteria: [
      { statement: "The audit redaction sample is recorded.", outcome: "Host-observed sample A: token=redacted; actor=present.", observedArtifact: "sample=A\ntoken=redacted\nactor=present\n" },
      { statement: "A second audit redaction sample is recorded.", outcome: "Host-observed sample B for the same token path: token=present; actor=present.", observedArtifact: "sample=B\ntoken=present\nactor=present\n" },
    ] },
    { id: "n04-retry-test-coverage", family: "inadequate-verification", expected: "UNCERTAIN", rationale: "The host verified only that a smoke test passed; its own report says the required retry path was not exercised.", objective: "Make payment submission idempotent when the provider retries a timed-out request.", criteria: [
      { statement: "The available smoke-test report is captured.", outcome: "Host-observed report: smoke=pass; provider retry path=not exercised.", observedArtifact: "smoke=pass\nprovider_retry_path=not_exercised\n" },
      { statement: "The test report is bound to the current candidate.", outcome: "Host-observed report digest is bound to this candidate; no idempotency assertion is present.", observedArtifact: "candidate_bound=true\nidempotency_assertion=absent\n" },
    ] },
    { id: "n05-dashboard-scope", family: "omitted-requirement", expected: "NOT_FULFILLED", rationale: "The objective requires dashboard coverage and alerts in all regions, but the host-observed evidence covers only the primary region.", objective: "Show latency and error-rate dashboards with alerts in every region.", criteria: [
      { statement: "Latency and error-rate panels are available in the primary region.", outcome: "Host-observed dashboard: latency=present; errors=present; region=primary.", observedArtifact: "region=primary\nlatency_panel=present\nerror_panel=present\n" },
      { statement: "The primary-region alert route is recorded.", outcome: "Host-observed alert route: primary=enabled; other regions are not measured.", observedArtifact: "primary_alert=enabled\nother_regions=unmeasured\n" },
    ] },
    { id: "n06-search-partial", family: "partial-fulfillment", expected: "NOT_FULFILLED", rationale: "The objective requires all documents indexed within one minute and exact-title ranking; evidence covers only the first 100 documents.", objective: "Index the full document corpus within one minute and rank exact title matches first.", criteria: [
      { statement: "A bounded indexing sample is measured.", outcome: "Host-observed sample: first 100 documents indexed within 44 seconds; remaining corpus unmeasured.", observedArtifact: "sample_size=100\nlag_seconds=44\nremaining_corpus=unmeasured\n" },
      { statement: "A bounded exact-title ranking sample is measured.", outcome: "Host-observed sample: exact-title position=1 for the same 100-document subset only.", observedArtifact: "sample_size=100\nexact_title_position=1\n" },
    ] },
  ];
}

function writeSwitch(path: string): void {
  writeFileSync(path, `${JSON.stringify({
    schema_version: 1, desired: "ON", generation: randomUUID().replaceAll("-", ""),
    updated_at: PREP_TIME, used_request_ids: [],
  })}\n`, { flag: "wx", mode: 0o600 });
}

function writeGraphJournal(dataDir: string, sessionId: string, inputHash: string, outputDigest: string): string {
  const graphDir = join(dataDir, "graph-journals");
  mkdirSync(graphDir, { mode: 0o700 });
  const journal = new FileJournal("run-1", graphDir, sessionId);
  journal.record({ type: "run-started", runId: "run-1", ts: "2026-11-03T18:00:00.000Z", graphHash: sha256("semantic-dev-graph"), policyHash: sha256("semantic-dev-policy") });
  journal.record({ type: "node-authorized", runId: "run-1", ts: "2026-11-03T18:00:01.000Z", nodeId: "produce-evidence", attemptId: "produce-evidence/1", allowed: true, inputHash });
  journal.record({ type: "node-running", runId: "run-1", ts: "2026-11-03T18:00:02.000Z", nodeId: "produce-evidence", attemptId: "produce-evidence/1", inputHash });
  journal.record({ type: "node-terminal", runId: "run-1", ts: "2026-11-03T18:00:03.000Z", nodeId: "produce-evidence", attemptId: "produce-evidence/1", status: "succeeded", inputHash, outputDigest });
  return join(graphDir, "jeverb-graph-run-1.jsonl");
}

function runHostArtifactCheck(root: string, expected: Array<{ path: string; digest: string }>): { exitCode: number; output: string } {
  const source = `const fs=require('node:fs'),c=${JSON.stringify(expected)};for(const x of c){const b=fs.readFileSync(x.path);const h=require('node:crypto').createHash('sha256').update(b).digest('hex');if(h!==x.digest)process.exit(2);process.stdout.write(x.path+':'+h+'\\n')}`;
  try {
    const output = execFileSync(process.execPath, ["--eval", source], { cwd: root, encoding: "utf8", timeout: 10_000 });
    return { exitCode: 0, output };
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    const status = (error as { status?: unknown }).status;
    return { exitCode: typeof status === "number" ? status : 1, output: typeof stdout === "string" ? stdout : "" };
  }
}

export async function buildCase(plan: CasePlan, receiptDir: string, journalDir: string): Promise<{ row: EvidenceRow; label: LabelSet["cases"][string]; provenance: ProvenanceRow }> {
  const sessionId = `semantic-dev-${plan.id}`;
  const temp = mkdtempSync(join(tmpdir(), "jeverb-semantic-dev-"));
  try {
    const dataDir = join(temp, "session-data");
    const evidenceRoot = join(temp, "observed-artifacts");
    mkdirSync(dataDir, { mode: 0o700 });
    mkdirSync(evidenceRoot, { mode: 0o700 });
    const switchPath = join(dataDir, "control-state.json");
    writeSwitch(switchPath);
    const store = new Store(dataDir, { masterSwitchPath: switchPath, requireRootOwnedMasterSwitch: false });
    const ledger = new EvidenceLedger(join(dataDir, "evidence.log"), { switchPath, requireRootOwnedSwitch: false });
    const prompt = `${plan.objective}\n\nAcceptance criteria:\n${plan.criteria.map((criterion) => `- ${criterion.statement}`).join("\n")}`;
    const contract = parseMissionContract(sessionId, prompt, PREP_TIME);
    require(contract !== undefined, `${plan.id}: mission contract did not parse`);

    const expectedFiles: Array<{ path: string; digest: string }> = [];
    for (let index = 0; index < plan.criteria.length; index += 1) {
      const path = `criterion-${String(index + 1).padStart(2, "0")}.txt`;
      const content = plan.criteria[index]!.observedArtifact;
      writeFileSync(join(evidenceRoot, path), content, { flag: "wx", mode: 0o600 });
      expectedFiles.push({ path, digest: sha256(content) });
    }
    const inputHash = sha256(prompt);
    const outputDigest = sha256(expectedFiles.map((item) => `${item.path}:${item.digest}`).join("\n"));
    const journalPath = writeGraphJournal(dataDir, sessionId, inputHash, outputDigest);
    const hostCheck = runHostArtifactCheck(evidenceRoot, expectedFiles);
    require(hostCheck.exitCode === 0, `${plan.id}: host artifact check failed`);

    store.updateSession(sessionId, (state) => ({
      ...state,
      mission_contract: contract,
      verification: { last: { kind: "test", ok: true, ts: PREP_TIME, command: "jev-semantic-dev-host-artifact-check" }, edits_since: 0 },
    }));
    const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => PREP_TIME }).load(sessionId, contract.missionId);
    require(probe.candidateDigest !== undefined && probe.candidateRevision !== undefined, `${plan.id}: candidate identity missing`);

    const verifyPrompt = [
      "Acceptance verification:", `mission_id: ${contract.missionId}`, `mission_revision: ${contract.missionRevision}`, "verified:",
      ...contract.criteria.map((criterion, index) => `- ${criterion.id}: ${plan.criteria[index]!.outcome}`),
    ].join("\n");
    const attestations = parseMissionAttestation(sessionId, verifyPrompt, contract, PREP_TIME + 1);
    require(attestations !== undefined, `${plan.id}: host fixture attestations did not parse`);
    const testReceipt = sha256(`independent-test:${sessionId}:${hostCheck.output}`);
    store.updateSession(sessionId, (state) => ({
      ...state,
      mission_contract: {
        ...addMissionAttestations(contract, attestations),
        independentVerifications: [{
          verifierId: "semantic-dev-host-test", missionRevision: contract.missionRevision,
          evidenceRevision: probe.candidateRevision!, candidate: probe.candidateDigest!,
          verificationResult: "pass", receiptCorrelationId: testReceipt, verifiedAt: PREP_TIME + 2,
        }],
      },
    }));

    const produced = await produceHostVerificationInputs({
      store, dataDir, sessionId, missionId: contract.missionId, ledger, evidenceRoot, now: () => PREP_TIME + 3,
      specs: contract.criteria.map((criterion, index) => ({
        criterionId: criterion.id,
        producers: [{ runId: "run-1", nodeId: "produce-evidence", attemptId: "produce-evidence/1" }],
        files: [{ path: expectedFiles[index]!.path, expectedDigest: expectedFiles[index]!.digest }],
      })),
    });
    require(produced.reports.length === contract.criteria.length && produced.reports.every((report) => report.status === "satisfied"), `${plan.id}: one or more host criterion verifiers did not satisfy`);
    const receiptRows = ledger.read().records;
    const receiptIds = verificationReceiptIds(receiptRows);
    require(produced.verifications.length === contract.criteria.length && produced.verifications.every((row) => receiptIds.has(row.receiptCorrelationId)), `${plan.id}: verifier receipt not durably persisted`);

    const evidence = await createSessionMissionClosureSource({
      store, dataDir, now: () => PREP_TIME + 4, ledger, enableTrustedGraphEvidence: true,
      criterionProducerAssociations: produced.associations,
      criterionVerifications: produced.verifications,
      trustedVerifierIds: ["file-state"],
    }).load(sessionId, contract.missionId);
    const baselineQuestionHash = hashQuestions(affirmativeRequest(evidence).questions);
    const candidatePolicy = policyFor(MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2, CANDIDATE_POLICY_VERSION);
    require(semanticFulfillmentCandidateRequest(evidence, candidatePolicy) !== undefined, `${plan.id}: candidate request not eligible`);
    const baselinePolicy = policyFor(MISSION_CLOSURE_QUESTION_V2, CLOSURE_POLICY_VERSION);
    require(preflightReachedReview(preflightMissionClosure(evidence, baselinePolicy)), `${plan.id}: baseline preflight did not reach review`);
    require(baselineQuestionHash === baselinePolicy.questionHash, `${plan.id}: baseline request question hash changed`);

    const receiptPath = join(receiptDir, `${plan.id}.jsonl`);
    const journalOut = join(journalDir, `${plan.id}.jsonl`);
    const receiptBytes = readFileSync(join(dataDir, "evidence.log"));
    const journalBytes = readFileSync(journalPath);
    writeNewArtifact(receiptPath, receiptBytes);
    writeNewArtifact(journalOut, journalBytes);
    const row: EvidenceRow = { id: plan.id, evidence };
    const label = { expected: plan.expected, family: plan.family, rationale: plan.rationale };
    const provenance: ProvenanceRow = {
      id: plan.id,
      candidateDigest: evidence.candidateDigest!,
      missionRevision: evidence.missionRevision,
      evidenceRevision: evidence.evidenceRevision,
      baselineQuestionHash,
      candidateQuestionHash: hashQuestions({ closure: MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2 }),
      verifierIds: [...new Set(produced.verifications.map((item) => item.verifierId))].sort(),
      verifierReceiptIds: produced.verifications.map((item) => item.receiptCorrelationId).sort(),
      receiptPath: `receipts/${plan.id}.jsonl`,
      receiptSha256: sha256(receiptBytes),
      graphJournalPath: `journals/${plan.id}.jsonl`,
      graphJournalSha256: sha256(journalBytes),
      hostCheckOutputSha256: sha256(hostCheck.output),
    };
    return { row, label, provenance };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function policyFor(question: Question, policyVersion: string): MissionClosurePolicy {
  return {
    policyVersion,
    minConfidence: MIN_CONFIDENCE,
    calibrated: true,
    backend: PROVIDER,
    model: REQUESTED_MODEL,
    modelVersion: EXPECTED_MODEL,
    questionHash: hashQuestions({ closure: question }),
    calibrationVersion: "semantic-paired-dev-v2",
  };
}

function validateDataset(rows: EvidenceRow[], labels: LabelSet, provenance: ProvenanceRow[]): void {
  require(rows.length === 12 && Object.keys(labels.cases).length === 12 && provenance.length === 12, "expected exactly 12 cases, labels, and provenance rows");
  const positives = Object.values(labels.cases).filter((item) => item.expected === "FULFILLED").length;
  const negatives = rows.length - positives;
  require(positives === 6 && negatives === 6, `expected 6 positive/6 hard-negative cases, got ${positives}/${negatives}`);
  require(new Set(rows.map((row) => row.id)).size === 12, "case ids are not unique");
  require(rows.every((row) => labels.cases[row.id] !== undefined), "a case has no independent development label");
  require(rows.every((row) => preflightReachedReview(preflightMissionClosure(row.evidence, policyFor(MISSION_CLOSURE_QUESTION_V2, CLOSURE_POLICY_VERSION)))), "a dataset case does not reach semantic review");
}

function createFreeze(args: { casesHash: string; labelsHash: string; manifestHash: string; baselineHash: string }): Record<string, unknown> {
  const sourceFiles = [
    "src/mission/closure.ts", "src/jev/lockbox.ts", "src/mission/session-source.ts",
    "src/mission/runtime.ts", "src/mission/verifiers.ts", "src/mission/graph-binding.ts",
  ];
  const implementationHashes = Object.fromEntries(sourceFiles.map((path) => [path, sha256(readFileSync(join(ROOT, path)))]));
  const policy = {
    policyVersion: CANDIDATE_POLICY_VERSION,
    confidenceStatistic: "TypeSafe Choice concentration: (pMax - 1/3) / (1 - 1/3); not correctness probability",
    minConfidence: MIN_CONFIDENCE,
    requestedProvider: PROVIDER,
    requestedModel: REQUESTED_MODEL,
    expectedReturnedModel: EXPECTED_MODEL,
    adapterVersion: HOOK_VERSION,
    maxRetries: 0,
    semanticDispositionMap: { FULFILLED: "COMPLETE", NOT_FULFILLED: "INCOMPLETE", UNCERTAIN: "INSUFFICIENT_EVIDENCE" },
    releaseFloor: { minLiveness: 0.95, minPositives: 60, minNegatives: 149, maxFalseTerminalCompletions: 0 },
    implementationHashes,
  };
  const questionHash = hashQuestions({ closure: MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2 });
  const identity = {
    evidenceProfile: "mission-closure/v2-graph-evidence",
    questionProfile: MISSION_SEMANTIC_FULFILLMENT_PROFILE_V2,
    questionHash,
    baselineQuestionHash: args.baselineHash,
    policyHash: sha256(stable(policy)),
    datasetHash: args.casesHash,
    labelsHash: args.labelsHash,
    provenanceManifestHash: args.manifestHash,
    provider: PROVIDER,
    requestedModel: REQUESTED_MODEL,
    expectedReturnedModel: EXPECTED_MODEL,
    adapterVersion: HOOK_VERSION,
  };
  return {
    schema: "jev-semantic-fulfillment-candidate-freeze/2",
    frozenAt: "2026-11-03",
    status: "frozen-candidate-unqualified",
    productionActivation: false,
    qualificationIdentity: sha256(stable(identity)),
    questionHash,
    baselineQuestionHash: args.baselineHash,
    policyHash: sha256(stable(policy)),
    dataset: {
      split: "development",
      cases: 12,
      positives: 6,
      hardNegatives: 6,
      casesSha256: args.casesHash,
      labelsSha256: args.labelsHash,
      provenanceManifestSha256: args.manifestHash,
    },
    policy,
    limitations: [
      "Development comparison only; 12 cases do not meet production qualification populations.",
      "Candidate decisions remain advisory and do not authorize terminal completion.",
      "No inference has been run by prepare mode.",
    ],
  };
}

async function prepare(): Promise<void> {
  require(!existsSync(BASE), `${BASE} already exists; refusing to overwrite evidence`);
  require(!existsSync(FREEZE_PATH), `${FREEZE_PATH} already exists; refusing to overwrite a freeze`);
  mkdirSync(BASE, { recursive: false, mode: 0o700 });
  const receiptDir = join(BASE, "receipts");
  const journalDir = join(BASE, "journals");
  mkdirSync(receiptDir, { mode: 0o700 });
  mkdirSync(journalDir, { mode: 0o700 });
  const built = [];
  for (const plan of plans()) built.push(await buildCase(plan, receiptDir, journalDir));
  const rows = built.map((item) => item.row);
  const labels: LabelSet = { schema: "jev-semantic-fulfillment-dev-labels/2", cases: Object.fromEntries(built.map((item) => [item.row.id, item.label])) };
  const provenance = built.map((item) => item.provenance);
  const casesText = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const labelsText = `${JSON.stringify(labels, null, 2)}\n`;
  const provenanceText = `${provenance.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const baselineHash = hashQuestions({ closure: MISSION_CLOSURE_QUESTION_V2 });
  validateDataset(rows, labels, provenance);
  const manifest = {
    schema: "jev-semantic-fulfillment-development-manifest/2",
    split: "development",
    generatedAt: new Date(PREP_TIME).toISOString(),
    caseCount: rows.length,
    positiveCount: Object.values(labels.cases).filter((item) => item.expected === "FULFILLED").length,
    hardNegativeCount: Object.values(labels.cases).filter((item) => item.expected !== "FULFILLED").length,
    baselinePolicyVersion: CLOSURE_POLICY_VERSION,
    candidatePolicyVersion: CANDIDATE_POLICY_VERSION,
    baselineQuestionHash: baselineHash,
    candidateQuestionHash: hashQuestions({ closure: MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2 }),
    requestStateRule: "model input is built from the stored MissionClosureEvidence; case ids and labels are not included in the request state",
    preflightEligibleCases: rows.map((row) => row.id),
    hostVerifierReceiptCount: provenance.reduce((sum, item) => sum + item.verifierReceiptIds.length, 0),
    hostVerifierKinds: [...new Set(provenance.flatMap((item) => item.verifierIds))].sort(),
    files: {
      casesSha256: sha256(casesText), labelsSha256: sha256(labelsText), provenanceSha256: sha256(provenanceText),
    },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeNewArtifact(CASES_PATH, casesText);
  writeFileSync(LABELS_PATH, labelsText, { flag: "wx", mode: 0o600 });
  writeFileSync(join(BASE, "provenance.jsonl"), provenanceText, { flag: "wx", mode: 0o600 });
  writeFileSync(MANIFEST_PATH, manifestText, { flag: "wx", mode: 0o600 });
  const freeze = createFreeze({ casesHash: sha256(casesText), labelsHash: sha256(labelsText), manifestHash: sha256(manifestText), baselineHash });
  mkdirSync(dirname(FREEZE_PATH), { recursive: true });
  writeFileSync(FREEZE_PATH, `${JSON.stringify(freeze, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: "prepared-no-inference", cases: rows.length, positives: manifest.positiveCount, hardNegatives: manifest.hardNegativeCount, allReachSemanticReview: true, verifierReceipts: manifest.hostVerifierReceiptCount, baselineQuestionHash: baselineHash, candidateQuestionHash: manifest.candidateQuestionHash, qualificationIdentity: freeze.qualificationIdentity }, null, 2));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function concentrationStats(values: number[]): { count: number; mean: number | null; min: number | null; max: number | null } {
  if (values.length === 0) return { count: 0, mean: null, min: null, max: null };
  return {
    count: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

async function runLive(): Promise<void> {
  require(process.argv.includes("--authorized-inference-24"), "run mode requires explicit --authorized-inference-24 approval");
  require(!existsSync(RESULTS_PATH), `${RESULTS_PATH} exists; refusing to overwrite a measured run`);
  const connectivity = await probeOpenRouterJevEndpoint();
  if (!connectivity.reachable) {
    console.error(JSON.stringify({ status: "connectivity-preflight-failed", inferenceRequests: 0, diagnostic: connectivity.diagnostic }));
    process.exitCode = 2;
    return;
  }
  const casesText = readFileSync(CASES_PATH, "utf8");
  const labelsText = readFileSync(LABELS_PATH, "utf8");
  const manifestText = readFileSync(MANIFEST_PATH, "utf8");
  const freeze = readJson<Record<string, unknown>>(FREEZE_PATH);
  const labels = JSON.parse(labelsText) as LabelSet;
  const rows = casesText.trim().split(/\r?\n/).map((line) => JSON.parse(line) as EvidenceRow);
  const provenance = readFileSync(join(BASE, "provenance.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as ProvenanceRow);
  const manifest = JSON.parse(manifestText) as { files?: Record<string, string>; baselineQuestionHash?: string; candidateQuestionHash?: string };
  require(sha256(casesText) === manifest.files?.casesSha256, "cases dataset hash mismatch");
  require(sha256(labelsText) === manifest.files?.labelsSha256, "label file hash mismatch");
  require(sha256(readFileSync(join(BASE, "provenance.jsonl"), "utf8")) === manifest.files?.provenanceSha256, "provenance manifest hash mismatch");
  require(sha256(casesText) === (freeze.dataset as Record<string, unknown>)?.casesSha256, "candidate freeze does not bind this dataset");
  require(hashQuestions({ closure: MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2 }) === manifest.candidateQuestionHash, "candidate question changed after freeze");
  require(rows.length === 12 && provenance.length === 12, "frozen evaluation must contain exactly 12 pairs");
  validateDataset(rows, labels, provenance);
  for (const row of provenance) {
    const receipt = readFileSync(join(BASE, row.receiptPath));
    const journal = readFileSync(join(BASE, row.graphJournalPath));
    require(sha256(receipt) === row.receiptSha256, `${row.id}: durable receipt bytes changed`);
    require(sha256(journal) === row.graphJournalSha256, `${row.id}: graph journal bytes changed`);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  require(typeof apiKey === "string" && apiKey.length > 0, "OPENROUTER_API_KEY is not configured; no request sent");
  const model: DecisionModel = new OpenRouterJevDecisionModel({
    apiKey,
    model: REQUESTED_MODEL,
    maxRetries: 0,
    timeoutMs: 20_000,
  });
  const failFast = createFailFastDecisionModel(model);
  const baselinePolicy = policyFor(MISSION_CLOSURE_QUESTION_V2, CLOSURE_POLICY_VERSION);
  const candidatePolicy = policyFor(MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2, CANDIDATE_POLICY_VERSION);
  require(baselinePolicy.minConfidence === 0.9 && candidatePolicy.minConfidence === 0.9, "confidence gate is not the frozen 0.90 value");

  let requests = 0;
  let reportedCostUsd = 0;
  let stoppedOnIdentityMismatch = false;
  let stoppedOnTransportFailure = false;
  const scored: Array<{
    id: string;
    expected: SemanticFulfillmentChoice;
    pair: SemanticQuestionPairScore;
    transportFailure?: TransportDiagnostic;
  }> = [];
  for (const row of rows) {
    require(requests + 2 <= REQUEST_CAP, "request ceiling reached before completing the next pair");
    const expected = labels.cases[row.id]?.expected;
    require(expected !== undefined, `${row.id}: label missing`);
    const requestsBeforePair = failFast.attemptedRequests;
    const pair = await scoreSemanticQuestionPair({ model: failFast.model, evidence: row.evidence, baselinePolicy, candidatePolicy, expected });
    const pairRequestAttempts = failFast.attemptedRequests - requestsBeforePair;
    pair.inferenceRequests = pairRequestAttempts;
    requests += pairRequestAttempts;
    reportedCostUsd += pair.baseline?.usage?.cost_usd ?? 0;
    reportedCostUsd += pair.candidate?.usage?.cost_usd ?? 0;
    scored.push({
      id: row.id, expected, pair,
      ...(failFast.transportFailure === undefined ? {} : { transportFailure: failFast.transportFailure }),
    });
    console.log(JSON.stringify({ id: row.id, status: pair.status, requestsConsumed: requests }));
    if (pair.status === "identity-mismatch") {
      stoppedOnIdentityMismatch = true;
      break;
    }
    if (failFast.transportFailure !== undefined || pair.status === "model-error") {
      stoppedOnTransportFailure = failFast.transportFailure !== undefined;
      break;
    }
    if (reportedCostUsd > 0.01) break;
  }
  const summarize = () => {
    const negatives = scored.filter((row) => row.expected !== "FULFILLED");
    const positives = scored.filter((row) => row.expected === "FULFILLED");
    const baselineFalseComplete = negatives.filter((row) => row.pair.baseline?.choice === "COMPLETE").length;
    const candidateFalseFulfilled = negatives.filter((row) => row.pair.candidate?.choice === "FULFILLED").length;
    const baselinePositiveLive = positives.filter((row) => row.pair.baseline?.semanticChoice === "FULFILLED").length;
    const candidatePositiveLive = positives.filter((row) => row.pair.candidate?.choice === "FULFILLED").length;
    const baselineNegativeCorrect = negatives.filter((row) => row.pair.baseline?.semanticCorrect === true).length;
    const candidateNegativeCorrect = negatives.filter((row) => row.pair.candidate?.correct === true).length;
    const baselineTerminalFalse = negatives.filter((row) => row.pair.baseline?.terminalGateAccepted === true).length;
    const baselineTerminalPositive = positives.filter((row) => row.pair.baseline?.terminalGateAccepted === true).length;
    const candidateConcentrationEligible = scored.filter((row) => {
      const candidate = row.pair.candidate;
      return candidate?.choice === "FULFILLED" && candidate.confidence !== undefined &&
        candidate.confidence >= MIN_CONFIDENCE;
    }).length;
    const candidateOutcomeProbabilityEligible = scored.filter((row) =>
      row.pair.candidate?.choice === "FULFILLED" &&
      (row.pair.candidate.probabilities?.FULFILLED ?? 0) >= MIN_CONFIDENCE,
    ).length;
    const candidateExistingGateEligible = scored.filter((row) =>
      row.pair.candidate?.choice === "FULFILLED" &&
      row.pair.candidate.confidence !== undefined && row.pair.candidate.confidence >= MIN_CONFIDENCE &&
      (row.pair.candidate.probabilities?.FULFILLED ?? 0) >= MIN_CONFIDENCE,
    ).length;
    const baselineConcentrations = scored.flatMap((row) => row.pair.baseline?.confidence === undefined ? [] : [row.pair.baseline.confidence]);
    const candidateConcentrations = scored.flatMap((row) => row.pair.candidate?.confidence === undefined ? [] : [row.pair.candidate.confidence]);
    return {
      totalCases: scored.length,
      totalRequests: requests,
      concurrency: 1,
      retries: 0,
      baseline: {
        falseCompleteOnNegatives: baselineFalseComplete,
        correctNegativeDecisions: baselineNegativeCorrect,
        positiveLiveness: `${baselinePositiveLive}/${positives.length}`,
        terminalPositiveAuthorizations: baselineTerminalPositive,
        falseTerminalAuthorizations: baselineTerminalFalse,
        concentration: concentrationStats(baselineConcentrations),
      },
      candidate: {
        falseFulfilledOnNegatives: candidateFalseFulfilled,
        correctNegativeDecisions: candidateNegativeCorrect,
        positiveLiveness: `${candidatePositiveLive}/${positives.length}`,
        candidatesMeetingUnchanged090ConfidenceConcentrationGate: candidateConcentrationEligible,
        candidatesMeetingUnchanged090FulfilledOutcomeProbabilityGate: candidateOutcomeProbabilityEligible,
        candidatesMeetingBothUnchanged090GateConditions: candidateExistingGateEligible,
        concentration: concentrationStats(candidateConcentrations),
        terminalAuthorization: "none; candidate question is not wired to production authority",
      },
    };
  };
  const result = {
    schema: "jev-semantic-paired-development-results/2",
    evaluatedAt: new Date().toISOString(),
    provider: PROVIDER,
    requestedModel: REQUESTED_MODEL,
    expectedReturnedModel: EXPECTED_MODEL,
    candidateQualificationIdentity: freeze.qualificationIdentity,
    candidateQuestionHash: manifest.candidateQuestionHash,
    baselineQuestionHash: manifest.baselineQuestionHash,
    minConfidence: MIN_CONFIDENCE,
    concentrationStatistic: "TypeSafe Choice confidence, not correctness probability",
    stopReason: stoppedOnIdentityMismatch ? "returned provider/model/question identity mismatch" : stoppedOnTransportFailure ? "transport failure; remaining pairs not attempted" : reportedCostUsd > 0.01 ? "reported-cost ceiling exceeded" : scored.length < rows.length ? "run ended before all 12 pairs completed" : "completed",
    summary: summarize(),
    reportedCostUsd,
    cases: scored,
  };
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeNewArtifact(RESULTS_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.stopReason, requests, reportedCostUsd, results: RESULTS_PATH }, null, 2));
}

async function runSmoke(): Promise<void> {
  require(process.argv.includes("--authorized-inference-1"), "smoke mode requires explicit --authorized-inference-1 approval");
  const connectivity = await probeOpenRouterJevEndpoint();
  if (!connectivity.reachable) {
    console.error(JSON.stringify({ status: "connectivity-preflight-failed", inferenceRequests: 0, diagnostic: connectivity.diagnostic }));
    process.exitCode = 2;
    return;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  require(typeof apiKey === "string" && apiKey.length > 0, "OPENROUTER_API_KEY is not configured; no request sent");
  const model = new OpenRouterJevDecisionModel({ apiKey, model: REQUESTED_MODEL, maxRetries: 0, timeoutMs: 20_000 });
  try {
    const result = await model.evaluate(SMOKE_QUESTION);
    const expectedHash = hashQuestions(SMOKE_QUESTION.questions);
    const identityValid = result.provider === PROVIDER && result.model === EXPECTED_MODEL && result.questionHash === expectedHash;
    console.log(JSON.stringify({
      status: identityValid ? "smoke-succeeded" : "identity-mismatch",
      inferenceRequests: 1,
      provider: result.provider,
      requestedModel: REQUESTED_MODEL,
      returnedModel: result.model,
      questionHash: result.questionHash,
      expectedQuestionHash: expectedHash,
      correlationId: result.correlationId,
      latencyMs: result.latency_ms,
      usage: result.usage,
      answer: result.answers.result,
    }, null, 2));
    if (!identityValid) process.exitCode = 3;
  } catch (error) {
    const failure = error instanceof JevError
      ? error.transportDiagnostic ?? { kind: error.status === undefined ? "tcp" : "http", code: error.code ?? "REQUEST_FAILED", ...(error.status === undefined ? {} : { status: error.status }) }
      : undefined;
    console.error(JSON.stringify({ status: "smoke-failed", inferenceRequests: 1, diagnostic: failure ?? { kind: "unknown", code: "REQUEST_FAILED" } }));
    process.exitCode = 4;
  }
}

function usage(): never {
  throw new Error("usage: jev-semantic-paired-dev.ts prepare | smoke --authorized-inference-1 | run --authorized-inference-24");
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2];
  if (mode === "prepare") await prepare();
  else if (mode === "smoke") await runSmoke();
  else if (mode === "run") await runLive();
  else usage();
}
