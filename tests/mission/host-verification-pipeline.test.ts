/**
 * Real host verification pipeline acceptance (P0-2, default OFF).
 *
 * The host-owned producer (`produceHostVerificationInputs` in
 * `src/mission/runtime.ts`) reads the authoritative mission contract plus
 * graph history, establishes explicit criterion→producer-node associations,
 * collects observations from actual authorized verifier operations
 * (host-invoked adapters against real temp-dir state, never an
 * agent-supplied `passed: true`), binds every verdict to the current
 * mission revision + candidate, persists verifier receipts and reads them
 * back, and supplies associations+verdicts through
 * `createSessionMissionClosureRunner`.
 *
 * - A successful graph plus a false agent completion claim cannot satisfy
 *   a criterion without its independently produced + validated receipt.
 * - A genuinely fulfilled criterion CAN reach closure when all other
 *   qualified requirements hold (host allowlist + real temp files + stub
 *   Jev) — including the test/host-command, validated-runner-record,
 *   file-state, and tree-binding observation paths.
 * - Enabling the trusted path alone authorizes nothing; stale, foreign,
 *   conflicting, and untrusted inputs fail closed; execution-observed is
 *   never equated with verified-outcome.
 *
 * Stub models only, real local persistence (Store, FileJournal,
 * EvidenceLedger on temp dirs) plus real temp-dir file state and one real
 * `node --eval` spawn the harness observes (host-controlled invocation).
 * No metered inference, no network.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { hashQuestions } from "../../src/decision/provenance.js";
import type { DecisionModel } from "../../src/decision/types.js";
import { FileJournal, reconcileJournal } from "../../src/graph/journal.js";
import { executeGraph } from "../../src/graph/executor.js";
import { run as runGraphTool } from "../../src/tools/execute-graph-runner.js";
import {
  addMissionAttestations,
  parseMissionAttestation,
  parseMissionContract,
} from "../../src/mission/contract.js";
import {
  MISSION_CLOSURE_QUESTION_V2,
  MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2,
  semanticFulfillmentCandidateRequest,
  dagLocalCriterionRequest,
  type MissionClosurePolicy,
} from "../../src/mission/closure.js";
import { scoreSemanticFulfillmentCandidate, scoreSemanticQuestionPair } from "../../src/jev/lockbox.js";
import { createSessionMissionClosureSource } from "../../src/mission/session-source.js";
import {
  createSessionMissionClosureRunner,
  createControlServiceProofPlanClosureRunner,
  produceHostVerificationInputs,
  resolveTrustedRunnerOptions,
  type HostProducerResult,
  type ProduceHostVerificationInputsArgs,
} from "../../src/mission/runtime.js";
import type { MissionCriterionVerification } from "../../src/mission/closure.js";
import { verificationReceiptIds } from "../../src/mission/verifiers.js";
import { buildHostProofPlanPayload, hostProofPlanContentDigest } from "../../src/mission/proof-plan.js";
import type { ServiceHostProofPlan } from "../../src/control/client.js";
import { testLedger, testStore } from "../helpers/control-state.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROMPT = `Ship the parser change.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- Parser handles the new syntax.`;

const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);
const F = "f".repeat(64);
const V2_HASH = hashQuestions({ closure: MISSION_CLOSURE_QUESTION_V2 });
const SEMANTIC_FULFILLMENT_HASH = hashQuestions({ closure: MISSION_SEMANTIC_FULFILLMENT_QUESTION_V2 });
const POLICY_V2: MissionClosurePolicy = {
  policyVersion: "mission-closure/1",
  minConfidence: 0.8,
  calibrated: true,
  backend: "typesafe",
  model: "jev-1.14.0",
  modelVersion: "jev-1.14.0",
  questionHash: V2_HASH,
  calibrationVersion: "host-pipeline-fixture-1",
};
const POLICY_SEMANTIC_FULFILLMENT: MissionClosurePolicy = {
  ...POLICY_V2,
  minConfidence: 0.9,
  policyVersion: "mission-semantic-fulfillment/v2",
  questionHash: SEMANTIC_FULFILLMENT_HASH,
  calibrationVersion: "development-candidate-unqualified",
};

const CORRECTIVE_PROBE_SCENARIOS = [
  {
    id: "revoked-membership",
    requirement: "A member whose membership is revoked immediately loses authorization.",
    source: "export function authorizeMember(active: boolean, revoked: boolean): boolean { return active; }\n",
    correctedSource: "export function authorizeMember(active: boolean, revoked: boolean): boolean { return active && !revoked; }\n",
    baseline: 'import { authorizeMember } from "./probe-target.mjs"; if (!authorizeMember(true, false)) throw new Error("baseline membership denied");',
    probe: 'import { authorizeMember } from "./probe-target.mjs"; if (authorizeMember(true, true)) throw new Error("AssertionError: revoked member still authorized");',
  },
  {
    id: "incomplete-v2-api",
    requirement: "The v2 write endpoint accepts valid writes while preserving v1 behavior.",
    source: "export function writeV1(): number { return 200; }\nexport function writeV2(): number { return 501; }\n",
    correctedSource: "export function writeV1(): number { return 200; }\nexport function writeV2(): number { return 200; }\n",
    baseline: 'import { writeV1 } from "./probe-target.mjs"; if (writeV1() !== 200) throw new Error("baseline v1 write failed");',
    probe: 'import { writeV2 } from "./probe-target.mjs"; if (writeV2() !== 200) throw new Error("AssertionError: v2 write did not succeed");',
  },
  {
    id: "input-validation",
    requirement: "Numeric input with trailing non-numeric characters is rejected instead of silently accepted.",
    source: "export function parseLimit(value: string): number { return Number.parseInt(value, 10); }\n",
    correctedSource: "export function parseLimit(value: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || value.trim() !== String(parsed)) throw new Error(\"invalid numeric input\"); return parsed; }\n",
    baseline: 'import { parseLimit } from "./probe-target.mjs"; if (parseLimit("12") !== 12) throw new Error("baseline parse failed");',
    probe: 'import { parseLimit } from "./probe-target.mjs"; let accepted = false; try { accepted = Number.isFinite(parseLimit("12invalid")); } catch { accepted = false; } if (accepted) throw new Error("AssertionError: malformed input was accepted");',
  },
] as const;

function stubComplete(): DecisionModel {
  return {
    evaluate: async (input: Parameters<DecisionModel["evaluate"]>[0]) => ({
      provider: "typesafe",
      model: "jev-1.14.0",
      questionHash: hashQuestions(input.questions),
      answers: {
        closure: {
          type: "choice",
          choice: "COMPLETE",
          confidence: 1,
          probabilities: { COMPLETE: 1, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
        },
      },
    }),
  } as unknown as DecisionModel;
}

function writeJournal(
  graphDir: string,
  sessionId: string,
  runId: string,
  nodes: Array<{ nodeId: string; inputHash: string; outputDigest: string }> = [
    { nodeId: "build", inputHash: C, outputDigest: D },
  ],
): void {
  mkdirSync(graphDir, { recursive: true, mode: 0o700 });
  const journal = new FileJournal(runId, graphDir, sessionId);
  journal.record({ type: "run-started", runId, ts: "2026-01-01T00:00:00.000Z", graphHash: "a".repeat(64), policyHash: "b".repeat(64) });
  nodes.forEach((node, index) => {
    const attemptId = `${node.nodeId}/${index + 1}`;
    journal.record({ type: "node-authorized", runId, ts: "2026-01-01T00:00:01.000Z", nodeId: node.nodeId, attemptId, allowed: true, inputHash: node.inputHash });
    journal.record({ type: "node-running", runId, ts: "2026-01-01T00:00:02.000Z", nodeId: node.nodeId, attemptId, inputHash: node.inputHash });
    journal.record({ type: "node-terminal", runId, ts: "2026-01-01T00:00:03.000Z", nodeId: node.nodeId, attemptId, declaredDependencies: [], status: "succeeded", inputHash: node.inputHash, outputDigest: node.outputDigest });
  });
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function writeEvidenceFile(root: string, rel: string, content: string): string {
  writeFileSync(join(root, rel), content);
  return sha256Text(content);
}

/** Host-controlled invocation: really spawn, really observe the exit + output. */
function hostInvokeSuite(exitCode: 0 | 1): { exitCode: number; outputDigest: string } {
  const marker = `host-suite-output-${exitCode}`;
  try {
    const out = execFileSync(
      process.execPath,
      ["--eval", `process.stdout.write(${JSON.stringify(marker)});process.exit(${exitCode});`],
      { encoding: "utf8" },
    );
    return { exitCode: 0, outputDigest: sha256Text(out) };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const stdout = (error as { stdout?: unknown }).stdout;
    return {
      exitCode: typeof status === "number" ? status : -1,
      outputDigest: sha256Text(typeof stdout === "string" ? stdout : ""),
    };
  }
}

/** Host-run migration fixture: the v2 write endpoint returns HTTP 501. */
function hostObserveV2Write(): { exitCode: number; outputDigest: string } {
  const script = `const response={status:501};process.stdout.write(JSON.stringify(response));if(response.status!==200)process.exit(1);`;
  try {
    const output = execFileSync(process.execPath, ["--eval", script], { encoding: "utf8" });
    return { exitCode: 0, outputDigest: sha256Text(output) };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const stdout = (error as { stdout?: unknown }).stdout;
    return {
      exitCode: typeof status === "number" ? status : -1,
      outputDigest: sha256Text(typeof stdout === "string" ? stdout : ""),
    };
  }
}

interface MissionFixture {
  dataDir: string;
  evidenceRoot: string;
  store: ReturnType<typeof testStore>;
  contract: NonNullable<ReturnType<typeof parseMissionContract>>;
  candidateDigest: string;
  candidateRevision: string;
}

/** Full qualified baseline: journal + host test record + attestation + independent attestation. */
async function setupMission(
  sessionId: string,
  nodes: Array<{ nodeId: string; inputHash: string; outputDigest: string }> = [
    { nodeId: "build", inputHash: C, outputDigest: D },
  ],
  prompt = PROMPT,
): Promise<MissionFixture> {
  const dataDir = tempDir("jeverb-host-pipeline-");
  const evidenceRoot = tempDir("jeverb-host-evidence-");
  const store = testStore(dataDir);
  const contract = parseMissionContract(sessionId, prompt, 100);
  if (contract === undefined) throw new Error("contract fixture failed to parse");
  store.updateSession(sessionId, (state) => ({ ...state, mission_contract: contract }));
  writeJournal(join(dataDir, "graph-journals"), sessionId, "run-1", nodes);
  store.updateSession(sessionId, (state) => ({
    ...state,
    verification: { last: { kind: "test" as const, ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
  }));
  const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load(sessionId, contract.missionId);
  if (probe.candidateDigest === undefined || probe.candidateRevision === undefined) {
    throw new Error("probe lacks candidate identity");
  }
  const userPrompt =
    `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\nverified:\n` +
    contract.criteria.map((criterion) => `- ${criterion.id}: host verification fixture`).join("\n");
  const attestations = parseMissionAttestation(sessionId, userPrompt, contract, 200);
  if (attestations === undefined) throw new Error("attestation fixture failed to parse");
  store.updateSession(sessionId, (state) => ({
    ...state,
    mission_contract: addMissionAttestations(state.mission_contract as typeof contract, attestations),
    independentVerifications: undefined,
  }));
  store.updateSession(sessionId, (state) => ({
    ...state,
    mission_contract: {
      ...(state.mission_contract as typeof contract),
      independentVerifications: [{
        verifierId: "mission-verifier-1",
        missionRevision: contract.missionRevision,
        evidenceRevision: probe.candidateRevision as string,
        candidate: probe.candidateDigest as string,
        verificationResult: "pass" as const,
        receiptCorrelationId: "mission-receipt-1",
        verifiedAt: 350,
      }],
    },
  }));
  return { dataDir, evidenceRoot, store, contract, candidateDigest: probe.candidateDigest, candidateRevision: probe.candidateRevision };
}

async function produce(args: Omit<ProduceHostVerificationInputsArgs, "dataDir" | "missionId" | "now"> & { dataDir: string; missionId: string }): Promise<HostProducerResult> {
  return produceHostVerificationInputs({ ...args, now: () => 400 });
}

async function closeTrusted(fixture: MissionFixture, sessionId: string, produced: HostProducerResult, trustedVerifierIds: string[]) {
  const ledger = testLedger(fixture.dataDir);
  const runner = createSessionMissionClosureRunner({
    model: stubComplete(),
    config: { dataDir: fixture.dataDir, missionClosurePolicy: POLICY_V2, timeoutMs: 1500 },
    store: fixture.store,
    ledger,
    now: () => 400,
    enableTrustedGraphEvidence: true,
    criterionProducerAssociations: produced.associations,
    criterionVerifications: produced.verifications,
    trustedVerifierIds,
  });
  const result = await runner(sessionId);
  if ("outcome" in result) throw new Error(`runner not applicable: ${result.reason}`);
  return result;
}

describe("host verification producer", () => {
  it("builds a host plan for a real code change and refuses closure without the operator verdict", async () => {
    const sessionId = "session-code-change-e2e";
    const prompt = [
      "Implement percentage discounts correctly.",
      "Objective coverage: exhaustive",
      "Acceptance criteria:",
      "- A 10 percent discount on 100 returns 90.",
    ].join("\n");
    const fixture = await setupMission(sessionId, undefined, prompt);
    const codeRoot = tempDir("jeverb-real-code-change-");
    const sourcePath = join(codeRoot, "discount.ts");
    const testPath = join(codeRoot, "discount.test.ts");
    const testCommand = "typescript-transpile-and-run discount.test.ts";
    writeFileSync(sourcePath,
      "export function discountedTotal(amount: number, percent: number): number { return amount * (1 + percent / 100); }\n",
    );
    writeFileSync(testPath,
      "import { equal } from 'node:assert/strict'; import { discountedTotal } from './discount.js'; equal(discountedTotal(100, 10), 90);\n",
    );
    const runDisposableSuite = (): string => {
      const sourceOutput = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const testOutput = ts.transpileModule(readFileSync(testPath, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const sourceModule = { exports: {} as Record<string, unknown> };
      runInNewContext(sourceOutput, { module: sourceModule, exports: sourceModule.exports });
      const testModule = { exports: {} as Record<string, unknown> };
      const requireForTest = (name: string): unknown => name === "./discount.js"
        ? sourceModule.exports
        : name === "node:assert/strict"
          ? { equal: (actual: unknown, expected: unknown) => {
              if (actual !== expected) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
            } }
          : (() => { throw new Error(`test attempted undeclared import ${name}`); })();
      runInNewContext(testOutput, { module: testModule, exports: testModule.exports, require: requireForTest });
      return "discount test passed";
    };
    let initialStatus = 0;
    try { runDisposableSuite(); } catch { initialStatus = 1; }
    expect(initialStatus).not.toBe(0);

    // This is the actual code change under test, in a disposable workspace.
    writeFileSync(sourcePath,
      "export function discountedTotal(amount: number, percent: number): number { return amount * (1 - percent / 100); }\n",
    );
    const runId = "run-real-code-change";
    const graphDir = join(fixture.dataDir, "graph-journals");
    mkdirSync(graphDir, { recursive: true, mode: 0o700 });
    const graph = { version: 1 as const, nodes: [{ id: "verify-code-change", kind: "shell" as const, command: testCommand }] };
    const results = await executeGraph(
      graph,
      { authorize: async () => ({ allowed: true }) },
      async () => runDisposableSuite(),
      {
        runId,
        policyHash: "a".repeat(64),
        journal: new FileJournal(runId, graphDir, sessionId),
        timeoutMs: 15_000,
      },
    );
    if (results[0]?.status !== "succeeded") throw new Error(`code-check graph failed: ${JSON.stringify(results[0])}`);
    expect(results).toMatchObject([{ nodeId: "verify-code-change", status: "succeeded" }]);

    const ledger = testLedger(fixture.dataDir);
    // The graph runner's real exit/output is recorded by the host verification
    // ledger, as the installed hook does. The plan maps that run, its exact
    // attempt, and the source/test files to the original criterion.
    const attemptId = "verify-code-change/1";
    fixture.store.updateSession(sessionId, (state) => ({
      ...state,
      verification: {
        last: { kind: "test" as const, ok: true, ts: 350, command: testCommand, cwd: codeRoot },
        byKind: { test: { kind: "test" as const, ok: true, ts: 350, command: testCommand, cwd: codeRoot } },
        edits_since: 0,
        editsSinceByKind: { test: 0 },
      },
      mission_contract: { ...(state.mission_contract as typeof fixture.contract), independentVerifications: [] },
    }));
    const plan = buildHostProofPlanPayload(fixture.contract, {
      schema: "jeverb-host-proof-plan-input/1",
      workspaceRoot: codeRoot,
      criteria: [{
        criterionId: fixture.contract.criteria[0]!.id,
        testCommand,
        producers: [{ runId, nodeId: "verify-code-change", attemptId }],
        codeFiles: ["discount.ts", "discount.test.ts"],
      }],
    });
    // This seam supplies only the control-service plan receipt needed to
    // exercise the installed runner adapter. It is not an independent
    // verification attestation; that authority is deliberately absent.
    const servicePlan: ServiceHostProofPlan = {
      ...plan,
      planDigest: hostProofPlanContentDigest(plan),
      receiptCorrelationId: "a".repeat(32),
      approvedAt: 1,
      approvedByUid: 0,
    };
    const hostProduced = await produceHostVerificationInputs({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger,
      evidenceRoot: codeRoot,
      specs: plan.criteria.map((entry) => ({
        criterionId: entry.criterionId,
        producers: entry.producers,
        test: {
          kind: "validated-runner-record" as const,
          expectedCommandSha256: plan.criteria[0]!.testCommandSha256,
          expectedCwd: codeRoot,
        },
      })),
      now: () => 400,
      hostProofPlanDigest: servicePlan.planDigest,
      criterionCodeFiles: plan.criteria.map(({ criterionId, codeFiles }) => ({ criterionId, files: codeFiles })),
      structuralAnalysisRoot: plan.workspaceRoot,
    });
    expect(hostProduced.reports).toMatchObject([{ status: "satisfied", verifierId: "test-execution" }]);
    const model = stubComplete();
    let modelCalls = 0;
    const observingModel = {
      async evaluate(input: Parameters<DecisionModel["evaluate"]>[0]) {
        modelCalls += 1;
        return model.evaluate(input);
      },
    } as DecisionModel;
    const runner = createControlServiceProofPlanClosureRunner({
      model: observingModel,
      config: { dataDir: fixture.dataDir, missionClosurePolicy: POLICY_V2, timeoutMs: 1500 },
      store: fixture.store,
      ledger,
      now: () => 400,
      readPlan: async (missionId) => missionId === plan.missionId
        ? { ok: true, generation: "1".repeat(32), plan: servicePlan }
        : { ok: true, generation: "1".repeat(32) },
      // No operator completion attestation is fabricated or inserted.
      readAttestations: async () => [],
    });
    const result = await runner(sessionId);
    if ("outcome" in result) throw new Error(`runner not applicable: ${result.reason}`);
    expect(result.decision.checks.allCriteriaVerified).toBe(true);
    expect(result.decision.checks.independentVerificationPassed).toBe(false);
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
    expect(modelCalls).toBe(0);
    expect(result.receipt.status).toMatch(/appended|duplicate/);

    const current = await createSessionMissionClosureSource({
      store: fixture.store,
      dataDir: fixture.dataDir,
      now: () => 400,
      ledger,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: plan.criteria.flatMap((entry) => entry.producers.map((producer) => ({
        criterionId: entry.criterionId, runId: producer.runId, nodeId: producer.nodeId,
        ...(producer.attemptId === undefined ? {} : { attemptId: producer.attemptId }),
      }))),
      criterionVerifications: hostProduced.verifications,
      trustedVerifierIds: ["test-execution"],
      criterionCodeFiles: plan.criteria.map(({ criterionId, codeFiles }) => ({ criterionId, files: codeFiles })),
      structuralAnalysisRoot: plan.workspaceRoot,
      hostProofPlanDigest: servicePlan.planDigest,
    }).load(sessionId, fixture.contract.missionId);
    expect(current.criteria[0]?.proofObligation?.codeStructure?.fileDigests).toHaveLength(2);
    expect(current.criteria[0]?.graphEvidence?.[0]?.attemptId).toBe(attemptId);
    const localRequest = dagLocalCriterionRequest(current, fixture.contract.criteria[0]!.id);
    expect(localRequest?.state.proofObligation?.codeStructure?.calls).toContainEqual(expect.objectContaining({
      relation: "compiler-resolved",
      targetSymbolId: expect.any(String),
    }));
  });

  it("builds the semantic candidate input from host observations, graph lineage, candidate identity, and durable receipts", async () => {
    const sessionId = "session-semantic-verified-dev";
    const prompt = [
      "Serve API v2 writes alongside v1, sunset v1 after six months, and evict expired sessions.",
      "Objective coverage: exhaustive",
      "Acceptance criteria:",
      "- v1 and v2 reads coexist during migration.",
      "- v1 sunset carries six months notice.",
    ].join("\n");
    const fixture = await setupMission(sessionId, undefined, prompt);
    const readDigest = writeEvidenceFile(fixture.evidenceRoot, "migration-read.txt", "v1 and v2 reads are served");
    const sunsetDigest = writeEvidenceFile(fixture.evidenceRoot, "sunset.txt", "sunset date: 2027-05-01");
    // The original objective includes writes and session eviction while the
    // verified criterion list omits both, testing semantic coverage.
    const ledger = testLedger(fixture.dataDir);
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger,
      evidenceRoot: fixture.evidenceRoot,
      specs: [
        { criterionId: "criterion-01", producers: [{ runId: "run-1", nodeId: "build" }], files: [{ path: "migration-read.txt", expectedDigest: readDigest }] },
        { criterionId: "criterion-02", producers: [{ runId: "run-1", nodeId: "build" }], files: [{ path: "sunset.txt", expectedDigest: sunsetDigest }] },
      ],
    });
    expect(produced.reports.map((row) => row.status)).toEqual(["satisfied", "satisfied"]);
    const receipts = verificationReceiptIds(ledger.read().records);
    expect(produced.verifications.every((row) => receipts.has(row.receiptCorrelationId))).toBe(true);

    const evidence = await createSessionMissionClosureSource({
      store: fixture.store,
      dataDir: fixture.dataDir,
      now: () => 400,
      ledger,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: produced.associations,
      criterionVerifications: produced.verifications,
      trustedVerifierIds: ["file-state"],
    }).load(sessionId, fixture.contract.missionId);
    const request = semanticFulfillmentCandidateRequest(evidence, POLICY_SEMANTIC_FULFILLMENT);
    expect(request).toBeDefined();
    expect(request!.state.objective).toContain("evict expired sessions");
    expect(request!.state.acceptanceCriteria).toHaveLength(2);
    expect(request!.state.criterionEvidence?.every((row) => row.verificationResult === "satisfied")).toBe(true);
    expect(request!.state.criterionEvidence?.every((row) => row.observedGraphState.some((node) => node.state === "bound"))).toBe(true);
    expect(request!.state.criterionEvidence?.every((row) => row.verificationScope?.candidateDigest === evidence.candidateDigest)).toBe(true);

    const model = {
      async evaluate(input: Parameters<DecisionModel["evaluate"]>[0]) {
        const questionHash = hashQuestions(input.questions);
        if (questionHash === V2_HASH) {
          return {
            provider: "typesafe", model: "jev-1.14.0", questionHash: V2_HASH,
            answers: { closure: { type: "choice", choice: "COMPLETE", confidence: 1,
              probabilities: { COMPLETE: 1, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 } } },
            usage: { input_tokens: 130, output_tokens: 8 }, latency_ms: 1,
          };
        }
        expect(questionHash).toBe(SEMANTIC_FULFILLMENT_HASH);
        expect(JSON.stringify(input.state)).toContain("evict expired sessions");
        return {
          provider: "typesafe", model: "jev-1.14.0", questionHash: SEMANTIC_FULFILLMENT_HASH,
          answers: { closure: { type: "choice", choice: "NOT_FULFILLED", confidence: 0.7,
            probabilities: { FULFILLED: 0.1, NOT_FULFILLED: 0.8, UNCERTAIN: 0.1 } } },
          usage: { input_tokens: 140, output_tokens: 9 }, latency_ms: 1,
        };
      },
    } as unknown as DecisionModel;
    const pair = await scoreSemanticQuestionPair({
      model,
      evidence,
      baselinePolicy: { ...POLICY_V2, minConfidence: 0.9 },
      candidatePolicy: POLICY_SEMANTIC_FULFILLMENT,
      expected: "NOT_FULFILLED",
    });
    expect(pair).toMatchObject({
      status: "scored",
      inferenceRequests: 2,
      baseline: { choice: "COMPLETE", semanticChoice: "FULFILLED", semanticCorrect: false, terminalGateAccepted: true },
      candidate: { status: "answered", choice: "NOT_FULFILLED", correct: true, confidence: 0.7 },
    });

    const malformedConfidenceModel = {
      async evaluate(input: Parameters<DecisionModel["evaluate"]>[0]) {
        return {
          provider: "typesafe", model: "jev-1.14.0", questionHash: hashQuestions(input.questions),
          answers: { closure: { type: "choice", choice: "NOT_FULFILLED", confidence: 0.8,
            probabilities: { FULFILLED: 0.1, NOT_FULFILLED: 0.8, UNCERTAIN: 0.1 } } },
          usage: { input_tokens: 140, output_tokens: 9 }, latency_ms: 1,
        };
      },
    } as unknown as DecisionModel;
    const malformed = await scoreSemanticFulfillmentCandidate(
      malformedConfidenceModel, evidence, POLICY_SEMANTIC_FULFILLMENT, "NOT_FULFILLED",
    );
    expect(malformed.status).toBe("invalid");
  });

  it.each(CORRECTIVE_PROBE_SCENARIOS)("runs the approved $id probe through the graph path and returns a receipt-linked repair obligation", async (scenario) => {
    const sessionId = `session-approved-probe-${scenario.id}`;
    const prompt = `Implement the requested behavior.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- ${scenario.requirement}`;
    const fixture = await setupMission(sessionId, undefined, prompt);
    const sourceFile = join(fixture.evidenceRoot, "probe-target.ts");
    writeFileSync(sourceFile, scenario.source);
    writeFileSync(join(fixture.evidenceRoot, "probe-check.mjs"), [
      scenario.probe,
    ].join("\n"));
    writeFileSync(join(fixture.evidenceRoot, "baseline-check.mjs"), scenario.baseline);
    writeFileSync(join(fixture.evidenceRoot, "probe-target.mjs"), ts.transpileModule(readFileSync(sourceFile, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText);
    const testCommand = "node --jitless --max-old-space-size=64 baseline-check.mjs";
    const baselineOutput = execFileSync(process.execPath, ["--jitless", "--max-old-space-size=64", "baseline-check.mjs"], {
      cwd: fixture.evidenceRoot, encoding: "utf8", timeout: 5_000,
    });
    fixture.store.updateSession(sessionId, (state) => ({
      ...state,
      verification: {
        last: { kind: "test" as const, ok: true, ts: 350, command: testCommand, cwd: fixture.evidenceRoot, outputDigest: sha256Text(baselineOutput) },
        byKind: { test: { kind: "test" as const, ok: true, ts: 350, command: testCommand, cwd: fixture.evidenceRoot, outputDigest: sha256Text(baselineOutput) } },
        edits_since: 0,
        editsSinceByKind: { test: 0 },
      },
    }));
    const probeCommand = "node --jitless --max-old-space-size=64 probe-check.mjs";
    writeFileSync(join(fixture.evidenceRoot, "repair.mjs"), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync("probe-target.ts", ${JSON.stringify(scenario.correctedSource)});`,
      `writeFileSync("probe-target.mjs", ${JSON.stringify(ts.transpileModule(scenario.correctedSource, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      }).outputText)});`,
    ].join("\n"));
    const plan = buildHostProofPlanPayload(fixture.contract, {
      schema: "jeverb-host-proof-plan-input/4",
      workspaceRoot: fixture.evidenceRoot,
      criteria: [{
        criterionId: fixture.contract.criteria[0]!.id,
        testCommand,
        producers: [{ runId: "run-1", nodeId: "build", attemptId: "build/1" }],
        codeFiles: ["probe-target.ts"],
        probeActions: [{
          id: scenario.id, description: `Verify: ${scenario.requirement}`,
          command: probeCommand,
          producers: [{ runId: "run-1", nodeId: "build", attemptId: "build/1" }],
          nodeId: `probe-${scenario.id}`, maxExecutions: 2,
        }],
        repairActions: [{ id: `repair-${scenario.id}`, description: `Repair only: ${scenario.requirement}`,
          command: "node --jitless --max-old-space-size=64 repair.mjs",
          producers: [{ runId: "run-1", nodeId: "build", attemptId: "build/1" }],
          nodeId: `repair-${scenario.id}`, maxExecutions: 1 }],
      }],
    });
    const servicePlan: ServiceHostProofPlan = {
      ...plan, planDigest: hostProofPlanContentDigest(plan), receiptCorrelationId: "d".repeat(32),
      approvedAt: 1, approvedByUid: 0,
    };
    const approvedSnapshot = await createSessionMissionClosureSource({
      store: fixture.store, dataDir: fixture.dataDir, now: () => 600,
      hostProofPlanDigest: servicePlan.planDigest,
      criterionCodeFiles: plan.criteria.map(({ criterionId, codeFiles }) => ({ criterionId, files: codeFiles })),
      structuralAnalysisRoot: plan.workspaceRoot,
    }).load(sessionId, fixture.contract.missionId);
    const serviceAttestation = {
      missionId: fixture.contract.missionId, missionRevision: fixture.contract.missionRevision,
      evidenceRevision: approvedSnapshot.candidateRevision!, candidate: approvedSnapshot.candidateDigest!,
      result: "pass" as const, receiptCorrelationId: "e".repeat(32), verifiedAt: 600, verifierUid: 0,
    };
    const ledger = testLedger(fixture.dataDir);
    const localModel = {
      evaluate: async (request: Parameters<DecisionModel["evaluate"]>[0]) => ({
        provider: "typesafe", model: "typesafe/jev-latest", questionHash: hashQuestions(request.questions),
        answers: {
          fulfillment: { type: "choice", choice: "UNCERTAIN", confidence: 0.7,
            probabilities: { FULFILLED: 0.1, NOT_FULFILLED: 0.2, UNCERTAIN: 0.7 } },
          probe: { type: "choice", choice: scenario.id, confidence: 0.9,
            probabilities: { [scenario.id]: 0.9, NO_PROBE: 0.1 } },
        },
        usage: { input_tokens: 20, output_tokens: 5 }, latency_ms: 3,
      }) as never,
    } as unknown as DecisionModel;
    const globalModel = stubComplete();
    let localRequests = 0;
    let probeQuestionContext = "";
    const selectedModel: DecisionModel = {
      evaluate: async (request: Parameters<DecisionModel["evaluate"]>[0]) => {
        const probeQuestion = request.questions.probe as { criteria: Record<string, string> } | undefined;
        if (probeQuestion === undefined) return globalModel.evaluate(request);
        localRequests += 1;
        probeQuestionContext = probeQuestion.criteria[scenario.id] ?? "";
        return localModel.evaluate(request);
      },
    } as unknown as DecisionModel;
    const runner = createControlServiceProofPlanClosureRunner({
      model: selectedModel,
      config: { dataDir: fixture.dataDir, missionClosurePolicy: POLICY_V2, timeoutMs: 1500 },
      store: fixture.store, ledger, now: () => 900,
      readPlan: async () => ({ ok: true, generation: "2".repeat(32), plan: servicePlan }),
      readAttestations: async () => {
        const current = await createSessionMissionClosureSource({
          store: fixture.store, dataDir: fixture.dataDir, now: () => 900,
          hostProofPlanDigest: servicePlan.planDigest,
          criterionCodeFiles: plan.criteria.map(({ criterionId, codeFiles }) => ({ criterionId, files: codeFiles })),
          structuralAnalysisRoot: plan.workspaceRoot,
        }).load(sessionId, fixture.contract.missionId);
        return [{ ...serviceAttestation, evidenceRevision: current.candidateRevision!, candidate: current.candidateDigest! }];
      },
    });
    const previousShellPolicy = process.env.JEV_GRAPH_SHELL;
    process.env.JEV_GRAPH_SHELL = "allow";
    let result: Awaited<ReturnType<typeof runner>>;
    let recovered: Awaited<ReturnType<typeof runner>>;
    try {
      result = await runner(sessionId);
      recovered = await runner(sessionId);
    } finally {
      if (previousShellPolicy === undefined) delete process.env.JEV_GRAPH_SHELL;
      else process.env.JEV_GRAPH_SHELL = previousShellPolicy;
    }
    if ("outcome" in result) throw new Error(`runner not applicable: ${result.reason}`);
    if ("outcome" in recovered) throw new Error(`recovery not applicable: ${recovered.reason}`);
    expect(probeQuestionContext).toContain("run-1/build@build/1");
    expect(probeQuestionContext).not.toContain(probeCommand);
    expect(result.terminalComplete, `${JSON.stringify(result.decision)}`).toBe(true);
    expect(result.decision.complete, `${result.decision.reasons.join("; ")} / ${JSON.stringify(result.decision.checks)}`).toBe(true);
    expect(result.decision.repairTask).toBeUndefined();
    const repairReceipts = ledger.read().records.filter((record) =>
      record.event === "ControlAction" && record.controlAction?.action === "verification-repair-obligation");
    expect(repairReceipts).toHaveLength(1);
    expect(repairReceipts[0]?.controlAction).toMatchObject({
      criterionId: fixture.contract.criteria[0]!.id,
      terminalReceipt: expect.stringMatching(/^[0-9a-f]{64}$/),
      evidenceRefs: expect.arrayContaining([expect.stringMatching(/^graph-run:/), expect.stringMatching(/^verifier-receipt:/)]),
      maxAttempts: 1,
    });
    expect(ledger.read().records.some((record) => record.event === "CriterionVerification" && record.enforcement === "criterion_failed")).toBe(true);
    expect(ledger.read().records.filter((record) => record.event === "ControlAction").map((record) => record.controlAction?.action)).toContain("verification-probe-reserved");
    expect(ledger.read().records.filter((record) => record.event === "ControlAction").map((record) => record.controlAction?.action)).toContain("verification-repair-reserved");
    expect(ledger.read().records.filter((record) => record.event === "ControlAction").map((record) => record.controlAction?.action)).toContain("verification-repair-result");
    expect(localRequests).toBe(1);
    expect(recovered.decision.complete, `${JSON.stringify(recovered.decision)}`).toBe(true);
    expect(ledger.read().records.filter((record) => record.event === "ControlAction" &&
      record.controlAction?.action === "verification-repair-obligation")).toHaveLength(1);
    const repairRunRecord = ledger.read().records.find((record) => record.event === "ControlAction" && record.controlAction?.action === "verification-repair-result");
    const currentRepairSnapshot = await createSessionMissionClosureSource({
      store: fixture.store, dataDir: fixture.dataDir, now: () => 900,
      hostProofPlanDigest: servicePlan.planDigest,
      criterionCodeFiles: plan.criteria.map(({ criterionId, codeFiles }) => ({ criterionId, files: codeFiles })),
      structuralAnalysisRoot: plan.workspaceRoot,
    }).load(sessionId, fixture.contract.missionId);
    expect(repairRunRecord?.controlAction?.candidateDigest).toBe(currentRepairSnapshot.candidateDigest);
    expect(repairRunRecord?.controlAction?.evidenceRefs).toEqual(expect.arrayContaining([
      expect.stringMatching(/^graph-run:/), expect.stringMatching(/^graph-node:repair-/), expect.stringMatching(/^graph-node:verify-/),
      expect.stringMatching(/^graph-node:probe-/), expect.stringMatching(/^verifier-receipt:/),
    ]));
    const repairVerifierRefs = repairRunRecord?.controlAction?.evidenceRefs?.filter((ref) => ref.startsWith("verifier-receipt:")) ?? [];
    const repairedPrimaryReceipt = ledger.read().records.find((record) => record.event === "CriterionVerification" &&
      repairVerifierRefs.includes(`verifier-receipt:${record.correlationId}`) &&
      record.deterministicFindings.some((finding) => finding === `evidence_ref=host-command:${testCommand}`));
    const repairedProbeReceipt = ledger.read().records.find((record) => record.event === "CriterionVerification" &&
      repairVerifierRefs.includes(`verifier-receipt:${record.correlationId}`) &&
      record.deterministicFindings.some((finding) => finding === `evidence_ref=host-command:${probeCommand}`));
    expect(repairedPrimaryReceipt).toBeDefined();
    expect(repairedProbeReceipt).toBeDefined();
    const graphRunRef = repairRunRecord?.controlAction?.evidenceRefs?.filter((ref) => ref.startsWith("graph-run:")).at(-1);
    expect(graphRunRef).toBeDefined();
    const graphRunId = graphRunRef!.slice("graph-run:".length);
    const journalPath = join(fixture.dataDir, "graph-journals", `jeverb-graph-${graphRunId}.jsonl`);
    const journalEvents = readFileSync(journalPath, "utf8").trim().split("\n").map((row) => JSON.parse(row) as { type?: string; status?: string; nodeId?: string });
    expect(journalEvents.find((row) => row.type === "node-terminal" && row.nodeId === `repair-${scenario.id}`)?.status).toBe("succeeded");
    expect(journalEvents.filter((row) => row.type === "node-running" && row.nodeId === `repair-${scenario.id}`)).toHaveLength(1);
    expect(journalEvents.some((row) => row.type === "node-terminal" && row.nodeId?.startsWith("verify-") && row.status === "succeeded")).toBe(true);
    expect(journalEvents.some((row) => row.type === "node-terminal" && row.nodeId?.startsWith("probe-") && row.status === "succeeded")).toBe(true);
    // The next Stop reconstructs current evidence from the durable repair
    // journal and receipt instead of asking Jev to repeat its prior probe decision.
    expect(localRequests).toBe(1);
    expect(readFileSync(sourceFile, "utf8")).toBe(scenario.correctedSource);

    // A terminal node status alone is not enough to reconstruct verifier
    // evidence. Recovery must bind the journal to the exact host-approved
    // repair/test/probe graph and session before treating it as an observation.
    const tamperedHeader = { ...journalEvents[0], graphHash: "0".repeat(64) };
    const tamperedJournal = [JSON.stringify(tamperedHeader), ...journalEvents.slice(1).map((row) => JSON.stringify(row))].join("\n") + "\n";
    writeFileSync(journalPath, tamperedJournal);
    const afterTamperedRecovery = await runner(sessionId);
    if ("outcome" in afterTamperedRecovery) throw new Error(`tampered recovery unexpectedly fell back: ${afterTamperedRecovery.reason}`);
    expect(afterTamperedRecovery.decision.complete).toBe(false);
    expect(afterTamperedRecovery.terminalComplete).toBe(false);
    expect(localRequests).toBe(1);
    expect(readFileSync(journalPath, "utf8").match(/"type":"node-running"[^\n]*"nodeId":"repair-[^"]+"/g)).toHaveLength(1);
  });

  it("recovers a terminal failed probe after a runner crash without inventing failure semantics or replaying it", async () => {
    const scenario = CORRECTIVE_PROBE_SCENARIOS[0]!;
    const sessionId = "session-probe-crash-recovery";
    const prompt = `Implement the requested behavior.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- ${scenario.requirement}`;
    const fixture = await setupMission(sessionId, undefined, prompt);
    writeFileSync(join(fixture.evidenceRoot, "probe-target.ts"), scenario.source);
    writeFileSync(join(fixture.evidenceRoot, "probe-check.mjs"), scenario.probe);
    writeFileSync(join(fixture.evidenceRoot, "baseline-check.mjs"), scenario.baseline);
    writeFileSync(join(fixture.evidenceRoot, "probe-target.mjs"), ts.transpileModule(scenario.source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText);
    const testCommand = "node --jitless --max-old-space-size=64 baseline-check.mjs";
    const baselineOutput = execFileSync(process.execPath, ["--jitless", "--max-old-space-size=64", "baseline-check.mjs"], {
      cwd: fixture.evidenceRoot, encoding: "utf8", timeout: 5_000,
    });
    fixture.store.updateSession(sessionId, (state) => ({
      ...state,
      verification: {
        last: { kind: "test" as const, ok: true, ts: 350, command: testCommand, cwd: fixture.evidenceRoot, outputDigest: sha256Text(baselineOutput) },
        byKind: { test: { kind: "test" as const, ok: true, ts: 350, command: testCommand, cwd: fixture.evidenceRoot, outputDigest: sha256Text(baselineOutput) } },
        edits_since: 0,
        editsSinceByKind: { test: 0 },
      },
    }));
    const probeCommand = "node --jitless --max-old-space-size=64 probe-check.mjs";
    writeFileSync(join(fixture.evidenceRoot, "repair.mjs"), "throw new Error('must not be dispatched during unresolved recovery');\n");
    const plan = buildHostProofPlanPayload(fixture.contract, {
      schema: "jeverb-host-proof-plan-input/4", workspaceRoot: fixture.evidenceRoot,
      criteria: [{
        criterionId: fixture.contract.criteria[0]!.id, testCommand,
        producers: [{ runId: "run-1", nodeId: "build", attemptId: "build/1" }], codeFiles: ["probe-target.ts"],
        probeActions: [{ id: scenario.id, description: `Check ${scenario.requirement}`, command: probeCommand,
          producers: [{ runId: "run-1", nodeId: "build", attemptId: "build/1" }], nodeId: `probe-${scenario.id}`, maxExecutions: 2 }],
        repairActions: [{ id: "repair-revoked-membership", description: "Repair only revoked-member authorization",
          command: "node --jitless --max-old-space-size=64 repair.mjs",
          producers: [{ runId: "run-1", nodeId: "build", attemptId: "build/1" }], nodeId: "repair-revoked-membership", maxExecutions: 1 }],
      }],
    });
    const servicePlan: ServiceHostProofPlan = {
      ...plan, planDigest: hostProofPlanContentDigest(plan), receiptCorrelationId: "c".repeat(32),
      approvedAt: 1, approvedByUid: 0,
    };
    const ledger = testLedger(fixture.dataDir);
    const scenarioModel = {
      evaluate: async (request: Parameters<DecisionModel["evaluate"]>[0]) => ({
        provider: "typesafe", model: "typesafe/jev-latest", questionHash: hashQuestions(request.questions),
        answers: {
          fulfillment: { type: "choice", choice: "UNCERTAIN", confidence: 0.8,
            probabilities: { FULFILLED: 0.1, NOT_FULFILLED: 0.1, UNCERTAIN: 0.8 } },
          probe: { type: "choice", choice: scenario.id, confidence: 0.9,
            probabilities: { [scenario.id]: 0.9, NO_PROBE: 0.1 } },
        }, usage: { input_tokens: 20, output_tokens: 5 }, latency_ms: 1,
      }) as never,
    } as unknown as DecisionModel;
    let modelCalls = 0;
    const model = { evaluate: async (request: Parameters<DecisionModel["evaluate"]>[0]) => {
      modelCalls += 1;
      return scenarioModel.evaluate(request);
    } } as unknown as DecisionModel;
    let graphDispatches = 0;
    const crashAfterJournal = async (...args: Parameters<typeof runGraphTool>) => {
      const result = await runGraphTool(...args);
      graphDispatches += 1;
      if (graphDispatches === 1) throw new Error("simulated Stop-process loss after durable graph terminal");
      return result;
    };
    const runner = createControlServiceProofPlanClosureRunner({
      model, config: { dataDir: fixture.dataDir, missionClosurePolicy: POLICY_V2, timeoutMs: 1500 },
      store: fixture.store, ledger, now: () => 900,
      readPlan: async () => ({ ok: true, generation: "3".repeat(32), plan: servicePlan }),
      readAttestations: async () => {
        const current = await createSessionMissionClosureSource({
          store: fixture.store, dataDir: fixture.dataDir, now: () => 900,
          hostProofPlanDigest: servicePlan.planDigest,
          criterionCodeFiles: plan.criteria.map(({ criterionId, codeFiles }) => ({ criterionId, files: codeFiles })),
          structuralAnalysisRoot: plan.workspaceRoot,
        }).load(sessionId, fixture.contract.missionId);
        return [{ missionId: fixture.contract.missionId, missionRevision: fixture.contract.missionRevision,
          evidenceRevision: current.candidateRevision!, candidate: current.candidateDigest!, result: "pass" as const,
          receiptCorrelationId: "e".repeat(32), verifiedAt: 900, verifierUid: 0 }];
      },
      executeGraph: crashAfterJournal,
    });
    const previousShellPolicy = process.env.JEV_GRAPH_SHELL;
    process.env.JEV_GRAPH_SHELL = "allow";
    let first: Awaited<ReturnType<typeof runner>>;
    let recovered: Awaited<ReturnType<typeof runner>>;
    try {
      first = await runner(sessionId);
      recovered = await runner(sessionId);
    } finally {
      if (previousShellPolicy === undefined) delete process.env.JEV_GRAPH_SHELL;
      else process.env.JEV_GRAPH_SHELL = previousShellPolicy;
    }
    if ("outcome" in first || "outcome" in recovered) throw new Error("crash recovery unexpectedly fell back from the trusted plan");
    const records = ledger.read().records;
    const reservationRecord = records.find((row) => row.event === "ControlAction" && row.controlAction?.action === "verification-probe-reserved")!;
    const reservedRunId = reservationRecord.controlAction!.requiredOutcome!.split(":")[1]!;
    const probeNode = reconcileJournal(join(fixture.dataDir, "graph-journals", `jeverb-graph-${reservedRunId}.jsonl`));
    expect(first.terminalComplete).toBe(false);
    expect(recovered.terminalComplete).toBe(false);
    expect(modelCalls).toBe(1);
    expect(graphDispatches).toBe(1);
    expect(records.filter((row) => row.event === "ControlAction" && row.controlAction?.action === "verification-probe-reserved")).toHaveLength(1);
    const probeResults = records.filter((row) => row.event === "ControlAction" && row.controlAction?.action === "verification-probe-result");
    expect(probeResults).toHaveLength(1);
    expect(probeResults[0]?.controlAction).toMatchObject({
      evidenceRevision: reservationRecord.controlAction?.evidenceRevision,
      candidateDigest: reservationRecord.controlAction?.candidateDigest,
      requiredOutcome: expect.stringContaining(":failed:execution-unresolved:"),
    });
    expect(records.some((row) => row.event === "ControlAction" && row.controlAction?.action === "verification-repair-obligation")).toBe(false);
    expect(probeNode.nodes.find((node) => node.nodeId === `probe-${scenario.id}`)?.status).toBe("failed");
  });

  it.each(CORRECTIVE_PROBE_SCENARIOS)("skips the $id probe for a correct implementation and keeps global closure as the final gate", async (scenario) => {
    const sessionId = `session-approved-probe-control-${scenario.id}`;
    const prompt = `Implement the requested behavior.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- ${scenario.requirement}`;
    const fixture = await setupMission(sessionId, undefined, prompt);
    writeFileSync(join(fixture.evidenceRoot, "probe-target.ts"), scenario.correctedSource);
    writeFileSync(join(fixture.evidenceRoot, "probe-check.mjs"), scenario.probe);
    writeFileSync(join(fixture.evidenceRoot, "baseline-check.mjs"), scenario.baseline);
    writeFileSync(join(fixture.evidenceRoot, "probe-target.mjs"), ts.transpileModule(scenario.correctedSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText);
    const testCommand = "node baseline-check.mjs";
    const baselineOutput = execFileSync(process.execPath, ["baseline-check.mjs"], { cwd: fixture.evidenceRoot, encoding: "utf8" });
    // The same registered behavioral probe passes against the correct code.
    execFileSync(process.execPath, ["probe-check.mjs"], { cwd: fixture.evidenceRoot, encoding: "utf8" });
    fixture.store.updateSession(sessionId, (state) => ({
      ...state,
      verification: {
        last: { kind: "test" as const, ok: true, ts: 350, command: testCommand, cwd: fixture.evidenceRoot, outputDigest: sha256Text(baselineOutput) },
        byKind: { test: { kind: "test" as const, ok: true, ts: 350, command: testCommand, cwd: fixture.evidenceRoot, outputDigest: sha256Text(baselineOutput) } },
        edits_since: 0, editsSinceByKind: { test: 0 },
      },
    }));
    const plan = buildHostProofPlanPayload(fixture.contract, {
        schema: "jeverb-host-proof-plan-input/3", workspaceRoot: fixture.evidenceRoot,
      criteria: [{
        criterionId: fixture.contract.criteria[0]!.id, testCommand,
        producers: [{ runId: "run-1", nodeId: "build", attemptId: "build/1" }],
        codeFiles: ["probe-target.ts"],
        probeActions: [{ id: scenario.id, description: `Verify: ${scenario.requirement}`, command: "node --jitless --max-old-space-size=64 probe-check.mjs",
          producers: [{ runId: "run-1", nodeId: "build", attemptId: "build/1" }], nodeId: `probe-${scenario.id}`, maxExecutions: 1 }],
      }],
    });
    const servicePlan: ServiceHostProofPlan = {
      ...plan, planDigest: hostProofPlanContentDigest(plan), receiptCorrelationId: "8".repeat(32), approvedAt: 1, approvedByUid: 0,
    };
    const dynamicAttestation = async () => {
      const current = await createSessionMissionClosureSource({
        store: fixture.store, dataDir: fixture.dataDir, now: () => 700,
        hostProofPlanDigest: servicePlan.planDigest,
        criterionCodeFiles: plan.criteria.map(({ criterionId, codeFiles }) => ({ criterionId, files: codeFiles })),
        structuralAnalysisRoot: plan.workspaceRoot,
      }).load(sessionId, fixture.contract.missionId);
      return [{ missionId: fixture.contract.missionId, missionRevision: fixture.contract.missionRevision,
        evidenceRevision: current.candidateRevision!, candidate: current.candidateDigest!, result: "pass" as const,
        receiptCorrelationId: "7".repeat(32), verifiedAt: 600, verifierUid: 0 }];
    };
    const global = stubComplete();
    const model: DecisionModel = {
      ...global,
      evaluate: async (request) => {
        if (request.questions.fulfillment !== undefined) return {
          provider: "typesafe", model: "typesafe/jev-latest", questionHash: hashQuestions(request.questions),
          answers: {
            fulfillment: { type: "choice", choice: "FULFILLED", confidence: 0.96,
              probabilities: { FULFILLED: 0.96, NOT_FULFILLED: 0.02, UNCERTAIN: 0.02 } },
            probe: { type: "choice", choice: "NO_PROBE", confidence: 0.96,
              probabilities: { [scenario.id]: 0.01, NO_PROBE: 0.99 } },
          }, usage: { input_tokens: 10, output_tokens: 2 }, latency_ms: 1,
        } as never;
        return global.evaluate(request);
      },
    };
    let dispatchCount = 0;
    const result = await createControlServiceProofPlanClosureRunner({
      model, config: { dataDir: fixture.dataDir, missionClosurePolicy: POLICY_V2, timeoutMs: 1500 },
      store: fixture.store, ledger: testLedger(fixture.dataDir), now: () => 700,
      readPlan: async () => ({ ok: true, generation: "3".repeat(32), plan: servicePlan }),
      readAttestations: dynamicAttestation,
      executeGraph: async () => { dispatchCount += 1; throw new Error("correct control must not dispatch a probe"); },
    })(sessionId);
    if ("outcome" in result) throw new Error(`runner not applicable: ${result.reason}`);
    expect(dispatchCount).toBe(0);
    expect(result.decision.complete).toBe(true);
    expect(result.terminalComplete).toBe(true);
    expect(testLedger(fixture.dataDir).read().records.some((record) => record.event === "ControlAction" &&
      record.controlAction?.action === "verification-probe-reserved")).toBe(false);
  });

  it("a host-observed 501 for a requested v2 write stops before semantic scoring", async () => {
    const sessionId = "session-v2-write-501";
    const prompt = [
      "Serve API v2 writes alongside v1 and evict expired sessions.",
      "Acceptance criteria:",
      "- v1 and v2 reads coexist.",
      "- v2 writes succeed.",
      "- expired sessions are evicted.",
    ].join("\n");
    const fixture = await setupMission(sessionId, undefined, prompt);
    const observed = hostObserveV2Write();
    expect(observed.exitCode).toBe(1);
    const ledger = testLedger(fixture.dataDir);
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger,
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-02",
        producers: [{ runId: "run-1", nodeId: "build" }],
        test: { kind: "host-command", command: "v2-write-verifier", exitCode: observed.exitCode, outputDigest: observed.outputDigest },
      }],
    });
    expect(produced.reports[0]?.status).toBe("failed");
    expect(verificationReceiptIds(ledger.read().records).has(produced.verifications[0]!.receiptCorrelationId)).toBe(true);
    const evidence = await createSessionMissionClosureSource({
      store: fixture.store,
      dataDir: fixture.dataDir,
      now: () => 400,
      ledger,
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: produced.associations,
      criterionVerifications: produced.verifications,
      trustedVerifierIds: ["test-execution"],
    }).load(sessionId, fixture.contract.missionId);
    let calls = 0;
    const model = { async evaluate() { calls += 1; throw new Error("preflight must stop this failed criterion"); } } as unknown as DecisionModel;
    const score = await scoreSemanticFulfillmentCandidate(model, evidence, POLICY_SEMANTIC_FULFILLMENT, "NOT_FULFILLED");
    expect(score.status).toBe("preflight-stopped");
    expect(calls).toBe(0);
  });

  it("derives test verdicts from host-observed exits, never a bare passed flag", async () => {
    const sessionId = "session-producer-exits";
    const fixture = await setupMission(sessionId);
    const observed = hostInvokeSuite(0);
    expect(observed.exitCode).toBe(0);
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        test: { kind: "host-command", command: "npm test", exitCode: observed.exitCode, outputDigest: observed.outputDigest },
      }],
    });
    expect(produced.reports).toHaveLength(1);
    expect(produced.reports[0]?.status).toBe("satisfied");
    expect(produced.reports[0]?.verifierId).toBe("test-execution");
    expect(produced.verifications).toHaveLength(1);
    expect(produced.verifications[0]?.candidateDigest).toBe(fixture.candidateDigest);
    expect(produced.verifications[0]?.missionRevision).toBe(fixture.contract.missionRevision);
    // The receipt is durably present on read-back, not just claimed in memory.
    const rows = testLedger(fixture.dataDir).read().records;
    expect(verificationReceiptIds(rows).has(produced.verifications[0]?.receiptCorrelationId as string)).toBe(true);

    const failing = hostInvokeSuite(1);
    expect(failing.exitCode).toBe(1);
    const negative = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        test: { kind: "host-command", command: "npm test", exitCode: failing.exitCode, outputDigest: failing.outputDigest },
      }],
    });
    // An observed negative is a persisted `failed` verdict, never silence.
    expect(negative.reports[0]?.status).toBe("failed");
    expect(negative.verifications).toHaveLength(1);
    expect(negative.verifications[0]?.result).toBe("failed");
  });

  it("retains bounded host-observed behavior while redacting credentials", async () => {
    const sessionId = "session-host-observed-behavior";
    const fixture = await setupMission(sessionId);
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        test: { kind: "host-command", command: "node verify.cjs", exitCode: 0, outputDigest: D, observedBehavior: '{"result":3,"token":"sk-abcdefghijklmnopqrstuvwxyz"}' },
      }],
    });
    const observed = produced.verifications[0]?.observedResult ?? "";
    expect(observed).toContain('"result":3');
    expect(observed).toContain("[REDACTED]");
    expect(observed).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("false agent completion claim cannot satisfy a criterion without an independently produced receipt", async () => {
    const sessionId = "session-false-claim";
    const fixture = await setupMission(sessionId);
    // The tree names a path the host never observed: the adapter's scan
    // fails, the producer abstains, and no verdict exists — even though the
    // graph succeeded, the agent claims completion (attestation), and stub
    // Jev votes COMPLETE.
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        tree: { expected: { "never-observed.txt": D } },
      }],
    });
    expect(produced.verifications).toHaveLength(0);
    expect(produced.reports[0]?.status).toBe("unobserved");
    const result = await closeTrusted(fixture, sessionId, produced, ["tree-binding"]);
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
    expect(result.decision.status).toBe("INCOMPLETE");
  });

  it("phantom agent-supplied verdicts without durable receipts fail closed", async () => {
    const sessionId = "session-phantom";
    const fixture = await setupMission(sessionId);
    const phantom: MissionCriterionVerification = {
      criterionId: "criterion-01",
      verifierId: "test-execution",
      missionRevision: fixture.contract.missionRevision,
      candidateDigest: fixture.candidateDigest,
      result: "satisfied",
      receiptCorrelationId: "p".repeat(64),
      verifiedAt: 400,
      evidenceRef: "agent-claim:all-green",
    };
    const result = await closeTrusted(
      fixture,
      sessionId,
      { associations: [{ criterionId: "criterion-01", runId: "run-1", nodeId: "build" }], verifications: [phantom], reports: [] },
      ["test-execution"],
    );
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
  });

  it("genuinely fulfilled criterion reaches closure with real temp files and stub Jev", async () => {
    const sessionId = "session-genuine-files";
    const fixture = await setupMission(sessionId);
    const digestA = writeEvidenceFile(fixture.evidenceRoot, "a.txt", "parser output v1");
    const digestB = writeEvidenceFile(fixture.evidenceRoot, "b.txt", "retry proof v1");
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        files: [
          { path: "a.txt", expectedDigest: digestA },
          { path: "b.txt", expectedDigest: digestB },
        ],
      }],
    });
    expect(produced.reports[0]?.status).toBe("satisfied");
    const result = await closeTrusted(fixture, sessionId, produced, ["file-state"]);
    expect(result.decision.status).toBe("COMPLETE");
    expect(result.decision.complete).toBe(true);
    expect(result.terminalComplete).toBe(true);
    expect(result.receipt.status === "appended" || result.receipt.status === "duplicate").toBe(true);
  });

  it("host-command test evidence closes the loop end to end", async () => {
    const sessionId = "session-genuine-command";
    const fixture = await setupMission(sessionId);
    const observed = hostInvokeSuite(0);
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        test: { kind: "host-command", command: "npm test", exitCode: observed.exitCode, outputDigest: observed.outputDigest },
      }],
    });
    expect(produced.reports[0]?.status).toBe("satisfied");
    const result = await closeTrusted(fixture, sessionId, produced, ["test-execution"]);
    expect(result.decision.complete).toBe(true);
    expect(result.terminalComplete).toBe(true);
  });

  it("validated runner records ground test evidence; stale records abstain", async () => {
    const sessionId = "session-runner-record";
    const fixture = await setupMission(sessionId);
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        test: { kind: "validated-runner-record" },
      }],
    });
    expect(produced.reports[0]?.status).toBe("satisfied");
    const result = await closeTrusted(fixture, sessionId, produced, ["test-execution"]);
    expect(result.decision.complete).toBe(true);
    expect(result.terminalComplete).toBe(true);

    // Edits after the host run mean the record no longer covers this state.
    fixture.store.updateSession(sessionId, (state) => ({
      ...state,
      verification: { last: { kind: "test" as const, ok: true, ts: 300, command: "npm test" }, edits_since: 3 },
    }));
    const stale = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        test: { kind: "validated-runner-record" },
      }],
    });
    expect(stale.verifications).toHaveLength(0);
    expect(stale.reports[0]?.status).toBe("unobserved");

    fixture.store.updateSession(sessionId, (state) => ({
      ...state,
      verification: {
        last: { kind: "test" as const, ok: true, ts: 300, command: "npm test", cwd: fixture.evidenceRoot },
        byKind: { test: { kind: "test" as const, ok: true, ts: 300, command: "npm test", cwd: fixture.evidenceRoot } },
        edits_since: 0,
        editsSinceByKind: { test: 0 },
      },
    }));
    const mismatchedPlanCommand = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        test: {
          kind: "validated-runner-record",
          expectedCommandSha256: sha256Text("npm run unrelated"),
          expectedCwd: fixture.evidenceRoot,
        },
      }],
    });
    expect(mismatchedPlanCommand.verifications).toHaveLength(0);
    expect(mismatchedPlanCommand.reports[0]?.status).toBe("unobserved");
  });

  it("tree evidence reflects actually observed trees", async () => {
    const sessionId = "session-tree";
    const fixture = await setupMission(sessionId);
    const digestA = writeEvidenceFile(fixture.evidenceRoot, "tree-a.txt", "tree content a");
    const digestB = writeEvidenceFile(fixture.evidenceRoot, "tree-b.txt", "tree content b");
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        tree: { expected: { "tree-a.txt": digestA, "tree-b.txt": digestB } },
      }],
    });
    expect(produced.reports[0]?.status).toBe("satisfied");
    const result = await closeTrusted(fixture, sessionId, produced, ["tree-binding"]);
    expect(result.decision.complete).toBe(true);
    expect(result.terminalComplete).toBe(true);
  });

  it("tampered tree state yields an observed failed verdict, never closure", async () => {
    const sessionId = "session-tree-tamper";
    const fixture = await setupMission(sessionId);
    const digestA = writeEvidenceFile(fixture.evidenceRoot, "tree-a.txt", "tree content a");
    writeEvidenceFile(fixture.evidenceRoot, "tree-b.txt", "tree content b");
    const staleDigestB = sha256Text("tree content b");
    expect(staleDigestB).toBe(sha256Text("tree content b"));
    // Tamper after the expectation was pinned: the host observes the drift.
    writeEvidenceFile(fixture.evidenceRoot, "tree-b.txt", "tree content TAMPERED");
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        tree: { expected: { "tree-a.txt": digestA, "tree-b.txt": staleDigestB } },
      }],
    });
    expect(produced.reports[0]?.status).toBe("failed");
    expect(produced.verifications[0]?.result).toBe("failed");
    const result = await closeTrusted(fixture, sessionId, produced, ["tree-binding"]);
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
  });

  it("enabling the trusted path alone authorizes nothing", async () => {
    const sessionId = "session-enable-alone";
    const fixture = await setupMission(sessionId);
    const result = await closeTrusted(
      fixture,
      sessionId,
      { associations: [], verifications: [], reports: [] },
      ["test-execution"],
    );
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
  });

  it("unallowlisted verifiers never count toward closure", async () => {
    const sessionId = "session-unallowlisted";
    const fixture = await setupMission(sessionId);
    const observed = hostInvokeSuite(0);
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        test: { kind: "host-command", command: "npm test", exitCode: observed.exitCode, outputDigest: observed.outputDigest },
      }],
    });
    expect(produced.reports[0]?.status).toBe("satisfied");
    const result = await closeTrusted(fixture, sessionId, produced, ["some-other-verifier"]);
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
  });

  it("stale verdicts bound to a superseded candidate fail closed", async () => {
    const sessionId = "session-stale";
    const fixture = await setupMission(sessionId);
    const digestA = writeEvidenceFile(fixture.evidenceRoot, "a.txt", "parser output v1");
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        files: [{ path: "a.txt", expectedDigest: digestA }],
      }],
    });
    expect(produced.reports[0]?.status).toBe("satisfied");
    // Rotate the candidate after the verdict was bound: the host ran the
    // suite again (new timestamp), so the old verdict names a superseded
    // candidate digest.
    fixture.store.updateSession(sessionId, (state) => ({
      ...state,
      verification: { last: { kind: "test" as const, ok: true, ts: 301, command: "npm test" }, edits_since: 0 },
    }));
    const result = await closeTrusted(fixture, sessionId, produced, ["file-state"]);
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
  });

  it("foreign runs and conflicting bindings fail closed", async () => {
    const foreignSession = "session-foreign-journal";
    const foreignDataDir = tempDir("jeverb-host-foreign-");
    const foreignStore = testStore(foreignDataDir);
    foreignStore.updateSession(foreignSession, (state) => ({ ...state }));
    writeJournal(join(foreignDataDir, "graph-journals"), foreignSession, "run-foreign");

    const sessionId = "session-foreign";
    const fixture = await setupMission(sessionId);
    const digestA = writeEvidenceFile(fixture.evidenceRoot, "a.txt", "parser output v1");
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-foreign", nodeId: "build" }],
        files: [{ path: "a.txt", expectedDigest: digestA }],
      }],
    });
    expect(produced.reports[0]?.status).toBe("satisfied");
    // Copy the foreign journal into this session's journal directory: it is
    // still scoped to another host session, so it cannot trace this one.
    mkdirSync(join(fixture.dataDir, "graph-journals"), { recursive: true, mode: 0o700 });
    const journals = join(foreignDataDir, "graph-journals");
    const { copyFileSync, readdirSync } = await import("node:fs");
    for (const name of readdirSync(journals)) {
      copyFileSync(join(journals, name), join(fixture.dataDir, "graph-journals", name));
    }
    const result = await closeTrusted(fixture, sessionId, produced, ["file-state"]);
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
  });

  it("divergent producer bindings for one criterion conflict instead of satisfying", async () => {
    const sessionId = "session-conflict";
    const fixture = await setupMission(sessionId, [
      { nodeId: "build", inputHash: C, outputDigest: D },
      { nodeId: "test", inputHash: E, outputDigest: F },
    ]);
    const digestA = writeEvidenceFile(fixture.evidenceRoot, "a.txt", "parser output v1");
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        // One node serves this criterion only through one explicit
        // association each — but two divergent terminal rows cannot both
        // trace one criterion, so the resolver marks conflict.
        criterionId: "criterion-01",
        producers: [
          { runId: "run-1", nodeId: "build" },
          { runId: "run-1", nodeId: "test" },
        ],
        files: [{ path: "a.txt", expectedDigest: digestA }],
      }],
    });
    expect(produced.reports[0]?.status).toBe("satisfied");
    const result = await closeTrusted(fixture, sessionId, produced, ["file-state"]);
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
  });

  it("unknown criteria are rejected and the trusted profile stays default-OFF", async () => {
    expect(resolveTrustedRunnerOptions({})).toEqual({});
    expect(resolveTrustedRunnerOptions({ JEVERB_TRUSTED_GRAPH_EVIDENCE: "0" })).toEqual({});
    expect(resolveTrustedRunnerOptions({ JEVERB_TRUSTED_VERIFIER_IDS: "test-execution" })).toEqual({});

    const sessionId = "session-unknown-criterion";
    const fixture = await setupMission(sessionId);
    const produced = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-99",
        producers: [{ runId: "run-1", nodeId: "build" }],
        test: { kind: "validated-runner-record" },
      }],
    });
    expect(produced.associations).toHaveLength(0);
    expect(produced.verifications).toHaveLength(0);
    expect(produced.reports[0]?.status).toBe("rejected");

    // Default-OFF: even fully formed trusted inputs change nothing without
    // the explicit flag.
    const digestA = writeEvidenceFile(fixture.evidenceRoot, "a.txt", "parser output v1");
    const genuine = await produce({
      store: fixture.store,
      dataDir: fixture.dataDir,
      sessionId,
      missionId: fixture.contract.missionId,
      ledger: testLedger(fixture.dataDir),
      evidenceRoot: fixture.evidenceRoot,
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        files: [{ path: "a.txt", expectedDigest: digestA }],
      }],
    });
    expect(genuine.reports[0]?.status).toBe("satisfied");
    const ledger = testLedger(fixture.dataDir);
    const runner = createSessionMissionClosureRunner({
      model: stubComplete(),
      config: { dataDir: fixture.dataDir, missionClosurePolicy: POLICY_V2, timeoutMs: 1500 },
      store: fixture.store,
      ledger,
      now: () => 400,
      criterionProducerAssociations: genuine.associations,
      criterionVerifications: genuine.verifications,
      trustedVerifierIds: ["file-state"],
    });
    const result = await runner(sessionId);
    if ("outcome" in result) throw new Error("runner not applicable");
    expect(result.decision.complete).toBe(false);
    expect(result.terminalComplete).toBe(false);
  });
});
