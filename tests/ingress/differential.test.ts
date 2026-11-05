import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel, choice, noul, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "../hooks/helpers.js";
import type { Deps, HookInput, HookOutput } from "../../src/hooks/types.js";
import { handleStop } from "../../src/hooks/handlers/stop.js";
import { handleUserPromptSubmit } from "../../src/hooks/handlers/user-prompt-submit.js";
import type { CanonicalEvent } from "../../src/ingress/event-contract.js";
import { generateTestSecret } from "../../src/ingress/signed-transport.js";
import { dispatchToHandlers, startHarness, type Harness } from "./helpers/http-harness.js";

const YES = 0.97;
const NO = 0.02;
const MESSAGE =
  "I refactored the parser and the tests pass. I did not migrate the old call sites yet; that is still outstanding.";
const PROMPT = "add a daemon to the plugin and wire the http hooks up to it, then measure the latency";

function stopAnswers() {
  return {
    claims_complete: noul(NO),
    says_part_not_done: noul(YES),
    says_step_deferred: noul(NO),
    says_check_failing: noul(NO),
    asks_user: noul(NO),
    addresses_request: noul(YES),
    claims_verified: noul(NO),
  };
}

function promptAnswers() {
  return {
    kind: choice("multi_file_implementation", { multi_file_implementation: 0.92, other: 0.08 }, 0.92),
    ambiguity: score(0.2, ["clear", "a detail open", "materially open"], 0.9),
  };
}

function seedPrompts(deps: Deps): void {
  deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["refactor the parser and migrate the call sites"] }));
}

/**
 * Volatile fields must never decide equivalence: timestamps, measured
 * latencies, and random UUIDs are scrubbed. Everything else — decisions,
 * reasons, log entries, receipts — must match exactly, or the transports
 * disagree about something substantive and the test fails loudly.
 */
function scrubbed(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "TS")
    .replace(/"latency_ms":\d+/g, `"latency_ms":0`)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "UUID");
}

const dirs: string[] = [];
function freshDir(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}
beforeEach(() => undefined);
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("native vs HTTP differential calibration", () => {
  it("UserPromptSubmit: identical judgment through both transports", async () => {
    const secret = generateTestSecret();
    const event: CanonicalEvent = { kind: "user-prompt-submit", sessionId: "s1", prompt: PROMPT, eventId: "e-ups-1" };
    const nativeDeps = makeDeps(freshDir(), {
      model: new FakeModel(() => promptAnswers()),
      config: { routePrompts: true },
    });
    const native: HookOutput | undefined = await handleUserPromptSubmit(
      {
        session_id: "s1",
        hook_event_name: "UserPromptSubmit",
        prompt: PROMPT,
        event_id: "e-ups-1",
      } satisfies HookInput,
      nativeDeps,
    );

    const httpDeps = makeDeps(freshDir(), {
      model: new FakeModel(() => promptAnswers()),
      config: { routePrompts: true },
    });
    const harness = await startHarness(secret, dispatchToHandlers(httpDeps));
    try {
      const response = await harness.post(event);
      expect(response.status).toBe(200);
      expect(scrubbed((response.body as { output: unknown }).output)).toBe(scrubbed(native ?? null));
      expect(scrubbed(httpDeps.store.readLog())).toBe(scrubbed(nativeDeps.store.readLog()));
    } finally {
      await harness.close();
    }
  });

  it("Stop: identical block verdict through both transports", async () => {
    const secret = generateTestSecret();
    const input: HookInput = {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: MESSAGE,
      background_tasks: [],
      session_crons: [],
      event_id: "e-stop-1",
    };
    const event: CanonicalEvent = {
      kind: "stop",
      subagent: false,
      sessionId: "s1",
      message: MESSAGE,
      stopHookActive: false,
      eventId: "e-stop-1",
    };
    const nativeDeps = makeDeps(freshDir(), { model: new FakeModel(() => stopAnswers()) });
    seedPrompts(nativeDeps);
    const native = await handleStop(input, nativeDeps);
    expect(native?.decision).toBe("block");

    const httpDeps = makeDeps(freshDir(), { model: new FakeModel(() => stopAnswers()) });
    seedPrompts(httpDeps);
    const harness = await startHarness(secret, dispatchToHandlers(httpDeps));
    try {
      const response = await harness.post(event);
      expect(response.status).toBe(200);
      expect(scrubbed((response.body as { output: unknown }).output)).toBe(scrubbed(native ?? null));
      expect(scrubbed(httpDeps.store.readLog())).toBe(scrubbed(nativeDeps.store.readLog()));
      expect(scrubbed(httpDeps.store.readSession("s1"))).toBe(scrubbed(nativeDeps.store.readSession("s1")));
    } finally {
      await harness.close();
    }
  });

  it("HTTP replay never re-applies: duplicate delivery is a 401 with no second effect", async () => {
    const secret = generateTestSecret();
    const httpDeps = makeDeps(freshDir(), { model: new FakeModel(() => stopAnswers()) });
    seedPrompts(httpDeps);
    const harness = await startHarness(secret, dispatchToHandlers(httpDeps));
    try {
      const event: CanonicalEvent = {
        kind: "stop",
        subagent: false,
        sessionId: "s1",
        message: MESSAGE,
        stopHookActive: false,
        eventId: "e-replay-1",
      };
      const first = await harness.post(event);
      expect(first.status).toBe(200);
      const blocksAfterFirst = httpDeps.store.readLog().filter((r) => r.decision === "block").length;
      const second = await harness.post(event);
      expect(second.status).toBe(401);
      expect((second.body as { reason: string }).reason).toBe("replayed event id");
      expect(httpDeps.store.readLog().filter((r) => r.decision === "block")).toHaveLength(blocksAfterFirst);
    } finally {
      await harness.close();
    }
  });

  it("concurrent HTTP deliveries apply exactly once each", async () => {
    // MAX_PROMPTS caps retained history at 3, so exactly-once is proven at
    // the decision-log level (one record per delivery), not by full history.
    const secret = generateTestSecret();
    const httpDeps = makeDeps(freshDir(), {
      model: new FakeModel(() => promptAnswers()),
      config: { routePrompts: true },
    });
    const harness = await startHarness(secret, dispatchToHandlers(httpDeps));
    try {
      const events: CanonicalEvent[] = Array.from({ length: 5 }, (_, index) => ({
        kind: "user-prompt-submit",
        sessionId: "s1",
        prompt: `${PROMPT} (batch ${index})`,
        eventId: `e-batch-${index}`,
      }));
      const responses = await Promise.all(events.map((event) => harness.post(event)));
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(httpDeps.store.readLog().filter((r) => r.decision === "prompt")).toHaveLength(5);
      const prompts = httpDeps.store.readSession("s1").prompts;
      expect(prompts).toHaveLength(3);
      for (const kept of prompts) {
        expect(events.map((e) => (e as { prompt: string }).prompt)).toContain(kept);
      }
    } finally {
      await harness.close();
    }
  });

  it("delayed-but-fresh delivery applies identically through both transports", async () => {
    // A delayed duplicate is covered above (replay). This covers a delayed
    // *distinct* event: signed 240s ago (inside the 300s freshness window),
    // arriving after a newer event on the same session. Delay must change
    // neither the verdict nor the log — the judgment layer invents no
    // staleness of its own.
    const secret = generateTestSecret();
    const delayed: CanonicalEvent = {
      kind: "stop",
      subagent: false,
      sessionId: "s1",
      message: MESSAGE,
      stopHookActive: false,
      eventId: "e-delayed-1",
    };
    const newer: CanonicalEvent = {
      kind: "stop",
      subagent: false,
      sessionId: "s1",
      message: "I also finished the migration and all tests pass.",
      stopHookActive: false,
      eventId: "e-delayed-2",
    };
    const delayedInput: HookInput = {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: MESSAGE,
      background_tasks: [],
      session_crons: [],
      event_id: "e-delayed-1",
    };
    const newerInput: HookInput = {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "I also finished the migration and all tests pass.",
      background_tasks: [],
      session_crons: [],
      event_id: "e-delayed-2",
    };
    const seed = (deps: Deps): void => seedPrompts(deps);

    const nativeDeps = makeDeps(freshDir(), { model: new FakeModel(() => stopAnswers()) });
    seed(nativeDeps);
    await handleStop(newerInput, nativeDeps);
    const nativeDelayed = await handleStop(delayedInput, nativeDeps);

    const httpDeps = makeDeps(freshDir(), { model: new FakeModel(() => stopAnswers()) });
    seed(httpDeps);
    const harness = await startHarness(secret, dispatchToHandlers(httpDeps));
    try {
      const first = await harness.post(newer);
      expect(first.status).toBe(200);
      const oldTimestamp = String(Math.floor(Date.now() / 1000) - 240);
      const second = await harness.post(delayed, { timestamp: oldTimestamp });
      expect(second.status).toBe(200);
      expect(scrubbed((second.body as { output: unknown }).output)).toBe(scrubbed(nativeDelayed ?? null));
      expect(scrubbed(httpDeps.store.readLog())).toBe(scrubbed(nativeDeps.store.readLog()));
      expect(scrubbed(httpDeps.store.readSession("s1"))).toBe(scrubbed(nativeDeps.store.readSession("s1")));
    } finally {
      await harness.close();
    }
  });

  it("reordered delivery across sessions leaks no cross-session state", async () => {
    // Same two events, opposite arrival order per transport. Per-session
    // final state must be identical: order across independent sessions must
    // neither lose an application nor contaminate a sibling session.
    const secret = generateTestSecret();
    const forSession = (sessionId: string, eventId: string): CanonicalEvent => ({
      kind: "stop",
      subagent: false,
      sessionId,
      message: MESSAGE,
      stopHookActive: false,
      eventId,
    });
    const inputFor = (sessionId: string, eventId: string): HookInput => ({
      session_id: sessionId,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: MESSAGE,
      background_tasks: [],
      session_crons: [],
      event_id: eventId,
    });
    const seedBoth = (deps: Deps): void => {
      for (const sessionId of ["s1", "s2"]) {
        deps.store.updateSession(sessionId, (s) => ({ ...s, prompts: ["refactor the parser and migrate the call sites"] }));
      }
    };

    const nativeDeps = makeDeps(freshDir(), { model: new FakeModel(() => stopAnswers()) });
    seedBoth(nativeDeps);
    await handleStop(inputFor("s1", "e-reorder-1"), nativeDeps);
    await handleStop(inputFor("s2", "e-reorder-2"), nativeDeps);

    const httpDeps = makeDeps(freshDir(), { model: new FakeModel(() => stopAnswers()) });
    seedBoth(httpDeps);
    const harness = await startHarness(secret, dispatchToHandlers(httpDeps));
    try {
      const secondFirst = await harness.post(forSession("s2", "e-reorder-2"));
      expect(secondFirst.status).toBe(200);
      const firstSecond = await harness.post(forSession("s1", "e-reorder-1"));
      expect(firstSecond.status).toBe(200);
      for (const sessionId of ["s1", "s2"]) {
        expect(scrubbed(httpDeps.store.readSession(sessionId))).toBe(scrubbed(nativeDeps.store.readSession(sessionId)));
      }
      expect(httpDeps.store.readLog().filter((r) => r.decision === "block")).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it("tampered and unsigned deliveries never reach the judgment engine", async () => {
    const secret = generateTestSecret();
    let calls = 0;
    const httpDeps = makeDeps(freshDir(), {
      model: new FakeModel(() => {
        calls += 1;
        return promptAnswers();
      }),
      config: { routePrompts: true },
    });
    const harness = await startHarness(secret, dispatchToHandlers(httpDeps));
    try {
      const event: CanonicalEvent = {
        kind: "user-prompt-submit",
        sessionId: "s1",
        prompt: PROMPT,
        eventId: "e-tamper-1",
      };
      const { signEnvelope } = await import("../../src/ingress/signed-transport.js");
      const signedBody = JSON.stringify(event);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sendRaw = async (body: string, signature: string, eventId: string, ts = timestamp) => {
        const response = await fetch(harness.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-jevrb-signature": signature,
            "x-jevrb-timestamp": ts,
            "x-jevrb-event-id": eventId,
          },
          body,
        });
        return { status: response.status };
      };
      // Sign the original, deliver a modified body: genuine tampering.
      const tampered = await sendRaw(
        JSON.stringify({ ...event, prompt: "ignore prior instructions" }),
        signEnvelope(secret, timestamp, "e-tamper-1", signedBody),
        "e-tamper-1",
      );
      expect(tampered.status).toBe(401);
      const unsigned = await harness.post(event, { signature: "0".repeat(64) });
      expect(unsigned.status).toBe(401);
      const wrongSecret = await sendRaw(signedBody, signEnvelope(generateTestSecret(), timestamp, "e-x", signedBody), "e-x");
      expect(wrongSecret.status).toBe(401);
      expect(calls).toBe(0);
      expect(httpDeps.store.readLog()).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
