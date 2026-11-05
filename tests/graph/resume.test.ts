import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDepEvidence, executeGraph, graphHash, type Graph } from "../../src/graph/executor.js";
import { FileJournal, reconcileJournal } from "../../src/graph/journal.js";

const allowAll = { authorize: async () => ({ allowed: true }) };

/** Build a resume prior map from reconciliation, omitting absent hashes (exactOptionalPropertyTypes). */
function priorOf(nodes: { nodeId: string; status: string; inputHash?: string; outputDigest?: string; outputArtifact?: string; jev?: import("../../src/graph/executor.js").JevDecision; effectiveInputHash?: string; revisionHash?: string; branch?: string }[]) {
  return new Map(
    nodes.map((n) => [
      n.nodeId,
      {
        status: n.status,
        ...(n.inputHash === undefined ? {} : { inputHash: n.inputHash }),
        ...(n.outputDigest === undefined ? {} : { outputDigest: n.outputDigest }),
        ...(n.outputArtifact === undefined ? {} : { outputArtifact: n.outputArtifact }),
        ...(n.jev === undefined ? {} : { jev: n.jev }),
        ...(n.effectiveInputHash === undefined ? {} : { effectiveInputHash: n.effectiveInputHash }),
        ...(n.revisionHash === undefined ? {} : { revisionHash: n.revisionHash }),
        ...(n.branch === undefined ? {} : { branch: n.branch }),
      },
    ] as const),
  );
}

const GRAPH: Graph = {
  version: 1,
  nodes: [
    { id: "a", kind: "shell", command: "echo one" },
    { id: "b", kind: "shell", command: "echo two", dependsOn: ["a"] },
  ],
};

describe("graph fingerprint", () => {
  it("binds resume identity to commands, review lanes, and graph parallelism", () => {
    const base: Graph = {
      version: 1,
      nodes: [
        { id: "diff", kind: "shell", command: "git diff" },
        { id: "review", kind: "review", diffFrom: "diff", dependsOn: ["diff"] },
        {
          id: "apply",
          kind: "shell",
          command: "apply-patch",
          dependsOn: ["review"],
          condition: { node: "review", field: "review.lane", equals: "MERGE" },
        },
      ],
    };
    expect(graphHash(base)).not.toBe(graphHash({
      ...base,
      nodes: base.nodes.map((node) => node.id === "diff" ? { ...node, command: "git diff --cached" } : node),
    }));
    expect(graphHash(base)).not.toBe(graphHash({
      ...base,
      nodes: base.nodes.map((node) => node.id === "apply" ? {
        ...node,
        condition: { node: "review", field: "review.lane", equals: "NITS" },
      } : node),
    }));
    expect(graphHash(base)).not.toBe(graphHash({ ...base, parallel: true }));
  });

  it("refuses a function condition that cannot be durably fingerprinted", () => {
    expect(() => graphHash({ version: 1, nodes: [{ id: "x", kind: "jev", when: () => true }] })).toThrow(/non-serializable/);
  });

  it("binds the graph identity to every typed Jev question and rubric", () => {
    const base: Graph = {
      version: 1,
      nodes: [{
        id: "classify",
        kind: "jev",
        questions: { route: { type: "choice", instructions: "Choose a route", criteria: { local: null, remote: null } } },
      }],
    };
    const changedInstructions: Graph = {
      ...base,
      nodes: [{ ...base.nodes[0]!, questions: { route: { type: "choice", instructions: "Choose a safe route", criteria: { local: null, remote: null } } } }],
    };
    const changedRubric: Graph = {
      ...base,
      nodes: [{ ...base.nodes[0]!, questions: { route: { type: "choice", instructions: "Choose a route", criteria: { local: "offline", remote: null } } } }],
    };
    expect(graphHash(base)).not.toBe(graphHash(changedInstructions));
    expect(graphHash(base)).not.toBe(graphHash(changedRubric));
  });

  it("binds graph identity to extractor behavior", () => {
    const base: Graph = {
      version: 1,
      nodes: [
        { id: "data", kind: "shell", command: "printf '{}'" },
        { id: "judge", kind: "jev", question: "Inspect the data", dependsOn: ["data"], extractors: [{ from: "data", as: "payload", extractor: "json" }] },
      ],
    };
    const changed: Graph = {
      ...base,
      nodes: base.nodes.map((node) => node.id === "judge" ? {
        ...node,
        extractors: [{ from: "data", as: "payload", extractor: "lines" as const }],
      } : node),
    };
    expect(graphHash(base)).not.toBe(graphHash(changed));
  });

  it("still executes an in-process callback condition when no durable graph resume is requested", async () => {
    const result = await executeGraph(
      { version: 1, nodes: [{ id: "x", kind: "jev", question: "Should run?", when: () => true }] },
      allowAll,
      async () => "ok",
    );
    expect(result[0]?.status).toBe("succeeded");
  });
});

describe("graph resume", () => {
  it("does not retry or resume an uncertain non-shell node outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-resume-unknown-plugin-"));
    const graph: Graph = {
      version: 1,
      nodes: [{ id: "extract", kind: "jev", question: "Did extraction finish?", maxAttempts: 3 }],
    };
    let calls = 0;
    const first = await executeGraph(graph, allowAll, async () => {
      calls += 1;
      throw new Error("outcome_unknown: helper side effect requires reconciliation");
    }, {
      policyHash: "p1", graphHash: "g-unknown", journal: new FileJournal("run-unknown", dir), runId: "run-unknown",
    });
    expect(calls).toBe(1);
    expect(first[0]?.status).toBe("outcome_unknown");

    const rec = reconcileJournal(join(dir, "jeverb-graph-run-unknown.jsonl"));
    let resumedCalls = 0;
    const resumed = await executeGraph(graph, allowAll, async () => {
      resumedCalls += 1;
      return "must not execute";
    }, {
      policyHash: "p1", graphHash: "g-unknown", journal: new FileJournal("run-unknown", dir), runId: "run-unknown",
      resume: {
        prior: priorOf(rec.nodes),
        ...(rec.graphHash === undefined ? {} : { priorGraphHash: rec.graphHash }),
        ...(rec.runId === undefined ? {} : { priorRunId: rec.runId }),
      },
    });
    expect(resumedCalls).toBe(0);
    expect(resumed[0]?.status).toBe("blocked");
  });

  it("reuses prior succeeded outcomes with matching input hashes without re-executing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-resume-"));
    let calls = 0;
    const first = await executeGraph(GRAPH, allowAll, async () => {
      calls += 1;
      return "ok";
    }, { policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1" });
    expect(calls).toBe(2);
    expect(first.every((r) => r.status === "succeeded")).toBe(true);

    const rec = reconcileJournal(join(dir, "jeverb-graph-run-1.jsonl"));
    expect(rec.runStarted).toBe(true);
    expect(rec.unknowns).toEqual([]);

    let secondCalls = 0;
    const second = await executeGraph(GRAPH, allowAll, async () => {
      secondCalls += 1;
      return "ok";
    }, {
      policyHash: "p1",
      graphHash: "g1",
      journal: new FileJournal("run-1", dir),
      runId: "run-1",
      resume: {
        prior: priorOf(rec.nodes),
        ...(rec.graphHash === undefined ? {} : { priorGraphHash: rec.graphHash }),
        ...(rec.runId === undefined ? {} : { priorRunId: rec.runId }),
      },
    });
    expect(secondCalls).toBe(0);
    expect(second.every((r) => r.status === "succeeded" && r.resumed === true)).toBe(true);
    // Input hashes survive the round trip: resume matched on content, not id alone.
    expect(second.map((r) => r.inputHash)).toEqual(first.map((r) => r.inputHash));
  });

  it("re-executes nodes whose input hash changed and refuses a different graph", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-resume-"));
    await executeGraph(GRAPH, allowAll, async () => "ok", {
      policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1",
    });
    const rec = reconcileJournal(join(dir, "jeverb-graph-run-1.jsonl"));
    const prior = priorOf(rec.nodes);

    const edited: Graph = {
      version: 1,
      nodes: [
        { id: "a", kind: "shell", command: "echo one" },
        { id: "b", kind: "shell", command: "echo CHANGED", dependsOn: ["a"], idempotent: true },
      ],
    };
    const ran: string[] = [];
    const results = await executeGraph(edited, allowAll, async (node) => {
      ran.push(node.id);
      return "ok";
    }, {
      policyHash: "p1", graphHash: "g1",
      journal: new FileJournal("run-1", dir), runId: "run-1",
      allowShellRetry: true,
      resume: { prior, ...(rec.graphHash === undefined ? {} : { priorGraphHash: rec.graphHash }) },
    });
    // `a` resumes; edited `b` re-executes through authorization.
    expect(ran).toEqual(["b"]);
    expect(results.find((r) => r.nodeId === "a")?.resumed).toBe(true);
    expect(results.find((r) => r.nodeId === "b")?.resumed).toBeUndefined();

    await expect(
      executeGraph(GRAPH, allowAll, async () => "ok", {
        policyHash: "p1", graphHash: "other",
        resume: { prior, priorGraphHash: "g1" },
      }),
    ).rejects.toThrow(/resume refused/);
  });

  it("re-runs prior failures instead of inheriting them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-resume-"));
    let fail = true;
    const graph: Graph = { version: 1, nodes: [{ id: "a", kind: "shell", command: "echo x", idempotent: true }] };
    await executeGraph(graph, allowAll, async () => {
      if (fail) throw new Error("boom");
      return "ok";
    }, { policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1", allowShellRetry: true });
    const rec = reconcileJournal(join(dir, "jeverb-graph-run-1.jsonl"));
    expect(rec.nodes[0]?.status).toBe("failed");

    fail = false;
    let calls = 0;
    const second = await executeGraph(graph, allowAll, async () => {
      calls += 1;
      return "ok";
    }, {
      policyHash: "p1", graphHash: "g1",
      journal: new FileJournal("run-1", dir), runId: "run-1",
      resume: {
        prior: priorOf(rec.nodes),
        ...(rec.graphHash === undefined ? {} : { priorGraphHash: rec.graphHash }),
      },
      allowShellRetry: true,
    });
    expect(calls).toBe(1);
    expect(second[0]?.status).toBe("succeeded");
    expect(second[0]?.resumed).toBeUndefined();
  });

  it("blocks interrupted shell outcomes without rerunning them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-resume-"));
    const graph: Graph = {
      version: 1,
      nodes: [{ id: "a", kind: "shell", command: "echo side-effect", idempotent: true }],
    };
    const journal = new FileJournal("run-1", dir);
    journal.record({ type: "run-started", runId: "run-1", ts: "", graphHash: "g1", policyHash: "p1" });
    journal.record({ type: "node-running", runId: "run-1", ts: "", nodeId: "a", attemptId: "a:1" });
    journal.record({
      type: "node-terminal",
      runId: "run-1",
      ts: "",
      nodeId: "a",
      status: "failed",
      inputHash: "previous-input",
    });
    // The retry started, but the process died before its next terminal event.
    // This latest uncertainty must override the earlier failure.
    journal.record({ type: "node-running", runId: "run-1", ts: "", nodeId: "a", attemptId: "a:2" });
    const rec = reconcileJournal(journal.path);
    expect(rec.nodes[0]?.status).toBe("outcome_unknown");
    let calls = 0;
    const result = await executeGraph(graph, allowAll, async () => {
      calls += 1;
      return "must not run";
    }, {
      policyHash: "p1", graphHash: "g1", journal, runId: "run-1",
      resume: { prior: priorOf(rec.nodes), priorGraphHash: "g1", priorRunId: "run-1" },
      allowShellRetry: true,
    });
    expect(calls).toBe(0);
    expect(result[0]?.status).toBe("blocked");
  });

  it("tells dependent Jev that resumed shell output is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-resume-"));
    const graph: Graph = {
      version: 1,
      nodes: [
        { id: "a", kind: "shell", command: "echo private" },
        { id: "b", kind: "jev", question: "Assess output", dependsOn: ["a"] },
      ],
    };
    await executeGraph(graph, allowAll, async (node) => node.id === "a" ? "private" : "ok", {
      policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1",
    });
    const rec = reconcileJournal(join(dir, "jeverb-graph-run-1.jsonl"));
    let observed: unknown;
    const result = await executeGraph(graph, allowAll, async (node, ctx) => {
      if (node.id === "b") observed = collectDepEvidence(node, ctx);
      return "ok";
    }, {
      policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1",
      resume: { prior: priorOf(rec.nodes), priorGraphHash: "g1", priorRunId: "run-1" },
    });
    expect(result[0]?.outputAvailable).toBe(false);
    expect(observed).toEqual([{ id: "a", status: "output_unavailable", output: "" }]);
  });
});
