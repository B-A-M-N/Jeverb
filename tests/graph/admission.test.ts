/**
 * Admission control: a node authorized after its level was preempted must
 * not start a new side-effecting operation, and a hung authorization must
 * not hold the graph past its deadline.
 */
import { describe, expect, it } from "vitest";
import { executeGraph, type Graph } from "../../src/graph/executor.js";

const parallelGraph: Graph = {
  version: 1,
  parallel: true,
  nodes: [
    { id: "a", kind: "shell", command: "fail fast" },
    { id: "b", kind: "shell", command: "must never run" },
  ],
};

describe("late authorization after sibling failure", () => {
  it("blocks the late-authorized sibling with zero attempts", async () => {
    const invocations: string[] = [];
    const authorizer = {
      authorize: async (node: { id: string }) => {
        // B's grant arrives only after A's failure has preempted the level.
        if (node.id === "b") await new Promise((resolve) => setTimeout(resolve, 30));
        return { allowed: true };
      },
    };
    const results = await executeGraph(
      parallelGraph,
      authorizer,
      async (node) => {
        invocations.push(node.id);
        if (node.id === "a") return { output: "boom", ok: false };
        return "should not happen";
      },
      {},
    );
    const a = results.find((r) => r.nodeId === "a")!;
    const b = results.find((r) => r.nodeId === "b")!;
    expect(a.status).toBe("failed");
    expect(b.status).toBe("blocked");
    expect(b.attempts).toBe(0);
    expect(invocations).toEqual(["a"]);
  });
});

describe("later-level rescue after failure", () => {
  it("still runs a conditional node admitted after the failure", async () => {
    const invocations: string[] = [];
    const results = await executeGraph(
      {
        version: 1,
        nodes: [
          { id: "a", kind: "shell", command: "fail" },
          { id: "b", kind: "shell", command: "also fails", dependsOn: ["a"] },
          { id: "rescue", kind: "shell", command: "rescue", dependsOn: ["a", "b"], whenAny: ["a", "b"] },
        ],
      },
      { authorize: async () => ({ allowed: true }) },
      async (node) => {
        invocations.push(node.id);
        if (node.id === "rescue") return "recovered";
        return { output: "boom", ok: false };
      },
      {},
    );
    // A rescue whose condition is unsatisfiable records skipped, never runs.
    // b is an ordinary dependent of the failed node, so it is blocked too.
    expect(results.find((r) => r.nodeId === "b")!.status).toBe("blocked");
    expect(results.find((r) => r.nodeId === "rescue")!.status).toBe("skipped");
    expect(invocations).toEqual(["a"]);
  });

  it("runs a satisfied rescue under a fresh signal", async () => {
    const invocations: string[] = [];
    const results = await executeGraph(
      {
        version: 1,
        nodes: [
          { id: "b", kind: "shell", command: "ok" },
          { id: "a", kind: "shell", command: "fail" },
          { id: "rescue", kind: "shell", command: "rescue", dependsOn: ["a", "b"], whenAny: ["b"] },
        ],
      },
      { authorize: async () => ({ allowed: true }) },
      async (node) => {
        invocations.push(node.id);
        if (node.id === "a") return { output: "boom", ok: false };
        return "fine";
      },
      {},
    );
    expect(results.find((r) => r.nodeId === "rescue")!.status).toBe("succeeded");
    expect(invocations).toContain("rescue");
  });

  it("propagates an authorizer throw instead of recording it", async () => {
    await expect(executeGraph(
      { version: 1, nodes: [{ id: "a", kind: "shell", command: "x" }] },
      { authorize: async () => { throw new Error("auth down"); } },
      async () => "x",
      { timeoutMs: 50 },
    )).rejects.toThrow("auth down");
  });
});

describe("revocation bounds condition evaluation", () => {
  const condGraph = (when: unknown): Graph => ({
    version: 1,
    nodes: [{ id: "a", kind: "shell", command: "x", when: when as never }],
  });

  it("records cancelled, not skipped, when a false predicate resolves late", async () => {
    const results = await executeGraph(
      condGraph(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return false;
      }),
      { authorize: async () => ({ allowed: true }) },
      async () => "x",
      { timeoutMs: 15 },
    );
    expect(results[0]!.status).toBe("cancelled");
    expect(results[0]!.attempts).toBe(0);
  });

  it("ignores a late true predicate after revocation", async () => {
    const results = await executeGraph(
      condGraph(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return true;
      }),
      { authorize: async () => ({ allowed: true }) },
      async (node) => `ran ${node.id}`,
      { timeoutMs: 15 },
    );
    expect(results[0]!.status).toBe("cancelled");
    expect(results[0]!.attempts).toBe(0);
  });

  it("does not wait for a never-resolving predicate past caller abort", async () => {
    const caller = new AbortController();
    const started = Date.now();
    const pending = executeGraph(
      condGraph(() => new Promise<boolean>(() => {})),
      { authorize: async () => ({ allowed: true }) },
      async () => "x",
      { signal: caller.signal },
    );
    setTimeout(() => caller.abort(), 15);
    const results = await pending;
    expect(Date.now() - started).toBeLessThan(500);
    expect(results[0]!.status).toBe("cancelled");
    expect(results[0]!.attempts).toBe(0);
  });

  it("still records a throwing predicate as failed when not revoked", async () => {
    const results = await executeGraph(
      condGraph(() => {
        throw new Error("predicate blew up");
      }),
      { authorize: async () => ({ allowed: true }) },
      async () => "x",
      {},
    );
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.output).toContain("predicate blew up");
  });
});

describe("deadline bounds pending authorization", () => {
  it("settles cancelled without waiting for a late grant", async () => {
    const invocations: string[] = [];
    const started = Date.now();
    const results = await executeGraph(
      { version: 1, nodes: [{ id: "a", kind: "shell", command: "slow grant" }] },
      { authorize: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { allowed: true };
      } },
      async (node) => {
        invocations.push(node.id);
        return "should not happen";
      },
      { timeoutMs: 15 },
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(150);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("cancelled");
    expect(results[0]!.attempts).toBe(0);
    expect(invocations).toEqual([]);
  });
});
