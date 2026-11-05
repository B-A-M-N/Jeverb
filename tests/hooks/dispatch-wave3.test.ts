/**
 * Wave 3 step 1 (D10): deadline/abort propagation on the legacy `runEvent` path.
 *
 * A slow model response past the 3.5 s hook deadline must cancel in-flight
 * work — not leave the handler detached and running to its full `timeoutMs`.
 * These tests pin the contract:
 *
 * 1. Abort mid-flight cancels the handler: `runEvent` resolves `undefined`
 *    and the handler writes no receipt after the abort.
 * 2. Deadline expiry leaves no live timers/handles behind, and the
 *    outer-abort listener the handler attaches is always removed.
 * 3. The PostToolUse chunk fan-out stays bounded under abort: all in-flight
 *    evaluations settle promptly and nothing new starts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluateRequest, EvaluateResult, Question } from "../../src/decision/types.js";
import { runEvent } from "../../src/hooks/dispatch.js";
import type { Deps, HookInput } from "../../src/hooks/types.js";
import { FakeModel } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * A model that hangs until its request signal fires, like a slow fetch
 * awaiting a model response. Tracks fan-out so the tests can assert the
 * bound; rejects with an abort error when cancelled.
 */
class HangingModel extends FakeModel {
  started = 0;
  aborted = 0;
  inFlight = 0;
  maxInFlight = 0;

  constructor() {
    super(() => {
      throw new Error("unused: hanging model only settles via abort");
    });
  }

  override async evaluate<Q extends Record<string, Question>>(
    request: EvaluateRequest<Q>,
  ): Promise<EvaluateResult<Q>> {
    this.started += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const signal = request.signal;
    try {
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted === true) {
          this.aborted += 1;
          reject(abortError());
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            this.aborted += 1;
            reject(abortError());
          },
          { once: true },
        );
      });
      throw new Error("unreachable: hanging model only settles via abort");
    } finally {
      this.inFlight -= 1;
    }
  }
}

/** Eight chunks: `chunk()` judges all pieces up to `MAX_SCREEN_CHUNKS`. */
const EIGHT_CHUNKS = "Ordinary documentation text with no instructions. ".repeat(2300);

function postToolUseInput(text: string): HookInput {
  return {
    session_id: "wave3",
    hook_event_name: "PostToolUse",
    tool_name: "WebFetch",
    tool_input: { url: "https://example.com" },
    tool_response: text,
    tool_use_id: "toolu_wave3",
  };
}

function depsWith(dir: string, model: FakeModel): Deps {
  return makeDeps(dir, { model, config: { screenResults: true } });
}

function timeoutResources(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
}

function processListeners(): Array<[string, number]> {
  return process.eventNames().map((name) => [String(name), process.listenerCount(name)]);
}

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  cleanup(dir);
  vi.restoreAllMocks();
});

describe("runEvent abort propagation (wave 3 / D10)", () => {
  it("abort mid-flight cancels the handler and writes no post-abort receipt", async () => {
    const model = new HangingModel();
    const deps = depsWith(dir, model);
    const appendSpy = vi.spyOn(deps.store, "append");
    const controller = new AbortController();

    const pending = runEvent("PostToolUse", JSON.stringify(postToolUseInput(EIGHT_CHUNKS)), deps, controller.signal);
    await vi.waitFor(() => {
      expect(model.started).toBe(8);
    });
    expect(model.maxInFlight).toBe(8);

    const start = Date.now();
    controller.abort();
    const output = await pending;
    const elapsed = Date.now() - start;

    expect(output).toBeUndefined();
    // The aborted fan-out settles now — not at the handler's own timeoutMs.
    expect(elapsed).toBeLessThan(1000);
    expect(model.inFlight).toBe(0);
    expect(model.aborted).toBe(8);
    // Nothing is published after the abort, not even an error receipt.
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it("deadline expiry leaves no live timers or process listeners behind", async () => {
    const model = new HangingModel();
    const deps = depsWith(dir, model);
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    const timeoutsBefore = timeoutResources();
    const listenersBefore = processListeners();

    const pending = runEvent("PostToolUse", JSON.stringify(postToolUseInput(EIGHT_CHUNKS)), deps, controller.signal);
    await vi.waitFor(() => {
      expect(model.started).toBe(8);
    });
    controller.abort();
    expect(await pending).toBeUndefined();

    // Let any dangling timer or listener outlive the settlement, then look:
    // no net-new live timeout, and no process listener added or removed.
    await vi.waitFor(() => {
      expect(timeoutResources()).toBeLessThanOrEqual(timeoutsBefore);
    });
    expect(processListeners()).toEqual(listenersBefore);
    // The handler linked the outer signal and unlinked it on the way out.
    expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), expect.objectContaining({ once: true }));
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("the chunk fan-out stays bounded under abort: nothing new starts", async () => {
    const model = new HangingModel();
    const deps = depsWith(dir, model);
    const controller = new AbortController();

    const pending = runEvent("PostToolUse", JSON.stringify(postToolUseInput(EIGHT_CHUNKS)), deps, controller.signal);
    await vi.waitFor(() => {
      expect(model.started).toBe(8);
    });
    const start = Date.now();
    controller.abort();
    await pending;

    // Cancellation is prompt — the handler does not run to its own timeoutMs.
    expect(Date.now() - start).toBeLessThan(1000);
    // The cap holds under abort and no chunk retries or restarts afterwards.
    expect(model.maxInFlight).toBeLessThanOrEqual(8);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(model.started).toBe(8);
    expect(model.inFlight).toBe(0);
  });
});
