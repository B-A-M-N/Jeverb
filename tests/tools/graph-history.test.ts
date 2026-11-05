import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { graphHash, type Graph } from "../../src/graph/executor.js";
import { FileJournal, digestFullOutput } from "../../src/graph/journal.js";
import { loadSessionGraphForResume } from "../../src/graph/history.js";
import { defaultExecutionPolicy } from "../../src/graph/policy.js";
import { saveGraphDefinition } from "../../src/graph/store.js";
import * as executeGraphTool from "../../src/tools/execute-graph.js";
import * as historyTool from "../../src/tools/graph-history.js";
import * as resumeTool from "../../src/tools/resume-graph.js";

const dirs: string[] = [];
function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "jeverb-graph-history-"));
  dirs.push(path);
  return path;
}
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function saveRun(dataDir: string, sessionId: string, runId: string, graph: Graph) {
  const journals = join(dataDir, "graph-journals");
  mkdirSync(journals, { recursive: true, mode: 0o700 });
  saveGraphDefinition(dataDir, runId, graph);
  const journal = new FileJournal(runId, journals, sessionId);
  journal.record({
    type: "run-started",
    runId,
    ts: "2026-10-30T00:00:00.000Z",
    graphHash: graphHash(graph),
    policyHash: "a".repeat(64),
  });
  journal.record({
    type: "node-terminal",
    runId,
    nodeId: "done",
    status: "succeeded",
    ts: "2026-10-30T00:00:01.000Z",
    inputHash: "b".repeat(64),
    outputDigest: digestFullOutput("result"),
  });
}

describe("session-scoped graph history and resume", () => {
  it("lists status summaries without exposing command or output text", () => {
    const dataDir = tempDir();
    const graph: Graph = { version: 1, nodes: [{ id: "done", kind: "shell", command: "printf private-output" }] };
    saveRun(dataDir, "session-a", "run-a", graph);
    saveRun(dataDir, "session-b", "run-b", graph);

    const result = historyTool.run({}, { dataDir, museSessionId: "session-a" } as never);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      runId: "run-a",
      definitionAvailable: true,
      nodes: { succeeded: 1 },
      uncertainAttempts: 0,
    });
    expect(result.unavailable).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private-output");
  });

  it("loads only a session-matched graph whose durable hash agrees", () => {
    const dataDir = tempDir();
    const graph: Graph = { version: 1, nodes: [{ id: "done", kind: "shell", command: "printf done" }] };
    saveRun(dataDir, "session-a", "run-a", graph);
    expect(loadSessionGraphForResume(dataDir, "session-a", "run-a")).toEqual(graph);
    expect(() => loadSessionGraphForResume(dataDir, "session-b", "run-a")).toThrow(/does not belong/);
    expect(() => loadSessionGraphForResume(dataDir, "session-a", "../run-a")).toThrow(/invalid graph run identifier/);
  });

  it("refuses resume when the host session identity is absent", async () => {
    await expect(resumeTool.run(null, { runId: "run-a", source: "test" }, {
      model: "test",
      thresholds: { auto: 0.9, review: 0.6 },
      maxConcurrency: 1,
      dataDir: tempDir(),
    })).rejects.toThrow(/host-injected Muse session id/);
  });

  it("resumes from saved session history without resending the graph or rerunning success", async () => {
    const dataDir = tempDir();
    vi.stubEnv("MUSE_SESSION_ID", "resume-session");
    try {
      const config = {
        model: "test",
        thresholds: { auto: 0.9, review: 0.6 },
        maxConcurrency: 1,
        dataDir,
        museSessionId: "resume-session",
        execution: defaultExecutionPolicy(process.cwd(), { allowShell: true }),
      };
      const first = await executeGraphTool.run(null, {
        source: "test",
        graph: { version: 1, nodes: [{ id: "done", kind: "shell", command: "printf ran-once" }] },
      }, config);
      const resumed = await resumeTool.run(null, { runId: first.runId, source: "test:resume" }, config);

      expect(resumed.runId).toBe(first.runId);
      expect(resumed.results[0]).toMatchObject({ status: "succeeded", resumed: true, attempts: 0, outputAvailable: false });
      expect(resumed.results[0]?.output).not.toContain("ran-once");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
