/**
 * Dispatch and the fail-open path around it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rejectUnverifiedMuseMasterCommand, buildDeps, failClosedMuseCommitOnInitError, HANDLERS, main, parseMasterCommand, runCommand, runEvent, WALL_CLOCK_MS } from "../../src/hooks/main.js";
import { FakeModel, noul, score } from "../helpers/fake-model.js";
import { CASES } from "./cases.js";
import { cleanup, makeDeps, tempDir, testConfig } from "./helpers.js";
import { parseMissionAttestation, parseMissionContract, addMissionAttestations } from "../../src/mission/contract.js";
import { readMasterSwitch } from "../../src/hooks/store.js";
import { setTestSwitch, testSwitchPath } from "../helpers/control-state.js";

// The CLI delegates protected control operations to the installed host
// service. Keep this unit test inside its fixture boundary; never touch the
// machine's live service or protected switch from the test suite.
vi.mock("../../src/control/client.js", () => ({
  setControlState: vi.fn(async (action: string) => {
    throw new Error(`mock host policy refused ${action}`);
  }),
  controlStatus: vi.fn(async () => {
    throw new Error("mock host status unavailable");
  }),
}));

const PRE = JSON.stringify({
  session_id: "s1",
  cwd: "/home/dev/project",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /" },
});

let dir: string;
beforeEach(() => {
  dir = tempDir();
  setTestSwitch(dir, "ON");
});
afterEach(() => {
  cleanup(dir);
});

describe("runEvent", () => {
  it("recognizes exact Muse master-switch prompts but refuses unauthenticated hook control", () => {
    expect(parseMasterCommand(" /jev:off ")).toBe("off");
    expect(parseMasterCommand("/jev:on")).toBe("on");
    expect(parseMasterCommand({ prompt: "/jev:off", origin: "operator", operator_approved: true })).toBeNull();
    for (const value of ["/jev:off now", "please /jev:off", "jev:off", null, 1]) {
      expect(parseMasterCommand(value)).toBeNull();
    }

    const off = rejectUnverifiedMuseMasterCommand("/jev:off");
    expect(off).toMatchObject({ decision: "block" });
    expect(off?.reason).toContain("trusted operator-origin evidence");
    expect(off?.reason).toContain("no protected local control service");
    expect(off?.reason).toContain("No state changed");
    expect(rejectUnverifiedMuseMasterCommand("ordinary prompt")).toBeNull();
    const on = rejectUnverifiedMuseMasterCommand("/jev:on");
    expect(on).toMatchObject({ decision: "block" });
    expect(on?.reason).toContain("No state changed");
    expect(readMasterSwitch(dir, false, testSwitchPath(dir), false).desired).toBe("ON");
  });

  it("suppresses every dispatched hook event without model or ledger work while OFF", async () => {
    const model = new FakeModel(() => ({}));
    const deps = makeDeps(dir, { model });
    setTestSwitch(dir, "OFF");
    const input = JSON.stringify({ session_id: "s1", prompt: "a substantive prompt that must not be captured", tool_name: "Bash", tool_input: { command: "git commit -m test" } });
    for (const event of Object.keys(HANDLERS)) {
      expect(await runEvent(event, input, deps), event).toBeUndefined();
    }
    expect(deps.store.readSession("s1")).toEqual({ prompts: [], stop_blocks: 0 });
    expect(deps.store.readLog()).toEqual([]);
    expect(deps.ledger).toBeUndefined();
    expect(model.calls).toEqual([]);
  });

  it("also suppresses runEvent when the environment disable override is active", async () => {
    const deps = makeDeps(dir);
    deps.config.disabled = true;
    expect(await runEvent("UserPromptSubmit", JSON.stringify({ session_id: "s-env", prompt: "capture this?" }), deps)).toBeUndefined();
    expect(deps.store.readSession("s-env")).toEqual({ prompts: [], stop_blocks: 0 });
  });

  it("resumes the existing protected action policy after install-wide ON", async () => {
    const deps = makeDeps(dir);
    setTestSwitch(dir, "OFF");
    expect(await runEvent("PreToolUse", PRE, deps)).toBeUndefined();
    setTestSwitch(dir, "ON");
    const resumed = await runEvent("PreToolUse", PRE, deps);
    expect(resumed?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(resumed?.hookSpecificOutput?.permissionDecisionReason).toContain("tripwire");
  });

  it("refuses same-UID CLI mutations even with a forged TTY, confirmation input, or approval metadata", async () => {
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const errors: string[] = [];
    const errorWrite = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    }) as never);
    setTestSwitch(dir, "ON");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    try {
      for (const action of ["off", "on"]) {
        await main(["node", "/tmp/hook.mjs", "control", action]);
        expect(JSON.parse(errors.pop() ?? "{}")).toMatchObject({ ok: false, action, error: expect.any(String) });
      }
      expect(readMasterSwitch(dir, false, testSwitchPath(dir), false).desired).toBe("ON");
      await main(["node", "/tmp/hook.mjs", "control", "status"]);
      expect(JSON.parse(errors.pop() ?? "{}")).toMatchObject({ ok: false, error: expect.any(String) });
    } finally {
      errorWrite.mockRestore();
      process.exitCode = 0;
      if (originalIsTTY === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
      else Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    }
  });

  it("keeps legacy disable and enable command dispatch non-mutating", async () => {
    const deps = makeDeps(dir);
    expect(await runCommand("disable", [], deps)).toContain("no trusted operator authorization channel");
    expect(await runCommand("enable", [], deps)).toContain("no trusted operator authorization channel");
    expect(readMasterSwitch(dir, false, testSwitchPath(dir), false).desired).toBe("ON");
  });

  it("denies protected Muse commits when Jev client initialization fails", async () => {
    const config = testConfig(dir);
    config.commitEnforcement = "mandatory";
    const decision = await failClosedMuseCommitOnInitError(
      "PreToolUse",
      { tool_name: "Bash", tool_input: { command: "git commit -m test" }, cwd: dir } as never,
      config,
      new Error("invalid backend/model configuration"),
    );

    expect(decision?.enforcement).toBe("deny");
    expect(JSON.stringify(decision?.reasons ?? [])).toContain("model initialization failed");
    const receipts = JSON.parse(readFileSync(join(config.dataDir, "evidence.log"), "utf8").trim()) as { enforcement: string };
    expect(receipts.enforcement).toBe("deny");
  });

  it("does not deny a local commit when advisory review initialization is unavailable", async () => {
    const config = testConfig(dir);
    const decision = await failClosedMuseCommitOnInitError(
      "PreToolUse",
      { tool_name: "Bash", tool_input: { command: "git commit -m test" }, cwd: dir } as never,
      config,
      new Error("review backend unavailable"),
    );
    expect(decision).toBeUndefined();
  });

  it("wires default Stop closure to session evidence and persists an uncalibrated non-completion receipt", async () => {
    const model = new FakeModel((call) => Object.fromEntries(Object.entries(call.questions).map(([key, question]) => [
      key,
      question.type === "noul" ? noul(key === "claims_complete" ? 0.99 : 0.01) :
        question.type === "score" ? score(0, question.criteria.map((level) => String(level)), 1) :
          { type: "choice", choice: Object.keys(question.criteria)[0]!, probabilities: Object.fromEntries(Object.keys(question.criteria).map((choice) => [choice, choice === Object.keys(question.criteria)[0] ? 1 : 0])), confidence: 1 },
    ])));
    const config = testConfig(dir);
    const deps = buildDeps(config, model);
    const missionPrompt = "Objective: implement the parser update\nAcceptance criteria:\n- Parser handles the new syntax\n- Tests pass";
    const contract = parseMissionContract("s1", missionPrompt, 100)!;
    const attestation = parseMissionAttestation(
      "s1",
      `Acceptance verification:\nmission_id: ${contract.missionId}\nmission_revision: ${contract.missionRevision}\nverified:\n- criterion-01: parser handles the new syntax\n- criterion-02: the full test suite passes`,
      contract,
      200,
    )!;
    deps.store.updateSession("s1", (state) => ({
      ...state,
      prompts: [missionPrompt],
      mission_contract: addMissionAttestations(contract, attestation),
      verification: { last: { kind: "test", ok: true, ts: 300, command: "npm run test:run" }, edits_since: 0 },
    }));

    const output = await runEvent("Stop", JSON.stringify({
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "The parser update is complete and the tests pass.",
      background_tasks: [],
      session_crons: [],
    }), deps);

    expect(output?.decision).toBe("block");
    // The block carries the structured controller correction: the exact
    // criterion, the observable outcome that resolves it, and the attempt
    // budget — not generic evidence-gathering text.
    expect(output?.reason).toContain('Next action: VERIFY criterion "criterion-01"');
    expect(output?.reason).toContain("produce: an independent verifier PASS bound to candidate revision");
    expect(output?.reason).toContain("at most");
    expect(output?.reason).toContain("Only this correction is authorized");
    const receipts = deps.ledger?.read().records.filter((record) => record.event === "MissionClosure");
    expect(receipts).toHaveLength(1);
    expect(receipts?.[0]?.missionClosure).toMatchObject({ status: "INCOMPLETE", complete: false, confidenceIsProof: false });
    // The controller decision behind the directive was reconciled, not invented.
    const corrections = deps.ledger?.read().records.filter((record) => record.event === "ControlAction");
    expect(corrections?.length).toBe(1);
    expect(corrections?.[0]?.controlAction?.criterionId).toBe("criterion-01");
  });

  it("dispatches a known event", async () => {
    const output = await runEvent("PreToolUse", PRE, makeDeps(dir));
    expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output?.hookSpecificOutput?.permissionDecisionReason).toContain("[jev] tripwire");
  });

  it("ignores an unknown event", async () => {
    expect(await runEvent("NoSuchEvent", PRE, makeDeps(dir))).toBeUndefined();
  });

  it("routes SubagentStop through the Stop handler", async () => {
    const model = new FakeModel(() => ({
      claims_complete: noul(0.1),
      says_part_not_done: noul(0.95),
      says_step_deferred: noul(0.02),
      says_check_failing: noul(0.02),
      asks_user: noul(0.02),
      addresses_request: noul(0.9),
    }));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["do the work"] }));
    const output = await runEvent(
      "SubagentStop",
      JSON.stringify({
        session_id: "s1",
        hook_event_name: "SubagentStop",
        stop_hook_active: false,
        last_assistant_message: "I got most of it done but the migration step is still outstanding.",
        background_tasks: [],
        session_crons: [],
      }),
      deps,
    );
    expect(output?.decision).toBe("block");
    expect(deps.store.readLog().at(-1)?.event).toBe("SubagentStop");
  });

  it("routes the Approval alias to bookkeeping only", async () => {
    const deps = makeDeps(dir);
    deps.store.rememberReissue("s1", { tool_use_id: "t1", ts: 0, tool_name: "Bash", trip_id: "t-aaaaaaaa" });
    const output = await runEvent(
      "Approval",
      JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" }),
      deps,
    );
    expect(output).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("reissue-ran");
  });

  const garbage = ["", "   ", "not json", "{", "[]", "null", "42", '"a string"', '{"tool_name":'];
  for (const raw of garbage) {
    it(`survives ${JSON.stringify(raw)} on stdin`, async () => {
      expect(await runEvent("PreToolUse", raw, makeDeps(dir))).toBeUndefined();
    });
  }

  it("records a failed re-issue as failed, not as a run", async () => {
    const deps = makeDeps(dir);
    deps.store.rememberReissue("s1", { tool_use_id: "t1", ts: 0, tool_name: "Bash", trip_id: "t-aaaaaaaa" });
    await runEvent(
      "Approval",
      JSON.stringify({
        session_id: "s1",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_use_id: "t1",
        error: "Exit code 1",
      }),
      deps,
    );
    expect(deps.store.readLog().at(-1)?.decision).toBe("reissue-failed");
  });

  it("fills in the event name when stdin omits it", async () => {
    const deps = makeDeps(dir);
    const output = await runEvent(
      "PreToolUse",
      JSON.stringify({ session_id: "s1", cwd: "/x", tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
      deps,
    );
    expect(output?.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
  });

  it("tolerates a tool_input that is not an object", async () => {
    const deps = makeDeps(dir);
    expect(
      await runEvent("PreToolUse", JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: "ls" }), deps),
    ).toBeUndefined();
  });

  it("produces a serializable output and nothing else", async () => {
    // Destructive, and not part of anything the user asked for: a note.
    const model = new FakeModel(() => ({
      destructive: noul(0.99),
      outward_facing: noul(0.02),
      in_scope: noul(0.3),
      credential_exposure: noul(0.01),
      blast_radius: score(1, ["a", "b", "c", "d"], 0.9),
    }));
    const deps = makeDeps(dir, { model });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["clean up"] }));
    const output = await runEvent(
      "PreToolUse",
      JSON.stringify({
        session_id: "s1",
        cwd: "/home/dev/project",
        permission_mode: "default",
        tool_name: "Bash",
        tool_input: { command: "npm install" },
      }),
      deps,
    );
    const text = JSON.stringify(output);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["hookSpecificOutput"]);
  });
});

describe("the wall-clock budget", () => {
  it("leaves headroom under the 5 second hooks.json timeout", () => {
    expect(WALL_CLOCK_MS).toBeLessThan(5000);
    expect(WALL_CLOCK_MS).toBeGreaterThan(2000);
  });
});

/**
 * The command half of the conformance pair.
 *
 * `conformance.test.ts` runs the same table against a real daemon and asserts
 * byte equality with what happens here. This half pins what the bytes are, so a
 * change in behaviour fails as a changed expectation rather than as two paths
 * quietly agreeing on something new.
 */
describe("the shared case table, in process", () => {
  for (const hookCase of CASES) {
    it(hookCase.name, async () => {
      const deps = makeDeps(dir, {
        ...(hookCase.model !== undefined ? { model: hookCase.model() } : {}),
        ...(hookCase.config !== undefined ? { config: hookCase.config } : {}),
      });
      hookCase.prepare?.(deps.store);
      const output = await runEvent(hookCase.event, JSON.stringify(hookCase.input), deps);
      const text = JSON.stringify(output ?? {});
      if (hookCase.expect !== undefined) expect(text).toBe(hookCase.expect);
      for (const needle of hookCase.contains ?? []) expect(text).toContain(needle);
    });
  }
});

describe("runCommand adversarial", () => {
  it("reports status without changing anything", async () => {
    const deps = makeDeps(dir);
    const text = await runCommand("adversarial", [], deps);
    expect(text).toContain("adversarial closure pair: off");
    expect(text).toContain("adversarial calibration: missing");
  });

  it("persists on and off to the install-scoped data-dir config", async () => {
    const deps = makeDeps(dir);
    const on = await runCommand("adversarial", ["on"], deps);
    expect(on).toContain("enabled");
    const { loadHookConfig } = await import("../../src/hooks/config.js");
    expect(loadHookConfig({ MUSE_PLUGIN_DATA_DIR: deps.config.dataDir }).adversarialClosure).toBe(true);
    const off = await runCommand("adversarial", ["off"], deps);
    expect(off).toContain("disabled");
    expect(loadHookConfig({ MUSE_PLUGIN_DATA_DIR: deps.config.dataDir }).adversarialClosure).toBe(false);
  });

  it("rejects an unknown subcommand without touching the config", async () => {
    const deps = makeDeps(dir);
    expect(await runCommand("adversarial", ["maybe"], deps)).toContain("usage: adversarial [on|off|status]");
  });
});

describe("HANDLERS", () => {
  it("is exported, so hooks.json and the daemon's routes can be checked against it", () => {
    // `Approval` is this repo's own label rather than a Claude Code event, and
    // the daemon exposes one route per key here, so it has to be in the map.
    // `PostToolBatch` is the Muse batch-observation event (P0-8).
    expect(Object.keys(HANDLERS).sort()).toEqual(
      [
        "Approval",
        "PostToolBatch",
        "PostToolUse",
        "PostToolUseFailure",
        "PreLLMCall",
        "PostLLMCall",
        "PreCompact",
        "PostCompact",
        "StopFailure",
        "Notification",
        "PermissionRequest",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "SubagentStop",
        "UserPromptSubmit",
      ].sort(),
    );
  });
});
