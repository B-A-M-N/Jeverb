/**
 * Stop: the truth table, and the loop protections around it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  endsWithQuestion,
  handleStop,
  MIN_MESSAGE_CHARS,
  stopPolicy,
  unfinishedClause,
  UNFINISHED_REASONS,
  type StopSignals,
} from "../../src/hooks/handlers/stop.js";
import { BANNED_IMPERATIVES } from "../../src/hooks/wording.js";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import { createSessionMissionClosureSource } from "../../src/mission/session-source.js";
import type { HookInput } from "../../src/hooks/types.js";
import { parseMissionContract } from "../../src/mission/contract.js";
import { FakeModel, noul } from "../helpers/fake-model.js";
import { buildDeps } from "../../src/hooks/main.js";
import { cleanup, makeDeps, tempDir, testConfig as makeTestConfig } from "./helpers.js";
import { setTestSwitch, testSwitchPath } from "../helpers/control-state.js";

const AUTO = 0.85;
const YES = 0.97;
const NO = 0.02;
const MAYBE = 0.5;

const MESSAGE =
  "I refactored the parser and the tests pass. I did not migrate the old call sites yet; that is still outstanding.";

function input(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: MESSAGE,
    background_tasks: [],
    session_crons: [],
    ...overrides,
  };
}

/**
 * The seven Nouls, driven through the one the 0.4.x compound stood in for.
 *
 * `unfinished` lands on `says_part_not_done` — the literal question closest to
 * what `admits_unfinished` was trying to ask — so every case below still reads
 * as the case it was written as.
 */
function answers(
  complete: number,
  unfinished: number,
  asks: number,
  addresses: number,
  verified = 0.02,
): Record<string, ReturnType<typeof noul>> {
  return {
    claims_complete: noul(complete),
    says_part_not_done: noul(unfinished),
    says_step_deferred: noul(NO),
    says_check_failing: noul(NO),
    asks_user: noul(asks),
    addresses_request: noul(addresses),
    claims_verified: noul(verified),
  };
}

/** The seven, as `StopSignals`, for the policy truth table. */
function signals(overrides: Partial<StopSignals> = {}): StopSignals {
  return {
    claims_complete: NO,
    says_part_not_done: NO,
    says_step_deferred: NO,
    says_check_failing: NO,
    asks_user: NO,
    addresses_request: YES,
    claims_verified: NO,
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  cleanup(dir);
});

describe("stopPolicy truth table", () => {
  const cases: [Partial<StopSignals>, boolean, string][] = [
    [{ claims_complete: YES }, false, "a clean done is never second-guessed"],
    [{ says_part_not_done: YES }, true, "says a part of the requested work is not done"],
    [{ says_step_deferred: YES }, true, "defers a requested step"],
    [{ says_check_failing: YES }, true, "reports a check still failing"],
    [{ says_part_not_done: YES, says_step_deferred: YES }, true, "two of the three at once"],
    [{ says_part_not_done: YES, asks_user: YES }, false, "says work remains but is waiting on the user"],
    [{ says_part_not_done: YES, asks_user: MAYBE }, false, "unsure whether it is waiting on the user"],
    [{ says_part_not_done: MAYBE }, false, "unsure whether work remains"],
    [{ addresses_request: NO }, false, "nothing fired"],
    [{ claims_complete: YES, says_part_not_done: YES }, true, "claims done and also names a gap"],
    [{ claims_complete: YES, says_part_not_done: YES, asks_user: YES }, false, "claims done, names a gap, asks"],
    [{ says_part_not_done: 0.84 }, false, "just below the threshold"],
    [{ says_part_not_done: 0.86 }, true, "just above the threshold"],
    [{ says_step_deferred: 0.84, says_check_failing: 0.84 }, false, "two near misses do not add up"],
    [{ says_part_not_done: YES, asks_user: 0.16 }, false, "asks_user just above 1 - auto"],
    [{ says_part_not_done: YES, asks_user: 0.15 }, true, "asks_user exactly at 1 - auto"],
  ];

  for (const [overrides, expected, label] of cases) {
    it(`${expected ? "block" : "allow"}: ${label}`, () => {
      expect(stopPolicy(signals(overrides), AUTO).block).toBe(expected);
    });
  }

  it("names the Noul that fired, so the block text can say which it was", () => {
    expect(stopPolicy(signals({ says_part_not_done: YES }), AUTO).unfinished_by).toBe("says_part_not_done");
    expect(stopPolicy(signals({ says_step_deferred: YES }), AUTO).unfinished_by).toBe("says_step_deferred");
    expect(stopPolicy(signals({ says_check_failing: YES }), AUTO).unfinished_by).toBe("says_check_failing");
    // Two fired: the stronger one gets to speak.
    expect(
      stopPolicy(signals({ says_part_not_done: 0.9, says_check_failing: 0.99 }), AUTO).unfinished_by,
    ).toBe("says_check_failing");
    expect(stopPolicy(signals(), AUTO).unfinished_by).toBeUndefined();
  });

  it("explains itself when it blocks", () => {
    const result = stopPolicy(signals({ says_part_not_done: YES }), AUTO);
    expect(result.reasons.join(" ")).toContain("names a part of the requested work as not done");
  });

  /**
   * A stop block is agent-facing text like a note or a trip, so it is held to
   * the same rule: imperative "system command" phrasing in injected context
   * trips Claude's own injection defenses.
   */
  it("says what it found without giving orders, in all three shapes", () => {
    for (const reason of UNFINISHED_REASONS) {
      const clause = unfinishedClause(reason, 0.94);
      const text = `[jev] Your final message ${clause} and is not waiting on the user. Continue with the remaining work, or state explicitly what blocks you.`;
      const match = BANNED_IMPERATIVES.exec(text);
      expect(match?.[0], `"${match?.[0]}" in: ${text}`).toBeUndefined();
    }
  });
});

/**
 * The nine live offers, as fixtures.
 *
 * Every one of these is a shape that scored `admits_unfinished` at 0.85 or
 * more in the first live week, and every one of them is an *offer* — extra work
 * on top of what was asked for. Only `asks_user` stopped them being wrong
 * blocks, and one record sat a threshold tick from one. Split into three
 * literal Nouls with the offer written into `not_for`, `says_part_not_done`
 * reads them low; and even if it did not, `asks_user` is high on all nine.
 *
 * The messages are what the shapes actually look like. The signals are the
 * fixture: this is a test of the policy, not of the classifier.
 */
describe("the nine offer shapes stay allow", () => {
  const OFFERS = [
    "Done — the three handlers log the new field and the tests pass. Say the word and I'll ship it.",
    "That's the parser fixed and green. I can also add a changelog entry if you want one.",
    "All four files are updated. Want me to run the full suite before you commit?",
    "The migration script is in place and tested. Happy to wire it into CI too — your call.",
    "Everything you asked for is done. I could extract the shared helper as well, if that's useful.",
    "Fix is in, type-check is clean. Let me know if you'd like the same treatment for the other module.",
    "The README section now matches the code. I can do the same pass on the docs folder if you like.",
    "Both hooks are wired up and passing. Shall I bump the version, or is that yours to do?",
    "That's the refactor complete. I can follow it with the dead-code sweep whenever you want.",
  ];

  for (const [index, message] of OFFERS.entries()) {
    it(`offer ${index + 1} is allowed: ${message.slice(0, 40)}…`, () => {
      // An offer is not requested work left undone, and it asks the user.
      const result = stopPolicy(
        signals({ claims_complete: YES, says_part_not_done: 0.08, asks_user: 0.93 }),
        AUTO,
      );
      expect(result.block, message).toBe(false);
      expect(result.unfinished_by, message).toBeUndefined();
    });
  }

  /**
   * The record that was one tick away. `admits_unfinished` 0.96 with
   * `asks_user` 0.24 blocked only because 0.24 > 0.15; at `auto` 0.80 it would
   * have been a wrong block. With the split, `says_part_not_done` is what has
   * to be high, and on an offer it is not.
   */
  it("does not depend on asks_user to get the near-miss record right", () => {
    for (const auto of [0.75, 0.8, 0.85, 0.9]) {
      expect(
        stopPolicy(signals({ claims_complete: YES, says_part_not_done: 0.08, asks_user: 0.24 }), auto).block,
        `auto ${auto}`,
      ).toBe(false);
    }
  });
});

describe("endsWithQuestion", () => {
  it("recognizes a trailing question", () => {
    expect(endsWithQuestion("Which one do you want?")).toBe(true);
    expect(endsWithQuestion("Done. Anything else?  ")).toBe(true);
  });

  it("ignores a question mark earlier in the message", () => {
    expect(endsWithQuestion(`Why? Because of the cache. ${"x".repeat(300)}`)).toBe(false);
  });
});

describe("handleStop", () => {
  const withPrompt = (deps: ReturnType<typeof makeDeps>): void => {
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["refactor the parser and migrate the call sites"] }));
  };

  const addMissionContract = (deps: ReturnType<typeof makeDeps>): void => {
    const contract = parseMissionContract(
      "s1",
      "Objective: complete the parser change\nAcceptance criteria:\n- Parser handles the new syntax\n- Tests pass",
      1,
    );
    if (contract === undefined) throw new Error("mission contract fixture failed to parse");
    deps.store.updateSession("s1", (state) => ({ ...state, mission_contract: contract }));
  };

  it("delivers a structured controller correction instead of generic text on incomplete closure", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(() => answers(YES, NO, NO, YES)) });
    withPrompt(deps);
    addMissionContract(deps);
    deps.ledger = new EvidenceLedger(join(dir, "evidence.log"), {
      switchPath: testSwitchPath(dir),
      requireRootOwnedSwitch: false,
    });
    // The gate judges the same evidence the controller will load, so the
    // correction binds the current revision rather than going stale.
    const source = createSessionMissionClosureSource({ store: deps.store, dataDir: deps.config.dataDir, now: deps.now });
    const contract = deps.store.readSession("s1").mission_contract;
    if (contract === undefined) throw new Error("missing mission contract");
    const evidence = await source.load("s1", contract.missionId);
    deps.missionClosure = async () => ({
      decision: {
        status: "INCOMPLETE",
        complete: false,
        missionId: evidence.missionId,
        missionRevision: evidence.missionRevision,
        evidenceRevision: evidence.evidenceRevision,
      },
      receipt: { status: "appended", correlationId: "b".repeat(64) },
      terminalComplete: false,
    } as never);
    const output = await handleStop(input(), deps);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("Next action: VERIFY criterion");
    expect(output?.reason).toContain("produce:");
    expect(output?.reason).toContain("at most");
    expect(output?.reason).toContain("Only this correction is authorized");
    // The correction was reconciled against the ledger, not invented.
    const records = deps.ledger.read().records.filter((r) => r.event === "ControlAction");
    expect(records.length).toBe(1);
    expect(records[0]?.controlAction?.evidenceRevision).toBe(evidence.evidenceRevision);
  });

  it("blocks when Claude said work remains", async () => {
    const model = new FakeModel(() => answers(NO, YES, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    const output = await handleStop(input(), deps);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("[jev]");
    // The block names the Noul that fired rather than a compound verdict.
    expect(output?.reason).toContain("names a part of the requested work as not done (p=0.97)");
    expect(output?.reason).toContain("is not waiting on the user");
    expect(deps.store.readLog().at(-1)?.unfinished_by).toBe("says_part_not_done");
  });

  it("signals Muse TOTAL_MISSION_COMPLETE only after the closure host returns a durable receipt", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(() => answers(YES, NO, NO, YES)) });
    withPrompt(deps);
    addMissionContract(deps);
    deps.missionClosure = async () => ({
      decision: {
        status: "COMPLETE",
        complete: true,
        missionId: "m-1",
        missionRevision: "m-r1",
        evidenceRevision: "e-r2",
        model: "jev-1.14.0",
        probabilities: { COMPLETE: 1, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
      },
      receipt: { status: "appended", correlationId: "a".repeat(64) },
      terminalComplete: true,
    } as never);
    const output = await handleStop(input(), deps);
    expect(output?.terminalOutcome).toEqual({
      status: "COMPLETE",
      missionId: "m-1",
      missionRevision: "m-r1",
      evidenceRevision: "e-r2",
      receiptCorrelationId: "a".repeat(64),
    });
    expect(output?.jev?.model).toBe("jev-1.14.0");
    expect(deps.store.readLog().at(-1)?.decision).toBe("mission-closure-complete");
  });

  it("does not turn a missing optional closure adapter into a Stop block", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(() => answers(YES, NO, NO, YES)) });
    withPrompt(deps);
    const contract = parseMissionContract(
      "s1",
      "Objective: complete the parser change\nAcceptance criteria:\n- Parser handles the new syntax\n- Tests pass",
      1,
    );
    expect(contract).toBeDefined();
    if (contract === undefined) throw new Error("mission contract fixture failed to parse");
    deps.store.updateSession("s1", (state) => ({ ...state, mission_contract: contract }));

    const output = await handleStop(input({ last_assistant_message: "The parser change is complete and the tests pass." }), deps);
    expect(output).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("mission-closure-unavailable");
  });

  it("does not run production mission closure for an ordinary session without a contract", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES));
    const config = makeTestConfig(dir);
    setTestSwitch(config.dataDir, "ON");
    const deps = buildDeps(config, model);
    deps.store.updateSession("s1", (state) => ({ ...state, prompts: ["refactor the parser and migrate the call sites"] }));

    // Production buildDeps does install the optional runner whenever a model
    // exists. Its absence of a mission contract must still be explicit and
    // non-blocking.
    expect(deps.missionClosure).toBeTypeOf("function");
    expect(deps.config.missionClosurePolicy.calibrated).toBe(false);
    await expect(deps.missionClosure?.("s1")).resolves.toEqual({
      outcome: "NOT_APPLICABLE",
      reason: "mission_contract_missing",
    });

    const output = await handleStop(input(), deps);
    expect(output).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
    expect(deps.store.readLog().some((record) => String(record.decision).startsWith("mission-closure-"))).toBe(false);
    expect(model.calls).toHaveLength(1);
  });

  it("does not turn a failed optional closure verifier into a Stop block", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(() => answers(YES, NO, NO, YES)) });
    withPrompt(deps);
    addMissionContract(deps);
    deps.missionClosure = async () => { throw new Error("provider unavailable"); };

    const output = await handleStop(input(), deps);
    expect(output).toBeUndefined();
    expect(output?.terminalOutcome).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("mission-closure-unavailable");
  });

  it("blocks an unreceipted or incomplete closure candidate instead of signaling completion", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(() => answers(YES, NO, NO, YES)) });
    withPrompt(deps);
    addMissionContract(deps);
    deps.missionClosure = async () => ({
      decision: { status: "INSUFFICIENT_EVIDENCE", complete: false, missionId: "m-1" },
      receipt: { status: "unavailable", correlationId: "", reason: "ledger unavailable" },
      terminalComplete: false,
    } as never);
    const output = await handleStop(input(), deps);
    expect(output?.decision).toBe("block");
    expect(output?.terminalOutcome).toBeUndefined();
    expect(output?.reason).toContain("cannot receive TOTAL_MISSION_COMPLETE");
  });

  it("names a deferral or a failing check when that is what fired", () => {
    const deferred = new FakeModel(() => ({
      ...answers(NO, NO, NO, YES),
      says_step_deferred: noul(YES),
    }));
    const depsA = makeDeps(dir, { model: deferred });
    withPrompt(depsA);
    return handleStop(input(), depsA).then(async (output) => {
      expect(output?.reason).toContain("defers a requested step");

      const failing = new FakeModel(() => ({
        ...answers(NO, NO, NO, YES),
        says_check_failing: noul(YES),
      }));
      const depsB = makeDeps(dir, { model: failing });
      depsB.store.updateSession("s2", (s) => ({ ...s, prompts: ["fix the failing parser test"] }));
      const second = await handleStop(input({ session_id: "s2" }), depsB);
      expect(second?.reason).toContain("reports a check still failing");
    });
  });

  it("counts the block so it happens at most once per prompt", async () => {
    const model = new FakeModel(() => answers(NO, YES, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    expect((await handleStop(input(), deps))?.decision).toBe("block");
    expect(deps.store.readSession("s1").stop_blocks).toBe(1);
    expect(await handleStop(input(), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(1);
  });

  it("says nothing when the work reads as finished", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    expect(await handleStop(input(), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
  });

  it("marks the audit record when a failed session read degrades the stop assessment", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES, YES));
    // A missing session file is a new session, not degradation: no flag.
    const fresh = makeDeps(dir, { model });
    withPrompt(fresh);
    expect(await handleStop(input(), fresh)).toBeUndefined();
    const freshRecord = fresh.store.readLog().at(-1);
    expect(freshRecord?.decision).toBe("unverified-claim");
    expect(freshRecord).not.toHaveProperty("storeDegraded");
    // A corrupt session file is a store failure: the allow is kept (fail
    // open), but the record says the assessment ran on nothing.
    const broken = makeDeps(dir, { model });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "s1.json"), "{truncated", { mode: 0o600 });
    expect(await handleStop(input(), broken)).toBeUndefined();
    expect(broken.store.readLog().at(-1)).toMatchObject({
      decision: "unavailable",
      storeDegraded: true,
      storeDegradedReason: "corrupt",
    });
  });

  const skips: [string, Partial<HookInput>][] = [
    ["stop_hook_active is set", { stop_hook_active: true }],
    ["a background task is in flight", { background_tasks: [{ id: "t1", type: "shell", status: "running" }] }],
    ["a cron will wake the session", { session_crons: [{ id: "c1", schedule: "* * * * *" }] }],
    ["the message is too short", { last_assistant_message: "x".repeat(MIN_MESSAGE_CHARS - 1) }],
    ["there is no message", { last_assistant_message: "" }],
    ["the message ends by asking the user", { last_assistant_message: `${MESSAGE} Shall I continue?` }],
  ];

  for (const [label, overrides] of skips) {
    it(`says nothing when ${label}`, async () => {
      const model = new FakeModel(() => answers(NO, YES, NO, YES));
      const deps = makeDeps(dir, { model });
      withPrompt(deps);
      expect(await handleStop(input(overrides), deps)).toBeUndefined();
      expect(model.calls).toHaveLength(0);
    });
  }

  it("says nothing when no prompt was ever recorded", async () => {
    const model = new FakeModel(() => answers(NO, YES, NO, YES));
    const deps = makeDeps(dir, { model });
    expect(await handleStop(input(), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(0);
  });

  it("obeys stop_check", async () => {
    const model = new FakeModel(() => answers(NO, YES, NO, YES));
    const deps = makeDeps(dir, { model, config: { stopCheck: false } });
    withPrompt(deps);
    expect(await handleStop(input(), deps)).toBeUndefined();
  });

  it("does nothing when the session is disabled", async () => {
    const model = new FakeModel(() => answers(NO, YES, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    deps.store.setDisabled("s1", true);
    expect(await handleStop(input(), deps)).toBeUndefined();
  });

  it("fails open with no api key", async () => {
    const deps = makeDeps(dir, { model: null, config: { apiKey: null } });
    withPrompt(deps);
    expect(await handleStop(input(), deps)).toBeUndefined();
  });

  it("logs the fail-open allow when no decision model is configured", async () => {
    const deps = makeDeps(dir, { model: null, config: { apiKey: null } });
    withPrompt(deps);
    expect(await handleStop(input(), deps)).toBeUndefined();
    const logged = deps.store.readLog().find((entry) => entry.decision === "unavailable");
    expect(logged?.reasons).toContain("no decision model is configured; nothing was judged");
  });

  it("fails open when the model throws", async () => {
    const model = new FakeModel(() => {
      throw new Error("overloaded");
    });
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    expect(await handleStop(input(), deps)).toBeUndefined();
    const logged = deps.store.readLog().at(-1);
    expect(logged?.decision).toBe("allow");
    expect(logged?.reasons).toContain(
      "stop classification exceeded its inference budget; judged on workspace evidence only",
    );
  });

  it("sends only the request and the final message", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    await handleStop(input(), deps);
    expect(Object.keys(model.calls[0]!.state as Record<string, unknown>).sort()).toEqual([
      "final_message",
      "request",
    ]);
    expect(model.calls[0]!.state).toMatchObject({
      request: { latest: "refactor the parser and migrate the call sites", previous: [] },
    });
  });

  it("still assesses a short final message when a mission contract is active", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    addMissionContract(deps);
    deps.missionClosure = async () => ({
      decision: {
        status: "COMPLETE",
        complete: true,
        missionId: "m-1",
        missionRevision: "m-r1",
        evidenceRevision: "e-r2",
        model: "jev-1.14.0",
        probabilities: { COMPLETE: 1, INCOMPLETE: 0, BLOCKED: 0, INSUFFICIENT_EVIDENCE: 0 },
      },
      receipt: { status: "appended", correlationId: "a".repeat(64) },
      terminalComplete: true,
    } as never);
    const output = await handleStop(input({ last_assistant_message: "Done" }), deps);
    expect(model.calls).toHaveLength(1);
    expect(output?.terminalOutcome?.status).toBe("COMPLETE");
  });

  it("still assesses a question-ending message when a mission contract is active", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    addMissionContract(deps);
    const output = await handleStop(
      input({ last_assistant_message: "The parser change is complete and the tests pass. Shall I continue?" }),
      deps,
    );
    expect(model.calls).toHaveLength(1);
    expect(output).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("mission-closure-unavailable");
  });

  it("reassesses after the evidence revision changes, within a finite budget", async () => {
    const model = new FakeModel(() => answers(NO, YES, NO, YES));
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    addMissionContract(deps);
    expect((await handleStop(input(), deps))?.decision).toBe("block");
    expect(deps.store.readSession("s1").stop_blocks).toBe(1);
    // Same evidence, same finding: suppressed without a new assessment.
    expect(await handleStop(input(), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(1);
    // New verification evidence advances the evidence revision: reassess.
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "test", ok: true, ts: deps.now(), command: "npm test" }, edits_since: 0 },
    }));
    expect((await handleStop(input(), deps))?.decision).toBe("block");
    expect(model.calls).toHaveLength(2);
    expect(deps.store.readSession("s1").stop_blocks).toBe(2);
    // Repeat on unchanged evidence: suppressed again.
    expect(await handleStop(input(), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(2);
    // The hard per-prompt cap still bounds total interventions.
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "lint", ok: true, ts: deps.now(), command: "npm run lint" }, edits_since: 0 },
    }));
    expect((await handleStop(input(), deps))?.decision).toBe("block");
    expect(deps.store.readSession("s1").stop_blocks).toBe(3);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "build", ok: true, ts: deps.now(), command: "npm run build" }, edits_since: 0 },
    }));
    expect(await handleStop(input(), deps)).toBeUndefined();
    expect(model.calls).toHaveLength(3);
  });
});

/**
 * A subagent's final message is about the task its parent gave it, not about
 * the user's last prompt — the user never saw the task. `SubagentStop` is also
 * the event that says the task is finished with.
 */
describe("handleStop inside a subagent", () => {
  const TASK = "find every call site of resolveDataDir and list them with line numbers";

  it("judges the final message against the captured task, then drops it", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["why is the data directory wrong after an upgrade?"] }));
    deps.store.rememberSubagentTask("s1", { agent_type: "Explore", prompt: TASK, ts: deps.now() }, deps.now());

    await handleStop(input({ hook_event_name: "SubagentStop", agent_type: "Explore" }), deps);
    expect(model.calls[0]!.state).toMatchObject({ request: { latest: TASK } });
    expect(deps.store.readLog().at(-1)?.subagent).toBe("Explore");
    // Consumed: the subagent has stopped, so its task is nobody's request now.
    expect(deps.store.readSession("s1").subagent_tasks).toBeUndefined();
  });

  it("falls back to the user's prompts when no task was captured", async () => {
    const model = new FakeModel(() => answers(YES, NO, NO, YES));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["refactor the parser"] }));
    await handleStop(input({ hook_event_name: "SubagentStop", agent_type: "Explore" }), deps);
    expect(model.calls[0]!.state).toMatchObject({ request: { latest: "refactor the parser" } });
  });
});

/**
 * Deterministic mission-contract enforcement through the Stop handler,
 * independent of the completion classifier. Whether inference is absent,
 * failed, or voted no claim, an explicit contract with a deterministic
 * defect must still block via the typed control decision, bounded by the
 * same intervention budget. SubagentStop never inherits the parent
 * contract.
 */
describe("handleStop without inference but with a mission contract", () => {
  const withPrompt = (deps: ReturnType<typeof makeDeps>): void => {
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["refactor the parser and migrate the call sites"] }));
  };

  const addMissionContract = (deps: ReturnType<typeof makeDeps>): void => {
    const contract = parseMissionContract(
      "s1",
      "Objective: complete the parser change\nAcceptance criteria:\n- Parser handles the new syntax\n- Tests pass",
      1,
    );
    if (contract === undefined) throw new Error("mission contract fixture failed to parse");
    deps.store.updateSession("s1", (state) => ({ ...state, mission_contract: contract }));
  };

  function contractDeps(options: Parameters<typeof makeDeps>[1]): ReturnType<typeof makeDeps> {
    const deps = makeDeps(dir, options);
    withPrompt(deps);
    addMissionContract(deps);
    deps.ledger = new EvidenceLedger(join(dir, "evidence.log"), {
      switchPath: testSwitchPath(dir),
      requireRootOwnedSwitch: false,
    });
    return deps;
  }

  it("blocks an unverified mission contract with a typed correction when no model is configured", async () => {
    const deps = contractDeps({ model: null, config: { apiKey: null } });
    const output = await handleStop(input(), deps);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("Next action:");
    expect(output?.terminalOutcome).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("mission-control-block");
  });

  it("blocks an unverified mission contract when the model throws", async () => {
    const deps = contractDeps({
      model: new FakeModel(() => {
        throw new Error("overloaded");
      }),
    });
    const output = await handleStop(input(), deps);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("Next action:");
    expect(output?.terminalOutcome).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("mission-control-block");
  });

  it("bounds the model-free correction block: unchanged evidence stands down", async () => {
    const deps = contractDeps({ model: null, config: { apiKey: null } });
    expect((await handleStop(input(), deps))?.decision).toBe("block");
    expect(await handleStop(input(), deps)).toBeUndefined();
  });

  it("still fails open without a contract when no model is configured", async () => {
    const deps = makeDeps(dir, { model: null, config: { apiKey: null } });
    withPrompt(deps);
    deps.ledger = new EvidenceLedger(join(dir, "evidence.log"), {
      switchPath: testSwitchPath(dir),
      requireRootOwnedSwitch: false,
    });
    expect(await handleStop(input(), deps)).toBeUndefined();
  });

  it("blocks a known contract violation when a healthy model falsely reports no completion claim", async () => {
    const model = new FakeModel(() => answers(NO, NO, NO, NO));
    const deps = contractDeps({ model });
    const output = await handleStop(input(), deps);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("Next action:");
    expect(output?.terminalOutcome).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("mission-control-block");
  });

  it("never applies the parent mission contract to a SubagentStop", async () => {
    const deps = contractDeps({ model: null, config: { apiKey: null } });
    const output = await handleStop(
      input({ hook_event_name: "SubagentStop", agent_type: "Explore" }),
      deps,
    );
    expect(output).toBeUndefined();
  });
});

/**
 * The verification ledger, end to end through the Stop handler.
 *
 * The bookkeeping half lives in `tests/hooks/verification.test.ts`; this is the
 * wiring: does a claim that the checks pass actually meet the record of what
 * the checks did, and does the ledger survive the things that should not clear
 * it.
 */
describe("handleStop and the verification ledger", () => {
  const CLAIM = "Fixed the parser and all tests pass now. Everything is green and ready to ship.";
  const withPrompt = (deps: ReturnType<typeof makeDeps>): void => {
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["fix the failing parser test"] }));
  };
  const claimsVerified = () => answers(YES, NO, NO, YES, YES);

  it("blocks a claim that checks pass when the last check failed", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(claimsVerified) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: {
        last: { kind: "test", ok: false, ts: deps.now() - 4 * 60_000, command: "npm test" },
        edits_since: 0,
      },
    }));

    const output = await handleStop(input({ last_assistant_message: CLAIM }), deps);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("[jev]");
    expect(output?.reason).toContain("says checks pass");
    expect(output?.reason).toContain("npm test");
    expect(output?.reason).toContain("4 min ago");
    expect(output?.reason).toContain("Re-run it, or correct the claim.");
    expect(deps.store.readLog().at(-1)?.decision).toBe("block");
    expect(deps.store.readSession("s1").stop_blocks).toBe(1);
  });

  it("says nothing when the last check passed and nothing has changed since", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(claimsVerified) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "test", ok: true, ts: deps.now() - 60_000, command: "npm test" }, edits_since: 0 },
    }));
    expect(await handleStop(input({ last_assistant_message: CLAIM }), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
  });

  it("logs, but does not block, a claim with no verification on record", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(claimsVerified) });
    withPrompt(deps);
    expect(await handleStop(input({ last_assistant_message: CLAIM }), deps)).toBeUndefined();
    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("unverified-claim");
    expect(record?.reasons?.join(" ")).toContain("no verification command on record");
    expect(deps.store.readSession("s1").stop_blocks).toBe(0);
  });

  it("logs, but does not block, a claim made after edits landed on a passing run", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(claimsVerified) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "test", ok: true, ts: deps.now() - 60_000, command: "npm test" }, edits_since: 2 },
    }));
    expect(await handleStop(input({ last_assistant_message: CLAIM }), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("unverified-claim");
  });

  it("does not block a message that never claimed the checks pass", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(() => answers(YES, NO, NO, YES, NO)) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "test", ok: false, ts: deps.now(), command: "npm test" }, edits_since: 0 },
    }));
    expect(await handleStop(input({ last_assistant_message: CLAIM }), deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("allow");
  });

  it("lets the stop-short rule speak first when both rules fire", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(() => answers(NO, YES, NO, YES, YES)) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "test", ok: false, ts: deps.now(), command: "npm test" }, edits_since: 0 },
    }));
    const output = await handleStop(input({ last_assistant_message: CLAIM }), deps);
    expect(output?.decision).toBe("block");
    expect(output?.reason).toContain("names a part of the requested work as not done");
    // Still one block, not two.
    expect(deps.store.readSession("s1").stop_blocks).toBe(1);
  });

  it("asks claims_verified as part of the one request it already makes", async () => {
    const model = new FakeModel(claimsVerified);
    const deps = makeDeps(dir, { model });
    withPrompt(deps);
    await handleStop(input({ last_assistant_message: CLAIM }), deps);
    expect(model.calls).toHaveLength(1);
    expect(Object.keys(model.calls[0]!.questions).sort()).toEqual([
      "addresses_request",
      "asks_user",
      "claims_complete",
      "claims_verified",
      "says_check_failing",
      "says_part_not_done",
      "says_step_deferred",
    ]);
    // The ledger is compared in code; it is never sent to the model.
    expect(JSON.stringify(model.calls[0]!.state)).not.toContain("npm test");
  });

  it("records the claims_verified signal for calibration even when nothing fires", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(claimsVerified) });
    withPrompt(deps);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      verification: { last: { kind: "lint", ok: true, ts: deps.now(), command: "npm run lint" }, edits_since: 0 },
    }));
    await handleStop(input({ last_assistant_message: CLAIM }), deps);
    expect(deps.store.readLog().at(-1)?.signals?.claims_verified).toBe(YES);
  });
});
