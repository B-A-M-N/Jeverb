#!/usr/bin/env node
/**
 * Development-only three-arm Jev experiment. `execute` runs disposable
 * TypeScript tasks through the real graph runner and writes host plan
 * proposals. `approve-plans` is an explicit operator command that asks the
 * installed root control service for PolicyKit approval. `finalize` requires
 * those service receipts before building trusted evidence/review packets.
 * `preflight` requires independent annotations and a freeze; `run` requires
 * a separate explicit inference authorization.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { hashQuestions } from "../src/decision/provenance.js";
import type { DecisionModel, EvaluateRequest, EvaluateResult, Question } from "../src/decision/types.js";
import { defaultExecutionPolicy } from "../src/graph/policy.js";
import { PROTECTED_MASTER_SWITCH_PATH } from "../src/control/constants.js";
import { readMasterSwitch } from "../src/control/master-switch.js";
import { EvidenceLedger } from "../src/evidence/ledger.js";
import { Store } from "../src/hooks/store.js";
import { reconcileJournal } from "../src/graph/journal.js";
import { parseMissionContract } from "../src/mission/contract.js";
import {
  affirmativeRequest, DAG_LOCAL_CRITERION_QUESTION_V1,
  DAG_LOCAL_ATOMIC_QUESTION_HASH_V1 as ATOMIC_HASH, MISSION_CLOSURE_REQUEST_PROFILE_V2,
  aggregateDagLocalAtomicJudgments, aggregateDagLocalCriterionJudgments,
  dagLocalAtomicCriterionRequest, dagLocalCriterionRequest,
  evaluateDagLocalAtomicCriterion, evaluateDagLocalCriterion,
  type DagLocalAtomicJudgment, type DagLocalCriterionJudgment, type MissionClosureEvidence,
  type SemanticFulfillmentChoice,
} from "../src/mission/closure.js";
import { buildHostProofPlanPayload, hostProofPlanContentDigest } from "../src/mission/proof-plan.js";
import { createSessionMissionClosureSource } from "../src/mission/session-source.js";
import { produceHostVerificationInputs } from "../src/mission/runtime.js";
import { readVerifierFileBytes } from "../src/mission/verifiers.js";
import { controlStatus, proofPlanStatus, setProofPlan, type HostProofPlanPayload } from "../src/control/client.js";
import { analyzeCriterionTypeScriptStructure } from "../src/mission/structural-analysis.js";
import { proofObligationId } from "../src/mission/proof-obligations.js";
import { OpenRouterJevDecisionModel } from "../src/jev/openrouter.js";
import { run as executeGraph } from "../src/tools/execute-graph.js";
import { verificationReceiptIds } from "../src/mission/verifiers.js";

const ROOT = process.cwd();
const CORPUS = resolve(ROOT, "bench/datasets/mission-dag-three-arm-dev-v1");
const PENDING = join(CORPUS, "pending");
const CASES = join(CORPUS, "cases.jsonl");
const MANIFEST = join(CORPUS, "manifest.json");
const REVIEW_A = join(CORPUS, "review-a.json");
const REVIEW_B = join(CORPUS, "review-b.json");
const ADJUDICATION = join(CORPUS, "adjudication.json");
const FREEZE = resolve(ROOT, "bench/analysis/mission-dag-three-arm-dev-v1-freeze.json");
const RESULTS = resolve(ROOT, "bench/results/mission-dag-three-arm-dev-v1.openrouter-results.json");
const ATTEMPTS = resolve(ROOT, "bench/results/mission-dag-three-arm-dev-v1.openrouter-attempts.jsonl");
const REQUESTED_MODEL = "typesafe/jev-latest";
const RETURNED_MODEL = "typesafe/jev-1.14-20261014";
const PROVIDER = "openrouter";
const COST_CAP_USD = 0.01;
const TOTAL_REQUESTS = 60;
const IMPLEMENTATION_FILES = [
  "src/decision/provenance.ts", "src/graph/executor.ts", "src/graph/journal.ts", "src/jev/client.ts", "src/jev/openrouter.ts",
  "src/mission/closure.ts", "src/mission/contract.ts", "src/mission/graph-binding.ts", "src/mission/proof-obligations.ts",
  "src/mission/proof-plan.ts", "src/mission/runtime.ts", "src/mission/session-source.ts", "src/mission/structural-analysis.ts",
  "src/mission/verifiers.ts", "scripts/jev-dag-three-arm-dev.ts",
];
const sha = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value);
function requireOk(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

type CriterionSpec = { statement: string; assertions: string; observations: string };
type TaskFamily = { objective: string; criteria: [CriterionSpec, CriterionSpec]; good: string; deficient: string };
type PendingCase = { id: string; sessionId: string; prompt: string; plan: HostProofPlanPayload; graph: unknown; dataDir: string; workspace: string; graphOutput: unknown };
type EvidenceRow = { id: string; evidence: MissionClosureEvidence };
type Label = { overall: SemanticFulfillmentChoice; criteria: Record<string, "SATISFIED" | "UNSATISFIED" | "UNCERTAIN">; objectiveCoverage: "covered" | "omitted" | "uncertain" };
type ReviewerCriterion = { criterionRef: string; judgment: "SATISFIED" | "UNSATISFIED" | "UNCERTAIN"; evidenceSufficient: boolean; rationale: string };
type ReviewerAnswer = {
  global: { judgment: SemanticFulfillmentChoice; evidenceSufficient: boolean; rationale: string };
  objectiveCoverage: { judgment: "covered" | "omitted" | "uncertain"; omittedRequirements: string[]; rationale: string };
  criteria: ReviewerCriterion[];
};
type ReviewFile = {
  schema: "jeverb-three-arm-review/1"; reviewerId: string | null; context: "blind-review-a" | "blind-review-b";
  reviewerType?: "human"; reviewStatus?: "independent-human-review";
  independenceDeclaration?: string;
  modelOutputsExposed: false; otherReviewerAnswersExposed: false; corpusSha256: string; contextsSha256: string;
  cases: Array<{ caseRef: string; contextSha256: string; globalContext: unknown; criterionContexts: Array<{ criterionRef: string; choiceContext: unknown; atomicContext: unknown }>;
    review: null | ReviewerAnswer }>;
};

/** Six full implementations and six one-obligation defects; truth is later independently annotated. */
const FAMILIES: TaskFamily[] = [
  {
    objective: "Implement percentage discounts and inclusive free-shipping eligibility.",
    criteria: [
      { statement: "A percentage discount reduces the input total by that percentage without adding to it.", observations: "({total100Rate10:m.discountTotal(100,10),total80Rate25:m.discountTotal(80,25)})", assertions: "assert.equal(m.discountTotal(100, 10), 90); assert.equal(m.discountTotal(80, 25), 60);" },
      { statement: "Free shipping is granted when the order total equals or exceeds the minimum.", observations: "({equalMinimum:m.freeShipping(50,50),belowMinimum:m.freeShipping(49,50)})", assertions: "assert.equal(m.freeShipping(50, 50), true); assert.equal(m.freeShipping(49, 50), false);" },
    ],
    good: "export function discountTotal(total: number, percent: number): number { return total * (1 - percent / 100); }\nexport function freeShipping(total: number, minimum: number): boolean { return total >= minimum; }\n",
    deficient: "export function discountTotal(total: number, percent: number): number { return total * (1 + percent / 100); }\nexport function freeShipping(total: number, minimum: number): boolean { return total >= minimum; }\n",
  },
  {
    objective: "Implement page counts and zero-based offsets for one-based page numbers.",
    criteria: [
      { statement: "Page count is the ceiling of total items divided by page size, and zero items produce zero pages.", observations: "({zeroItems:m.pageCount(0,10),twentyOneItems:m.pageCount(21,10)})", assertions: "assert.equal(m.pageCount(0, 10), 0); assert.equal(m.pageCount(21, 10), 3);" },
      { statement: "The first page has offset zero and each later page advances by one page size.", observations: "({firstPage:m.pageOffset(1,10),thirdPage:m.pageOffset(3,10)})", assertions: "assert.equal(m.pageOffset(1, 10), 0); assert.equal(m.pageOffset(3, 10), 20);" },
    ],
    good: "export function pageCount(total: number, size: number): number { return Math.ceil(total / size); }\nexport function pageOffset(page: number, size: number): number { return (page - 1) * size; }\n",
    deficient: "export function pageCount(total: number, size: number): number { return Math.ceil(total / size); }\nexport function pageOffset(page: number, size: number): number { return page * size; }\n",
  },
  {
    objective: "Implement clamping and inclusive range membership.",
    criteria: [
      { statement: "Clamping returns the lower bound below range, the upper bound above range, and the value otherwise.", observations: "({below:m.clamp(2,3,8),above:m.clamp(10,3,8),inside:m.clamp(5,3,8)})", assertions: "assert.equal(m.clamp(2, 3, 8), 3); assert.equal(m.clamp(10, 3, 8), 8); assert.equal(m.clamp(5, 3, 8), 5);" },
      { statement: "Range membership includes both endpoints.", observations: "({lowerEndpoint:m.inRange(3,3,8),upperEndpoint:m.inRange(8,3,8),outside:m.inRange(9,3,8)})", assertions: "assert.equal(m.inRange(3, 3, 8), true); assert.equal(m.inRange(8, 3, 8), true); assert.equal(m.inRange(9, 3, 8), false);" },
    ],
    good: "export function clamp(value: number, low: number, high: number): number { return Math.max(low, Math.min(value, high)); }\nexport function inRange(value: number, low: number, high: number): boolean { return value >= low && value <= high; }\n",
    deficient: "export function clamp(value: number, low: number, high: number): number { return Math.max(low, Math.min(value, high)); }\nexport function inRange(value: number, low: number, high: number): boolean { return value > low && value < high; }\n",
  },
  {
    objective: "Implement exponential retry delay and bounded retryability.",
    criteria: [
      { statement: "Retry delay doubles from the base delay for each zero-based retry attempt.", observations: "({attempt0:m.retryDelay(0,100),attempt3:m.retryDelay(3,100)})", assertions: "assert.equal(m.retryDelay(0, 100), 100); assert.equal(m.retryDelay(3, 100), 800);" },
      { statement: "Retryability is true only while attempts used are below the configured maximum.", observations: "({twoOfThree:m.canRetry(2,3),threeOfThree:m.canRetry(3,3)})", assertions: "assert.equal(m.canRetry(2, 3), true); assert.equal(m.canRetry(3, 3), false);" },
    ],
    good: "export function retryDelay(attempt: number, base: number): number { return base * 2 ** attempt; }\nexport function canRetry(used: number, maximum: number): boolean { return used < maximum; }\n",
    deficient: "export function retryDelay(attempt: number, base: number): number { return base * 2 ** (attempt + 1); }\nexport function canRetry(used: number, maximum: number): boolean { return used < maximum; }\n",
  },
  {
    objective: "Implement lowercase tag normalization and case-insensitive tag membership.",
    criteria: [
      { statement: "Tag normalization trims surrounding whitespace and converts letters to lowercase.", observations: "({normalized:m.normalizeTag('  Build  ')})", assertions: "assert.equal(m.normalizeTag('  Build  '), 'build');" },
      { statement: "Tag membership compares normalized tags without regard to case or surrounding whitespace.", observations: "({matching:m.hasTag(['build','release'],' Release '),missing:m.hasTag(['build'],'docs')})", assertions: "assert.equal(m.hasTag(['build', 'release'], ' Release '), true); assert.equal(m.hasTag(['build'], 'docs'), false);" },
    ],
    good: "export function normalizeTag(value: string): string { return value.trim().toLowerCase(); }\nexport function hasTag(tags: string[], wanted: string): boolean { return tags.map(normalizeTag).includes(normalizeTag(wanted)); }\n",
    deficient: "export function normalizeTag(value: string): string { return value.trim(); }\nexport function hasTag(tags: string[], wanted: string): boolean { return tags.map(normalizeTag).includes(normalizeTag(wanted)); }\n",
  },
  {
    objective: "Implement rounded tax totals and an inclusive spending limit.",
    criteria: [
      { statement: "Tax totals round to the nearest cent after applying the rate.", observations: "({standard:m.taxTotal(10.01,0.1),halfCent:m.taxTotal(0.05,0.1)})", assertions: "assert.equal(m.taxTotal(10.01, 0.1), 11.01); assert.equal(m.taxTotal(0.05, 0.1), 0.06);" },
      { statement: "A total is within the spending limit when equal to or below the limit.", observations: "({atLimit:m.withinLimit(20,20),aboveLimit:m.withinLimit(20.01,20)})", assertions: "assert.equal(m.withinLimit(20, 20), true); assert.equal(m.withinLimit(20.01, 20), false);" },
    ],
    good: "export function taxTotal(subtotal: number, rate: number): number { return Math.round((subtotal * (1 + rate)) * 100) / 100; }\nexport function withinLimit(total: number, limit: number): boolean { return total <= limit; }\n",
    deficient: "export function taxTotal(subtotal: number, rate: number): number { return Math.floor((subtotal * (1 + rate)) * 100) / 100; }\nexport function withinLimit(total: number, limit: number): boolean { return total <= limit; }\n",
  },
];

export function protectedSwitchReady(status: { desired: string; effective: string }): boolean {
  return status.desired === "ON" && status.effective === "ON";
}

function requireProtectedSwitchOn(): void {
  const status = readMasterSwitch(ROOT, false, PROTECTED_MASTER_SWITCH_PATH, true);
  requireOk(protectedSwitchReady(status),
    `protected control state is ${status.desired}/${status.effective}; install/initialize the root control service, then obtain a fresh PolicyKit ON authorization before running disposable graph tasks`);
}

async function requireControlServiceOn(): Promise<void> {
  requireProtectedSwitchOn();
  const status = await controlStatus();
  requireOk(status.ok === true && status.desired === "ON" && status.effective === "ON",
    "root control service status did not confirm desired=ON/effective=ON; no corpus tasks were started");
}

function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }
function writeNew(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, value, { flag: "wx", mode: 0o600 }); }

function taskSource(family: TaskFamily, deficient: boolean): string { return deficient ? family.deficient : family.good; }
function promptFor(family: TaskFamily, caseId: string): string {
  return [family.objective, "Objective coverage: exhaustive", "Acceptance criteria:",
    ...family.criteria.map((criterion, i) => `- ${criterion.statement}`), ""].join("\n");
}

async function executeCorpus(): Promise<void> {
  await requireControlServiceOn();
  requireOk(!existsSync(CORPUS), `refusing to overwrite ${CORPUS}`);
  mkdirSync(CORPUS, { recursive: false, mode: 0o700 });
  mkdirSync(PENDING, { mode: 0o700 });
  const pending: PendingCase[] = [];
  const transpilerVersion = ts.version;
  for (let familyIndex = 0; familyIndex < FAMILIES.length; familyIndex += 1) {
    for (const deficient of [false, true]) {
      const ordinal = pending.length + 1;
      const id = `case-${String(ordinal).padStart(2, "0")}`;
      const sessionId = `dag3-${String(ordinal).padStart(2, "0")}`;
      const family = FAMILIES[familyIndex]!;
      const workspace = join(CORPUS, "workspaces", id);
      const dataDir = join(PENDING, "state", id);
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const prompt = promptFor(family, id);
      const contract = parseMissionContract(sessionId, prompt, Date.now());
      requireOk(contract !== undefined, `${id}: synthetic development task contract parse failed`);
      const solutionTs = taskSource(family, deficient);
      writeNew(join(workspace, "solution.ts"), solutionTs);
      const compiled = ts.transpileModule(solutionTs, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
      requireOk(compiled.diagnostics?.every((item) => item.category !== ts.DiagnosticCategory.Error), `${id}: TypeScript transpilation failed`);
      writeNew(join(workspace, "solution.cjs"), compiled.outputText);
      const criteria = family.criteria.map((criterion, index) => {
        const nodeId = `verify-${String(index + 1).padStart(2, "0")}`;
        const command = `node ${nodeId}.cjs`;
        const observationPath = `observation-${String(index + 1).padStart(2, "0")}.json`;
        const source = `const assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst m = require('./solution.cjs');\nconst observed = ${criterion.observations};\nfs.writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify(observed) + '\\n', { flag: 'w', mode: 0o600 });\n${criterion.assertions}\nprocess.stdout.write('host behavior artifact written\\n');\n`;
        writeNew(join(workspace, `${nodeId}.cjs`), source);
        return { criterionId: contract.criteria[index]!.id, nodeId, command, observationPath, codeFiles: ["solution.ts"] };
      });
      const store = new Store(dataDir, { masterSwitchPath: PROTECTED_MASTER_SWITCH_PATH, requireRootOwnedMasterSwitch: true });
      store.updateSession(sessionId, (state) => ({ ...state, mission_contract: contract }));
      const runId = `dag3-${String(ordinal).padStart(2, "0")}`;
      const previousSession = process.env.MUSE_SESSION_ID;
      process.env.MUSE_SESSION_ID = sessionId;
      let graphOutput: unknown;
      try {
        graphOutput = await executeGraph(null, {
          source: "jeverb-development-corpus-generator",
          runId,
          graph: { version: 1, nodes: criteria.map(({ nodeId, command }) => ({ id: nodeId, kind: "shell" as const, command })) },
        }, {
          dataDir,
          masterSwitchPath: PROTECTED_MASTER_SWITCH_PATH,
          execution: defaultExecutionPolicy(workspace, { allowShell: true, allowNetwork: false, allowShellRetry: false, allowOutputArtifacts: false, maxParallelShells: 1, nodeTimeoutMs: 15_000, graphTimeoutMs: 45_000 }),
        } as never, AbortSignal.timeout(60_000));
      } finally {
        if (previousSession === undefined) delete process.env.MUSE_SESSION_ID;
        else process.env.MUSE_SESSION_ID = previousSession;
      }
      const result = graphOutput as { results?: Array<{ nodeId: string; status: string; attempts: number; outputDigest: string; inputHash: string }>; evidenceReceipts?: { status: string; appended: number } };
      requireOk(result.results?.length === 2 && result.evidenceReceipts?.status === "persisted" && result.evidenceReceipts.appended === 2,
        `${id}: real graph attempts or durable execution receipts missing; preserving pending run for diagnosis`);
      const byNode = new Map(result.results.map((entry) => [entry.nodeId, entry]));
      requireOk(criteria.every((criterion) => byNode.has(criterion.nodeId)), `${id}: graph omitted a criterion test node`);
      const journalPath = join(dataDir, "graph-journals", `jeverb-graph-${runId}.jsonl`);
      const reconciled = reconcileJournal(journalPath);
      requireOk(reconciled.malformed === 0 && reconciled.runId === runId && reconciled.nodes.length === 2,
        `${id}: graph journal failed host reconciliation`);
      const mapping = {
        schema: "jeverb-host-proof-plan-input/1" as const,
        workspaceRoot: realpathSync(workspace),
        criteria: criteria.map(({ criterionId, nodeId, command, codeFiles }) => {
          const node = reconciled.nodes.find((entry) => entry.nodeId === nodeId);
          const attemptId = node?.attemptIds?.at(-1);
          requireOk(attemptId !== undefined, `${id}/${criterionId}: actual execution attempt id missing from journal`);
          return { criterionId, testCommand: command, producers: [{ runId, nodeId, attemptId }], observationPath: criteria.find((item) => item.criterionId === criterionId)!.observationPath, codeFiles };
        }),
      };
      const plan = buildHostProofPlanPayload(contract, mapping);
      const caseDir = join(PENDING, id);
      mkdirSync(caseDir, { recursive: true, mode: 0o700 });
      writeNew(join(caseDir, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
      writeNew(join(caseDir, "mapping.json"), `${JSON.stringify(mapping, null, 2)}\n`);
      writeNew(join(caseDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
      writeNew(join(caseDir, "graph.json"), `${JSON.stringify(graphOutput, null, 2)}\n`);
      writeNew(join(caseDir, "task-metadata.json"), `${JSON.stringify({ id, sessionId, runId, workspace, dataDir, prompt, transpilerVersion, sourceSha256: sha(solutionTs), testFiles: criteria.map((item) => item.nodeId + ".cjs"), planDigest: hostProofPlanContentDigest(plan) }, null, 2)}\n`);
      pending.push({ id, sessionId, prompt, plan, graph: { runId }, dataDir, workspace, graphOutput });
      process.stdout.write(`${id}: graph attempts persisted; proof-plan approval pending (${plan.missionRevision.slice(0, 12)})\n`);
    }
  }
  writeNew(join(PENDING, "pending-manifest.json"), `${JSON.stringify({
    schema: "jeverb-three-arm-pending/1", createdAt: new Date().toISOString(), caseCount: pending.length,
    criterionCount: 24, transpilerVersion, graphExecutor: "src/tools/execute-graph.ts", approvalStatus: "pending-root-control-service-receipts",
    cases: pending.map((item) => ({ id: item.id, planSha256: sha(stable(item.plan)), planDigest: hostProofPlanContentDigest(item.plan), graphSha256: sha(readFileSync(join(PENDING, item.id, "graph.json"))) })),
  }, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ status: "execution-complete-awaiting-host-plan-approval", cases: 12, criteria: 24, requests: 0, pendingDirectory: PENDING }, null, 2) + "\n");
}

async function approvePlans(): Promise<void> {
  requireOk(process.argv.includes("--operator-authorized-proof-plan-set"), "approve-plans requires explicit --operator-authorized-proof-plan-set; each plan triggers a fresh PolicyKit authorization");
  const pending = readJson<{ cases: Array<{ id: string }> }>(join(PENDING, "pending-manifest.json"));
  for (const item of pending.cases) {
    const plan = readJson<HostProofPlanPayload>(join(PENDING, item.id, "plan.json"));
    const caseDir = join(PENDING, item.id);
    const metadata = readJson<{ sessionId: string; runId: string; workspace: string }>(join(caseDir, "task-metadata.json"));
    const contract = readJson<NonNullable<ReturnType<Store["readSession"]>["mission_contract"]>>(join(caseDir, "contract.json"));
    const mapping = readJson<{ workspaceRoot: string; criteria: Array<{ criterionId: string; producers: Array<{ runId: string; nodeId: string; attemptId: string }>; codeFiles: string[]; testCommand: string }> }>(join(caseDir, "mapping.json"));
    const journalPath = join(PENDING, "state", item.id, "graph-journals", `jeverb-graph-${metadata.runId}.jsonl`);
    const reconciled = reconcileJournal(journalPath);
    requireOk(reconciled.malformed === 0 && reconciled.runId === metadata.runId && reconciled.nodes.length === 2 &&
      mapping.criteria.every((criterion) => {
        const producer = criterion.producers[0]!;
        const node = reconciled.nodes.find((entry) => entry.nodeId === producer.nodeId);
        return node !== undefined && node.status !== undefined && node.attemptIds?.includes(producer.attemptId);
      }), `${item.id}: graph journal does not authenticate every proposed plan producer/attempt`);
    const probeStore = new Store(join(PENDING, "state", item.id), {
      masterSwitchPath: PROTECTED_MASTER_SWITCH_PATH, requireRootOwnedMasterSwitch: true,
    });
    const probe = await createSessionMissionClosureSource({ store: probeStore, dataDir: join(PENDING, "state", item.id), now: () => Date.now() })
      .load(metadata.sessionId, contract.missionId);
    requireOk(probe.candidateDigest !== undefined, `${item.id}: host candidate identity missing before approval`);
    for (const criterion of mapping.criteria) analyzeCriterionTypeScriptStructure({
      root: mapping.workspaceRoot, files: criterion.codeFiles, criterionId: criterion.criterionId,
      proofObligationId: proofObligationId(criterion.criterionId, contract.criteria.find((entry) => entry.id === criterion.criterionId)!.statement),
      missionRevision: contract.missionRevision, candidateDigest: probe.candidateDigest,
    });
    const rebuilt = buildHostProofPlanPayload(contract, { schema: "jeverb-host-proof-plan-input/1", ...mapping });
    requireOk(hostProofPlanContentDigest(rebuilt) === hostProofPlanContentDigest(plan), `${item.id}: plan proposal changed after graph execution`);
    const expectedDigest = hostProofPlanContentDigest(plan);
    const status = await proofPlanStatus(plan.missionId);
    if (status.plan?.planDigest === expectedDigest) {
      process.stdout.write(`${item.id}: matching root-approved plan already present\n`);
      continue;
    }
    process.stdout.write(JSON.stringify({ action: "PROOF_PLAN_SET", caseId: item.id, objectiveSha256: plan.objectiveSha256, missionRevision: plan.missionRevision, criteria: plan.criteria.map(({ criterionId, testCommandSha256, producers, codeFiles }) => ({ criterionId, testCommandSha256, producers, codeFiles })), planDigest: expectedDigest }) + "\n");
    const stored = await setProofPlan(plan);
    requireOk(stored.planDigest === expectedDigest && stored.receiptCorrelationId.length === 32, `${item.id}: control service returned mismatched plan receipt`);
  }
  process.stdout.write("all 12 proof plans have matching service receipts\n");
}

async function finalizeCorpus(): Promise<void> {
  await requireControlServiceOn();
  requireOk(!existsSync(CASES), `refusing to overwrite ${CASES}`);
  const pending = readJson<{ cases: Array<{ id: string }> }>(join(PENDING, "pending-manifest.json"));
  const evidenceRows: EvidenceRow[] = [];
  const provenance: Array<Record<string, unknown>> = [];
  for (const item of pending.cases) {
    const dir = join(PENDING, item.id);
    const contract = readJson<NonNullable<ReturnType<Store["readSession"]>["mission_contract"]>>(join(dir, "contract.json"));
    const mapping = readJson<{ workspaceRoot: string; criteria: Array<{ criterionId: string; testCommand: string; observationPath: string; producers: Array<{ runId: string; nodeId: string; attemptId: string }>; codeFiles: string[] }> }>(join(dir, "mapping.json"));
    const graph = readJson<{ results: Array<{ nodeId: string; status: string; outputDigest: string; inputHash: string }>; runId: string }>(join(dir, "graph.json"));
    const metadata = readJson<{ sessionId: string; runId: string }>(join(dir, "task-metadata.json"));
    const approved = await proofPlanStatus(contract.missionId);
    const plan = readJson<HostProofPlanPayload>(join(dir, "plan.json"));
    requireOk(approved.plan !== undefined && approved.plan.planDigest === hostProofPlanContentDigest(plan) &&
      approved.plan.receiptCorrelationId.length === 32 && approved.plan.approvedByUid >= 0,
      `${item.id}: exact root-owned proof-plan receipt is missing or mismatched`);
    const journalPath = join(PENDING, "state", item.id, "graph-journals", `jeverb-graph-${metadata.runId}.jsonl`);
    const reconciled = reconcileJournal(journalPath);
    requireOk(graph.runId === metadata.runId && reconciled.malformed === 0 && reconciled.runId === metadata.runId && reconciled.nodes.length === mapping.criteria.length,
      `${item.id}: host journal cannot reconcile the approved producer graph`);
    for (const criterion of mapping.criteria) {
      const producer = criterion.producers[0]!;
      const journalNode = reconciled.nodes.find((node) => node.nodeId === producer.nodeId);
      const savedResult = graph.results.find((node) => node.nodeId === producer.nodeId);
      requireOk(journalNode !== undefined && savedResult !== undefined && journalNode.attemptIds?.includes(producer.attemptId) &&
        journalNode.status === savedResult.status && journalNode.outputDigest === savedResult.outputDigest &&
        journalNode.inputHash === savedResult.inputHash,
      `${item.id}/${criterion.criterionId}: cached graph outcome differs from reconciled host attempt`);
    }
    const dataDir = join(PENDING, "state", item.id);
    const sessionId = metadata.sessionId;
    const sw = PROTECTED_MASTER_SWITCH_PATH;
    const store = new Store(dataDir, { masterSwitchPath: sw, requireRootOwnedMasterSwitch: true });
    const ledger = new EvidenceLedger(join(dataDir, "evidence.log"), { switchPath: sw, requireRootOwnedSwitch: true });
    const now = Date.now();
    const byNode = new Map(graph.results.map((row) => [row.nodeId, row]));
    const verifications = [];
    const associations = [];
    const behaviorArtifacts: Array<{ criterionId: string; path: string; sha256: string }> = [];
    store.updateSession(sessionId, (state) => ({
      ...state,
      mission_contract: contract,
      verification: { last: { kind: "test", ok: graph.results.length === 2 && graph.results.every((row) => row.status === "succeeded"), ts: now,
        command: "jeverb-three-arm-development-test-suite", cwd: mapping.workspaceRoot }, edits_since: 0 },
    }));
    for (const criterion of mapping.criteria) {
      const producer = criterion.producers[0]!;
      const result = byNode.get(producer.nodeId);
      requireOk(result !== undefined && producer.attemptId.endsWith("/1"), `${item.id}/${criterion.criterionId}: graph node attempt missing`);
      requireOk(result.status === "succeeded" || result.status === "failed", `${item.id}/${criterion.criterionId}: graph test ended in a non-terminal/uncertain state`);
      const observedBytes = readVerifierFileBytes(mapping.workspaceRoot, criterion.observationPath);
      requireOk(observedBytes.byteLength <= 512, `${item.id}/${criterion.criterionId}: observed behavior artifact exceeds bound`);
      const observedValue: unknown = JSON.parse(observedBytes.toString("utf8"));
      requireOk(observedValue !== null && typeof observedValue === "object" && !Array.isArray(observedValue), `${item.id}/${criterion.criterionId}: behavior artifact is not an object`);
      const behaviorEntries = Object.entries(observedValue as Record<string, unknown>);
      requireOk(behaviorEntries.length > 0 && behaviorEntries.length <= 8 && behaviorEntries.every(([, value]) =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null),
      `${item.id}/${criterion.criterionId}: behavior artifact is not a bounded primitive observation`);
      const observedBehavior = JSON.stringify(Object.fromEntries(behaviorEntries));
      behaviorArtifacts.push({ criterionId: criterion.criterionId, path: relativePath(CORPUS, join(mapping.workspaceRoot, criterion.observationPath)), sha256: sha(observedBytes) });
      const testCommand = criterion.testCommand;
      const host = await produceHostVerificationInputs({
        store, dataDir, sessionId, missionId: contract.missionId, ledger, evidenceRoot: mapping.workspaceRoot, now: () => now,
        hostProofPlanDigest: approved.plan.planDigest,
        criterionCodeFiles: mapping.criteria.map(({ criterionId, codeFiles }) => ({ criterionId, files: codeFiles })),
        structuralAnalysisRoot: mapping.workspaceRoot,
        specs: [{ criterionId: criterion.criterionId, producers: [producer], test: {
          kind: "host-command", command: testCommand, exitCode: result.status === "succeeded" ? 0 : 1, outputDigest: result.outputDigest, observedBehavior,
        } }],
      });
      requireOk(host.reports.length === 1 && host.reports[0]!.status === (result.status === "succeeded" ? "satisfied" : "failed") && host.verifications.length === 1,
        `${item.id}/${criterion.criterionId}: host verifier did not bind the observed graph result`);
      verifications.push(...host.verifications);
      associations.push(...host.associations);
    }
    const ledgerIds = verificationReceiptIds(ledger.read().records);
    requireOk(verifications.every((row) => ledgerIds.has(row.receiptCorrelationId)), `${item.id}: durable verifier receipt readback failed`);
    const evidence = await createSessionMissionClosureSource({
      store, dataDir, now: () => now, ledger, enableTrustedGraphEvidence: true,
      criterionProducerAssociations: associations, criterionVerifications: verifications,
      trustedVerifierIds: ["test-execution"], hostProofPlanDigest: approved.plan.planDigest,
      criterionCodeFiles: mapping.criteria.map(({ criterionId, codeFiles }) => ({ criterionId, files: codeFiles })),
      structuralAnalysisRoot: mapping.workspaceRoot,
    }).load(sessionId, contract.missionId);
    requireOk(evidence.requestProfile === MISSION_CLOSURE_REQUEST_PROFILE_V2 && evidence.criteria.length === 2 &&
      evidence.criteria.every((row) => row.proofObligation?.codeStructure !== undefined && row.graphEvidence?.some((binding) => binding.state === "bound") && row.criterionVerification?.receiptCorrelationId),
      `${item.id}: trusted proof obligation, graph binding, AST, or verifier receipt missing`);
    const graphBytes = readFileSync(join(dir, "graph.json"));
    const ledgerBytes = readFileSync(join(dataDir, "evidence.log"));
    requireOk(evidence.graphRuns?.[0]?.runId === metadata.runId, `${item.id}: closure snapshot names a different graph run`);
    requireOk(existsSync(journalPath), `${item.id}: persisted graph journal missing`);
    const journalBytes = readFileSync(journalPath);
    const criteriaPlan = mapping.criteria.map((criterion) => {
      const local = dagLocalCriterionRequest(evidence, criterion.criterionId);
      const atomic = dagLocalAtomicCriterionRequest(evidence, criterion.criterionId);
      requireOk(local !== undefined && atomic !== undefined, `${item.id}/${criterion.criterionId}: one candidate context missing`);
      return { criterionId: criterion.criterionId, requirement: evidence.criteria.find((row) => row.id === criterion.criterionId)!.statement,
        choice: { state: local.state, questions: local.questions, questionHash: hashQuestions(local.questions) },
        atomic: { state: atomic.state, questions: atomic.questions, questionHash: atomic.questionHash, contextHash: atomic.contextHash } };
    });
    const caseRow: EvidenceRow = { id: item.id, evidence };
    evidenceRows.push(caseRow);
    provenance.push({ id: item.id, promptHash: sha(contract.objective + "\n" + contract.criteria.map(({ statement }) => statement).join("\n")),
      missionRevision: evidence.missionRevision, candidateDigest: evidence.candidateDigest, planDigest: approved.plan.planDigest,
      planReceipt: approved.plan.receiptCorrelationId, graphSha256: sha(graphBytes), journalPath: relativePath(CORPUS, journalPath), journalSha256: sha(journalBytes),
      ledgerPath: relativePath(CORPUS, join(dataDir, "evidence.log")), ledgerSha256: sha(ledgerBytes), verifierReceiptIds: verifications.map((row) => row.receiptCorrelationId),
      graphPath: relativePath(CORPUS, join(dir, "graph.json")),
      behaviorArtifacts,
      ASTDigests: evidence.criteria.map((row) => row.proofObligation?.codeStructure?.evidenceDigest),
      reviewContextSha256: sha(stable(reviewContext({ id: item.id, evidence }))), criterionContexts: criteriaPlan });
  }
  requireOk(evidenceRows.length === 12 && evidenceRows.every((row) => row.evidence.criteria.length === 2), "expected 12 fully bound cases with two criteria each");
  writeNew(CASES, `${evidenceRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeNew(join(CORPUS, "provenance.jsonl"), `${provenance.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const corpusSha = sha(readFileSync(CASES));
  for (const slot of ["a", "b"] as const) {
    const packet: ReviewFile = {
      schema: "jeverb-three-arm-review/1", reviewerId: null, context: `blind-review-${slot}`,
      modelOutputsExposed: false, otherReviewerAnswersExposed: false, corpusSha256: corpusSha, contextsSha256: "",
      cases: evidenceRows.map((row) => {
        const context = reviewContext(row);
        return { ...context, contextSha256: sha(stable(context)), review: null };
      }),
    };
    packet.contextsSha256 = sha(stable(packet.cases.map(({ caseRef, contextSha256 }) => ({ caseRef, contextSha256 }))));
    writeNew(slot === "a" ? REVIEW_A : REVIEW_B, `${JSON.stringify(packet, null, 2)}\n`);
  }
  const manifest = { schema: "jeverb-three-arm-corpus/1", status: "awaiting-independent-reviews", generatedAt: new Date().toISOString(),
    cases: 12, criteria: 24, sourceType: "synthetic-development-prompts; no operator attestation represented", compiler: { name: "typescript", version: ts.version },
    evidenceProfile: MISSION_CLOSURE_REQUEST_PROFILE_V2, hostPlanReceiptCount: 12, verifierReceiptCount: provenance.reduce((n, item) => n + (item.verifierReceiptIds as unknown[]).length, 0),
    files: { casesSha256: sha(readFileSync(CASES)), provenanceSha256: sha(readFileSync(join(CORPUS, "provenance.jsonl"))), reviewerASha256: sha(readFileSync(REVIEW_A)), reviewerBSha256: sha(readFileSync(REVIEW_B)) },
    questions: { global: hashQuestions(affirmativeRequest(evidenceRows[0]!.evidence).questions), choice: hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 }), atomic: ATOMIC_HASH },
  };
  writeNew(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ status: "corpus-built-awaiting-independent-labels", cases: 12, criteria: 24, objectiveCoverageLabels: 0, reviewerPackets: [REVIEW_A, REVIEW_B], inferenceRequests: 0 }, null, 2) + "\n");
}

function relativePath(root: string, path: string): string { const rel = resolve(path).slice(resolve(root).length + 1); return rel.replaceAll("\\", "/"); }

function reviewContext(row: EvidenceRow): { caseRef: string; globalContext: unknown; criterionContexts: ReviewFile["cases"][number]["criterionContexts"] } {
  const global = affirmativeRequest(row.evidence);
  return {
    caseRef: sha(row.id).slice(0, 20),
    globalContext: { state: global.state, questions: global.questions, questionHash: hashQuestions(global.questions) },
    criterionContexts: row.evidence.criteria.map((criterion) => {
      const choice = dagLocalCriterionRequest(row.evidence, criterion.id);
      const atomic = dagLocalAtomicCriterionRequest(row.evidence, criterion.id);
      requireOk(choice !== undefined && atomic !== undefined, `${row.id}/${criterion.id}: reviewer context cannot be built`);
      return { criterionRef: sha(`${row.id}/${criterion.id}`).slice(0, 20),
        choiceContext: { state: choice.state, questions: choice.questions, questionHash: hashQuestions(choice.questions) },
        atomicContext: { state: atomic.state, questions: atomic.questions, questionHash: atomic.questionHash, contextHash: atomic.contextHash } };
    }),
  };
}

function reviewContextDigest(cases: ReviewFile["cases"]): string {
  return sha(stable(cases.map(({ caseRef, contextSha256 }) => ({ caseRef, contextSha256 }))));
}

function validateReviewer(review: ReviewFile, slot: "a" | "b", rows: EvidenceRow[], corpusSha: string): string[] {
  const errors: string[] = [];
  if (review.schema !== "jeverb-three-arm-review/1" || review.context !== `blind-review-${slot}`) errors.push(`review ${slot}: schema/context mismatch`);
  if (typeof review.reviewerId !== "string" || review.reviewerId.trim() === "" || review.reviewerType !== "human" || review.reviewStatus !== "independent-human-review") errors.push(`review ${slot}: reviewer identity/type/status missing`);
  if (!review.independenceDeclaration?.trim()) errors.push(`review ${slot}: independence declaration missing`);
  if (review.modelOutputsExposed !== false || review.otherReviewerAnswersExposed !== false || review.corpusSha256 !== corpusSha) errors.push(`review ${slot}: blind context or corpus binding invalid`);
  if (review.cases.length !== rows.length || new Set(review.cases.map((entry) => entry.caseRef)).size !== rows.length) errors.push(`review ${slot}: case set is incomplete or duplicated`);
  const expectedByRef = new Map(rows.map((row) => [sha(row.id).slice(0, 20), reviewContext(row)]));
  for (const answer of review.cases) {
    const expected = expectedByRef.get(answer.caseRef);
    if (expected === undefined || stable({ caseRef: answer.caseRef, globalContext: answer.globalContext, criterionContexts: answer.criterionContexts }) !== stable(expected) ||
        answer.contextSha256 !== sha(stable(expected))) {
      errors.push(`review ${slot}/${answer.caseRef}: exact model-visible contexts changed`);
      continue;
    }
    const reviewAnswer = answer.review;
    if (reviewAnswer === null || reviewAnswer === undefined) { errors.push(`review ${slot}/${answer.caseRef}: judgment missing`); continue; }
    if (!reviewAnswer.global.rationale.trim() || !reviewAnswer.global.evidenceSufficient || !reviewAnswer.objectiveCoverage.rationale.trim()) errors.push(`review ${slot}/${answer.caseRef}: global/coverage rationale or evidence sufficiency missing`);
    if (reviewAnswer.criteria.length !== expected.criterionContexts.length || reviewAnswer.criteria.some((criterion) => !criterion.rationale.trim() || !criterion.evidenceSufficient) ||
        new Set(reviewAnswer.criteria.map((criterion) => criterion.criterionRef)).size !== expected.criterionContexts.length ||
        expected.criterionContexts.some((criterion) => !reviewAnswer.criteria.some((answerCriterion) => answerCriterion.criterionRef === criterion.criterionRef))) {
      errors.push(`review ${slot}/${answer.caseRef}: criterion judgments are incomplete, duplicated, or unsupported`);
    }
  }
  if (review.contextsSha256 !== reviewContextDigest(review.cases)) errors.push(`review ${slot}: context digest mismatch`);
  return errors;
}

function freezeCorpus(): void {
  requireOk(existsSync(CASES) && existsSync(MANIFEST), "finalize must create trusted evidence and blind packets first");
  requireOk(!existsSync(FREEZE) && !existsSync(join(CORPUS, "labels.json")), "refusing to overwrite labels/freeze");
  const caseBytes = readFileSync(CASES);
  const provenanceBytes = readFileSync(join(CORPUS, "provenance.jsonl"));
  const rows = caseBytes.toString("utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as EvidenceRow);
  const corpusSha = sha(caseBytes);
  const reviewA = readJson<ReviewFile>(REVIEW_A);
  const reviewB = readJson<ReviewFile>(REVIEW_B);
  const errors = [...validateReviewer(reviewA, "a", rows, corpusSha), ...validateReviewer(reviewB, "b", rows, corpusSha)];
  if (reviewA.reviewerId === reviewB.reviewerId) errors.push("reviewers must be distinct");
  const adjudication = readJson<{ reviewerId: string; reviewStatus: string; corpusSha256: string; contextsSha256: string; cases: Array<{
    caseRef: string; overall: SemanticFulfillmentChoice; objectiveCoverage: Label["objectiveCoverage"];
    rationale: string; criteria: Array<{ criterionRef: string; judgment: Label["criteria"][string]; rationale: string; resolvesDisagreement?: string }>;
  }> }>(ADJUDICATION);
  if (!adjudication.reviewerId || adjudication.reviewerId === reviewA.reviewerId || adjudication.reviewerId === reviewB.reviewerId ||
      adjudication.reviewStatus !== "independent-adjudication" || adjudication.corpusSha256 !== corpusSha ||
      adjudication.contextsSha256 !== reviewA.contextsSha256 || adjudication.cases.length !== 12) errors.push("independent adjudication identity, provenance, or coverage invalid");
  const labels: Record<string, Label> = {};
  const byRefA = new Map(reviewA.cases.map((item) => [item.caseRef, item]));
  const byRefB = new Map(reviewB.cases.map((item) => [item.caseRef, item]));
  const byRefAdj = new Map(adjudication.cases.map((item) => [item.caseRef, item]));
  for (const row of rows) {
    const ref = sha(row.id).slice(0, 20);
    const a = byRefA.get(ref)?.review;
    const b = byRefB.get(ref)?.review;
    const final = byRefAdj.get(ref);
    if (a === null || a === undefined || b === null || b === undefined || final === undefined) { errors.push(`${row.id}: reviewer/adjudicator labels missing`); continue; }
    const criterionRefs = row.evidence.criteria.map((criterion) => sha(`${row.id}/${criterion.id}`).slice(0, 20));
    if (!final.rationale.trim() || final.criteria.length !== 2 || final.criteria.some((criterion) => !criterion.rationale.trim()) ||
        new Set(final.criteria.map((criterion) => criterion.criterionRef)).size !== 2 || criterionRefs.some((id) => !final.criteria.some((criterion) => criterion.criterionRef === id))) {
      errors.push(`${row.id}: adjudicated criteria/rationale missing or duplicated`); continue;
    }
    const criterionLabels: Record<string, Label["criteria"][string]> = {};
    for (const criterion of final.criteria) {
      const left = a.criteria.find((item) => item.criterionRef === criterion.criterionRef);
      const right = b.criteria.find((item) => item.criterionRef === criterion.criterionRef);
      if (left === undefined || right === undefined) { errors.push(`${row.id}/${criterion.criterionRef}: independent judgments missing`); continue; }
      if ((left.judgment !== right.judgment || left.evidenceSufficient !== right.evidenceSufficient) && !criterion.resolvesDisagreement?.trim()) errors.push(`${row.id}/${criterion.criterionRef}: disagreement lacks adjudication rationale`);
      const id = row.evidence.criteria[criterionRefs.indexOf(criterion.criterionRef)]!.id;
      criterionLabels[id] = criterion.judgment;
    }
    if ((a.global.judgment !== b.global.judgment || a.objectiveCoverage.judgment !== b.objectiveCoverage.judgment) && !final.rationale.trim()) errors.push(`${row.id}: overall disagreement lacks adjudication rationale`);
    if (final.objectiveCoverage !== "covered" && final.overall === "FULFILLED") errors.push(`${row.id}: omitted/unresolved objective scope cannot label complete`);
    if (Object.values(criterionLabels).some((value) => value !== "SATISFIED") && final.overall === "FULFILLED") errors.push(`${row.id}: unsatisfied/uncertain criterion cannot label complete`);
    labels[row.id] = { overall: final.overall, objectiveCoverage: final.objectiveCoverage, criteria: criterionLabels };
  }
  if (Object.values(labels).filter((label) => label.overall === "FULFILLED").length !== 6 || Object.keys(labels).length !== 12) errors.push("ground truth must adjudicate exactly six fulfilled and six deficient cases");
  if (errors.length > 0) throw new Error(`freeze refused: ${errors.join("; ")}`);
  const labelsFile = { schema: "jeverb-three-arm-labels/1", sourceCorpusSha256: corpusSha,
    reviewerIds: [reviewA.reviewerId, reviewB.reviewerId], adjudicatorId: adjudication.reviewerId,
    reviewHashes: [sha(readFileSync(REVIEW_A)), sha(readFileSync(REVIEW_B))], adjudicationSha256: sha(readFileSync(ADJUDICATION)), cases: labels };
  const labelText = `${JSON.stringify(labelsFile, null, 2)}\n`;
  writeNew(join(CORPUS, "labels.json"), labelText);
  const manifest = readJson<Record<string, unknown>>(MANIFEST);
  manifest.status = "frozen-awaiting-live-authorization";
  manifest.labelsSha256 = sha(labelText);
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const codeHashes = Object.fromEntries(IMPLEMENTATION_FILES.map((path) => [path, sha(readFileSync(resolve(ROOT, path)))]));
  const questionBindings = rows.map((row) => ({ caseId: row.id,
    global: hashQuestions(affirmativeRequest(row.evidence).questions),
    criteria: row.evidence.criteria.map((criterion) => {
      const choice = dagLocalCriterionRequest(row.evidence, criterion.id);
      const atomic = dagLocalAtomicCriterionRequest(row.evidence, criterion.id);
      requireOk(choice !== undefined && atomic !== undefined, `${row.id}/${criterion.id}: question binding unavailable during freeze`);
      return { criterionId: criterion.id, choice: hashQuestions(choice.questions), atomic: atomic.questionHash, atomicContext: atomic.contextHash };
    }),
  }));
  const freeze = {
    schema: "jeverb-three-arm-experiment-freeze/1", status: "development-frozen-unqualified", productionActivation: false,
    dataset: { cases: 12, criteria: 24, positives: 6, deficient: 6, casesSha256: corpusSha, provenanceSha256: sha(provenanceBytes), labelsSha256: sha(labelText),
      manifestSha256: sha(readFileSync(MANIFEST)), reviewASha256: sha(readFileSync(REVIEW_A)), reviewBSha256: sha(readFileSync(REVIEW_B)), adjudicationSha256: sha(readFileSync(ADJUDICATION)) },
    questions: { bindings: questionBindings, global: hashQuestions(affirmativeRequest(rows[0]!.evidence).questions), choice: hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 }), atomic: ATOMIC_HASH },
    requestedModel: REQUESTED_MODEL, requiredReturnedModel: RETURNED_MODEL, provider: PROVIDER,
    policies: { productionConfidenceThreshold: 0.9, changed: false, atomicNoulComposition: "mission-dag-local-atomic-noul/v1", atomicPolicyQualified: false, terminalCompletionEnabled: false },
    execution: { requests: TOTAL_REQUESTS, global: 12, criterionChoice: 24, criterionAtomic: 24, concurrency: 1, retries: 0, budgetUsd: COST_CAP_USD, estimatedCostUsd: null, costEstimateStatus: "must be checked against returned usage and hard-aborted at cap" },
    implementationSha256: codeHashes,
    qualification: { liveInferenceAuthorized: false, liveModelConditionedGraphTransitionsValidated: false, productionReady: false },
  };
  writeNew(FREEZE, `${JSON.stringify(freeze, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ status: "three-arm-frozen-awaiting-inference-authorization", cases: 12, criteria: 24, requests: 60, budgetUsd: COST_CAP_USD, freeze: FREEZE, inferenceRequests: 0 }, null, 2) + "\n");
}

async function checkPreflight(): Promise<{ blockers: string[]; rows: EvidenceRow[]; labels?: Record<string, Label>; freeze?: Record<string, unknown> }> {
  const blockers: string[] = [];
  if (![CASES, MANIFEST, REVIEW_A, REVIEW_B, ADJUDICATION, FREEZE].every(existsSync)) {
    const missing = [CASES, MANIFEST, REVIEW_A, REVIEW_B, ADJUDICATION, FREEZE].filter((path) => !existsSync(path)).map((path) => relativePath(ROOT, path));
    const switchState = readMasterSwitch(ROOT, false, PROTECTED_MASTER_SWITCH_PATH, true);
    blockers.push(`required artifacts not yet generated/adjudicated: ${missing.join(", ")}`);
    if (!protectedSwitchReady(switchState)) blockers.push(`protected switch is ${switchState.desired}/${switchState.effective}; no corpus execution or trusted receipts are admitted`);
    try {
      const service = await controlStatus();
      if (service.ok !== true) blockers.push("root control service did not confirm STATUS");
    } catch { blockers.push("root control service/PolicyKit integration is unavailable for trusted proof-plan approval"); }
    return { blockers, rows: [] };
  }
  const caseBytes = readFileSync(CASES);
  const provenanceBytes = readFileSync(join(CORPUS, "provenance.jsonl"));
  const manifest = readJson<Record<string, unknown>>(MANIFEST);
  const freeze = readJson<Record<string, unknown>>(FREEZE);
  const rows = caseBytes.toString("utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as EvidenceRow);
  if (rows.length !== 12 || rows.some((row) => row.evidence.criteria.length !== 2)) blockers.push("expected 12 cases and 24 criteria");
  const dataset = freeze.dataset as Record<string, unknown> | undefined;
  if (dataset?.casesSha256 !== sha(caseBytes) || dataset?.provenanceSha256 !== sha(provenanceBytes)) blockers.push("corpus evidence/provenance hash mismatch");
  if (manifest.files === undefined || (manifest.files as Record<string, unknown>).casesSha256 !== sha(caseBytes)) blockers.push("manifest does not bind exact corpus cases");
  const questions = freeze.questions as Record<string, unknown> | undefined;
  const globalHash = rows[0] === undefined ? "" : hashQuestions(affirmativeRequest(rows[0].evidence).questions);
  if (questions?.global !== globalHash || questions?.choice !== hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 }) || questions?.atomic !== ATOMIC_HASH) blockers.push("question identities do not match the exact three arms");
  const savedBindings = questions?.bindings;
  if (!Array.isArray(savedBindings) || savedBindings.length !== rows.length) blockers.push("per-case frozen question bindings are missing");
  else for (const row of rows) {
    const binding = savedBindings.find((entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).caseId === row.id) as Record<string, unknown> | undefined;
    const actualCriteria = row.evidence.criteria.map((criterion) => {
      const choice = dagLocalCriterionRequest(row.evidence, criterion.id);
      const atomic = dagLocalAtomicCriterionRequest(row.evidence, criterion.id);
      return { criterionId: criterion.id, choice: choice === undefined ? "" : hashQuestions(choice.questions), atomic: atomic?.questionHash ?? "", atomicContext: atomic?.contextHash ?? "" };
    });
    if (binding === undefined || binding.global !== hashQuestions(affirmativeRequest(row.evidence).questions) || stable(binding.criteria) !== stable(actualCriteria)) blockers.push(`${row.id}: frozen global/criterion/atomic question or context hash changed`);
  }
  if (freeze.requestedModel !== REQUESTED_MODEL || freeze.requiredReturnedModel !== RETURNED_MODEL || freeze.provider !== PROVIDER) blockers.push("provider/model alias or required returned version differs");
  const execution = freeze.execution as Record<string, unknown> | undefined;
  if (execution?.requests !== TOTAL_REQUESTS || execution?.concurrency !== 1 || execution?.retries !== 0 || execution?.budgetUsd !== COST_CAP_USD) blockers.push("request-count/concurrency/retry/budget freeze mismatch");
  const provenanceRows = provenanceBytes.toString("utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
  if (provenanceRows.length !== 12) blockers.push("provenance row count differs from case count");
  for (const row of rows) {
    const evidence = row.evidence;
    if (evidence.requestProfile !== MISSION_CLOSURE_REQUEST_PROFILE_V2 || evidence.criteria.length !== 2) blockers.push(`${row.id}: untrusted evidence profile or criterion count`);
    const prov = provenanceRows.find((entry) => entry.id === row.id);
    if (prov === undefined || prov.candidateDigest !== evidence.candidateDigest || prov.missionRevision !== evidence.missionRevision ||
        prov.reviewContextSha256 !== sha(stable(reviewContext(row)))) blockers.push(`${row.id}: candidate/revision/review-context provenance mismatch`);
    if (evidence.objectiveCoverage?.status !== "attested" || evidence.objectiveCoverage.source !== "user-prompt-objective-coverage" || evidence.objectiveCoverage.missionRevision !== evidence.missionRevision) blockers.push(`${row.id}: original synthetic task coverage is not prompt-bound`);
    if (prov !== undefined) {
      try {
        const approved = await proofPlanStatus(evidence.missionId);
        const pendingPlanPath = join(PENDING, row.id, "plan.json");
        const localPlan = existsSync(pendingPlanPath) ? readJson<HostProofPlanPayload>(pendingPlanPath) : undefined;
        if (approved.plan === undefined || localPlan === undefined || approved.plan.planDigest !== prov.planDigest ||
            approved.plan.receiptCorrelationId !== prov.planReceipt || approved.plan.approvedByUid < 0 ||
            approved.plan.planDigest !== hostProofPlanContentDigest(localPlan) || approved.plan.missionRevision !== evidence.missionRevision ||
            approved.plan.objectiveSha256 !== sha(evidence.objective)) blockers.push(`${row.id}: root-owned PROOF_PLAN_SET receipt is absent or does not match frozen evidence`);
      } catch { blockers.push(`${row.id}: root control service cannot verify the PROOF_PLAN_SET receipt`); }
      for (const [pathKey, digestKey] of [["graphPath", "graphSha256"], ["journalPath", "journalSha256"], ["ledgerPath", "ledgerSha256"]] as const) {
        const relative = prov[pathKey];
        if (typeof relative !== "string" || !existsSync(resolve(CORPUS, relative)) || sha(readFileSync(resolve(CORPUS, relative))) !== prov[digestKey]) blockers.push(`${row.id}: durable ${pathKey} hash mismatch`);
      }
      const behaviorArtifacts = prov.behaviorArtifacts;
      if (!Array.isArray(behaviorArtifacts) || behaviorArtifacts.length !== 2 || behaviorArtifacts.some((entry) => {
        if (typeof entry !== "object" || entry === null) return true;
        const artifact = entry as Record<string, unknown>;
        return typeof artifact.path !== "string" || !existsSync(resolve(CORPUS, artifact.path)) || sha(readFileSync(resolve(CORPUS, artifact.path))) !== artifact.sha256;
      })) blockers.push(`${row.id}: host-observed behavior artifact missing or changed`);
      const dataDir = resolve(CORPUS, String(prov.ledgerPath)).replace(/\/evidence\.log$/, "");
      try {
        const ledger = new EvidenceLedger(resolve(CORPUS, String(prov.ledgerPath)), { switchPath: PROTECTED_MASTER_SWITCH_PATH, requireRootOwnedSwitch: true });
        const receiptIds = verificationReceiptIds(ledger.read().records);
        if (!Array.isArray(prov.verifierReceiptIds) || prov.verifierReceiptIds.some((id) => typeof id !== "string" || !receiptIds.has(id))) blockers.push(`${row.id}: verifier receipt is absent from the durable ledger`);
      } catch { blockers.push(`${row.id}: durable verifier ledger cannot be reconciled`); }
    }
    for (const criterion of evidence.criteria) {
      const local = dagLocalCriterionRequest(evidence, criterion.id);
      const atomic = dagLocalAtomicCriterionRequest(evidence, criterion.id);
      if (criterion.proofObligation?.codeStructure === undefined || local === undefined || atomic === undefined) blockers.push(`${row.id}/${criterion.id}: obligation, AST, or candidate context missing`);
      if (criterion.criterionVerification?.result === undefined || criterion.criterionVerification.receiptCorrelationId === undefined || criterion.criterionVerification.adapterVersion === undefined || criterion.criterionVerification.observedResult === undefined) blockers.push(`${row.id}/${criterion.id}: trusted verifier result/receipt/observation missing`);
      if ((criterion.graphEvidence ?? []).length === 0 || criterion.graphEvidence?.some((edge) => edge.state !== "bound" || edge.provenance !== "host:journal-projection/v2" || !edge.attemptId)) blockers.push(`${row.id}/${criterion.id}: source/attempt binding missing`);
    }
  }
  const manifestHash = sha(readFileSync(MANIFEST));
  if (dataset?.manifestSha256 !== manifestHash || manifest.status !== "frozen-awaiting-live-authorization") blockers.push("manifest content/status differs from the adjudicated freeze");
  const implementationHashes = freeze.implementationSha256 as Record<string, unknown> | undefined;
  if (implementationHashes === undefined || stable(Object.keys(implementationHashes).sort()) !== stable([...IMPLEMENTATION_FILES].sort()) || Object.entries(implementationHashes).some(([path, digest]) =>
    !existsSync(resolve(ROOT, path)) || digest !== sha(readFileSync(resolve(ROOT, path))))) blockers.push("frozen implementation/question code hash mismatch");
  let labels: Record<string, Label> | undefined;
  let labelFile: Record<string, unknown> | undefined;
  try { labelFile = readJson<Record<string, unknown>>(join(CORPUS, "labels.json")); labels = labelFile.cases as Record<string, Label>; } catch { blockers.push("adjudicated labels missing"); }
  const reviews = [readJson<ReviewFile>(REVIEW_A), readJson<ReviewFile>(REVIEW_B)];
  if (reviews.some((review, index) => validateReviewer(review, index === 0 ? "a" : "b", rows, sha(caseBytes)).length > 0)) blockers.push("independent blind review is incomplete or not bound to exact contexts");
  if (reviews[0]?.reviewerId === reviews[1]?.reviewerId) blockers.push("reviewers must have distinct identities");
  const adjudication = readJson<Record<string, unknown>>(ADJUDICATION);
  if (!adjudication.reviewerId || adjudication.reviewerId === reviews[0]?.reviewerId || adjudication.reviewerId === reviews[1]?.reviewerId || adjudication.corpusSha256 !== sha(caseBytes) || adjudication.reviewStatus !== "independent-adjudication") blockers.push("independent adjudication is incomplete or not bound to corpus");
  if (labels === undefined || Object.keys(labels).length !== 12 || Object.values(labels).filter((label) => label.overall === "FULFILLED").length !== 6 ||
      Object.values(labels).some((label) => label.objectiveCoverage !== "covered")) blockers.push("adjudicated labels must establish all objective coverage and exactly six positives/six deficient cases");
  if (labels !== undefined) for (const row of rows) {
    const label = labels[row.id];
    const criterionIds = row.evidence.criteria.map((criterion) => criterion.id).sort();
    if (label === undefined || stable(Object.keys(label.criteria).sort()) !== stable(criterionIds) ||
      Object.values(label.criteria).some((value) => !["SATISFIED", "UNSATISFIED", "UNCERTAIN"].includes(value)) ||
      (label.overall === "FULFILLED" && (label.objectiveCoverage !== "covered" || Object.values(label.criteria).some((value) => value !== "SATISFIED")))) {
      blockers.push(`${row.id}: adjudicated truth does not cover exact mandatory criterion IDs or is internally inconsistent`);
    }
  }
  if (labelFile?.sourceCorpusSha256 !== sha(caseBytes) || stable(labelFile?.reviewerIds) !== stable(reviews.map((review) => review.reviewerId)) ||
      labelFile?.adjudicationSha256 !== sha(readFileSync(ADJUDICATION))) blockers.push("adjudicated labels are not bound to exact independent review/adjudication files");
  if (manifest.labelsSha256 !== sha(readFileSync(join(CORPUS, "labels.json")))) blockers.push("manifest does not bind the adjudicated labels");
  if (dataset?.labelsSha256 !== sha(readFileSync(join(CORPUS, "labels.json"))) || dataset?.reviewASha256 !== sha(readFileSync(REVIEW_A)) ||
      dataset?.reviewBSha256 !== sha(readFileSync(REVIEW_B)) || dataset?.adjudicationSha256 !== sha(readFileSync(ADJUDICATION))) blockers.push("review and label hashes differ from freeze");
  const expectedProvenanceHash = (freeze.dataset as Record<string, unknown> | undefined)?.provenanceSha256;
  if (expectedProvenanceHash !== sha(provenanceBytes)) blockers.push("frozen provenance hash mismatch");
  return { blockers, rows, ...(labels === undefined ? {} : { labels }), freeze };
}

export function threeArmRequestCeiling(caseCount = 12, criterionCount = 24): number { return caseCount + criterionCount * 2; }

async function runExperiment(): Promise<void> {
  requireOk(process.argv.includes("--authorized-inference-60"), "run requires explicit --authorized-inference-60 operator authorization");
  requireOk(!existsSync(RESULTS), `refusing to overwrite ${RESULTS}`);
  requireOk(!existsSync(ATTEMPTS), `refusing to overwrite ${ATTEMPTS}`);
  const state = await checkPreflight();
  requireOk(state.blockers.length === 0, `preflight blocked: ${state.blockers.join("; ")}`);
  requireOk(threeArmRequestCeiling(state.rows.length, state.rows.reduce((sum, row) => sum + row.evidence.criteria.length, 0)) === TOTAL_REQUESTS, "request ceiling mismatch");
  const apiKey = process.env.OPENROUTER_API_KEY;
  requireOk(apiKey, "OPENROUTER_API_KEY missing; no inference sent");
  const transport: DecisionModel = new OpenRouterJevDecisionModel({ apiKey, model: REQUESTED_MODEL, maxRetries: 0, timeoutMs: 20_000 });
  writeNew(ATTEMPTS, "");
  const observedModels = new Set<string>();
  const results: Array<Record<string, unknown>> = [];
  let requests = 0;
  let cost = 0;
  const guardedModel = Object.create(transport) as DecisionModel;
  guardedModel.evaluate = async <Q extends Record<string, Question>>(request: EvaluateRequest<Q>): Promise<EvaluateResult<Q>> => {
    requireOk(requests < TOTAL_REQUESTS, "request ceiling reached; batch abort before additional inference");
    requireOk(cost < COST_CAP_USD, "spend ceiling reached; batch abort before additional inference");
    const requestIndex = requests + 1;
    const expectedQuestionHash = hashQuestions(request.questions);
    requests += 1;
    appendFileSync(ATTEMPTS, `${JSON.stringify({ type: "request-started", requestIndex, expectedQuestionHash, timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
    let answer;
    try {
      answer = await transport.evaluate(request);
    } catch (error) {
      appendFileSync(ATTEMPTS, `${JSON.stringify({ type: "request-failed", requestIndex, errorType: error instanceof Error ? error.name : "unknown" })}\n`, { mode: 0o600 });
      throw error;
    }
    appendFileSync(ATTEMPTS, `${JSON.stringify({ type: "response", requestIndex, provider: answer.provider, model: answer.model, questionHash: answer.questionHash,
      answers: answer.answers, usage: answer.usage, latencyMs: answer.latency_ms })}\n`, { mode: 0o600 });
    requireOk(answer.provider === PROVIDER && answer.model === RETURNED_MODEL, "provider or returned-model mismatch; batch abort");
    requireOk(answer.questionHash === expectedQuestionHash, "question hash mismatch; batch abort");
    const requestCost = answer.usage?.cost_usd;
    requireOk(requestCost !== undefined && Number.isFinite(requestCost) && requestCost >= 0, "missing or invalid actual cost; batch abort");
    observedModels.add(answer.model);
    cost += requestCost;
    requireOk(cost <= COST_CAP_USD, "actual cost cap exceeded; batch abort after recording the response");
    return answer;
  };
  for (const row of state.rows) {
    const globalReq = affirmativeRequest(row.evidence);
    const global = await guardedModel.evaluate({ state: globalReq.state as never, questions: globalReq.questions });
    const choiceJudgments: DagLocalCriterionJudgment[] = [];
    const atomicJudgments: DagLocalAtomicJudgment[] = [];
    for (const criterion of row.evidence.criteria) {
      const choice = await evaluateDagLocalCriterion(guardedModel, row.evidence, criterion.id);
      requireOk(choice !== undefined, `${row.id}/${criterion.id}: Choice answer invalid`);
      choiceJudgments.push(choice);
      const atomic = await evaluateDagLocalAtomicCriterion(guardedModel, row.evidence, criterion.id);
      requireOk(atomic !== undefined, `${row.id}/${criterion.id}: atomic Noul answer invalid`);
      atomicJudgments.push(atomic);
    }
    const choiceAggregate = aggregateDagLocalCriterionJudgments({ evidence: row.evidence, judgments: choiceJudgments,
      expectedProvider: PROVIDER, expectedModel: RETURNED_MODEL, expectedQuestionHash: hashQuestions({ fulfillment: DAG_LOCAL_CRITERION_QUESTION_V1 }) });
    const atomicAggregate = aggregateDagLocalAtomicJudgments({ evidence: row.evidence, judgments: atomicJudgments,
      expectedProvider: PROVIDER, expectedModel: RETURNED_MODEL, expectedQuestionHash: ATOMIC_HASH });
    const label = state.labels![row.id];
    requireOk(label !== undefined, `${row.id}: adjudicated label missing`);
    const globalAnswer = global.answers.closure;
    const globalChoice: SemanticFulfillmentChoice = globalAnswer?.type !== "choice" ? "UNCERTAIN" :
      globalAnswer.choice === "COMPLETE" ? "FULFILLED" : globalAnswer.choice === "INCOMPLETE" ? "NOT_FULFILLED" : "UNCERTAIN";
    const choiceLocalCorrect = choiceJudgments.filter((j) => j.disposition === label.criteria[j.criterionId]).length;
    const atomicLocalCorrect = atomicJudgments.filter((j) => j.disposition === label.criteria[j.criterionId]).length;
    results.push({ caseId: row.id, expected: label, global: { choice: globalChoice, answer: global.answers, provider: global.provider, model: global.model, questionHash: global.questionHash, usage: global.usage, latencyMs: global.latency_ms },
      localChoice: { judgments: choiceJudgments, criterionCorrect: choiceLocalCorrect, criterionCount: choiceJudgments.length, rawAggregate: choiceAggregate.semanticDisposition, hypotheticalTerminal: choiceAggregate.semanticDisposition === "FULFILLED", disposition: choiceAggregate.disposition, terminalComplete: false },
      localAtomic: { judgments: atomicJudgments, criterionCorrect: atomicLocalCorrect, criterionCount: atomicJudgments.length, rawAggregate: atomicAggregate.semanticDisposition, hypotheticalTerminal: atomicAggregate.semanticDisposition === "FULFILLED", disposition: atomicAggregate.disposition, terminalComplete: false } });
  }
  requireOk(requests === TOTAL_REQUESTS && observedModels.size === 1 && observedModels.has(RETURNED_MODEL), "final request count or model identity mismatch");
  writeNew(RESULTS, `${JSON.stringify({ schema: "jev-dag-three-arm-results/1", requestedModel: REQUESTED_MODEL, returnedModel: RETURNED_MODEL, provider: PROVIDER, requests, concurrency: 1, retries: 0, costUsd: cost, results }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "execute") return executeCorpus();
  if (command === "approve-plans") return approvePlans();
  if (command === "finalize") return finalizeCorpus();
  if (command === "freeze") { freezeCorpus(); return; }
  if (command === "preflight") {
    const state = await checkPreflight();
    process.stdout.write(JSON.stringify({ ready: state.blockers.length === 0, blockers: state.blockers, requests: TOTAL_REQUESTS, concurrency: 1, retries: 0, budgetUsd: COST_CAP_USD, requestedModel: REQUESTED_MODEL, returnedModel: RETURNED_MODEL, inferenceRequests: 0 }, null, 2) + "\n");
    process.exitCode = state.blockers.length === 0 ? 0 : 2;
    return;
  }
  if (command === "run") return runExperiment();
  throw new Error("usage: jev-dag-three-arm-dev.ts <execute|approve-plans|finalize|freeze|preflight|run>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
