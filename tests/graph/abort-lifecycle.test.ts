/**
 * Abort-listener lifecycle: a shared caller signal must not accumulate one
 * listener per completed execution, on success, cancellation, or thrown
 * errors. Level-scoped master->level propagation is likewise removed in a
 * level-scoped finally.
 */
import { describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { executeGraph, type Graph } from "../../src/graph/executor.js";

const allowAll = { authorize: async () => ({ allowed: true }) };
const okRun = async (): Promise<string> => "ok";

const tinyGraph: Graph = {
  version: 1,
  nodes: [{ id: "a", kind: "shell", command: "true" }],
};

const abortCount = (signal: AbortSignal): number => getEventListeners(signal, "abort").length;

describe("caller abort listener lifecycle", () => {
  it("leaves no listeners after repeated successful executions", async () => {
    const caller = new AbortController();
    for (let i = 0; i < 5; i += 1) {
      const results = await executeGraph(tinyGraph, allowAll, okRun, { signal: caller.signal });
      expect(results[0]!.status).toBe("succeeded");
      expect(abortCount(caller.signal)).toBe(0);
    }
    expect(abortCount(caller.signal)).toBe(0);
  });

  it("leaves no listeners after a deadline-cancelled execution", async () => {
    const caller = new AbortController();
    const results = await executeGraph(
      tinyGraph,
      allowAll,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "late";
      },
      { signal: caller.signal, timeoutMs: 15 },
    );
    // Mid-attempt revocation on a shell node is fail-closed uncertainty, not
    // success — the listener must still be gone.
    expect(results[0]!.status).toBe("outcome_unknown");
    expect(abortCount(caller.signal)).toBe(0);
  });

  it("leaves no listeners after caller abort or a throwing authorizer", async () => {
    const caller = new AbortController();
    const r1 = await executeGraph(tinyGraph, allowAll, okRun, { signal: caller.signal });
    // Caller never aborted here; run succeeded — listener still removed.
    expect(r1[0]!.status).toBe("succeeded");
    expect(abortCount(caller.signal)).toBe(0);

    const aborter = new AbortController();
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = executeGraph(
      {
        version: 1,
        nodes: [{ id: "slow", kind: "shell", command: "sleep" }],
      },
      allowAll,
      async (_node, ctx) => {
        started();
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) {
            resolve();
            return;
          }
          ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "interrupted";
      },
      { signal: aborter.signal },
    );
    await startedP;
    aborter.abort();
    const r2 = await pending;
    // Aborted mid-attempt: fail-closed uncertainty, and no retained listener.
    expect(r2[0]!.status).toBe("outcome_unknown");
    expect(abortCount(aborter.signal)).toBe(0);

    const throwing = new AbortController();
    await expect(
      executeGraph(
        tinyGraph,
        {
          authorize: async () => {
            throw new Error("authorizer blew up");
          },
        },
        okRun,
        { signal: throwing.signal },
      ),
    ).rejects.toThrow("authorizer blew up");
    expect(abortCount(throwing.signal)).toBe(0);
  });

  it("still propagates caller abort into the run context", async () => {
    const caller = new AbortController();
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    let sawAbort = false;
    const pending = executeGraph(
      tinyGraph,
      allowAll,
      async (_node, ctx) => {
        started();
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) {
            sawAbort = true;
            resolve();
            return;
          }
          ctx.signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return "interrupted";
      },
      { signal: caller.signal },
    );
    // Wait until the runner is in flight: aborting earlier would correctly
    // settle the node with zero attempts before it ever starts.
    await startedP;
    caller.abort();
    await pending;
    expect(sawAbort).toBe(true);
    expect(abortCount(caller.signal)).toBe(0);
  });
});
