/**
 * Stub-transport end-to-end mission workflow through the production Stop path.
 *
 * Drives `handleStop` with the real production mission-closure runner
 * (`buildDeps`, no injected `missionClosure` double) and a scripted
 * in-process DecisionModel standing in for the stub relay: no network, no
 * provider credentials, no installs. Covers the Pass 4 workflow the live
 * gateway cannot currently serve:
 *
 * correction -> agent continuation -> current-candidate mission receipt ->
 * deterministic refusal when host criterion proof is absent, plus the fault
 * guards (stale/unchanged evidence, provider outage, wrong candidate, loop cap).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { hashQuestions } from "../../src/decision/provenance.js";
import type { Answer, DecisionModel, Question, State } from "../../src/decision/types.js";
import { buildDeps } from "../../src/hooks/main.js";
import { handleStop, MAX_STOP_BLOCKS_PER_PROMPT } from "../../src/hooks/handlers/stop.js";
import type { HookInput } from "../../src/hooks/types.js";
import { MISSION_CLOSURE_QUESTION, type MissionClosurePolicy } from "../../src/mission/closure.js";
import {
  addMissionAttestations,
  parseMissionAttestation,
  parseMissionContract,
} from "../../src/mission/contract.js";
import { createSessionMissionClosureSource } from "../../src/mission/session-source.js";
import { cleanup, tempDir, testConfig } from "./helpers.js";
import { setTestSwitch } from "../helpers/control-state.js";

const QUESTION_HASH = hashQuestions({ closure: MISSION_CLOSURE_QUESTION });

const POLICY: MissionClosurePolicy = {
  policyVersion: "mission-closure/1",
  minConfidence: 0.8,
  calibrated: true,
  backend: "typesafe",
  model: "jev-1.14.0",
  modelVersion: "jev-1.14.0",
  questionHash: QUESTION_HASH,
  calibrationVersion: "stub-workflow-1",
};

const PROMPT = "Objective: ship the parser change\nObjective coverage: exhaustive\nAcceptance criteria:\n- Parser handles the new syntax\n- Regression tests cover retry safety";
const DONE_MESSAGE =
  "The parser change is complete: the new syntax parses and the retry-safety regression tests pass on this candidate.";

type ClosureVote = "COMPLETE" | "INCOMPLETE";

/** Scripted stand-in for the stub relay: stop Nouls plus a closure choice vote. */
class WorkflowModel implements DecisionModel {
  readonly name = "jev-1.14.0";
  readonly calls: Array<{ ids: string[] }> = [];
  closureVote: ClosureVote = "COMPLETE";
  throwOnClosure = false;
  classificationComplete = 0.97;
  onClassification: (() => void) | undefined;

  async evaluate(request: { state: State; questions: Record<string, Question>; model?: string }): Promise<never> {
    const ids = Object.keys(request.questions);
    this.calls.push({ ids });
    if (ids.includes("closure")) {
      if (this.throwOnClosure) throw new Error("stub relay unavailable");
      const distribution: Record<string, number> = {
        COMPLETE: 0.02,
        INCOMPLETE: 0.02,
        BLOCKED: 0.02,
        INSUFFICIENT_EVIDENCE: 0.02,
      };
      distribution[this.closureVote] = 0.94;
      return {
        model: "jev-1.14.0",
        provider: "typesafe",
        questionHash: QUESTION_HASH,
        answers: {
          closure: { type: "choice", choice: this.closureVote, confidence: 0.94, probabilities: distribution },
        },
        usage: { input_tokens: 10, output_tokens: 10 },
        latency_ms: 3,
      } as never;
    }
    this.onClassification?.();
    const answers: Record<string, Answer> = {};
    for (const id of ids) answers[id] = { type: "noul", noul: id === "claims_complete" ? this.classificationComplete : id === "addresses_request" ? 0.97 : 0.02 };
    return {
      model: "jev-1.14.0",
      provider: "typesafe",
      questionHash: "stop",
      answers,
      usage: { input_tokens: 10, output_tokens: 10 },
      latency_ms: 3,
    } as never;
  }

  async choice(): Promise<never> { throw new Error("unused"); }
  async score(): Promise<never> { throw new Error("unused"); }
  async probability(): Promise<never> { throw new Error("unused"); }

  closureCalls(): number {
    return this.calls.filter((call) => call.ids.includes("closure")).length;
  }
}

function input(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: DONE_MESSAGE,
    background_tasks: [],
    session_crons: [],
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = tempDir();
  setTestSwitch(dir, "ON");
});
afterEach(() => {
  cleanup(dir);
});

function workflowDeps(model: WorkflowModel): ReturnType<typeof buildDeps> {
  const config = testConfig(dir, { missionClosurePolicy: POLICY });
  return buildDeps(config, model);
}

function plantContractUnverified(deps: ReturnType<typeof buildDeps>): void {
  const contract = parseMissionContract("s1", PROMPT, 100);
  if (contract === undefined) throw new Error("contract fixture failed to parse");
  deps.store.updateSession("s1", (state) => ({
    ...state,
    prompts: ["ship the parser change"],
    mission_contract: contract,
    verification: { last: { kind: "test", ok: true, ts: 300, command: "npm test" }, edits_since: 0 },
  }));
}

/** Agent continuation: attest both criteria, then bind an independent verifier receipt to the new candidate. */
async function agentCorrectsAndVerifies(deps: ReturnType<typeof buildDeps>): Promise<void> {
  const session = deps.store.readSession("s1");
  const contract = session.mission_contract;
  if (contract === undefined) throw new Error("missing mission contract");
  const userPrompt =
    `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\n` +
    `verified:\n- criterion-01: the new syntax parses\n- criterion-02: retry-safety regression tests pass`;
  const attestations = parseMissionAttestation("s1", userPrompt, contract, 400);
  if (attestations === undefined) throw new Error("attestation fixture failed to parse");
  const attested = addMissionAttestations(contract, attestations);
  deps.store.updateSession("s1", (state) => ({ ...state, mission_contract: attested }));
  const source = createSessionMissionClosureSource({ store: deps.store, dataDir: deps.config.dataDir, now: () => 500 });
  const probe = await source.load("s1", contract.missionId);
  if (probe.candidateRevision === undefined || probe.candidateDigest === undefined) {
    throw new Error("probe evidence missing candidate identity");
  }
  const candidateRevision: string = probe.candidateRevision;
  const candidateDigest: string = probe.candidateDigest;
  deps.store.updateSession("s1", (state) => ({
    ...state,
    mission_contract: {
      ...attested,
      independentVerifications: [{
        verifierId: "stub-verifier-1",
        missionRevision: contract.missionRevision,
        evidenceRevision: candidateRevision,
        candidate: candidateDigest,
        verificationResult: "pass",
        receiptCorrelationId: "stub-verifier-receipt-1",
        verifiedAt: 450,
      }],
    },
  }));
}

function controlActions(deps: ReturnType<typeof buildDeps>): unknown[] {
  if (deps.ledger === undefined) throw new Error("production deps always carry a ledger");
  return deps.ledger.read().records.filter((record) => record.event === "ControlAction");
}

function completeReceipts(deps: ReturnType<typeof buildDeps>): unknown[] {
  if (deps.ledger === undefined) throw new Error("production deps always carry a ledger");
  return deps.ledger.read().records.filter(
    (record) => record.event === "MissionClosure" && record.missionClosure?.complete === true,
  );
}

describe("stub-transport mission workflow through the Stop hook", () => {
  it("blocks incomplete work and refuses agent claims without host proof-plan evidence", async () => {
    const model = new WorkflowModel();
    const deps = workflowDeps(model);
    plantContractUnverified(deps);

    // 1. Incomplete: no attestations, mechanical evidence fails before any Jev call.
    const blocked = await handleStop(input(), deps);
    expect(blocked?.decision).toBe("block");
    expect(blocked?.reason).toContain("Next action:");
    expect(blocked?.reason).toContain("criterion-01");
    expect(blocked?.terminalOutcome).toBeUndefined();
    expect(controlActions(deps)).toHaveLength(1);
    expect(completeReceipts(deps)).toHaveLength(0);

    // 2. Unchanged evidence: no repeat correction, no loop — the second Stop stands down.
    const stalled = await handleStop(input(), deps);
    expect(stalled).toBeUndefined();
    expect(controlActions(deps)).toHaveLength(1);

    // 3. Agent continuation supplies contract claims and a candidate-bound
    // mission receipt, but no host proof-plan producer mapping or criterion
    // verifier receipt. Those claims cannot establish all criteria.
    await agentCorrectsAndVerifies(deps);

    // 4. The deterministic criterion gate remains closed.
    const terminal = await handleStop(input(), deps);
    const outcome = terminal?.terminalOutcome;
    expect(outcome).toBeUndefined();
    expect(completeReceipts(deps)).toHaveLength(0);
    expect(deps.ledger?.read().records.filter((record) => record.event === "MissionClosure").at(-1)?.missionClosure?.checks.allCriteriaVerified).toBe(false);

    // Repeated Stop remains nonterminal while the trusted evidence is absent.
    const again = await handleStop(input(), deps);
    expect(again?.terminalOutcome).toBeUndefined();
    expect(completeReceipts(deps)).toHaveLength(0);
    expect(controlActions(deps)).toHaveLength(2);
  });

  it("allows a fully evidenced mission when the classifier falsely reports no claim", async () => {
    const model = new WorkflowModel();
    model.classificationComplete = 0.02;
    const deps = workflowDeps(model);
    plantContractUnverified(deps);
    await agentCorrectsAndVerifies(deps);

    // Deterministic evidence is complete, so the Stop allows without a
    // terminal receipt: nothing is established, but the mission is not
    // trapped by a false-negative classifier. Semantic closure never runs
    // on a negative vote.
    const output = await handleStop(input(), deps);
    expect(output).toBeUndefined();
    expect(model.closureCalls()).toBe(0);
    expect(completeReceipts(deps)).toHaveLength(0);
  });

  it("never completes when the provider is unavailable", async () => {
    const model = new WorkflowModel();
    model.throwOnClosure = true;
    const deps = workflowDeps(model);
    plantContractUnverified(deps);
    await agentCorrectsAndVerifies(deps);

    const output = await handleStop(input(), deps);
    expect(output?.terminalOutcome).toBeUndefined();
    expect(completeReceipts(deps)).toHaveLength(0);
  });

  it("never completes against a verifier receipt bound to the wrong candidate", async () => {
    const model = new WorkflowModel();
    const deps = workflowDeps(model);
    plantContractUnverified(deps);
    await agentCorrectsAndVerifies(deps);

    // Swap in a receipt for a candidate that was never observed here.
    const session = deps.store.readSession("s1");
    const contract = session.mission_contract;
    if (contract === undefined) throw new Error("missing mission contract");
    deps.store.updateSession("s1", (state) => ({
      ...state,
      mission_contract: {
        ...contract,
        independentVerifications: [{
          verifierId: "stub-verifier-1",
          missionRevision: contract.missionRevision,
          evidenceRevision: "candidate-that-never-existed",
          candidate: "0".repeat(64),
          verificationResult: "pass",
          receiptCorrelationId: "stub-verifier-receipt-9",
          verifiedAt: 450,
        }],
      },
    }));

    const output = await handleStop(input(), deps);
    expect(output?.terminalOutcome).toBeUndefined();
    expect(completeReceipts(deps)).toHaveLength(0);
  });

  it("does not start mission closure when the classification phase leaves too little budget", async () => {
    const model = new WorkflowModel();
    const deps = workflowDeps(model);
    deps.config.timeoutMs = 1000;
    let now = 1000;
    deps.now = () => now;
    model.onClassification = () => { now += 850; };
    let closureCalls = 0;
    const missionClosure = deps.missionClosure;
    if (missionClosure === undefined) throw new Error("production deps must provide mission closure");
    deps.missionClosure = async (...args) => {
      closureCalls += 1;
      return missionClosure(...args);
    };
    plantContractUnverified(deps);

    const output = await handleStop(input(), deps);

    expect(output).toBeUndefined();
    expect(closureCalls).toBe(0);
    expect(deps.store.readLog().at(-1)?.decision).toBe("mission-closure-timeout");
    expect(deps.store.readLog().at(-1)?.reasons).toContain(
      "mission closure exceeded its inference budget; completion not established",
    );
    expect(completeReceipts(deps)).toHaveLength(0);
  });

  it("cannot loop forever on unchanged evidence: the per-prompt cap holds", async () => {
    const model = new WorkflowModel();
    const deps = workflowDeps(model);
    plantContractUnverified(deps);
    for (let attempt = 0; attempt < MAX_STOP_BLOCKS_PER_PROMPT + 2; attempt += 1) {
      await handleStop(input(), deps);
    }
    expect(controlActions(deps)).toHaveLength(1);
    expect(completeReceipts(deps)).toHaveLength(0);
  });
});
