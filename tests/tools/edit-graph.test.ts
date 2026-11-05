import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../../src/graph/policy.js";
import { loadGraphDefinition, saveGraphDefinition } from "../../src/graph/store.js";
import * as editGraphTool from "../../src/tools/edit-graph.js";
import type { ToolConfig } from "../../src/tools/shared.js";

const graph = {
  version: 1 as const,
  nodes: [{ id: "step", kind: "shell" as const, command: "printf old", maxAttempts: 1 }],
};

describe("jev_execute_graph_mod", () => {
  it("applies value, substring, and null-delete edits to a copy", () => {
    const edited = editGraphTool.applyGraphEdits(graph, [
      { op: "replace_text", path: "/nodes/0/command", search: "old", replacement: "new" },
      { op: "set", path: "/nodes/0/maxAttempts", value: 3 },
      { op: "set", path: "/nodes/0/maxAttempts", value: null },
    ]);
    expect(edited.nodes[0]?.command).toBe("printf new");
    expect(edited.nodes[0]).not.toHaveProperty("maxAttempts");
    expect(graph.nodes[0]?.command).toBe("printf old");
  });

  it("rejects malformed, prototype, and non-string substring paths", () => {
    expect(() => editGraphTool.applyGraphEdits(graph, [
      { op: "set", path: "/nodes/0/command/~2", value: "x" },
    ])).toThrow(/invalid JSON Pointer escape/);
    expect(() => editGraphTool.applyGraphEdits(graph, [
      { op: "set", path: "/nodes/0/__proto__/polluted", value: true },
    ])).toThrow(/unsafe JSON Pointer/);
    expect(() => editGraphTool.applyGraphEdits(graph, [
      { op: "replace_text", path: "/nodes/0/maxAttempts", search: "1", replacement: "2" },
    ])).toThrow(/not a string/);
  });

  it("loads a saved graph, executes edits as a new run, and retains the source definition", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jeverb-graph-edit-"));
    const sourceRunId = "source-run";
    saveGraphDefinition(dataDir, sourceRunId, graph);
    const config: ToolConfig = {
      model: "test",
      thresholds: { auto: 0.9, review: 0.6 },
      maxConcurrency: 2,
      dataDir,
      execution: defaultExecutionPolicy(process.cwd(), { allowShell: true }),
    };
    const result = await editGraphTool.run(null, {
      sourceRunId,
      source: "test",
      edits: [{ op: "replace_text", path: "/nodes/0/command", search: "old", replacement: "new" }],
    }, config);
    expect(result.basedOnRunId).toBe(sourceRunId);
    expect(result.runId).not.toBe(sourceRunId);
    expect(result.results[0]?.output).toBe("new");
    expect(loadGraphDefinition(dataDir, sourceRunId).nodes[0]?.command).toBe("printf old");
    expect(loadGraphDefinition(dataDir, result.runId).nodes[0]?.command).toBe("printf new");
  });

  it("reapplies deterministic shell authorization after graph edits", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jeverb-graph-edit-auth-"));
    const sourceRunId = "source-run";
    saveGraphDefinition(dataDir, sourceRunId, graph);
    const result = await editGraphTool.run(null, {
      sourceRunId,
      source: "test",
      edits: [{ op: "set", path: "/nodes/0/command", value: "sudo printf should-not-run" }],
    }, {
      model: "test",
      thresholds: { auto: 0.9, review: 0.6 },
      maxConcurrency: 2,
      dataDir,
      execution: defaultExecutionPolicy(process.cwd(), { allowShell: true }),
    });

    expect(result.results[0]).toMatchObject({ status: "blocked", attempts: 0 });
    expect(result.results[0]?.output).toMatch(/privilege escalation is never permitted/);
  });

  it("rejects a graph source that was never persisted by a run", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jeverb-graph-edit-"));
    await expect(editGraphTool.run(null, {
      sourceRunId: "unknown",
      source: "test",
      edits: [{ op: "set", path: "/nodes/0/command", value: "echo changed" }],
    }, {
      model: "test",
      thresholds: { auto: 0.9, review: 0.6 },
      maxConcurrency: 2,
      dataDir,
    })).rejects.toThrow(/not found/);
  });
});
