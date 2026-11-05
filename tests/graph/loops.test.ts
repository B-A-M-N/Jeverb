import { describe, expect, it } from "vitest";
import { executeGraph, expandGraphLoops, graphHash, validateGraph, type Graph } from "../../src/graph/executor.js";
import { NullJournal } from "../../src/graph/journal.js";

describe("structural graph loops", () => {
  it("expands body nodes with stable iteration ids and final-iteration downstream refs", async () => {
    const graph: Graph = {
      version: 1,
      loops: [{ id: "repair", nodes: ["inspect", "fix"], iterations: 2 }],
      nodes: [
        { id: "inspect", kind: "shell", command: "inspect", dependsOn: [], idempotent: true },
        { id: "fix", kind: "shell", command: "fix", dependsOn: ["inspect"], idempotent: true },
        { id: "final", kind: "jev", question: "Is it ready?", dependsOn: ["fix"] },
      ],
    };
    const expanded = expandGraphLoops(graph);
    expect(expanded.nodes.map((node) => node.id)).toEqual([
      "repair/1/inspect", "repair/2/inspect", "repair/1/fix", "repair/2/fix", "final",
    ]);
    expect(expanded.nodes.find((node) => node.id === "repair/2/fix")?.dependsOn).toEqual([
      "repair/2/inspect", "repair/1/inspect", "repair/1/fix",
    ]);
    expect(expanded.nodes.find((node) => node.id === "final")?.dependsOn).toEqual(["repair/2/fix"]);
    expect(validateGraph(graph)).toEqual([]);
    expect(graphHash(graph)).not.toBe(graphHash({ ...graph, loops: [{ id: "repair", nodes: ["inspect", "fix"], iterations: 1 }] }));

    const invoked: string[] = [];
    const results = await executeGraph(graph, { authorize: async () => ({ allowed: true }) }, async (node, context) => {
      invoked.push(node.id);
      if (node.id === "final") expect(context.results.get("repair/2/fix")?.output).toBe("repair/2/fix:output");
      return `${node.id}:output`;
    }, { journal: new NullJournal(), maxParallel: 1, allowShellRetry: true });
    expect(invoked).toEqual([
      "repair/1/inspect", "repair/1/fix", "repair/2/inspect", "repair/2/fix", "final",
    ]);
    expect(results.every((result) => result.status === "succeeded")).toBe(true);
  });

  it("rejects overlapping bodies and loops over callbacks", () => {
    const overlapping: Graph = {
      version: 1,
      loops: [{ id: "a", nodes: ["x"], iterations: 2 }, { id: "b", nodes: ["x"], iterations: 2 }],
      nodes: [{ id: "x", kind: "jev", question: "Q" }],
    };
    expect(validateGraph(overlapping).join(" ")).toContain("belongs to more than one loop");

    const callback: Graph = {
      version: 1,
      loops: [{ id: "a", nodes: ["x"], iterations: 2 }],
      nodes: [{ id: "x", kind: "jev", question: "Q", when: () => true }],
    };
    expect(validateGraph(callback).join(" ")).toContain("non-serializable when callback");
  });

  it("rejects iteration bounds outside the hard cap", () => {
    const graph: Graph = {
      version: 1,
      loops: [{ id: "a", nodes: ["x"], iterations: 4 }],
      nodes: [{ id: "x", kind: "jev", question: "Q" }],
    };
    expect(validateGraph(graph).join(" ")).toContain("between 1 and 3");
  });

  it("keeps looped shell work behind the operator retry switch", async () => {
    const graph: Graph = {
      version: 1,
      loops: [{ id: "repeat", nodes: ["safe"], iterations: 2 }],
      nodes: [{ id: "safe", kind: "shell", command: "safe", idempotent: true }],
    };
    const invoked: string[] = [];
    const results = await executeGraph(graph, { authorize: async () => ({ allowed: true }) }, async (node) => {
      invoked.push(node.id);
      return "ran";
    }, { journal: new NullJournal() });
    expect(invoked).toEqual([]);
    expect(results.map((result) => result.status)).toEqual(["blocked", "blocked"]);
  });
});
