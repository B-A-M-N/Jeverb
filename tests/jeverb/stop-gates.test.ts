import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toMuseOutput } from "../../src/hosts/muse/outputs.js";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import { dispatchEvent } from "../../src/hooks/unified.js";
import { buildDeps } from "../../src/hooks/main.js";
import { loadHookConfig } from "../../src/hooks/config.js";
import { ReviewService } from "../../src/review/service.js";
import { FakeModel, noul } from "../helpers/fake-model.js";
import { hashQuestions } from "../../src/decision/provenance.js";
import { MissionClosureGate, MISSION_CLOSURE_QUESTION, type MissionClosureEvidence } from "../../src/mission/closure.js";
import { testHookConfig } from "../helpers/control-state.js";
import { parseMissionContract } from "../../src/mission/contract.js";
import { testLedgerForFile } from "../helpers/control-state.js";

function testDeps() {
  const config = {
    ...testHookConfig(join(mkdtempSync(join(tmpdir(), "jeverb-stop-store-")), "data")),
    // Keep persistent counters inside the test-owned directory. The default
    // host data dir may be read-only in CI/sandbox runs, which would make the
    // one-block-per-prompt invariant appear to reset on every dispatch.
  };
  const base = buildDeps(config, null);
  const review = new ReviewService(null, {
    checks: [],
    policy: { policy_version: "1", thresholds: { block: 0.85, security_review: 0.6 } },
  });
  const ledger = testLedgerForFile(join(mkdtempSync(join(tmpdir(), "jeverb-stop-")), "evidence.log"));
  return { ...base, review, ledger };
}

describe("stop completion gates", () => {
  // Fresh session per test: stop_blocks live in the shared store, so a
  // reused id would inherit the cap from an earlier run.
  const freshSession = () => `stop-test-${randomUUID()}`;
  it("stays observable-only on an empty subagent deliverable without a model", async () => {
    // SubagentStop never enforces on an absent/empty parent-facing message:
    // missing information is unknown, not a failed deliverable.
    const decision = await dispatchEvent(
      "SubagentStop",
      { session_id: freshSession(), last_assistant_message: "   " } as never,
      testDeps(),
    );
    expect(decision).toBeUndefined();
  });

  it("maps an empty Stop to a Muse block decision", async () => {
    const decision = await dispatchEvent(
      "Stop",
      { session_id: freshSession(), last_assistant_message: "" } as never,
      testDeps(),
    );
    expect(toMuseOutput("Stop", decision ?? undefined)).toMatchObject({ decision: "block" });
  });

  it("keeps completion nonterminal when trusted objective coverage is absent", async () => {
    const deps = testDeps();
    const sid = freshSession();
    deps.model = new FakeModel(() => ({
      claims_complete: noul(0.99),
      says_part_not_done: noul(0.01),
      says_step_deferred: noul(0.01),
      says_check_failing: noul(0.01),
      asks_user: noul(0.01),
      addresses_request: noul(0.99),
      claims_verified: noul(0.01),
    }), { answeredBy: "jev-1.14.0" });
    const missionPrompt = "Implement the parser migration and verify it\n\nAcceptance criteria:\n- The parser migration is implemented";
    const missionContract = parseMissionContract(sid, missionPrompt, deps.now());
    expect(missionContract).toBeDefined();
    deps.store.updateSession(sid, (state) => ({
      ...state,
      prompts: [missionPrompt],
      mission_contract: missionContract!,
    }));
    const questionHash = hashQuestions({ closure: MISSION_CLOSURE_QUESTION });
    const closureModel = {
      name: "jev-1.14.0",
      evaluate: async () => ({
        model: "jev-1.14.0",
        provider: "typesafe",
        questionHash,
        answers: { closure: {
          type: "choice",
          choice: "COMPLETE",
          confidence: 1,
          probabilities: { COMPLETE: 1, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
        } },
        usage: { input_tokens: 1, output_tokens: 1 },
        latency_ms: 1,
      }) as never,
      choice: async () => { throw new Error("unused"); },
      score: async () => { throw new Error("unused"); },
      probability: async () => { throw new Error("unused"); },
    };
    const evidence: MissionClosureEvidence = {
      missionId: "m-1",
      objective: "Implement the parser migration and verify it",
      missionRevision: "m-r1",
      evidenceRevision: "e-r2",
      criteria: [{
        id: "migration",
        statement: "The parser migration is implemented",
        verified: true,
        outcome: "The new parser is active and the migration path succeeds",
        evidenceRef: "graph:run-1/node-1",
        missionRevision: "m-r1",
        evidenceRevision: "e-r2",
      }],
      tests: { passed: true, independent: true, evidenceRef: "test:run-2", revision: "e-r2" },
      operations: { pending: 0, uncertain: 0 },
      blockers: [],
    };
    const gate = new MissionClosureGate(closureModel as never, {
      policyVersion: "mission-closure/1",
      minConfidence: 0.9,
      calibrated: true,
      backend: "typesafe",
      model: "jev-1.14.0",
      modelVersion: "jev-1.14.0",
      questionHash,
      calibrationVersion: "test-calibration-1",
    }, { load: async () => evidence, isCurrent: async () => true }, deps.ledger!);
    deps.missionClosure = (currentSessionId, signal) => gate.close(currentSessionId, "m-1", signal);
    const decision = await dispatchEvent("Stop", {
      session_id: sid,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "The requested parser migration is implemented and its verification passed.",
      background_tasks: [],
      session_crons: [],
    }, deps);
    // The fixture has no host-owned original-objective coverage attestation.
    // A positive global Jev vote and passing criterion evidence therefore
    // remain nonterminal; the coverage gate must fail closed.
    expect(decision?.enforcement).toBe("continue_work");
    expect(decision?.terminalOutcome).toBeUndefined();
    expect(toMuseOutput("Stop", decision)).toMatchObject({
      decision: "block",
    });
    expect(deps.ledger?.read().records.filter((record) => record.event === "MissionClosure")).toHaveLength(1);
  });

  it("fails open after one block per prompt", async () => {
    const deps = testDeps();
    const input = { session_id: freshSession(), last_assistant_message: "" } as never;
    expect((await dispatchEvent("Stop", input, deps))?.enforcement).toBe("continue_work");
    expect(await dispatchEvent("Stop", input, deps)).toBeUndefined();
  });

  it("resets the cap on the next user prompt", async () => {
    const deps = testDeps();
    const sid = freshSession();
    const stop = { session_id: sid, last_assistant_message: "" } as never;
    expect((await dispatchEvent("Stop", stop, deps))?.enforcement).toBe("continue_work");
    await dispatchEvent(
      "UserPromptSubmit",
      { session_id: sid, prompt: "please try the migration again from scratch now" } as never,
      deps,
    );
    expect((await dispatchEvent("Stop", stop, deps))?.enforcement).toBe("continue_work");
  });

  it("stays silent on non-empty messages and on active stop hooks", async () => {
    expect(
      await dispatchEvent(
        "Stop",
        { session_id: freshSession(), last_assistant_message: "Done. The tests pass." } as never,
        testDeps(),
      ),
    ).toBeUndefined();
    expect(
      await dispatchEvent(
        "SubagentStop",
        { session_id: freshSession(), last_assistant_message: "", stop_hook_active: true } as never,
        testDeps(),
      ),
    ).toBeUndefined();
  });
});
