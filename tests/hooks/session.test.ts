/**
 * UserPromptSubmit bookkeeping and SessionStart's one warning.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleSessionStart } from "../../src/hooks/handlers/session-start.js";
import { handleUserPromptSubmit, MIN_PROMPT_CHARS } from "../../src/hooks/handlers/user-prompt-submit.js";
import { MAX_PROMPT_CHARS, MAX_PROMPTS } from "../../src/hooks/store.js";
import { FakeModel, choice, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";
import { setTestSwitch } from "../helpers/control-state.js";

const PROMPT = "Please refactor the parser so the tokenizer is a separate module, and keep the tests green.";

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  cleanup(dir);
});

describe("handleUserPromptSubmit", () => {
  it("records the prompt with no model call and no output", async () => {
    const model = new FakeModel(() => ({}));
    const deps = makeDeps(dir, { model });
    expect(await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps)).toBeUndefined();
    expect(deps.store.readSession("s1").prompts).toEqual([PROMPT]);
    expect(model.calls).toHaveLength(0);
  });

  it("captures only explicit user acceptance criteria and clears them on a new substantive request", async () => {
    const deps = makeDeps(dir);
    const missionPrompt = `Implement parser recovery without changing command authorization.\n\nAcceptance criteria:\n- Interrupted retries remain blocked until reconciled.\n- Add regression tests for stale terminal records.`;
    await handleUserPromptSubmit({ session_id: "s1", prompt: missionPrompt }, deps);
    const contract = deps.store.readSession("s1").mission_contract;
    expect(contract?.objective).toBe("Implement parser recovery without changing command authorization.");
    expect(contract?.criteria).toHaveLength(2);

    await handleUserPromptSubmit({ session_id: "s1", prompt: "yes" }, deps);
    expect(deps.store.readSession("s1").mission_contract?.missionId).toBe(contract?.missionId);

    await handleUserPromptSubmit({ session_id: "s1", prompt: "Now update the documentation for the separate release process." }, deps);
    expect(deps.store.readSession("s1").mission_contract).toBeUndefined();
  });

  it("persists explicit user verification without needing Jev routing", async () => {
    const deps = makeDeps(dir, { config: { routePrompts: false } });
    const missionPrompt = `Implement parser recovery without changing command authorization.\n\nAcceptance criteria:\n- Interrupted retries remain blocked until reconciled.\n- Add regression tests for stale terminal records.`;
    await handleUserPromptSubmit({ session_id: "s1", prompt: missionPrompt }, deps);
    const contract = deps.store.readSession("s1").mission_contract;
    expect(contract).toBeDefined();

    const verification = `Acceptance verification:\nmission_id: ${contract!.missionId}\nmission_revision: ${contract!.missionRevision}\nverified:\n- criterion-01`;
    const output = await handleUserPromptSubmit({ session_id: "s1", prompt: verification }, deps);
    expect(output?.hookSpecificOutput?.additionalContext).toContain("Recorded your explicit verification");
    expect(output?.hookSpecificOutput?.additionalContext).toContain("Independent checks and semantic review are still required");
    expect(deps.store.readSession("s1").mission_contract?.attestations).toHaveLength(1);
    expect(deps.store.readSession("s1").mission_contract?.missionId).toBe(contract?.missionId);
  });

  it("keeps only the last few substantive prompts", async () => {
    const deps = makeDeps(dir);
    const long = (n: number): string => `Please implement feature number ${n} across the whole codebase`;
    for (const n of [1, 2, 3, 4, 5]) {
      await handleUserPromptSubmit({ session_id: "s1", prompt: long(n) }, deps);
    }
    const prompts = deps.store.readSession("s1").prompts;
    expect(prompts).toEqual([long(3), long(4), long(5)]);
    expect(prompts).toHaveLength(MAX_PROMPTS);
  });

  it("does not let short follow-ups evict the request they continue", async () => {
    const deps = makeDeps(dir);
    const request = "Bump the version everywhere and push the release to the public repo";
    await handleUserPromptSubmit({ session_id: "s1", prompt: request }, deps);
    for (const follow of ["go", "yes", "ship both", "try it now"]) {
      await handleUserPromptSubmit({ session_id: "s1", prompt: follow }, deps);
    }
    expect(deps.store.readSession("s1").prompts).toEqual([request, "ship both", "try it now"]);
  });

  it("ignores an empty prompt without resetting the stop counter", async () => {
    const deps = makeDeps(dir);
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["a real request that is long enough to keep"], stop_blocks: 1 }));
    await handleUserPromptSubmit({ session_id: "s1", prompt: "   " }, deps);
    const session = deps.store.readSession("s1");
    expect(session.prompts).toHaveLength(1);
    expect(session.stop_blocks).toBe(1);
  });

  it("does not reset the Stop budget when the same prompt event is redelivered", async () => {
    const deps = makeDeps(dir);
    await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps);
    deps.store.updateSession("s1", (s) => ({ ...s, stop_blocks: 1 }));
    await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps);
    expect(deps.store.readSession("s1").stop_blocks).toBe(1);
    expect(deps.store.readSession("s1").prompt_revision).toBe(1);
  });

  it("uses host turn identity to distinguish a repeated request in a new turn", async () => {
    const deps = makeDeps(dir);
    await handleUserPromptSubmit({ session_id: "s1", turn_id: "turn-1", prompt: PROMPT }, deps);
    deps.store.updateSession("s1", (s) => ({ ...s, stop_blocks: 1 }));
    await handleUserPromptSubmit({ session_id: "s1", turn_id: "turn-1", prompt: PROMPT }, deps);
    expect(deps.store.readSession("s1").stop_blocks).toBe(1);
    await handleUserPromptSubmit({ session_id: "s1", turn_id: "turn-2", prompt: PROMPT }, deps);
    expect(deps.store.readSession("s1").stop_blocks).toBe(0);
    expect(deps.store.readSession("s1").prompt_revision).toBe(2);
  });

  it("truncates a very long prompt", async () => {
    const deps = makeDeps(dir);
    await handleUserPromptSubmit({ session_id: "s1", prompt: "x".repeat(5000) }, deps);
    expect(deps.store.readSession("s1").prompts[0]!.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  it("redacts a secret pasted into a prompt", async () => {
    const deps = makeDeps(dir);
    await handleUserPromptSubmit(
      { session_id: "s1", prompt: "use the key sk-abcdefghijklmnopqrstuvwxyz012345 please" },
      deps,
    );
    expect(deps.store.readSession("s1").prompts[0]).toContain("[REDACTED]");
  });

  it("resets the stop-block counter, the note budget and pending re-issues", async () => {
    const deps = makeDeps(dir);
    deps.store.updateSession("s1", (s) => ({
      ...s,
      stop_blocks: 1,
      notes_this_prompt: 4,
      pending_reissues: [{ tool_use_id: "t", ts: 0, tool_name: "Bash" }],
    }));
    await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps);
    const session = deps.store.readSession("s1");
    expect(session.stop_blocks).toBe(0);
    expect(session.notes_this_prompt).toBe(0);
    expect(session.pending_reissues).toEqual([]);
  });

  /**
   * A trip issued a moment before the user types "yes, do that" must still be
   * answerable, so the trip list survives a prompt. Clearing it here would make
   * every marker a no-op after any interleaved message.
   */
  it("keeps open tripwires across a user prompt", async () => {
    const deps = makeDeps(dir);
    deps.store.openTrip(
      "s1",
      {
        id: "t-abcdef12",
        fingerprint: "abcdef1234567890",
        tool_name: "Bash",
        ts: deps.now(),
        source: "pattern",
        reason: "recursive delete",
        denies: 1,
      },
      deps.now(),
    );
    await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps);
    expect(deps.store.liveTrips("s1", deps.now()).map((t) => t.id)).toEqual(["t-abcdef12"]);
  });

  it("records one prompt line in the log, with no prompt text in it", async () => {
    const deps = makeDeps(dir);
    await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps);
    const record = deps.store.readLog().at(-1);
    expect(record?.event).toBe("UserPromptSubmit");
    expect(record?.decision).toBe("prompt");
    expect(JSON.stringify(record)).not.toContain(PROMPT.slice(0, 20));
  });

  /**
   * A failing test suite is still failing after the user types something, so
   * the ledger deliberately outlives a prompt. If it did not, the stop check
   * would be blind for exactly as long as it takes to say "carry on".
   */
  it("does not reset the verification ledger", async () => {
    const deps = makeDeps(dir);
    const ledger = {
      last: { kind: "test" as const, ok: false, ts: 1_699_000_000_000, command: "npm test" },
      edits_since: 3,
    };
    deps.store.updateSession("s1", (s) => ({ ...s, verification: ledger }));
    await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps);
    expect(deps.store.readSession("s1").verification).toEqual(ledger);
  });

  it("does the bookkeeping even with no api key", async () => {
    const deps = makeDeps(dir, { model: null, config: { apiKey: null, routePrompts: true } });
    await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps);
    expect(deps.store.readSession("s1").prompts).toEqual([PROMPT]);
  });

  it("does no bookkeeping when the install is disabled", async () => {
    const deps = makeDeps(dir);
    setTestSwitch(dir, "OFF");
    await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps);
    expect(deps.store.readSession("s1").prompts).toEqual([]);
    expect(deps.store.readLog()).toEqual([]);
  });

  it("classifies the prompt when route_prompts is on", async () => {
    const model = new FakeModel(() => ({
      kind: choice("multi_file_implementation", { multi_file_implementation: 0.92, other: 0.08 }, 0.92),
      ambiguity: score(0.4, ["clear", "a detail open", "materially open"], 0.9),
    }));
    const deps = makeDeps(dir, { model, config: { routePrompts: true } });
    const output = await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps);
    expect(output?.hookSpecificOutput?.additionalContext).toContain("task kind: multi_file_implementation");
    expect(output?.hookSpecificOutput?.additionalContext).toContain("conf 0.92");
    expect(output?.hookSpecificOutput?.additionalContext).not.toContain("ambiguous");
  });

  it("mentions ambiguity when the score is high", async () => {
    const model = new FakeModel(() => ({
      kind: choice("debugging_unknown_cause", { debugging_unknown_cause: 0.9, other: 0.1 }, 0.9),
      ambiguity: score(1.8, ["clear", "a detail open", "materially open"], 0.9),
    }));
    const deps = makeDeps(dir, { model, config: { routePrompts: true } });
    const output = await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps);
    expect(output?.hookSpecificOutput?.additionalContext).toContain("ambiguous");
  });

  it("says nothing when the classification is not confident", async () => {
    const model = new FakeModel(() => ({
      kind: choice("other", { other: 0.4, question: 0.35, risky_change: 0.25 }, 0.4),
    }));
    const deps = makeDeps(dir, { model, config: { routePrompts: true } });
    expect(await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("low-confidence");
  });

  it("does not classify a short prompt", async () => {
    const model = new FakeModel(() => ({}));
    const deps = makeDeps(dir, { model, config: { routePrompts: true } });
    await handleUserPromptSubmit({ session_id: "s1", prompt: "x".repeat(MIN_PROMPT_CHARS - 1) }, deps);
    expect(model.calls).toHaveLength(0);
  });

  it("fails open when the model throws", async () => {
    const model = new FakeModel(() => {
      throw new Error("nope");
    });
    const deps = makeDeps(dir, { model, config: { routePrompts: true } });
    expect(await handleUserPromptSubmit({ session_id: "s1", prompt: PROMPT }, deps)).toBeUndefined();
    expect(deps.store.readLog().at(-1)?.decision).toBe("error");
  });
});

describe("handleSessionStart", () => {
  it("says nothing when a key is configured", async () => {
    const deps = makeDeps(dir);
    expect(await handleSessionStart({ session_id: "s1", source: "startup" }, deps)).toBeUndefined();
  });

  it("warns once when no key is configured", async () => {
    const deps = makeDeps(dir, { config: { apiKey: null } });
    const first = await handleSessionStart({ session_id: "s1", source: "startup" }, deps);
    expect(first?.systemMessage).toContain("inactive");
    expect(first?.hookSpecificOutput?.additionalContext).toContain("TYPESAFE_API_KEY");
    expect(await handleSessionStart({ session_id: "s1", source: "clear" }, deps)).toBeUndefined();
  });

  it("stays quiet when the gate is off entirely", async () => {
    const deps = makeDeps(dir, { config: { apiKey: null, gate: "off" } });
    expect(await handleSessionStart({ session_id: "s1" }, deps)).toBeUndefined();
  });

  it("never prints the key", async () => {
    const deps = makeDeps(dir, { config: { apiKey: "sk-secret-value-123456" } });
    const output = await handleSessionStart({ session_id: "s1" }, deps);
    expect(JSON.stringify(output ?? {})).not.toContain("sk-secret");
  });

  it("does not overwrite a corrupt session file", async () => {
    const deps = makeDeps(dir, { config: { apiKey: null } });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const path = join(dir, "sessions", "s1.json");
    writeFileSync(path, "{corrupt");
    expect(await handleSessionStart({ session_id: "s1", source: "startup" }, deps)).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("{corrupt");
    expect(deps.store.readSession("s1").key_warned).toBeUndefined();
  });

  it("warns after a corrupt session file is repaired, and only once", async () => {
    const deps = makeDeps(dir, { config: { apiKey: null } });
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const path = join(dir, "sessions", "s1.json");
    writeFileSync(path, "{corrupt");
    expect(await handleSessionStart({ session_id: "s1", source: "startup" }, deps)).toBeUndefined();
    // Repair outside the hook (operator restores the file); the warning fires once, then sticks.
    writeFileSync(path, `{"prompts":["do the thing"]}`);
    const warned = await handleSessionStart({ session_id: "s1", source: "startup" }, deps);
    expect(warned?.systemMessage).toContain("inactive");
    expect(await handleSessionStart({ session_id: "s1", source: "startup" }, deps)).toBeUndefined();
    expect(deps.store.readSession("s1")).toMatchObject({ prompts: ["do the thing"], key_warned: true });
  });

  it("warns exactly once under concurrent duplicate delivery", async () => {
    const deps = makeDeps(dir, { config: { apiKey: null } });
    const [first, second] = await Promise.all([
      handleSessionStart({ session_id: "s1", source: "startup" }, deps),
      handleSessionStart({ session_id: "s1", source: "startup" }, deps),
    ]);
    const warned = [first, second].filter((output) => output !== undefined);
    expect(warned).toHaveLength(1);
    expect(deps.store.readSession("s1").key_warned).toBe(true);
  });

  it("does not clobber a concurrent session update", async () => {
    const deps = makeDeps(dir, { config: { apiKey: null } });
    deps.store.updateSession("s1", (state) => ({ ...state, prompts: ["do the thing"] }));
    const [first, second] = await Promise.all([
      handleSessionStart({ session_id: "s1", source: "startup" }, deps),
      (async () => {
        deps.store.updateSession("s1", (state) => ({ ...state, stop_blocks: state.stop_blocks + 1 }));
        return undefined;
      })(),
    ]);
    expect(first?.systemMessage).toContain("inactive");
    expect(second).toBeUndefined();
    expect(deps.store.readSession("s1")).toMatchObject({
      prompts: ["do the thing"],
      stop_blocks: 1,
      key_warned: true,
    });
  });
});
