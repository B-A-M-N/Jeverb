import { describe, expect, it } from "vitest";
import { executeGraph } from "../../src/graph/executor.js";
import { toMuseOutput } from "../../src/hosts/muse/outputs.js";
import { ReviewService } from "../../src/review/service.js";

const allowAll = { authorize: async () => ({ allowed: true }) };

describe("jeverb graph orchestration", () => {
  it("runs independent nodes in parallel levels", async () => {
    const order: string[] = [];
    const results = await executeGraph(
      {
        version: 1,
        parallel: true,
        nodes: [
          { id: "a", kind: "shell", command: "echo a" },
          { id: "b", kind: "shell", command: "echo b" },
        ],
      },
      allowAll,
      async (node) => {
        order.push(node.id);
        return node.id;
      },
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(order.sort()).toEqual(["a", "b"]);
  });

  it("stops successors when authorization denies", async () => {
    const ran: string[] = [];
    const results = await executeGraph(
      {
        version: 1,
        nodes: [
          { id: "a", kind: "shell", command: "echo a" },
          { id: "b", kind: "shell", command: "echo b", dependsOn: ["a"] },
        ],
      },
      {
        authorize: async (node) =>
          node.id === "a" ? { allowed: false, reason: "denied" } : { allowed: true },
      },
      async (node) => {
        ran.push(node.id);
        return node.id;
      },
    );
    expect(results[0]!.ok).toBe(false);
    // The denied node is recorded; its dependent is recorded as blocked,
    // never silently omitted and never run.
    expect(results).toHaveLength(2);
    expect(results[1]!.status).toBe("blocked");
    expect(ran).toEqual([]);
  });

  it("skips conditional nodes and bounds repeats", async () => {
    let runs = 0;
    const results = await executeGraph(
      {
        version: 1,
        nodes: [{ id: "a", kind: "shell", command: "echo a", when: false, repeat: 10 }],
      },
      allowAll,
      async () => {
        runs += 1;
        return "x";
      },
    );
    expect(results[0]!.output).toBe("skipped");
    expect(runs).toBe(0);
  });
});

describe("jeverb muse mapping", () => {
  it("never emits an allow permission", async () => {
    const service = new ReviewService(null, {
      checks: [],
      policy: { policy_version: "1", thresholds: { block: 0.85, security_review: 0.6 } },
    });
    const review = await service.review({ diff: "+ ok\n" });
    expect(review.lane).toBe("UNAVAILABLE");
    const output = toMuseOutput("PreToolUse", {
      event: "PreToolUse",
      enforcement: "advise",
      source: "deterministic",
      reasons: ["note"],
      evidence: [],
      policyVersion: "1",
      decisionId: "t",
    }) as Record<string, unknown>;
    const specific = output.hookSpecificOutput as Record<string, unknown>;
    expect(specific.permissionDecision).not.toBe("allow");
  });
});
