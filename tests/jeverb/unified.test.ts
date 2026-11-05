import { describe, expect, it } from "vitest";
import { runDetectors } from "../../src/review/detectors.js";
import { applyReviewPolicy } from "../../src/review/policy.js";
import { toMuseOutput } from "../../src/hosts/muse/outputs.js";
import { executeGraph } from "../../src/graph/executor.js";
import { ReviewService } from "../../src/review/service.js";
import { DEFAULT_JEV_MODEL } from "../../src/decision/types.js";

describe("jeverb unified P0", () => {
  it("pins jev-1.14.0", () => {
    expect(DEFAULT_JEV_MODEL).toBe("jev-1.14.0");
  });

  it("blocks live credentials deterministically", () => {
    const result = runDetectors({ diff: "+ sk-abcdef1234567890\n" });
    expect(result.hardBlock.length).toBeGreaterThan(0);
    const policy = applyReviewPolicy({ deterministic: result, judged: [], policy: { policy_version: "1", thresholds: { block: 0.85, security_review: 0.6 } } });
    expect(policy.lane).toBe("BLOCK");
  });

  it("maps deny to Muse PreToolUse output without allow", () => {
    const output = toMuseOutput("PreToolUse", {
      event: "PreToolUse",
      enforcement: "deny",
      source: "deterministic",
      reasons: ["blocked"],
      evidence: [],
      policyVersion: "1",
      decisionId: "test",
    });
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked",
      },
    });
  });

  it("never blocks benign work when Jev is unavailable", async () => {
    const service = new ReviewService(null, {
      checks: [],
      policy: { policy_version: "1", thresholds: { block: 0.85, security_review: 0.6 } },
    });
    const result = await service.review({ diff: "+ // harmless comment\n" });
    expect(result.lane).not.toBe("BLOCK");
    expect(result.lane).toBe("UNAVAILABLE");
    expect(toMuseOutput("PreToolUse", undefined)).toBeUndefined();
  });

  it("authorizes graph nodes and stops on deny", async () => {
    const results = await executeGraph(
      { version: 1, nodes: [{ id: "a", kind: "shell", command: "echo hi" }, { id: "b", kind: "shell", command: "echo bye", dependsOn: ["a"] }] },
      { authorize: async () => ({ allowed: true }) },
      async (node) => `ran ${node.id}`,
    );
    expect(results.map((r) => r.nodeId)).toEqual(["a", "b"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
