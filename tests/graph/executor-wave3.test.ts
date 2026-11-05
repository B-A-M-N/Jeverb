import { describe, expect, it } from "vitest";
import {
  executeGraph,
  type ExecutorResult,
  type Graph,
  type GraphNode,
  type NodeRunContext,
} from "../../src/graph/executor.js";

const allowAll = { authorize: async () => ({ allowed: true }) };

interface Behavior {
  delayMs: number;
  fail?: string;
  output?: string;
}

interface Harness {
  run: (node: GraphNode, ctx: NodeRunContext) => Promise<string>;
  started: Set<string>;
  aborted: Set<string>;
}

/** Fake runner that honors the graph abort signal, like the real shell runner. */
function makeHarness(behavior: Record<string, Behavior>): Harness {
  const started = new Set<string>();
  const aborted = new Set<string>();
  const run = (node: GraphNode, ctx: NodeRunContext): Promise<string> => {
    started.add(node.id);
    const spec = behavior[node.id] ?? { delayMs: 0 };
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        ctx.signal?.removeEventListener("abort", onAbort);
        if (spec.fail !== undefined) reject(new Error(spec.fail));
        else resolve(spec.output ?? `${node.id}-done`);
      }, spec.delayMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        aborted.add(node.id);
        reject(new Error(`cancelled: ${node.id} aborted`));
      };
      if (ctx.signal?.aborted) {
        onAbort();
        return;
      }
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
  return { run, started, aborted };
}

const byId = (results: ExecutorResult[], id: string): ExecutorResult | undefined =>
  results.find((r) => r.nodeId === id);

describe("wave 3: parallel preemption with the no-rollback invariant", () => {
  it("a failing node cancels running shell siblings as outcome_unknown", async () => {
    const graph: Graph = {
      version: 1,
      parallel: true,
      nodes: [
        { id: "fail-fast", kind: "shell", command: "exit 1" },
        { id: "slow", kind: "shell", command: "slow side effects" },
      ],
    };
    const harness = makeHarness({
      "fail-fast": { delayMs: 20, fail: "shell node failed: exit 1" },
      slow: { delayMs: 2000 },
    });
    const results = await executeGraph(graph, allowAll, harness.run, { maxParallel: 2 });

    // Without preemption the slow sibling runs to completion (succeeded);
    // with preemption it is aborted mid-attempt.
    expect(byId(results, "fail-fast")?.status).toBe("failed");
    const slow = byId(results, "slow");
    expect(slow?.status).toBe("outcome_unknown");
    expect(slow?.ok).toBe(false);
    expect(slow?.output).toMatch(/outcome_unknown/);
    expect(slow?.output).toMatch(/reconciliation/);
    // The abort reached the running node through the graph signal.
    expect(harness.aborted.has("slow")).toBe(true);
  });

  it("admits no new nodes after a failure (late siblings never execute)", async () => {
    const graph: Graph = {
      version: 1,
      parallel: true,
      nodes: [
        { id: "fail-fast", kind: "shell", command: "exit 1" },
        { id: "slow-a", kind: "shell", command: "echo a" },
        { id: "slow-b", kind: "shell", command: "echo b" },
        { id: "late", kind: "shell", command: "echo late" },
      ],
    };
    const harness = makeHarness({
      "fail-fast": { delayMs: 10, fail: "shell node failed: exit 1" },
      "slow-a": { delayMs: 2000 },
      "slow-b": { delayMs: 2000 },
      late: { delayMs: 5 },
    });
    const results = await executeGraph(graph, allowAll, harness.run, { maxParallel: 2 });

    // Without preemption every side-effecting sibling executes; with
    // preemption the never-admitted nodes settle blocked with zero attempts
    // (proof they never ran — never outcome_unknown, never success).
    for (const id of ["slow-b", "late"]) {
      const result = byId(results, id);
      expect(result?.status).toBe("blocked");
      expect(result?.attempts).toBe(0);
    }
    expect(harness.started.has("late")).toBe(false);
    expect(harness.aborted.has("slow-a")).toBe(true);
    expect(byId(results, "slow-a")?.status).toBe("outcome_unknown");
  });

  it("preempts a mixed shell/verify level: jev siblings cancel cleanly", async () => {
    const graph: Graph = {
      version: 1,
      parallel: true,
      nodes: [
        { id: "shell-fail", kind: "shell", command: "exit 1" },
        { id: "verify", kind: "jev", question: "Is this safe?" },
      ],
    };
    const harness = makeHarness({
      "shell-fail": { delayMs: 20, fail: "shell node failed: exit 1" },
      verify: { delayMs: 2000, output: "verdict=yes noul=0.9" },
    });
    const results = await executeGraph(graph, allowAll, harness.run, { maxParallel: 2 });

    expect(byId(results, "shell-fail")?.status).toBe("failed");
    // A judgment node performs no side effects, so an abort is plain
    // cancellation — never outcome_unknown.
    const verify = byId(results, "verify");
    expect(verify?.status).toBe("cancelled");
    expect(verify?.ok).toBe(false);
    expect(harness.aborted.has("verify")).toBe(true);
  });

  it("keeps a fast sibling that already succeeded before the failure", async () => {
    const graph: Graph = {
      version: 1,
      parallel: true,
      nodes: [
        { id: "fast", kind: "shell", command: "echo fast" },
        { id: "slow-fail", kind: "shell", command: "exit 1" },
        { id: "filler", kind: "shell", command: "echo filler" },
        { id: "late", kind: "shell", command: "echo late" },
      ],
    };
    const harness = makeHarness({
      fast: { delayMs: 10 },
      "slow-fail": { delayMs: 100, fail: "shell node failed: exit 1" },
      filler: { delayMs: 2000 },
      late: { delayMs: 5 },
    });
    const results = await executeGraph(graph, allowAll, harness.run, { maxParallel: 2 });

    // Success observed before the failure stands — preemption is not rollback.
    const fast = byId(results, "fast");
    expect(fast?.status).toBe("succeeded");
    expect(fast?.ok).toBe(true);
    expect(byId(results, "slow-fail")?.status).toBe("failed");
    expect(byId(results, "filler")?.status).toBe("outcome_unknown");
    expect(harness.aborted.has("filler")).toBe(true);
    const late = byId(results, "late");
    expect(late?.status).toBe("blocked");
    expect(late?.attempts).toBe(0);
    expect(harness.started.has("late")).toBe(false);
  });

  it("preemption keeps a completed sibling and still admits conditional rescue", async () => {
    const graph: Graph = {
      version: 1,
      parallel: true,
      nodes: [
        { id: "fail-fast", kind: "shell", command: "exit 1" },
        { id: "quick", kind: "shell", command: "echo quick" },
        { id: "rescue", kind: "shell", command: "echo rescue", dependsOn: ["fail-fast", "quick"], whenAny: ["quick"] },
      ],
    };
    const harness = makeHarness({ "fail-fast": { delayMs: 20, fail: "shell node failed: exit 1" } });
    // A runner that ignores the preemption signal and runs to completion:
    // the attempt genuinely finished, so its outcome must stand — the graph
    // continues, and the rescue condition must read what actually happened.
    const ignoringRun = async (node: GraphNode, ctx: NodeRunContext): Promise<string> => {
      if (node.id !== "quick") return harness.run(node, ctx);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "quick-done";
    };
    const results = await executeGraph(graph, allowAll, ignoringRun, { maxParallel: 2 });

    expect(byId(results, "fail-fast")?.status).toBe("failed");
    const quick = byId(results, "quick");
    expect(quick?.status).toBe("succeeded");
    expect(quick?.output).toBe("quick-done");
    // The rescue path still evaluates after a sibling failure: preemption
    // stops new ordinary admissions, never conditional rescue.
    expect(byId(results, "rescue")?.status).toBe("succeeded");
  });

  it("caller revocation still discards a late result from an ignoring runner", async () => {
    const graph: Graph = {
      version: 1,
      nodes: [{ id: "only", kind: "shell", command: "echo only" }],
    };
    const caller = new AbortController();
    const ignoringRun = async (): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "late-result";
    };
    setTimeout(() => caller.abort(), 10);
    const results = await executeGraph(graph, allowAll, ignoringRun, { signal: caller.signal });

    // Revocation is not preemption: a result that arrives after the run was
    // revoked must never become a success. For a shell node the side
    // effects are uncertain (the command ran despite revocation), so the
    // conservative classification is outcome_unknown, never succeeded.
    const only = byId(results, "only");
    expect(only?.status).toBe("outcome_unknown");
    expect(only?.ok).toBe(false);
  });

  it("resume after an abort requires reconciliation of outcome_unknown nodes", async () => {
    const graph: Graph = {
      version: 1,
      parallel: true,
      nodes: [
        { id: "fail-fast", kind: "shell", command: "exit 1" },
        { id: "slow", kind: "shell", command: "slow side effects" },
      ],
    };
    const first = makeHarness({
      "fail-fast": { delayMs: 20, fail: "shell node failed: exit 1" },
      slow: { delayMs: 2000 },
    });
    const firstResults = await executeGraph(graph, allowAll, first.run, { maxParallel: 2 });
    expect(byId(firstResults, "slow")?.status).toBe("outcome_unknown");

    // Reconcile: the aborted shell node has uncertain side effects, so an
    // explicit resume refuses to run past it until a human reconciles.
    let executions = 0;
    const countingRun = async (node: GraphNode, ctx: NodeRunContext): Promise<string> => {
      executions += 1;
      return first.run(node, ctx);
    };
    const resumed = await executeGraph(graph, allowAll, countingRun, {
      maxParallel: 2,
      resume: {
        prior: new Map([
          ["fail-fast", { status: "failed" }],
          ["slow", { status: "outcome_unknown" }],
        ]),
      },
    });
    const slow = byId(resumed, "slow");
    expect(slow?.status).toBe("blocked");
    expect(slow?.output).toMatch(/outcome is unknown/);
    expect(slow?.attempts).toBe(0);
    expect(executions).toBe(0);
  });
});
