import { describe, expect, it } from "vitest";
import { executeGraph, validateGraph, type Graph, type GraphNode } from "../../src/graph/executor.js";
import type { ReviewResult } from "../../src/review/policy.js";

const cleanReview: ReviewResult = {
  lane: "MERGE",
  source: "deterministic",
  findings: [],
  policyVersion: "review-v1",
  calibration: {
    provider: "typesafe",
    model: "jev-1.14.0",
    modelVersion: "jev-1.14.0",
    questionHash: "qhash",
    calibrationVersion: "cal-v1",
    calibrated: true,
    advisory: false,
  },
};

function graph(review: ReviewResult, downstream: boolean): Graph {
  return {
    version: 1,
    nodes: [
      { id: "diff", kind: "shell", command: "git diff" },
      { id: "review", kind: "review", diffFrom: "diff", dependsOn: ["diff"] },
      ...(downstream
        ? [
            {
              id: "act",
              kind: "shell" as const,
              command: "apply-reviewed-change",
              dependsOn: ["review"],
              condition: { node: "review", field: "review.lane" as const, equals: "MERGE" as const },
            },
          ]
        : []),
    ],
  };
}

describe("Jive review composition", () => {
  it("validates a diff -> typed review -> MERGE-gated shell workflow", () => {
    expect(validateGraph(graph(cleanReview, true))).toEqual([]);
  });

  it("passes complete dependency output to review and skips shell when lane is BLOCK", async () => {
    const blockedReview: ReviewResult = {
      ...cleanReview,
      lane: "BLOCK",
      findings: [{ id: "security:unsafe", severity: "hard", message: "unsafe change" }],
    };
    const workflow = graph(blockedReview, true);
    const completeDiff = `diff --git a/app.ts b/app.ts\n${"+x\n".repeat(2500)}`;
    let reviewedDiff = "";
    const executed: string[] = [];

    const results = await executeGraph(
      workflow,
      { authorize: async () => ({ allowed: true }) },
      async (node: GraphNode, ctx) => {
        if (node.id === "diff") return completeDiff;
        if (node.id === "review") {
          reviewedDiff = ctx.fullOutputs.get("diff") ?? "";
          return { output: "reviewed BLOCK", review: blockedReview };
        }
        executed.push(node.id);
        return "should not run";
      },
    );

    expect(reviewedDiff).toBe(completeDiff);
    expect(results.find((result) => result.nodeId === "review")?.review?.lane).toBe("BLOCK");
    expect(results.find((result) => result.nodeId === "act")?.status).toBe("skipped");
    expect(executed).toEqual([]);
  });

  it("rejects a shell dependency on review unless it explicitly requires MERGE", () => {
    const unsafe: Graph = {
      version: 1,
      nodes: [
        { id: "diff", kind: "shell", command: "git diff" },
        { id: "review", kind: "review", diffFrom: "diff", dependsOn: ["diff"] },
        { id: "act", kind: "shell", command: "deploy", dependsOn: ["review"] },
      ],
    };
    expect(validateGraph(unsafe).join("\n")).toContain("must require condition review.lane=MERGE");
  });

  it("runs the protected shell only after a MERGE review and the authorizer", async () => {
    const workflow = graph(cleanReview, true);
    const authorized: string[] = [];
    const results = await executeGraph(
      workflow,
      { authorize: async (node) => { authorized.push(node.id); return { allowed: true }; } },
      async (node) => node.id === "diff"
        ? "diff --git a/a b/a"
        : node.id === "review"
          ? { output: "reviewed MERGE", review: cleanReview }
          : "executed",
    );
    expect(results.find((result) => result.nodeId === "act")?.status).toBe("succeeded");
    expect(authorized).toContain("act");
  });
});
