#!/usr/bin/env node
/**
 * One disposable corrective-execution cycle through Jeverb's existing graph,
 * journal, AST, and host-verifier paths. This is explicitly untrusted local
 * evidence: the temp switch is not the installed control service and this
 * runner cannot authorize production closure or protected work.
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
import { Store } from "../src/hooks/store.js";
import { EvidenceLedger } from "../src/evidence/ledger.js";
import { parseMissionContract } from "../src/mission/contract.js";
import { createSessionMissionClosureSource } from "../src/mission/session-source.js";
import { produceHostVerificationInputs } from "../src/mission/runtime.js";
import { analyzeCriterionTypeScriptStructure } from "../src/mission/structural-analysis.js";
import { proofObligationId } from "../src/mission/proof-obligations.js";
import { readVerifierFileBytes, verificationReceiptIds } from "../src/mission/verifiers.js";
import { run as executeGraph, type ExecuteGraphToolInput } from "../src/tools/execute-graph.js";
import type { ToolConfig } from "../src/tools/shared.js";

const OBJECTIVE = [
  "Implement parseCount for non-negative whole-number strings.",
  "Objective coverage: exhaustive",
  "Acceptance criteria:",
  "- parseCount returns safe non-negative integers and rejects decimals, signs, and non-numeric input.",
].join("\n");
const CRITERION = "parseCount returns safe non-negative integers and rejects decimals, signs, and non-numeric input.";
const CRITERION_ID = "criterion-01";

function requireOk(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function compileWorkspaceTypeScript(workspace: string): { sourceDigest: string; compiledDigest: string } {
  const source = readFileSync(join(workspace, "solution.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  requireOk(errors.length === 0, `TypeScript transpilation reported ${errors.length} error(s)`);
  const output = compiled.outputText;
  writeFileSync(join(workspace, "solution.cjs"), output, { mode: 0o600 });
  return {
    sourceDigest: createHash("sha256").update(source).digest("hex"),
    compiledDigest: createHash("sha256").update(output).digest("hex"),
  };
}

function createLocalSwitch(path: string): void {
  // Temporary, same-user switch used only to persist this explicitly
  // untrusted development ledger. Per-node execution still uses Jeverb's
  // deterministic authorization and confined shell runner.
  writeFileSync(path, `${JSON.stringify({
    schema_version: 1, desired: "ON", generation: randomUUID().replaceAll("-", ""),
    updated_at: Date.now(), used_request_ids: [],
  })}\n`, { flag: "wx", mode: 0o600 });
}

function configFor(workspaceRoot: string, dataDir: string, switchPath: string): ToolConfig {
  return {
    model: "deterministic-advisory-only",
    thresholds: { auto: 0.9, review: 0.7 },
    maxConcurrency: 1,
    dataDir,
    masterSwitchPath: switchPath,
    execution: defaultExecutionPolicy(workspaceRoot, {
      allowShell: true,
      allowNetwork: false,
      allowShellRetry: false,
      denyPrivileged: true,
      maxParallelShells: 1,
      // Node/V8 reserves a large virtual code range before using much RSS.
      // Keep execution confined, but give this disposable verifier enough
      // address space to start under Bubblewrap's RLIMIT_AS.
      resourceLimits: { maxMemoryMb: 2048, maxProcesses: 64, maxFileBytes: 100 * 1024 * 1024, maxCpuSeconds: 120 },
      nodeTimeoutMs: 20_000,
      graphTimeoutMs: 45_000,
      allowOutputArtifacts: false,
    }),
  };
}

async function graphRun(args: {
  sessionId: string; graph: ExecuteGraphToolInput["graph"];
  config: ToolConfig;
}) {
  const previous = process.env.MUSE_SESSION_ID;
  process.env.MUSE_SESSION_ID = args.sessionId;
  try {
    return await executeGraph(null, { source: "jev-corrective-loop-local-development", graph: args.graph }, args.config,
      AbortSignal.timeout(60_000));
  } finally {
    if (previous === undefined) delete process.env.MUSE_SESSION_ID;
    else process.env.MUSE_SESSION_ID = previous;
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jeverb-corrective-cycle-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "jeverb-data");
  const switchPath = join(root, "local-development-switch.json");
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(dataDir, { mode: 0o700 });
  createLocalSwitch(switchPath);
  const sessionId = `corrective-${randomUUID().slice(0, 12)}`;
  const contract = parseMissionContract(sessionId, OBJECTIVE, Date.now());
  requireOk(contract !== undefined && contract.criteria.length === 1 && contract.criteria[0]?.id === CRITERION_ID,
    "disposable corrective task contract did not parse as one mandatory criterion");
  writeFileSync(join(workspace, "solution.ts"), [
    "export function parseCount(value: string): number {",
    "  const result = Number.parseInt(value, 10);",
    "  if (Number.isNaN(result)) throw new Error('invalid count');",
    "  return result;",
    "}",
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  writeFileSync(join(workspace, "verify.cjs"), [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const { parseCount } = require('./solution.cjs');",
    "try { fs.unlinkSync('observed-behavior.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }",
    "const observe = (input) => { try { return { value: parseCount(input) }; } catch (error) { return { error: error.message }; } };",
    "const behavior = { valid: observe('12'), zero: observe('0'), decimal: observe('2.5'), negative: observe('-3'), text: observe('x') };",
    "fs.writeFileSync('observed-behavior.json', JSON.stringify(behavior) + '\\n', { mode: 0o600 });",
    "assert.deepEqual(behavior.valid, { value: 12 });",
    "assert.deepEqual(behavior.zero, { value: 0 });",
    "assert.equal(typeof behavior.decimal.error, 'string');",
    "assert.equal(typeof behavior.negative.error, 'string');",
    "assert.equal(typeof behavior.text.error, 'string');",
    "process.stdout.write(JSON.stringify(behavior) + '\\n');",
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  writeFileSync(join(workspace, "repair.cjs"), [
    "const fs = require('node:fs');",
    "fs.copyFileSync('solution.fixed.ts', 'solution.ts');",
    "process.stdout.write('bounded parseCount repair applied\\n');",
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  writeFileSync(join(workspace, "solution.fixed.ts"), [
    "export function parseCount(value: string): number {",
    "  if (!/^\\d+$/.test(value)) throw new Error('invalid count');",
    "  const result = Number(value);",
    "  if (!Number.isSafeInteger(result)) throw new Error('invalid count');",
    "  return result;",
    "}",
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  const initialCompilation = compileWorkspaceTypeScript(workspace);
  const store = new Store(dataDir, { masterSwitchPath: switchPath, requireRootOwnedMasterSwitch: false });
  store.updateSession(sessionId, (state) => ({ ...state, prompts: [OBJECTIVE], mission_contract: contract }));
  const ledger = new EvidenceLedger(join(dataDir, "evidence.log"), { switchPath, requireRootOwnedSwitch: false });
  const config = configFor(workspace, dataDir, switchPath);
  const initial = await graphRun({ sessionId, config,
    graph: { version: 1, nodes: [{ id: "verify-before-repair", kind: "shell", command: "node verify.cjs" }] } });
  const failedNode = initial.results.find((row) => row.nodeId === "verify-before-repair");
  requireOk(failedNode?.status === "failed", `initial graph did not capture the expected real failing test: ${JSON.stringify(initial.results)}`);
  const failedJournal = reconcileJournal(initial.journalPath);
  requireOk(failedJournal.malformed === 0 && failedJournal.nodes[0]?.status === "failed", "initial failure journal did not reconcile");
  let failedBytes: Buffer;
  try { failedBytes = readVerifierFileBytes(workspace, "observed-behavior.json"); }
  catch (error) { throw new Error(`initial host test did not persist observations: ${error instanceof Error ? error.message : String(error)}; graph=${JSON.stringify(failedNode)}`); }
  const failedBehavior = JSON.parse(failedBytes.toString("utf8")) as Record<string, unknown>;
  requireOk(JSON.stringify(failedBehavior.decimal) === JSON.stringify({ value: 2 }) &&
    JSON.stringify(failedBehavior.negative) === JSON.stringify({ value: -3 }),
    "host did not observe the specific decimal and negative-input defects");
  const failedSnapshot = await createSessionMissionClosureSource({ store, dataDir, now: Date.now, ledger }).load(sessionId, contract.missionId);
  requireOk(failedSnapshot.candidateDigest !== undefined, "initial candidate identity missing");
  const failedAttemptId = failedJournal.nodes[0]?.attemptIds?.at(-1);
  requireOk(failedAttemptId !== undefined, "initial failed attempt id missing");
  const failedVerification = await produceHostVerificationInputs({
    store, dataDir, sessionId, missionId: contract.missionId, ledger, evidenceRoot: workspace,
    specs: [{ criterionId: CRITERION_ID, producers: [{ runId: initial.runId, nodeId: "verify-before-repair", attemptId: failedAttemptId }],
      test: { kind: "host-command", command: "node verify.cjs", exitCode: 1, outputDigest: failedNode.outputDigest,
        observedBehavior: JSON.stringify(failedBehavior) } }],
  });
  requireOk(failedVerification.reports[0]?.status === "failed" && failedVerification.verifications.length === 1,
    "host verifier did not persist the initial failed criterion result");

  const repairTask = {
    obligationId: contract.criteria[0]!.id,
    finding: "Observed parseCount('2.5') = 2 and parseCount('-3') = -3; both violate the mandatory whole non-negative integer requirement.",
    action: "Replace parseInt parsing with decimal-free digit validation and Number.isSafeInteger; rerun the same verifier.",
    command: "node repair.cjs",
    allowedPaths: ["solution.ts"],
    maxAttempts: 1,
  };
  const repairRun = await graphRun({ sessionId, config,
    graph: { version: 1, nodes: [{ id: "repair-code", kind: "shell", command: repairTask.command }] } });
  const repairNode = repairRun.results.find((row) => row.nodeId === "repair-code");
  requireOk(repairNode?.status === "succeeded", "authorized repair graph did not apply the targeted correction");
  const repairJournal = reconcileJournal(repairRun.journalPath);
  requireOk(repairJournal.malformed === 0 && repairJournal.nodes.every((node) => node.status === "succeeded"),
    "repair journal contains a non-success or malformed execution state");
  const repairedCompilation = compileWorkspaceTypeScript(workspace);
  const verificationRun = await graphRun({ sessionId, config,
    graph: { version: 1, nodes: [{ id: "verify-after-repair", kind: "shell", command: "node verify.cjs" }] } });
  const verifyNode = verificationRun.results.find((row) => row.nodeId === "verify-after-repair");
  requireOk(verifyNode?.status === "succeeded", `authorized post-repair verifier did not pass: ${JSON.stringify(verificationRun.results)}`);
  requireOk(repairRun.graphHash !== initial.graphHash && verificationRun.graphHash !== initial.graphHash,
    "repair and verification did not produce new graph identities");
  const repairedJournal = reconcileJournal(verificationRun.journalPath);
  requireOk(repairedJournal.malformed === 0 && repairedJournal.nodes.every((node) => node.status === "succeeded"),
    "post-repair verification journal contains a non-success or malformed execution state");
  const passingBytes = readVerifierFileBytes(workspace, "observed-behavior.json");
  const passingBehavior = JSON.parse(passingBytes.toString("utf8")) as Record<string, unknown>;
  requireOk(JSON.stringify(passingBehavior.valid) === JSON.stringify({ value: 12 }) &&
    JSON.stringify(passingBehavior.zero) === JSON.stringify({ value: 0 }) &&
    typeof passingBehavior.decimal === "object" && passingBehavior.decimal !== null &&
    typeof (passingBehavior.decimal as Record<string, unknown>).error === "string" &&
    typeof passingBehavior.negative === "object" && passingBehavior.negative !== null &&
    typeof (passingBehavior.negative as Record<string, unknown>).error === "string",
    "host-observed passing behavior does not match required values");
  const finalSnapshot = await createSessionMissionClosureSource({ store, dataDir, now: Date.now, ledger }).load(sessionId, contract.missionId);
  requireOk(finalSnapshot.candidateDigest !== undefined && finalSnapshot.candidateDigest !== failedSnapshot.candidateDigest,
    "repair did not rotate the candidate identity");
  const verifyJournalNode = repairedJournal.nodes.find((node) => node.nodeId === "verify-after-repair");
  const finalAttemptId = verifyJournalNode?.attemptIds?.at(-1);
  requireOk(finalAttemptId !== undefined, "passing verifier attempt id missing");
  const passingVerification = await produceHostVerificationInputs({
    store, dataDir, sessionId, missionId: contract.missionId, ledger, evidenceRoot: workspace,
    specs: [{ criterionId: CRITERION_ID, producers: [{ runId: verificationRun.runId, nodeId: "verify-after-repair", attemptId: finalAttemptId }],
      test: { kind: "host-command", command: "node verify.cjs", exitCode: 0, outputDigest: verifyNode.outputDigest,
        observedBehavior: JSON.stringify(passingBehavior) } }],
  });
  requireOk(passingVerification.reports[0]?.status === "satisfied" && passingVerification.verifications.length === 1,
    "independent host verifier did not accept the repaired code");
  const structure = analyzeCriterionTypeScriptStructure({ root: workspace, files: ["solution.ts"], criterionId: CRITERION_ID,
    proofObligationId: proofObligationId(CRITERION_ID, CRITERION), missionRevision: contract.missionRevision,
    candidateDigest: finalSnapshot.candidateDigest });
  const evidence = await createSessionMissionClosureSource({
    store, dataDir, now: Date.now, ledger, enableTrustedGraphEvidence: true,
    criterionProducerAssociations: passingVerification.associations,
    criterionVerifications: passingVerification.verifications,
    trustedVerifierIds: ["test-execution"], criterionCodeStructure: [structure],
  }).load(sessionId, contract.missionId);
  const criterion = evidence.criteria.find((row) => row.id === CRITERION_ID);
  requireOk(criterion?.proofObligation?.codeStructure !== undefined && criterion.criterionVerification?.result === "satisfied" &&
    criterion.criterionVerification.receiptCorrelationId !== undefined && criterion.graphEvidence?.some((row) => row.state === "bound" && row.attemptId === finalAttemptId),
  "final evidence does not bind the criterion, AST, passing attempt, and durable verifier receipt");
  requireOk(criterion.verified === false, "untrusted local cycle unexpectedly promoted to production-verified mission evidence");
  const receipts = verificationReceiptIds(ledger.read().records);
  requireOk(failedVerification.verifications.every((row) => receipts.has(row.receiptCorrelationId)) &&
    passingVerification.verifications.every((row) => receipts.has(row.receiptCorrelationId)),
  "one or more failing/passing verifier receipts are absent from durable development ledger");

  const report = {
    schema: "jeverb-corrective-loop-untrusted-development/1",
    trustMode: "untrusted-local-development; no root service receipt, production switch, or terminal authority",
    mission: { id: contract.missionId, revision: contract.missionRevision, objective: contract.objective, criterionId: CRITERION_ID },
    initial: { runId: initial.runId, graphHash: initial.graphHash, nodeStatus: failedNode.status, attemptId: failedAttemptId,
      compilation: initialCompilation,
      outputDigest: failedNode.outputDigest, observedBehavior: failedBehavior, verifier: failedVerification.reports[0], receipt: failedVerification.verifications[0] },
    repairTask,
    repair: { runId: repairRun.runId, graphHash: repairRun.graphHash, verificationRunId: verificationRun.runId,
      verificationGraphHash: verificationRun.graphHash, changedGraph: repairRun.graphHash !== initial.graphHash,
      compilation: repairedCompilation, repairStatus: repairNode.status, verifierStatus: verifyNode.status, verifyAttemptId: finalAttemptId,
      verifierOutputDigest: verifyNode.outputDigest, observedBehavior: passingBehavior,
      verifier: passingVerification.reports[0], receipt: passingVerification.verifications[0] },
    finalEvidence: { candidateDigest: evidence.candidateDigest, evidenceRevision: evidence.evidenceRevision,
      proofObligation: criterion.proofObligation, graphEvidence: criterion.graphEvidence,
      criterionVerification: criterion.criterionVerification, verified: criterion.verified,
      journalPaths: [initial.journalPath, repairRun.journalPath, verificationRun.journalPath], ledgerPath: ledger.path,
      receiptIds: [failedVerification.verifications[0]!.receiptCorrelationId, passingVerification.verifications[0]!.receiptCorrelationId] },
    productionTerminalAuthorized: false,
  };
  const reportPath = join(root, "corrective-loop-evidence.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: "corrective-cycle-complete-untrusted-development", reportPath,
    initial: "failed", targetedRepair: "executed-through-graph", finalVerifier: "satisfied", ast: "bound", receipts: receipts.size,
    candidateRotated: true, productionTerminalAuthorized: false }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
