#!/usr/bin/env node
/**
 * One local, non-production demonstration: existing tests pass while one
 * semantic boundary is omitted; DAG-local Jev requests a bounded probe,
 * which exposes the defect and drives a graph-authorized repair.
 * Exactly one Jev request is permitted.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { defaultExecutionPolicy } from "../src/graph/policy.js";
import { reconcileJournal } from "../src/graph/journal.js";
import { JevGatewayDecisionModel } from "../src/jev/gateway.js";
import type { DecisionModel } from "../src/decision/types.js";
import { Store } from "../src/hooks/store.js";
import { EvidenceLedger } from "../src/evidence/ledger.js";
import { parseMissionContract } from "../src/mission/contract.js";
import { analyzeCriterionTypeScriptStructure } from "../src/mission/structural-analysis.js";
import { proofObligationId } from "../src/mission/proof-obligations.js";
import { createSessionMissionClosureSource } from "../src/mission/session-source.js";
import { produceHostVerificationInputs } from "../src/mission/runtime.js";
import {
  dagLocalCriterionRequest, dagLocalProbeGraph, evaluateDagLocalCriterion, selectDagLocalProbe,
  type MissionClosureEvidence, type RegisteredDagLocalProbeAction,
} from "../src/mission/closure.js";
import { readVerifierFileBytes, verificationReceiptIds } from "../src/mission/verifiers.js";
import { run as executeGraph, type ExecuteGraphToolInput } from "../src/tools/execute-graph.js";
import type { ToolConfig } from "../src/tools/shared.js";

const CRITERION_ID = "criterion-01";
const REQUIREMENT = "Workspace owners and active members may access; revoked memberships and guests must be denied.";
const OBJECTIVE = [
  "Implement workspace access policy.",
  "Objective coverage: exhaustive",
  "Acceptance criteria:",
  "- " + REQUIREMENT,
].join("\n");
const MODEL = "typesafe/jev-latest";
const EXPECTED_MODEL = "typesafe/jev-1.14-20261014";
const MAX_REQUESTS = 1;
const PROBE_REGISTRY: readonly RegisteredDagLocalProbeAction[] = [{
  id: "revoked-membership",
  description: "Exercise the authorization behavior for a revoked membership",
  command: "node revoked-probe.cjs",
  sourceReadOnly: true,
}];

function assertOk(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function transpileCurrent(workspace: string): { sourceDigest: string; compiledDigest: string } {
  const source = readFileSync(join(workspace, "policy.ts"), "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
    reportDiagnostics: true,
  });
  assertOk(!(result.diagnostics ?? []).some((d) => d.category === ts.DiagnosticCategory.Error), "TypeScript compilation failed");
  writeFileSync(join(workspace, "policy.cjs"), result.outputText, { mode: 0o600 });
  return { sourceDigest: sha(source), compiledDigest: sha(result.outputText) };
}
function compileSource(workspace: string, fixed = false): { sourceDigest: string; compiledDigest: string } {
  const source = fixed
    ? [
        "export type Membership = { role: 'owner' | 'member' | 'guest'; revoked: boolean };",
        "export function canAccessWorkspace(membership: Membership): boolean {",
        "  if (membership.revoked) return false;",
        "  return membership.role === 'owner' || membership.role === 'member';",
        "}", "",
      ].join("\n")
    : [
        "export type Membership = { role: 'owner' | 'member' | 'guest'; revoked: boolean };",
        "export function canAccessWorkspace(membership: Membership): boolean {",
        "  return membership.role === 'owner' || membership.role === 'member';",
        "}", "",
      ].join("\n");
  writeFileSync(join(workspace, "policy.ts"), source, { mode: 0o600 });
  return transpileCurrent(workspace);
}
function writeFiles(workspace: string): void {
  writeFileSync(join(workspace, "existing-tests.cjs"), [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const { canAccessWorkspace } = require('./policy.cjs');",
    "try { fs.unlinkSync('existing-observations.json'); } catch (e) { if (e.code !== 'ENOENT') throw e; }",
    "const observed = { owner: canAccessWorkspace({role:'owner',revoked:false}), activeMember: canAccessWorkspace({role:'member',revoked:false}), guest: canAccessWorkspace({role:'guest',revoked:false}) };",
    "fs.writeFileSync('existing-observations.json', JSON.stringify(observed)+'\\n', {mode:0o600});",
    "assert.deepEqual(observed, {owner:true,activeMember:true,guest:false});",
    "process.stdout.write(JSON.stringify(observed)+'\\n');",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(join(workspace, "revoked-probe.cjs"), [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const { canAccessWorkspace } = require('./policy.cjs');",
    "const observed = { revokedMember: canAccessWorkspace({role:'member',revoked:true}) };",
    "fs.writeFileSync('revoked-observation.json', JSON.stringify(observed)+'\\n', {mode:0o600});",
    "assert.equal(observed.revokedMember, false, 'revoked membership must be denied');",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(join(workspace, "full-tests.cjs"), [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const { canAccessWorkspace } = require('./policy.cjs');",
    "const observed = { owner: canAccessWorkspace({role:'owner',revoked:false}), activeMember: canAccessWorkspace({role:'member',revoked:false}), guest: canAccessWorkspace({role:'guest',revoked:false}), revokedMember: canAccessWorkspace({role:'member',revoked:true}) };",
    "fs.writeFileSync('full-observations.json', JSON.stringify(observed)+'\\n', {mode:0o600});",
    "assert.deepEqual(observed, {owner:true,activeMember:true,guest:false,revokedMember:false});",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(join(workspace, "repair.cjs"), [
    "const fs = require('node:fs');",
    "fs.copyFileSync('policy.fixed.ts', 'policy.ts');",
    "process.stdout.write('bounded revoked-membership repair applied\\n');",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(join(workspace, "policy.fixed.ts"), [
    "export type Membership = { role: 'owner' | 'member' | 'guest'; revoked: boolean };",
    "export function canAccessWorkspace(membership: Membership): boolean {",
    "  if (membership.revoked) return false;",
    "  return membership.role === 'owner' || membership.role === 'member';",
    "}", "",
  ].join("\n"), { mode: 0o600 });
}
function createSwitch(path: string): void {
  const record = { schema_version: 1, desired: "ON", generation: randomUUID().replaceAll("-", ""), updated_at: Date.now(), used_request_ids: [] };
  writeFileSync(path, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
}
function toolConfig(workspaceRoot: string, dataDir: string, switchPath: string): ToolConfig {
  return {
    model: MODEL, thresholds: { auto: 0.9, review: 0.7 }, maxConcurrency: 1, dataDir, masterSwitchPath: switchPath,
    execution: defaultExecutionPolicy(workspaceRoot, {
      allowShell: true, allowNetwork: false, allowShellRetry: false, denyPrivileged: true,
      maxParallelShells: 1, nodeTimeoutMs: 20_000, graphTimeoutMs: 45_000,
      resourceLimits: { maxMemoryMb: 2048, maxProcesses: 64, maxFileBytes: 100 * 1024 * 1024, maxCpuSeconds: 120 },
    }),
  };
}
async function graphRun(sessionId: string, graph: ExecuteGraphToolInput["graph"], config: ToolConfig, initialRunId?: string) {
  const previous = process.env.MUSE_SESSION_ID;
  process.env.MUSE_SESSION_ID = sessionId;
  try {
    return await executeGraph(null, {
      source: "jev-coverage-gap-local-development", graph,
    }, { ...config, ...(initialRunId === undefined ? {} : { initialRunId }) }, AbortSignal.timeout(60_000));
  } finally {
    if (previous === undefined) delete process.env.MUSE_SESSION_ID;
    else process.env.MUSE_SESSION_ID = previous;
  }
}
async function createWorld(root: string, name: string) {
  const dir = join(root, name), workspace = join(dir, "workspace"), dataDir = join(dir, "data");
  const switchPath = join(dir, "local-development-switch.json");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  createSwitch(switchPath);
  const sessionId = "coverage-" + name + "-" + randomUUID().slice(0, 8);
  const contract = parseMissionContract(sessionId, OBJECTIVE, Date.now());
  assertOk(contract !== undefined && contract.criteria.length === 1 && contract.criteria[0]?.id === CRITERION_ID && contract.objectiveCoverage !== undefined,
    "objective contract/coverage parsing failed");
  const store = new Store(dataDir, { masterSwitchPath: switchPath, requireRootOwnedMasterSwitch: false });
  store.updateSession(sessionId, (state) => ({ ...state, prompts: [OBJECTIVE], mission_contract: contract }));
  const ledger = new EvidenceLedger(join(dataDir, "evidence.log"), { switchPath, requireRootOwnedSwitch: false });
  compileSource(workspace);
  writeFiles(workspace);
  return { dir, workspace, dataDir, switchPath, sessionId, contract, store, ledger, config: toolConfig(workspace, dataDir, switchPath) };
}
async function recordVerifier(args: {
  world: Awaited<ReturnType<typeof createWorld>>; runId: string; nodeId: string; attemptId: string;
  command: string; exitCode: number; outputDigest: string; observation: unknown;
}) {
  return produceHostVerificationInputs({
    store: args.world.store, dataDir: args.world.dataDir, sessionId: args.world.sessionId,
    missionId: args.world.contract.missionId, ledger: args.world.ledger, evidenceRoot: args.world.workspace,
    specs: [{ criterionId: CRITERION_ID, producers: [{ runId: args.runId, nodeId: args.nodeId, attemptId: args.attemptId }],
      test: { kind: "host-command", command: args.command, exitCode: args.exitCode, outputDigest: args.outputDigest,
        observedBehavior: JSON.stringify(args.observation) } }],
  });
}

async function main(): Promise<void> {
  const gatewayBaseUrl = process.env.JEV_GATEWAY_BASE_URL ?? "http://127.0.0.1:18769/jev";
  const endpoint = new URL(gatewayBaseUrl);
  assertOk(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1" &&
    endpoint.pathname.replace(/\/$/, "") === "/jev" && endpoint.username === "" &&
    endpoint.password === "" && endpoint.search === "" && endpoint.hash === "",
  "refusing to send a Jev request anywhere except the local Locus Jev slot");

  const root = await mkdtemp(join(tmpdir(), "jeverb-coverage-gap-"));
  const baseline = await createWorld(root, "baseline-no-jev");
  const assisted = await createWorld(root, "dag-local-jev");
  const baselineCompilation = transpileCurrent(baseline.workspace);
  const assistedCompilation = transpileCurrent(assisted.workspace);
  assertOk(baselineCompilation.sourceDigest === assistedCompilation.sourceDigest &&
    baselineCompilation.compiledDigest === assistedCompilation.compiledDigest,
    "comparison arms must start with byte-identical source and transpiled code");

  // Jev-disabled baseline: same real task and existing verifier, no semantic
  // request and no supplemental revocation probe.
  const baselineRun = await graphRun(baseline.sessionId,
    { version: 1, nodes: [{ id: "existing-tests", kind: "shell", command: "node existing-tests.cjs" }] }, baseline.config);
  const baselineNode = baselineRun.results.find((row) => row.nodeId === "existing-tests");
  assertOk(baselineNode?.status === "succeeded", "Jev-disabled baseline tests should pass");
  const baselineJournal = reconcileJournal(baselineRun.journalPath);
  const baselineAttempt = baselineJournal.nodes[0]?.attemptIds?.at(-1);
  assertOk(baselineAttempt, "baseline attempt id missing");
  const baselineObserved = JSON.parse(readVerifierFileBytes(baseline.workspace, "existing-observations.json").toString("utf8"));
  const baselineVerification = await recordVerifier({
    world: baseline, runId: baselineRun.runId, nodeId: "existing-tests", attemptId: baselineAttempt,
    command: "node existing-tests.cjs", exitCode: 0, outputDigest: baselineNode.outputDigest, observation: baselineObserved,
  });
  assertOk(baselineVerification.reports[0]?.status === "satisfied", "baseline host verifier should accept its tested scope");

  // Jev-enabled arm repeats the same green verifier on identical source and
  // builds a real session snapshot with graph lineage, verifier receipt and AST.
  const jevRun = await graphRun(assisted.sessionId,
    { version: 1, nodes: [{ id: "existing-tests", kind: "shell", command: "node existing-tests.cjs" }] }, assisted.config);
  const jevNode = jevRun.results.find((row) => row.nodeId === "existing-tests");
  assertOk(jevNode?.status === "succeeded", "Jev-arm existing tests should pass before semantic review");
  const jevJournal = reconcileJournal(jevRun.journalPath);
  const jevAttempt = jevJournal.nodes[0]?.attemptIds?.at(-1);
  assertOk(jevAttempt, "Jev-arm attempt id missing");
  const jevObserved = JSON.parse(readVerifierFileBytes(assisted.workspace, "existing-observations.json").toString("utf8"));
  const initialVerification = await recordVerifier({
    world: assisted, runId: jevRun.runId, nodeId: "existing-tests", attemptId: jevAttempt,
    command: "node existing-tests.cjs", exitCode: 0, outputDigest: jevNode.outputDigest, observation: jevObserved,
  });
  assertOk(initialVerification.reports[0]?.status === "satisfied", "Jev-arm host verifier should report its tested scope as passing");
  const preAstSnapshot = await createSessionMissionClosureSource({
    store: assisted.store, dataDir: assisted.dataDir, now: Date.now, ledger: assisted.ledger,
  }).load(assisted.sessionId, assisted.contract.missionId);
  assertOk(preAstSnapshot.candidateDigest, "candidate digest missing before AST analysis");
  const structure = analyzeCriterionTypeScriptStructure({
    root: assisted.workspace, files: ["policy.ts"], criterionId: CRITERION_ID,
    proofObligationId: proofObligationId(CRITERION_ID, REQUIREMENT),
    missionRevision: assisted.contract.missionRevision, candidateDigest: preAstSnapshot.candidateDigest,
  });
  const jevEvidence = await createSessionMissionClosureSource({
    store: assisted.store, dataDir: assisted.dataDir, now: Date.now, ledger: assisted.ledger,
    enableTrustedGraphEvidence: true, criterionProducerAssociations: initialVerification.associations,
    criterionVerifications: initialVerification.verifications, trustedVerifierIds: ["test-execution"],
    criterionCodeStructure: [structure],
  }).load(assisted.sessionId, assisted.contract.missionId) as MissionClosureEvidence;
  const request = dagLocalCriterionRequest(jevEvidence, CRITERION_ID, PROBE_REGISTRY);
  assertOk(request !== undefined && request.state.requirement === REQUIREMENT &&
    request.verifier.result === "satisfied" && request.verifier.receiptCorrelationId === initialVerification.verifications[0]?.receiptCorrelationId &&
    request.state.proofObligation?.codeStructure?.candidateDigest === jevEvidence.candidateDigest,
  "offline admission failed: criterion context lacks the exact requirement, verified observation, AST, or current candidate binding");
  if (process.argv.includes("--preflight")) {
    process.stdout.write(JSON.stringify({
      status: "coverage-gap-demo-preflight-ready", inferenceRequests: 0,
      baselineTests: baselineNode.status, jevArmTests: jevNode.status,
      criterion: request.criterionId, evidenceDigest: request.evidenceDigest,
      graphRevision: request.graphRevision, contextHash: request.contextHash,
      verifierReceipt: request.verifier.receiptCorrelationId,
    }, null, 2) + "\n");
    return;
  }

  const model = new JevGatewayDecisionModel({
    baseUrl: endpoint.toString().replace(/\/$/, ""), model: MODEL, timeoutMs: 30_000, maxRetries: 0,
  });
  let requests = 0;
  const boundedModel = {
    async evaluate(input: Parameters<DecisionModel["evaluate"]>[0]) {
      requests += 1;
      assertOk(requests <= MAX_REQUESTS, "one-request ceiling exceeded");
      return model.evaluate(input);
    },
  } as DecisionModel;
  const judgment = await evaluateDagLocalCriterion(
    boundedModel, jevEvidence, CRITERION_ID, AbortSignal.timeout(35_000), PROBE_REGISTRY,
  );
  assertOk(requests === 1 && judgment !== undefined, "DAG-local Jev did not return one valid decision");
  assertOk(judgment.provider === "jev-gateway" && judgment.model === EXPECTED_MODEL,
    "Jev gateway model identity mismatch; refusing to use the judgment");
  assertOk(judgment.evidenceDigest.length === 64 && judgment.graphRevision.length === 64 &&
    judgment.verifierProvenance.receiptCorrelationId === initialVerification.verifications[0]?.receiptCorrelationId,
    "Jev judgment is not bound to the observed receipt and graph context");

  // A semantic concern may request only this fixed verifier. The graph
  // executor still performs deterministic authorization and confinement.
  const probeSelection = selectDagLocalProbe(judgment, PROBE_REGISTRY);
  writeFileSync(join(root, "coverage-gap-attempt.json"), JSON.stringify({
    schema: "jeverb-dag-local-coverage-gap-attempt/1",
    trustMode: "untrusted local development; advisory decision only",
    requestCount: requests,
    provider: judgment.provider,
    model: judgment.model,
    questionHash: judgment.questionHash,
    evidenceDigest: judgment.evidenceDigest,
    graphRevision: judgment.graphRevision,
    contextHash: judgment.contextHash,
    disposition: judgment.disposition,
    choice: judgment.choice,
    confidence: judgment.confidence,
    probabilities: judgment.probabilities,
    latencyMs: judgment.latencyMs,
    inputTokens: judgment.inputTokens,
    outputTokens: judgment.outputTokens,
    costUsd: judgment.costUsd ?? null,
    selectedProbe: probeSelection.status === "selected" ? probeSelection.probe.id : null,
    probeSelectionSource: probeSelection.status === "selected" ? probeSelection.source : null,
    probeSelectionReason: probeSelection.status === "none" ? probeSelection.reason : null,
    productionTerminalAuthorized: false,
  }, null, 2) + "\n", { mode: 0o600 });
  if (probeSelection.status === "none") {
    const reportPath = join(root, "coverage-gap-evidence.json");
    writeFileSync(reportPath, JSON.stringify({
      schema: "jeverb-dag-local-coverage-gap-demo/1",
      trustMode: "untrusted local development; no production closure or privileged authority",
      request: {
        count: requests, max: MAX_REQUESTS, requestedModel: MODEL, returnedModel: judgment.model,
        provider: judgment.provider, questionHash: judgment.questionHash, choice: judgment.choice,
        disposition: judgment.disposition, confidence: judgment.confidence, probabilities: judgment.probabilities,
        latencyMs: judgment.latencyMs, inputTokens: judgment.inputTokens, outputTokens: judgment.outputTokens,
        costUsd: judgment.costUsd ?? null, evidenceDigest: judgment.evidenceDigest,
        graphRevision: judgment.graphRevision, contextHash: judgment.contextHash,
      },
      baseline: { jev: "disabled", existingTests: baselineNode.status, observation: baselineObserved,
        hostVerifier: baselineVerification.reports[0], result: "no supplemental action" },
      jevArm: { existingTests: jevNode.status, observation: jevObserved, requirement: REQUIREMENT,
        judgment: { choice: judgment.choice, disposition: judgment.disposition } },
      comparison: { JevContributed: false, reason: `no probe selected: ${probeSelection.reason}` },
      productionTerminalAuthorized: false,
    }, null, 2) + "\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify({
      status: "jev-did-not-identify-gap", reportPath, requestCount: requests,
      disposition: judgment.disposition, productionTerminalAuthorized: false,
    }, null, 2) + "\n");
    return;
  }
  const probeGraph = dagLocalProbeGraph(probeSelection, CRITERION_ID, judgment.evidenceDigest);
  assertOk(probeGraph !== undefined, "selected registry action did not produce a safe bounded graph");
  const probeNodeId = probeGraph.graph.nodes[0].id;
  const probeCommand = probeSelection.probe.command;
  const probeRun = await graphRun(assisted.sessionId, probeGraph.graph, assisted.config, probeGraph.runId);
  const probeNode = probeRun.results.find((row) => row.nodeId === probeNodeId);
  assertOk(probeNode?.status === "failed", "revoked-membership probe did not expose the expected defect");
  const probeJournal = reconcileJournal(probeRun.journalPath);
  const probeAttempt = probeJournal.nodes[0]?.attemptIds?.at(-1);
  assertOk(probeAttempt, "probe attempt id missing");
  const probeObserved = JSON.parse(readVerifierFileBytes(assisted.workspace, "revoked-observation.json").toString("utf8")) as { revokedMember: boolean };
  assertOk(probeObserved.revokedMember === true, "host did not observe the revoked-member access defect");
  const probeVerification = await recordVerifier({
    world: assisted, runId: probeRun.runId, nodeId: probeNodeId, attemptId: probeAttempt,
    command: probeCommand, exitCode: 1, outputDigest: probeNode.outputDigest, observation: probeObserved,
  });
  assertOk(probeVerification.reports[0]?.status === "failed", "host verifier did not persist the failed revocation probe");

  // Repair and full re-verification remain inside separately authorized,
  // confined graph runs. The Jev judgment only caused a test to be considered.
  const repairRun = await graphRun(assisted.sessionId,
    { version: 1, nodes: [{ id: "repair-revocation-check", kind: "shell", command: "node repair.cjs" }] }, assisted.config);
  const repairNode = repairRun.results.find((row) => row.nodeId === "repair-revocation-check");
  assertOk(repairNode?.status === "succeeded", "authorized repair graph did not apply the fix");
  const repairedCompilation = transpileCurrent(assisted.workspace);
  const finalRun = await graphRun(assisted.sessionId,
    { version: 1, nodes: [{ id: "verify-full-policy", kind: "shell", command: "node full-tests.cjs" }] }, assisted.config);
  const finalNode = finalRun.results.find((row) => row.nodeId === "verify-full-policy");
  assertOk(finalNode?.status === "succeeded", "independent full verifier did not pass after repair");
  const finalJournal = reconcileJournal(finalRun.journalPath);
  const finalAttempt = finalJournal.nodes[0]?.attemptIds?.at(-1);
  assertOk(finalAttempt, "final verification attempt id missing");
  const finalObserved = JSON.parse(readVerifierFileBytes(assisted.workspace, "full-observations.json").toString("utf8"));
  const finalVerification = await recordVerifier({
    world: assisted, runId: finalRun.runId, nodeId: "verify-full-policy", attemptId: finalAttempt,
    command: "node full-tests.cjs", exitCode: 0, outputDigest: finalNode.outputDigest, observation: finalObserved,
  });
  assertOk(finalVerification.reports[0]?.status === "satisfied", "final host verifier did not accept the full behavior");
  const receipts = verificationReceiptIds(assisted.ledger.read().records);
  assertOk(probeVerification.verifications.every((row) => receipts.has(row.receiptCorrelationId)) &&
    finalVerification.verifications.every((row) => receipts.has(row.receiptCorrelationId)), "failure/success receipts are not durable");
  const finalSnapshot = await createSessionMissionClosureSource({
    store: assisted.store, dataDir: assisted.dataDir, now: Date.now, ledger: assisted.ledger,
    enableTrustedGraphEvidence: true, criterionProducerAssociations: finalVerification.associations,
    criterionVerifications: finalVerification.verifications, trustedVerifierIds: ["test-execution"],
    criterionCodeStructure: [{
      ...analyzeCriterionTypeScriptStructure({
        root: assisted.workspace, files: ["policy.ts"], criterionId: CRITERION_ID,
        proofObligationId: proofObligationId(CRITERION_ID, REQUIREMENT),
        missionRevision: assisted.contract.missionRevision,
        candidateDigest: (await createSessionMissionClosureSource({
          store: assisted.store, dataDir: assisted.dataDir, now: Date.now, ledger: assisted.ledger,
        }).load(assisted.sessionId, assisted.contract.missionId)).candidateDigest ?? "",
      }),
    }],
  }).load(assisted.sessionId, assisted.contract.missionId);
  const finalCriterion = finalSnapshot.criteria.find((row) => row.id === CRITERION_ID);
  assertOk(finalCriterion?.criterionVerification?.result === "satisfied" &&
    finalCriterion.graphEvidence?.some((row) => row.state === "bound" && row.attemptId === finalAttempt),
  "final evidence does not bind the current passing receipt to its graph attempt");

  const report = {
    schema: "jeverb-dag-local-coverage-gap-demo/1",
    trustMode: "untrusted local development; no production closure or privileged authority",
    request: {
      count: requests, max: MAX_REQUESTS, requestedModel: MODEL, returnedModel: judgment.model,
      provider: judgment.provider, questionHash: judgment.questionHash, choice: judgment.choice,
      disposition: judgment.disposition, confidence: judgment.confidence, probabilities: judgment.probabilities,
      latencyMs: judgment.latencyMs, inputTokens: judgment.inputTokens, outputTokens: judgment.outputTokens,
      costUsd: judgment.costUsd ?? null, evidenceDigest: judgment.evidenceDigest, graphRevision: judgment.graphRevision,
      contextHash: judgment.contextHash,
    },
    baseline: {
      jev: "disabled", sourceDigest: baselineCompilation.sourceDigest, existingTests: baselineNode.status,
      observation: baselineObserved, hostVerifier: baselineVerification.reports[0],
      result: "no revoked-membership probe; the omitted behavior remains undiscovered at this point",
    },
    jevArm: {
      sourceDigest: assistedCompilation.sourceDigest, existingTests: jevNode.status,
      observation: jevObserved, hostVerifier: initialVerification.reports[0],
      requirement: REQUIREMENT, astEvidence: structure, runId: jevRun.runId,
      attemptId: jevAttempt, judgment: {
        choice: judgment.choice, disposition: judgment.disposition,
        receiptCorrelationId: judgment.verifierProvenance.receiptCorrelationId,
      },
      probeRequestedByJev: probeSelection.source === "jev", probeSelection: {
        id: probeSelection.probe.id, source: probeSelection.source, runId: probeRun.runId,
      }, probe: { status: probeNode.status, observation: probeObserved, receipt: probeVerification.verifications[0] },
      repair: { runId: repairRun.runId, status: repairNode.status },
      finalVerification: { runId: finalRun.runId, attemptId: finalAttempt, status: finalNode.status,
        sourceDigest: repairedCompilation.sourceDigest, observation: finalObserved, receipt: finalVerification.verifications[0] },
      finalEvidence: { candidateDigest: finalSnapshot.candidateDigest, criterionVerified: finalCriterion.verified,
        verifierResult: finalCriterion.criterionVerification?.result, graphEvidence: finalCriterion.graphEvidence },
    },
    comparison: {
      initialVerifierOutcomeEqual: baselineNode.status === jevNode.status &&
        baselineVerification.reports[0]?.status === initialVerification.reports[0]?.status,
      discoveredDefect: probeObserved.revokedMember === true,
      JevContributed: probeSelection.source === "jev" && probeObserved.revokedMember === true,
      productionTerminalAuthorized: false,
    },
  };
  const reportPath = join(root, "coverage-gap-evidence.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({
    status: probeSelection.status === "selected" && probeObserved.revokedMember
      ? "jev-identified-omitted-requirement-and-repair-verified"
      : "jev-did-not-contribute-to-gap-discovery",
    reportPath, requestCount: requests, requestedModel: MODEL, returnedModel: judgment.model,
    disposition: judgment.disposition, probe: probeObserved, finalVerifier: finalNode.status,
    productionTerminalAuthorized: false,
  }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
