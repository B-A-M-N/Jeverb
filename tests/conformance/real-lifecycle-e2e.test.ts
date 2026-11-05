/**
 * Real end-to-end lifecycle execution proof (P1-4; deterministic, no live inference).
 *
 * This is the execution counterpart to `./lifecycle-harness.js` (component-level
 * policy conformance over SIMULATED transitions — see its header). Everything
 * here is real and local:
 *
 * - the ACTUAL graph tool (`jev_execute_graph` via `src/tools/execute-graph.ts`,
 *   built on `executeGraph` in `src/graph/executor.ts`), never an in-memory
 *   `settle()` script, as the execution engine;
 * - the REAL constrained shell runner (`runShellConstrained`: bwrap sandbox,
 *   filtered env, no network) against a disposable temp workspace;
 * - a REAL `FileJournal` per run, recovered through the real `reconcileJournal`
 *   interface — crash recovery is demonstrated, not asserted;
 * - filesystem state observed independently from disk (`readFileSync` on the
 *   workspace from the test host), never from tool output strings;
 * - REAL verifier receipts: `produceHostVerificationInputs` persists through
 *   `persistVerifierFinding` into a file-backed `EvidenceLedger`, and every
 *   counted receipt is confirmed present via a ledger read-back;
 * - the trusted mission-closure source (`createSessionMissionClosureSource`)
 *   plus the real closure runner, and the REAL Stop boundary (`handleStop`)
 *   with `deps.missionClosure` wired to that runner.
 *
 * Decision models are deterministic fixtures only (`FakeModel` with recorded
 * qualification where consequential; `null` where no judgment is needed).
 * No metered inference, no network, no pushes. Real shell commands run
 * exclusively against disposable temp dirs.
 *
 * Proven here: a successful workflow (observed file effects → verified →
 * closure disposition, surfaced through Stop) plus falsifications —
 * unqualified routing refused, invalid authorization refused, changed
 * evidence invalidates, crash/interruption recovered only via journal
 * reconcile (resume of an `outcome_unknown` attempt is blocked; only an
 * explicit operator retry runs again), stale candidates rejected, false
 * success claims blocked (directly and at the Stop boundary), contradictory
 * observations fail closed, and verdicts without durable receipts do not
 * count. `outcome_unknown` is reconciled before any retry; nothing
 * auto re-executes.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashQuestions } from "../../src/decision/provenance.js";
import type { DecisionModel } from "../../src/decision/types.js";
import { reconcileJournal } from "../../src/graph/journal.js";
import { isSandboxAvailable } from "../../src/graph/runner.js";
import { handleStop } from "../../src/hooks/handlers/stop.js";
import type { HookInput } from "../../src/hooks/types.js";
import {
  addMissionAttestations,
  parseMissionAttestation,
  parseMissionContract,
} from "../../src/mission/contract.js";
import {
  MISSION_CLOSURE_QUESTION_V2,
  type MissionClosurePolicy,
  type MissionCriterionVerification,
} from "../../src/mission/closure.js";
import { createSessionMissionClosureSource } from "../../src/mission/session-source.js";
import {
  createSessionMissionClosureRunner,
  produceHostVerificationInputs,
} from "../../src/mission/runtime.js";
import type { CriterionProducerAssociation } from "../../src/mission/graph-binding.js";
import {
  findingReceiptCorrelationId,
  persistVerifierFinding,
  verificationReceiptIds,
  verifyFileState,
} from "../../src/mission/verifiers.js";
import * as executeGraphTool from "../../src/tools/execute-graph.js";
import type { ToolConfig } from "../../src/tools/shared.js";
import { setTestSwitch, testLedger, testSwitchPath } from "../helpers/control-state.js";
import { FakeModel, noul, testConfig as baseTestConfig } from "../helpers/fake-model.js";
import { makeDeps } from "../hooks/helpers.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const V2_HASH = hashQuestions({ closure: MISSION_CLOSURE_QUESTION_V2 });
const POLICY_V2: MissionClosurePolicy = {
  policyVersion: "mission-closure/1",
  minConfidence: 0.8,
  calibrated: true,
  backend: "typesafe",
  model: "jev-1.14.0",
  modelVersion: "jev-1.14.0",
  questionHash: V2_HASH,
  calibrationVersion: "real-e2e-fixture-1",
};

const PROMPT = `Ship the parser change.\n\nObjective coverage: exhaustive\n\nAcceptance criteria:\n- Parser handles the new syntax.`;

type TestStore = ReturnType<typeof makeDeps>["store"];

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

/** Stop-classification model: nothing unfinished, completion claimed loudly. */
function stopClaimsComplete(): FakeModel {
  return new FakeModel(() => ({
    claims_complete: noul(0.95),
    says_part_not_done: noul(0.02),
    says_step_deferred: noul(0.02),
    says_check_failing: noul(0.02),
    asks_user: noul(0.02),
    addresses_request: noul(0.95),
    claims_verified: noul(0.5),
  }));
}

/** Per-scenario disposable world: data dir (store+ledger+journals), workspace, tool config. */
function world(prefix: string): { dataDir: string; workspace: string; config: ToolConfig } {
  const dataDir = mkdtempSync(join(tmpdir(), `jeverb-reale2e-${prefix}-data-`));
  const workspace = mkdtempSync(join(tmpdir(), `jeverb-reale2e-${prefix}-work-`));
  setTestSwitch(dataDir, "ON");
  if (baseTestConfig.execution === undefined) throw new Error("base test config must provision shell execution");
  const config: ToolConfig = {
    ...baseTestConfig,
    dataDir,
    masterSwitchPath: testSwitchPath(dataDir),
    execution: { ...baseTestConfig.execution, workspaceRoot: workspace },
  };
  return { dataDir, workspace, config };
}

/** Run the ACTUAL graph tool with the host session stamped for journal scoping. */
async function runTool(
  model: DecisionModel | null,
  input: Parameters<typeof executeGraphTool.run>[1],
  config: ToolConfig,
  sessionId: string,
): Promise<executeGraphTool.ExecuteGraphToolOutput> {
  const previous = process.env.MUSE_SESSION_ID;
  process.env.MUSE_SESSION_ID = sessionId;
  try {
    return await executeGraphTool.run(model, input, config);
  } finally {
    if (previous === undefined) delete process.env.MUSE_SESSION_ID;
    else process.env.MUSE_SESSION_ID = previous;
  }
}

/** Mission scaffolding on the shared store: contract, host test record, attestation, independent check. */
async function scaffoldMission(
  store: TestStore,
  dataDir: string,
  sessionId: string,
): Promise<{
  contract: NonNullable<ReturnType<typeof parseMissionContract>>;
  candidateDigest: string;
  candidateRevision: string;
}> {
  const contract = parseMissionContract(sessionId, PROMPT, 100);
  if (contract === undefined) throw new Error("contract fixture failed to parse");
  store.updateSession(sessionId, (state) => ({ ...state, mission_contract: contract }));
  store.updateSession(sessionId, (state) => ({
    ...state,
    prompts: ["Ship the parser change."],
    verification: { last: { kind: "test" as const, ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
  }));
  const probe = await createSessionMissionClosureSource({ store, dataDir, now: () => 400 }).load(
    sessionId,
    contract.missionId,
  );
  if (probe.candidateDigest === undefined || probe.candidateRevision === undefined) {
    throw new Error("probe lacks candidate identity");
  }
  const userPrompt =
    `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\nverified:\n` +
    `- criterion-01: parser handles the new syntax`;
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
  return { contract, candidateDigest: probe.candidateDigest, candidateRevision: probe.candidateRevision };
}

async function produceFiles(
  store: TestStore,
  dataDir: string,
  sessionId: string,
  contract: NonNullable<ReturnType<typeof parseMissionContract>>,
  evidenceRoot: string,
  files: Array<{ path: string; expectedDigest: string }>,
  runId: string,
  nodeId: string,
) {
  return produceHostVerificationInputs({
    store,
    dataDir,
    sessionId,
    missionId: contract.missionId,
    ledger: testLedger(dataDir),
    evidenceRoot,
    specs: [{ criterionId: "criterion-01", producers: [{ runId, nodeId }], files }],
    now: () => 400,
  });
}

function closeWith(
  store: TestStore,
  dataDir: string,
  sessionId: string,
  produced: { associations: CriterionProducerAssociation[]; verifications: MissionCriterionVerification[] },
  trustedVerifierIds: string[],
) {
  const runner = createSessionMissionClosureRunner({
    model: stubComplete(),
    config: { dataDir, missionClosurePolicy: POLICY_V2, timeoutMs: 1500 },
    store,
    ledger: testLedger(dataDir),
    now: () => 400,
    enableTrustedGraphEvidence: true,
    criterionProducerAssociations: produced.associations,
    criterionVerifications: produced.verifications,
    trustedVerifierIds,
  });
  return runner(sessionId);
}

function stopInput(sessionId: string, message: string): HookInput {
  return {
    session_id: sessionId,
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: message,
  };
}

describe("real end-to-end lifecycle execution", () => {
  it("requires an operational sandbox backend (no silent downgrade)", async () => {
    expect(await isSandboxAvailable()).toBe(true);
  });

  it("successful workflow: real tool run → observed file effects → verified → COMPLETE → Stop terminal outcome", async () => {
    const sessionId = "e2e-success";
    const { dataDir, workspace, config } = world("success");
    const deps = makeDeps(dataDir, { model: stopClaimsComplete() });

    // The ACTUAL graph tool runs two REAL sandboxed shell nodes. The mission
    // scaffolding probes AFTER the run so the candidate binds the journals.
    const result = await runTool(
      null,
      {
        source: "e2e",
        graph: {
          version: 1,
          nodes: [
            { id: "build", kind: "shell", command: "printf 'parser output v1' > parser.txt" },
            { id: "test", kind: "shell", command: "printf 'suite green' > report.txt", dependsOn: ["build"] },
          ],
        },
      },
      config,
      sessionId,
    );
    expect(result.results.find((r) => r.nodeId === "build")?.status).toBe("succeeded");
    expect(result.results.find((r) => r.nodeId === "test")?.status).toBe("succeeded");

    // Mission scaffolding probes the post-run state: the candidate binds the
    // journals the tool just wrote.
    const { contract } = await scaffoldMission(deps.store, dataDir, sessionId);

    // Independently observed filesystem state: the host reads bytes from disk.
    const parserBytes = readFileSync(join(workspace, "parser.txt"));
    const reportBytes = readFileSync(join(workspace, "report.txt"));
    expect(parserBytes.toString("utf8")).toBe("parser output v1");
    expect(reportBytes.toString("utf8")).toBe("suite green");
    const digestA = sha(parserBytes);
    const digestB = sha(reportBytes);

    // The REAL journal is on disk with terminal success rows.
    const journalText = readFileSync(result.journalPath, "utf8");
    const terminals = journalText.split("\n").filter((line) => line.includes('"type":"node-terminal"'));
    expect(terminals.length).toBeGreaterThanOrEqual(2);
    expect(terminals.every((line) => line.includes('"status":"succeeded"'))).toBe(true);

    // Verify through the trusted producer: REAL receipts, read back from disk.
    const produced = await produceFiles(deps.store, dataDir, sessionId, contract, workspace, [
      { path: "parser.txt", expectedDigest: digestA },
      { path: "report.txt", expectedDigest: digestB },
    ], result.runId, "build");
    // One criterion yields one verdict covering both asserted files.
    expect(produced.reports).toHaveLength(1);
    expect(produced.reports[0]?.status).toBe("satisfied");
    expect(produced.verifications).toHaveLength(1);
    const rows = testLedger(dataDir).read().records;
    expect(
      verificationReceiptIds(rows).has(produced.verifications[0]?.receiptCorrelationId as string),
    ).toBe(true);

    const closed = await closeWith(deps.store, dataDir, sessionId, produced, ["file-state"]);
    if ("outcome" in closed) throw new Error(`runner not applicable: ${closed.reason}`);
    expect(closed.decision.status).toBe("COMPLETE");
    expect(closed.decision.complete).toBe(true);
    expect(closed.terminalComplete).toBe(true);
    expect(closed.receipt.status === "appended" || closed.receipt.status === "duplicate").toBe(true);

    // Stop integration: the REAL Stop boundary consults the REAL trusted runner.
    const stopDeps = {
      ...deps,
      ledger: testLedger(dataDir),
      missionClosure: () => closeWith(deps.store, dataDir, sessionId, produced, ["file-state"]),
    };
    const output = await handleStop(stopInput(sessionId, "Done. The parser change is complete."), stopDeps);
    expect(output?.terminalOutcome?.status).toBe("COMPLETE");
    expect(output?.terminalOutcome?.missionId).toBe(contract.missionId);
  }, 60000);

  it("unqualified routing refused: verdict-gated shell never runs without operator qualification", async () => {
    const sessionId = "e2e-unqualified";
    const { workspace, config } = world("unqualified");
    // No routing-qualification.json in this dataDir: the satisfied yes verdict
    // plus the permissive shell policy admit nothing.
    const result = await runTool(
      new FakeModel(() => ({ q: noul(0.95) })),
      {
        source: "e2e",
        graph: {
          version: 1,
          nodes: [
            { id: "verification", kind: "jev", question: "Deploy?" },
            {
              id: "deploy",
              kind: "shell",
              command: "printf 'deployed' > deployed.txt",
              dependsOn: ["verification"],
              condition: { node: "verification", field: "decision.verdict", equals: "yes" },
            },
          ],
        },
      },
      config,
      sessionId,
    );
    const deploy = result.results.find((r) => r.nodeId === "deploy");
    expect(deploy?.status).toBe("skipped");
    expect(deploy?.attempts).toBe(0);
    expect(deploy?.output).toMatch(/consequential-routing/);
    // Independently observed: the side-effect file was never created.
    expect(existsSync(join(workspace, "deployed.txt"))).toBe(false);
  }, 60000);

  it("invalid authorization refused: privileged command blocked with zero attempts and a journal refusal", async () => {
    const sessionId = "e2e-denauth";
    const { dataDir, workspace, config } = world("denauth");
    const result = await runTool(
      null,
      {
        source: "e2e",
        graph: {
          version: 1,
          nodes: [{ id: "escalate", kind: "shell", command: "sudo printf 'x' > owned.txt" }],
        },
      },
      config,
      sessionId,
    );
    const node = result.results.find((r) => r.nodeId === "escalate");
    expect(node?.status).toBe("blocked");
    expect(node?.attempts).toBe(0);
    expect(existsSync(join(workspace, "owned.txt"))).toBe(false);
    // The REAL journal records the denial (allowed:false) — refusal is durable evidence.
    const journalText = readFileSync(result.journalPath, "utf8");
    expect(journalText).toMatch(/"nodeId":"escalate"/);
    expect(journalText).toMatch(/"allowed":false/);
  }, 60000);

  it("changed evidence invalidates: tampering after observation yields a failed verdict, never closure", async () => {
    const sessionId = "e2e-tamper";
    const { dataDir, workspace, config } = world("tamper");
    const deps = makeDeps(dataDir, { model: stopClaimsComplete() });

    const result = await runTool(
      null,
      {
        source: "e2e",
        graph: {
          version: 1,
          nodes: [{ id: "build", kind: "shell", command: "printf 'parser output v1' > parser.txt" }],
        },
      },
      config,
      sessionId,
    );
    expect(result.results.find((r) => r.nodeId === "build")?.status).toBe("succeeded");
    // Scaffold after the run so the candidate binds the tool's journals.
    const { contract } = await scaffoldMission(deps.store, dataDir, sessionId);
    const genuineDigest = sha(readFileSync(join(workspace, "parser.txt")));

    // Genuine observation first: satisfied while the bytes match.
    const genuine = await produceFiles(deps.store, dataDir, sessionId, contract, workspace, [
      { path: "parser.txt", expectedDigest: genuineDigest },
    ], result.runId, "build");
    expect(genuine.reports[0]?.status).toBe("satisfied");

    // The host tampers with the evidence after the expectation was pinned.
    writeFileSync(join(workspace, "parser.txt"), "parser output TAMPERED");
    expect(readFileSync(join(workspace, "parser.txt")).toString("utf8")).toBe("parser output TAMPERED");

    const produced = await produceFiles(deps.store, dataDir, sessionId, contract, workspace, [
      { path: "parser.txt", expectedDigest: genuineDigest },
    ], result.runId, "build");
    expect(produced.reports[0]?.status).toBe("failed");
    expect(produced.verifications).toHaveLength(1);
    expect(produced.verifications[0]?.result).toBe("failed");

    const closed = await closeWith(deps.store, dataDir, sessionId, produced, ["file-state"]);
    if ("outcome" in closed) throw new Error(`runner not applicable: ${closed.reason}`);
    expect(closed.decision.complete).toBe(false);
    expect(closed.terminalComplete).toBe(false);
  }, 60000);

  it("crash/interruption: outcome_unknown reconciled via the real journal; resume blocked; explicit retry recovers", async () => {
    const sessionId = "e2e-crash";
    const { dataDir, workspace, config } = world("crash");

    // A REAL crash: the side effect lands, then the process dies by signal.
    // bwrap masks signal death as exit 128+; the runner reports outcome_unknown.
    const crashCommand = "printf 'partial bytes' > crash-marker.txt; kill -9 $$";
    const crashed = await runTool(
      null,
      {
        source: "e2e",
        graph: { version: 1, nodes: [{ id: "build", kind: "shell", command: crashCommand }] },
      },
      config,
      sessionId,
    );
    const node = crashed.results.find((r) => r.nodeId === "build");
    expect(node?.status).toBe("outcome_unknown");
    expect(node?.output).toMatch(/outcome_unknown/);

    // The uncertain effect is really on disk — landed, but unproven.
    expect(readFileSync(join(workspace, "crash-marker.txt")).toString("utf8")).toBe("partial bytes");

    // Recovery interface, for real: reconcile the on-disk journal BEFORE any retry.
    // The runner survived to journal the uncertain terminal, so no attempt is
    // left `running` — but the reconciled node row itself carries
    // `outcome_unknown`: landed, unproven, must be inspected before any retry.
    const recovery = reconcileJournal(crashed.journalPath);
    expect(recovery.runStarted).toBe(true);
    expect(recovery.unknowns).toHaveLength(0);
    const unknown = recovery.nodes.find((entry) => entry.nodeId === "build");
    expect(unknown?.status).toBe("outcome_unknown");

    // Blind resume of the unknown attempt is REFUSED — never auto re-executed.
    const resumed = await runTool(
      null,
      {
        source: "e2e",
        runId: crashed.runId,
        graph: { version: 1, nodes: [{ id: "build", kind: "shell", command: crashCommand }] },
      },
      config,
      sessionId,
    );
    const refused = resumed.results.find((r) => r.nodeId === "build");
    expect(refused?.status).toBe("blocked");
    expect(refused?.attempts).toBe(0);
    expect(refused?.output).toMatch(/prior node outcome is unknown/);

    // Explicit operator retry under a fresh run id recovers: it runs and succeeds.
    const retried = await runTool(
      null,
      {
        source: "e2e",
        graph: {
          version: 1,
          nodes: [{ id: "build", kind: "shell", command: "printf 'recovered bytes' > crash-marker.txt" }],
        },
      },
      config,
      sessionId,
    );
    expect(retried.results.find((r) => r.nodeId === "build")?.status).toBe("succeeded");
    expect(readFileSync(join(workspace, "crash-marker.txt")).toString("utf8")).toBe("recovered bytes");
    expect(reconcileJournal(retried.journalPath).unknowns).toHaveLength(0);
  }, 120000);

  it("stale candidate rejected: verdicts bound to a superseded candidate never close", async () => {
    const sessionId = "e2e-stale";
    const { dataDir, workspace, config } = world("stale");
    const deps = makeDeps(dataDir, { model: stopClaimsComplete() });

    const result = await runTool(
      null,
      {
        source: "e2e",
        graph: {
          version: 1,
          nodes: [{ id: "build", kind: "shell", command: "printf 'parser output v1' > parser.txt" }],
        },
      },
      config,
      sessionId,
    );
    expect(result.results.find((r) => r.nodeId === "build")?.status).toBe("succeeded");
    // Scaffold after the run so the candidate binds the tool's journals.
    const { contract } = await scaffoldMission(deps.store, dataDir, sessionId);
    const digest = sha(readFileSync(join(workspace, "parser.txt")));
    const produced = await produceFiles(deps.store, dataDir, sessionId, contract, workspace, [
      { path: "parser.txt", expectedDigest: digest },
    ], result.runId, "build");
    expect(produced.reports[0]?.status).toBe("satisfied");

    // Rotate the candidate after the verdict was bound (host runs the suite
    // again under a new timestamp, so the old verdict names a superseded digest).
    deps.store.updateSession(sessionId, (state) => ({
      ...state,
      verification: { last: { kind: "test" as const, ok: true, ts: 301, command: "npm test" }, edits_since: 0 },
    }));
    const closed = await closeWith(deps.store, dataDir, sessionId, produced, ["file-state"]);
    if ("outcome" in closed) throw new Error(`runner not applicable: ${closed.reason}`);
    expect(closed.decision.complete).toBe(false);
    expect(closed.terminalComplete).toBe(false);
  }, 60000);

  it("false success claim blocked: attestation without an independently produced receipt closes nothing (directly and at Stop)", async () => {
    const sessionId = "e2e-falseclaim";
    const { dataDir } = world("falseclaim");
    const deps = makeDeps(dataDir, { model: stopClaimsComplete() });
    const { contract } = await scaffoldMission(deps.store, dataDir, sessionId);

    // The agent claims completion (attestation is on record) but the tree
    // names a path the host never observed: the producer abstains, so no
    // verdict exists even though stub Jev votes COMPLETE.
    const produced = await produceHostVerificationInputs({
      store: deps.store,
      dataDir,
      sessionId,
      missionId: contract.missionId,
      ledger: testLedger(dataDir),
      evidenceRoot: mkdtempSync(join(tmpdir(), "jeverb-reale2e-empty-")),
      specs: [{
        criterionId: "criterion-01",
        producers: [{ runId: "run-1", nodeId: "build" }],
        tree: { expected: { "never-observed.txt": "d".repeat(64) } },
      }],
      now: () => 400,
    });
    expect(produced.verifications).toHaveLength(0);
    expect(produced.reports[0]?.status).toBe("unobserved");

    const closed = await closeWith(deps.store, dataDir, sessionId, produced, ["tree-binding"]);
    if ("outcome" in closed) throw new Error(`runner not applicable: ${closed.reason}`);
    expect(closed.decision.status).toBe("INCOMPLETE");
    expect(closed.terminalComplete).toBe(false);

    const stopDeps = {
      ...deps,
      ledger: testLedger(dataDir),
      missionClosure: () => closeWith(deps.store, dataDir, sessionId, produced, ["tree-binding"]),
    };
    const output = await handleStop(
      stopInput(sessionId, "Done. Everything is complete and all tests pass."),
      stopDeps,
    );
    expect(output?.decision).toBe("block");
    expect(output?.reason).toMatch(/Mission closure is/);
  }, 60000);

  it("contradictory observations fail closed: a satisfied receipt plus a later failed verdict never complete", async () => {
    const sessionId = "e2e-conflict";
    const { dataDir, workspace, config } = world("conflict");
    const deps = makeDeps(dataDir, { model: stopClaimsComplete() });

    const result = await runTool(
      null,
      {
        source: "e2e",
        graph: {
          version: 1,
          nodes: [{ id: "build", kind: "shell", command: "printf 'parser output v1' > parser.txt" }],
        },
      },
      config,
      sessionId,
    );
    expect(result.results.find((r) => r.nodeId === "build")?.status).toBe("succeeded");
    // Scaffold after the run so the candidate binds the tool's journals.
    const { contract } = await scaffoldMission(deps.store, dataDir, sessionId);
    const genuineDigest = sha(readFileSync(join(workspace, "parser.txt")));
    const satisfied = await produceFiles(deps.store, dataDir, sessionId, contract, workspace, [
      { path: "parser.txt", expectedDigest: genuineDigest },
    ], result.runId, "build");
    expect(satisfied.reports[0]?.status).toBe("satisfied");
    expect(satisfied.verifications).toHaveLength(1);

    // A later host observation contradicts the first: the file changed.
    writeFileSync(join(workspace, "parser.txt"), "parser output DRIFTED");
    const failed = await produceFiles(deps.store, dataDir, sessionId, contract, workspace, [
      { path: "parser.txt", expectedDigest: genuineDigest },
    ], result.runId, "build");
    expect(failed.reports[0]?.status).toBe("failed");
    expect(failed.verifications).toHaveLength(1);

    // Both receipts are durably on disk — and closure still refuses.
    const ids = verificationReceiptIds(testLedger(dataDir).read().records);
    for (const verification of [...satisfied.verifications, ...failed.verifications]) {
      expect(ids.has(verification.receiptCorrelationId)).toBe(true);
    }
    const closed = await closeWith(
      deps.store,
      dataDir,
      sessionId,
      {
        associations: satisfied.associations,
        verifications: [...satisfied.verifications, ...failed.verifications],
      },
      ["file-state"],
    );
    if ("outcome" in closed) throw new Error(`runner not applicable: ${closed.reason}`);
    expect(closed.decision.complete).toBe(false);
    expect(closed.terminalComplete).toBe(false);
  }, 60000);

  it("missing receipts blocked: a verdict without a durable receipt never counts", async () => {
    const sessionId = "e2e-phantom";
    const { dataDir, workspace, config } = world("phantom");
    const deps = makeDeps(dataDir, { model: stopClaimsComplete() });

    const result = await runTool(
      null,
      {
        source: "e2e",
        graph: {
          version: 1,
          nodes: [{ id: "build", kind: "shell", command: "printf 'parser output v1' > parser.txt" }],
        },
      },
      config,
      sessionId,
    );
    expect(result.results.find((r) => r.nodeId === "build")?.status).toBe("succeeded");
    // Scaffold after the run so the candidate binds the tool's journals.
    const { contract, candidateDigest } = await scaffoldMission(deps.store, dataDir, sessionId);
    // The effect really landed; the claim below is about the missing receipt, not the file.
    expect(existsSync(join(workspace, "parser.txt"))).toBe(true);

    // A phantom verdict: well-formed but never persisted through the ledger.
    const phantom: MissionCriterionVerification = {
      criterionId: "criterion-01",
      verifierId: "file-state",
      missionRevision: contract.missionRevision,
      candidateDigest,
      result: "satisfied",
      receiptCorrelationId: "p".repeat(64),
      verifiedAt: 400,
      evidenceRef: "agent-claim:all-green",
    };
    // Read-back proves the absence: no such receipt is on disk.
    expect(verificationReceiptIds(testLedger(dataDir).read().records).has(phantom.receiptCorrelationId)).toBe(false);

    const closed = await closeWith(
      deps.store,
      dataDir,
      sessionId,
      { associations: [{ criterionId: "criterion-01", runId: result.runId, nodeId: "build" }], verifications: [phantom] },
      ["file-state"],
    );
    if ("outcome" in closed) throw new Error(`runner not applicable: ${closed.reason}`);
    expect(closed.decision.complete).toBe(false);
    expect(closed.terminalComplete).toBe(false);
  }, 60000);

  it("verifier receipts persist idempotently: same observation twice is a duplicate, never a second verdict", async () => {
    const sessionId = "e2e-idempotent";
    const { dataDir, workspace, config } = world("idempotent");
    const deps = makeDeps(dataDir, { model: stopClaimsComplete() });

    const result = await runTool(
      null,
      {
        source: "e2e",
        graph: {
          version: 1,
          nodes: [{ id: "build", kind: "shell", command: "printf 'parser output v1' > parser.txt" }],
        },
      },
      config,
      sessionId,
    );
    expect(result.results.find((r) => r.nodeId === "build")?.status).toBe("succeeded");
    // Scaffold after the run so the candidate binds the tool's journals.
    const { contract, candidateDigest } = await scaffoldMission(deps.store, dataDir, sessionId);
    const digest = sha(readFileSync(join(workspace, "parser.txt")));

    // Two independent observations of the same satisfied state.
    const spec = [{ path: "parser.txt", expectedDigest: digest }];
    const first = await produceFiles(deps.store, dataDir, sessionId, contract, workspace, spec, result.runId, "build");
    const second = await produceFiles(deps.store, dataDir, sessionId, contract, workspace, spec, result.runId, "build");
    expect(first.reports[0]?.status).toBe("satisfied");
    expect(second.reports[0]?.status).toBe("satisfied");
    // Same observation, same receipt identity: the ledger holds one receipt row per finding.
    expect(first.verifications[0]?.receiptCorrelationId).toBe(second.verifications[0]?.receiptCorrelationId);

    // And a direct pin: persisting the identical finding reports duplicate.
    const ledger = testLedger(dataDir);
    const finding = verifyFileState({
      criterionId: "criterion-01",
      missionRevision: contract.missionRevision,
      candidateDigest,
      graphNodes: [{ runId: result.runId, nodeId: "build" }],
      files: spec,
      root: workspace,
      verifiedAt: 400,
    });
    if (finding === undefined) throw new Error("expected a satisfied finding");
    const once = persistVerifierFinding(ledger, sessionId, finding);
    const twice = persistVerifierFinding(ledger, sessionId, finding);
    expect(once.status === "appended" || once.status === "duplicate").toBe(true);
    expect(twice.status).toBe("duplicate");
    expect(findingReceiptCorrelationId(finding)).toBe(first.verifications[0]?.receiptCorrelationId);
  }, 60000);
});
