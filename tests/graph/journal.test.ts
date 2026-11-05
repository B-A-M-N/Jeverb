import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeGraph, hashValue, type Graph } from "../../src/graph/executor.js";
import {
  FileJournal,
  NullJournal,
  digestFullOutput,
  reconcileJournal,
  type JournalEvent,
} from "../../src/graph/journal.js";

const allowAll = { authorize: async () => ({ allowed: true }) };
const denyAll = { authorize: async () => ({ allowed: false, reason: "nope" }) };

function eventsOf(dir: string, runId: string): JournalEvent[] {
  const path = join(dir, `jeverb-graph-${runId}.jsonl`);
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as JournalEvent);
  } catch {
    return [];
  }
}

describe("graph run journal", () => {
  it("does not start a node when cancellation arrives during authorization", async () => {
    const controller = new AbortController();
    let authorizeStarted!: () => void;
    let finishAuthorization!: () => void;
    const started = new Promise<void>((resolve) => { authorizeStarted = resolve; });
    const pendingAuthorization = new Promise<void>((resolve) => { finishAuthorization = resolve; });
    let runCalls = 0;
    const run = executeGraph(
      { version: 1, nodes: [{ id: "a", kind: "shell", command: "echo must-not-run" }] },
      { authorize: async () => { authorizeStarted(); await pendingAuthorization; return { allowed: true }; } },
      async () => { runCalls += 1; return "unexpected"; },
      { signal: controller.signal, journal: new NullJournal() },
    );
    await started;
    controller.abort();
    finishAuthorization();
    const results = await run;
    expect(runCalls).toBe(0);
    expect(results[0]).toMatchObject({ status: "cancelled", attempts: 0, ok: false });
  });

  it("does not report late Jev completion as success or persist its output artifact", async () => {
    const controller = new AbortController();
    let evaluationStarted!: () => void;
    let resolveEvaluation!: (value: string) => void;
    const started = new Promise<void>((resolve) => { evaluationStarted = resolve; });
    const pendingEvaluation = new Promise<string>((resolve) => { resolveEvaluation = resolve; });
    const write = vi.fn(() => ({ artifactId: "artifact" }));
    const execution = executeGraph(
      { version: 1, nodes: [{ id: "judge", kind: "jev", question: "Q", captureOutput: true }] },
      allowAll,
      async () => { evaluationStarted(); return pendingEvaluation; },
      { signal: controller.signal, journal: new NullJournal(), outputArtifactsAllowed: true, outputArtifacts: { write } as never },
    );
    await started;
    controller.abort();
    resolveEvaluation("late model answer");
    const results = await execution;
    expect(results[0]).toMatchObject({ status: "cancelled", attempts: 1, ok: false });
    expect(results[0]?.output).toContain("cancelled");
    expect(results[0]?.outputArtifact).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it("records run-started, authorized, running, and terminal for every node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-journal-"));
    const journal = new FileJournal("run-1", dir);
    const graph: Graph = {
      version: 1,
      nodes: [
        { id: "a", kind: "shell", command: "echo hi" },
        { id: "b", kind: "shell", command: "echo bye", dependsOn: ["a"] },
      ],
    };
    const results = await executeGraph(graph, allowAll, async () => "ok", {
      journal,
      runId: "run-1",
      graphHash: "g",
      source: "test",
    });
    expect(results).toHaveLength(2);
    const events = eventsOf(dir, "run-1");
    expect(events[0]?.type).toBe("run-started");
    for (const id of ["a", "b"]) {
      const mine = events.filter((e) => e.nodeId === id).map((e) => e.type);
      expect(mine).toEqual(["node-authorized", "node-running", "node-terminal"]);
    }
    // Denied attempts record authorized:false and a blocked terminal.
    const journal2 = new FileJournal("run-2", dir);
    await executeGraph({ version: 1, nodes: [{ id: "x", kind: "shell", command: "rm -rf /" }] }, denyAll, async () => {
      throw new Error("must not run");
    }, { journal: journal2, runId: "run-2" });
    const denied = eventsOf(dir, "run-2");
    expect(denied.map((e) => e.type)).toEqual(["run-started", "node-authorized", "node-terminal"]);
    expect(denied[1]?.allowed).toBe(false);
  });

  it("digests the full output while the excerpt stays truncated", async () => {
    const full = `x`.repeat(9000);
    const [result] = await executeGraph(
      { version: 1, nodes: [{ id: "a", kind: "shell", command: "echo big" }] },
      allowAll,
      async () => full,
      { journal: new NullJournal() },
    );
    expect(result?.output).toHaveLength(4000);
    expect(result?.outputHash).toBe(hashValue(result?.output ?? ""));
    expect(result?.outputDigest).toBe(digestFullOutput(full));
    expect(result?.outputDigest).not.toBe(result?.outputHash);
  });

  it("a throwing run still persists a terminal record (crash-after-spawn shape)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-journal-"));
    const journal = new FileJournal("run-3", dir);
    const results = await executeGraph(
      { version: 1, nodes: [{ id: "a", kind: "shell", command: "boom" }] },
      allowAll,
      async () => {
        throw new Error("spawn died");
      },
      { journal, runId: "run-3" },
    );
    expect(results[0]?.status).toBe("failed");
    const rec = reconcileJournal(join(dir, "jeverb-graph-run-3.jsonl"));
    expect(rec.runStarted).toBe(true);
    expect(rec.unknowns).toEqual([]);
    expect(rec.nodes).toHaveLength(1);
    expect(rec.nodes[0]?.status).toBe("failed");
  });

  it("classifies running-without-terminal as outcome_unknown, never success", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-journal-"));
    const journal = new FileJournal("run-4", dir);
    journal.record({ type: "run-started", runId: "run-4", ts: new Date().toISOString() });
    journal.record({
      type: "node-authorized",
      runId: "run-4",
      ts: new Date().toISOString(),
      nodeId: "a",
      attemptId: "a/1",
      allowed: true,
      inputHash: "h",
    });
    journal.record({
      type: "node-running",
      runId: "run-4",
      ts: new Date().toISOString(),
      nodeId: "a",
      attemptId: "a/1",
      inputHash: "h",
    });
    // Crash here: no terminal event.
    const rec = reconcileJournal(join(dir, "jeverb-graph-run-4.jsonl"));
    expect(rec.runStarted).toBe(true);
    expect(rec.unknowns).toEqual(["a"]);
    expect(rec.nodes[0]?.status).toBe("outcome_unknown");
  });

  it.each(["failed", "succeeded"]) (
    "does not let a prior %s terminal hide a later interrupted attempt",
    (priorStatus) => {
      const dir = mkdtempSync(join(tmpdir(), "jeverb-journal-retry-"));
      const journal = new FileJournal("run-retry", dir);
      journal.record({ type: "run-started", runId: "run-retry", ts: "" });
      journal.record({ type: "node-running", runId: "run-retry", ts: "", nodeId: "a", attemptId: "a/1" });
      journal.record({ type: "node-terminal", runId: "run-retry", ts: "", nodeId: "a", status: priorStatus });
      journal.record({ type: "node-running", runId: "run-retry", ts: "", nodeId: "a", attemptId: "a/2" });

      const rec = reconcileJournal(journal.path);
      expect(rec.unknowns).toEqual(["a"]);
      expect(rec.nodes[0]).toMatchObject({ status: "outcome_unknown", attemptIds: ["a/2"] });
      expect(rec.nodes[0]?.outputDigest).toBeUndefined();
    },
  );

  it("closes pending attempts only when a later terminal record lands", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-journal-settled-"));
    const journal = new FileJournal("run-settled", dir);
    journal.record({ type: "run-started", runId: "run-settled", ts: "" });
    journal.record({ type: "node-running", runId: "run-settled", ts: "", nodeId: "a", attemptId: "a/1" });
    journal.record({ type: "node-terminal", runId: "run-settled", ts: "", nodeId: "a", status: "failed" });
    journal.record({ type: "node-running", runId: "run-settled", ts: "", nodeId: "a", attemptId: "a/2" });
    journal.record({
      type: "node-terminal",
      runId: "run-settled",
      ts: "",
      nodeId: "a",
      status: "succeeded",
      outputDigest: "digest-2",
      inputHash: "input-2",
    });

    const rec = reconcileJournal(journal.path);
    expect(rec.unknowns).toEqual([]);
    expect(rec.nodes[0]).toMatchObject({
      status: "succeeded",
      attemptIds: ["a/1", "a/2"],
      outputDigest: "digest-2",
      inputHash: "input-2",
    });
  });

  it("does not clear an unknown attempt when resume records that retry was blocked", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-journal-blocked-resume-"));
    const journal = new FileJournal("run-blocked-resume", dir);
    journal.record({ type: "run-started", runId: "run-blocked-resume", ts: "" });
    journal.record({ type: "node-running", runId: "run-blocked-resume", ts: "", nodeId: "a", attemptId: "a/1" });
    // Resume refuses to run a second time until the original side effect has
    // been inspected. This terminal records that refusal, not reconciliation.
    journal.record({ type: "node-terminal", runId: "run-blocked-resume", ts: "", nodeId: "a", status: "blocked" });

    const rec = reconcileJournal(journal.path);
    expect(rec.unknowns).toEqual(["a"]);
    expect(rec.nodes[0]).toMatchObject({ status: "outcome_unknown", attemptIds: ["a/1"] });
  });

  it("treats a malformed running record as uncertain rather than ignoring possible effects", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-journal-malformed-run-"));
    const journal = new FileJournal("run-malformed", dir);
    journal.record({ type: "run-started", runId: "run-malformed", ts: "" });
    writeFileSync(journal.path, `${JSON.stringify({ type: "node-running", nodeId: "a" })}\n`, { flag: "a" });
    const rec = reconcileJournal(journal.path);
    expect(rec.malformed).toBe(1);
    expect(rec.unknowns).toEqual(["a"]);
    expect(rec.nodes[0]?.status).toBe("outcome_unknown");
  });

  it("survives a torn tail write and counts it malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-journal-"));
    const path = join(dir, "jeverb-graph-run-5.jsonl");
    const journal = new FileJournal("run-5", dir);
    journal.record({ type: "run-started", runId: "run-5", ts: new Date().toISOString() });
    writeFileSync(path, '{"type": "node-running", "nodeId": "a",\n', { flag: "a" });
    const rec = reconcileJournal(path);
    expect(rec.runStarted).toBe(true);
    expect(rec.malformed).toBe(1);
    expect(rec.unknowns).toEqual([]);
  });

  it("missing journal reconciles to nothing, not to success", () => {
    const rec = reconcileJournal(join(mkdtempSync(join(tmpdir(), "jeverb-journal-")), "absent.jsonl"));
    expect(rec.runStarted).toBe(false);
    expect(rec.nodes).toEqual([]);
    expect(rec.unknowns).toEqual([]);
  });
});
