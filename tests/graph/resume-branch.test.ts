import { describe, expect, it } from "vitest";
import { executeGraph, type Graph, type JevDecision } from "../../src/graph/executor.js";
import { reconcileJournal } from "../../src/graph/journal.js";
import { questionSetHashFor } from "../../src/jev/qualification.js";
import type { RoutingAdmission } from "../../src/decision/routing.js";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal } from "../../src/graph/journal.js";

const allowAll = { authorize: async () => ({ allowed: true }) };

const QHASH = "a".repeat(64);

/**
 * Verifier-attested routing admission standing in for the qualification
 * boundary's output: these tests exercise resume/branch semantics under an
 * admitted consequential route, never the verifier itself.
 */
const ROUTING: RoutingAdmission = {
  active: {
    backend: "typesafe",
    model: "typesafe-stub",
    modelVersion: "v-test",
    questionFamily: questionSetHashFor([QHASH]),
    policyHash: "p1",
  },
  qualification: {
    verified: true,
    qualificationId: "qual-test-001",
    id: "qual-test-001",
    family: "consequential-routing",
    backend: "typesafe",
    model: "typesafe-stub",
    modelVersion: "v-test",
    questionFamily: questionSetHashFor([QHASH]),
    policyHash: "p1",
    qualified: true,
  },
};

type Prior = Map<string, {
  status: string;
  inputHash?: string;
  outputDigest?: string;
  outputArtifact?: string;
  jev?: JevDecision;
  effectiveInputHash?: string;
  revisionHash?: string;
  branch?: string;
}>;

/** Full-identity prior map from reconciliation (exactOptionalPropertyTypes-safe). */
function priorFrom(path: string): { prior: Prior; graphHash?: string; runId?: string } {
  const rec = reconcileJournal(path);
  const prior: Prior = new Map(rec.nodes.map((n) => [n.nodeId, {
    status: n.status,
    ...(n.inputHash === undefined ? {} : { inputHash: n.inputHash }),
    ...(n.outputDigest === undefined ? {} : { outputDigest: n.outputDigest }),
    ...(n.outputArtifact === undefined ? {} : { outputArtifact: n.outputArtifact }),
    ...(n.jev === undefined ? {} : { jev: n.jev }),
    ...(n.effectiveInputHash === undefined ? {} : { effectiveInputHash: n.effectiveInputHash }),
    ...(n.revisionHash === undefined ? {} : { revisionHash: n.revisionHash }),
    ...(n.branch === undefined ? {} : { branch: n.branch }),
  }]));
  return {
    prior,
    ...(rec.graphHash === undefined ? {} : { graphHash: rec.graphHash }),
    ...(rec.runId === undefined ? {} : { runId: rec.runId }),
  };
}

const verdict = (v: "yes" | "no", noul: number): JevDecision =>
  ({ answers: {}, provider: "typesafe", model: "typesafe-stub", questionHash: QHASH, calibrated: false, verdict: v, noul });

/** Evidence-driven stub: the Jev verdict follows the source output, never the run. */
function evidenceStub(calls: string[], srcId: string) {
  return async (node: { id: string; command?: string }, ctx: { results: ReadonlyMap<string, { output: string }> }): Promise<string | { output: string; jev: JevDecision; ok: boolean }> => {
    calls.push(node.id);
    if (node.id === srcId) return node.command?.includes("v2") === true ? "v2" : "v1";
    const evidence = ctx.results.get(srcId)?.output ?? "";
    const no = evidence.includes("v2");
    return { output: `verdict=${no ? "no" : "yes"} noul=${no ? 0.1 : 0.9}`, jev: verdict(no ? "no" : "yes", no ? 0.1 : 0.9), ok: true };
  };
}

function chainGraph(srcCommand: string): Graph {
  return {
    version: 1,
    nodes: [
      { id: "src", kind: "shell", command: srcCommand, idempotent: true },
      { id: "judge", kind: "jev", question: "Proceed?", dependsOn: ["src"] },
      {
        id: "apply",
        kind: "shell",
        command: "apply-patch",
        dependsOn: ["judge"],
        condition: { node: "judge", field: "decision.verdict", equals: "yes" },
      },
    ],
  };
}

describe("resume must not bypass rejected branches (reported defect)", () => {
  it("a shell gated on verdict=yes is skipped — not resumed — when the current verdict is no", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-resume-branch-"));
    const journalPath = join(dir, "jeverb-graph-run-1.jsonl");
    // Prior run: evidence v1, verdict yes, shell executed and succeeded.
    const run1Calls: string[] = [];
    const first = await executeGraph(chainGraph("echo v1"), allowAll, evidenceStub(run1Calls, "src") as never, {
      policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1",
      routing: ROUTING,
    });
    expect(first.find((r) => r.nodeId === "apply")?.status).toBe("succeeded");
    expect(run1Calls).toContain("apply");

    // New evidence (edited source, operator-authorized retry): verdict flips to no.
    const { prior } = priorFrom(journalPath);
    const run2Calls: string[] = [];
    const second = await executeGraph(chainGraph("echo v2"), allowAll, evidenceStub(run2Calls, "src") as never, {
      policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1",
      allowShellRetry: true, routing: ROUTING,
      resume: { prior, priorGraphHash: "g1", priorRunId: "run-1" },
    });
    expect(second.find((r) => r.nodeId === "src")?.status).toBe("succeeded");
    expect(second.find((r) => r.nodeId === "judge")?.status).toBe("succeeded");
    expect(second.find((r) => r.nodeId === "judge")?.resumed).toBeUndefined(); // fresh evaluation
    const apply = second.find((r) => r.nodeId === "apply")!;
    expect(apply.status).toBe("skipped");
    expect(apply.resumed).toBeUndefined();
    expect(run2Calls).not.toContain("apply");
  });

  it("identical historical decisions replay deterministically without re-invoking the backend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-resume-replay-"));
    const journalPath = join(dir, "jeverb-graph-run-1.jsonl");
    const graph = chainGraph("echo v1");
    const run1Calls: string[] = [];
    const first = await executeGraph(graph, allowAll, evidenceStub(run1Calls, "src") as never, {
      policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1",
      routing: ROUTING,
    });
    expect(first.every((r) => r.status === "succeeded")).toBe(true);

    const { prior } = priorFrom(journalPath);
    const run2Calls: string[] = [];
    const second = await executeGraph(graph, allowAll, evidenceStub(run2Calls, "src") as never, {
      policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1",
      routing: ROUTING,
      resume: { prior, priorGraphHash: "g1", priorRunId: "run-1" },
    });
    // Nothing re-executed or re-invoked: shell resumed, Jev replayed verbatim.
    expect(run2Calls).toEqual([]);
    const judge = second.find((r) => r.nodeId === "judge")!;
    expect(judge.status).toBe("succeeded");
    expect(judge.resumed).toBe(true);
    expect(judge.jev?.verdict).toBe("yes");
    expect(judge.jev?.provider).toBe("typesafe");
    const apply = second.find((r) => r.nodeId === "apply")!;
    expect(apply.status).toBe("succeeded");
    expect(apply.resumed).toBe(true);
    // The journaled branch is stable across the replay.
    const rec = reconcileJournal(journalPath);
    expect(rec.nodes.find((n) => n.nodeId === "apply")?.branch).toBe(
      prior.get("apply")?.branch,
    );
    expect(prior.get("apply")?.branch).toMatch(/decision\.verdict/);
  });

  it("changed effective inputs block shell reuse without idempotent+retry and force fresh Jev evaluation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-resume-effective-"));
    const journalPath = join(dir, "jeverb-graph-run-1.jsonl");
    const graph: Graph = {
      version: 1,
      nodes: [
        { id: "src", kind: "shell", command: "echo v1", idempotent: true },
        { id: "mid", kind: "shell", command: "consume", dependsOn: ["src"] },
        { id: "judge", kind: "jev", question: "Proceed?", dependsOn: ["src"] },
      ],
    };
    const run1Calls: string[] = [];
    await executeGraph(graph, allowAll, evidenceStub(run1Calls, "src") as never, {
      policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1",
    });

    const edited: Graph = {
      version: 1,
      nodes: [
        { id: "src", kind: "shell", command: "echo v2", idempotent: true },
        { id: "mid", kind: "shell", command: "consume", dependsOn: ["src"] },
        { id: "judge", kind: "jev", question: "Proceed?", dependsOn: ["src"] },
      ],
    };
    const { prior } = priorFrom(journalPath);
    const run2Calls: string[] = [];
    const second = await executeGraph(edited, allowAll, evidenceStub(run2Calls, "src") as never, {
      policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1",
      allowShellRetry: true,
      resume: { prior, priorGraphHash: "g1", priorRunId: "run-1" },
    });
    // src re-executed under the idempotent+retry conjunction; mid must not
    // reuse or rerun on changed evidence; judge evaluates fresh (new revision).
    expect(run2Calls).toContain("src");
    expect(run2Calls).not.toContain("mid");
    const mid = second.find((r) => r.nodeId === "mid")!;
    expect(mid.status).toBe("blocked");
    expect(mid.resumed).toBeUndefined();
    expect(mid.output).toMatch(/effective dependency inputs changed/);
    expect(run2Calls).toContain("judge");
    expect(second.find((r) => r.nodeId === "judge")?.resumed).toBeUndefined();
    expect(second.find((r) => r.nodeId === "judge")?.jev?.verdict).toBe("no");
  });

  it("a policy change invalidates reuse: shells block, Jev evaluates fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-resume-policy-"));
    const journalPath = join(dir, "jeverb-graph-run-1.jsonl");
    const graph: Graph = {
      version: 1,
      nodes: [
        { id: "s1", kind: "shell", command: "echo hi" },
        { id: "j1", kind: "jev", question: "Ok?" },
      ],
    };
    const run1Calls: string[] = [];
    await executeGraph(graph, allowAll, async (node) => {
      run1Calls.push(node.id);
      return node.id === "j1" ? { output: "verdict=yes noul=0.9", jev: verdict("yes", 0.9), ok: true } : "hi";
    }, { policyHash: "p1", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1" });

    const { prior } = priorFrom(journalPath);
    const run2Calls: string[] = [];
    const second = await executeGraph(graph, allowAll, async (node) => {
      run2Calls.push(node.id);
      return node.id === "j1" ? { output: "verdict=yes noul=0.9", jev: verdict("yes", 0.9), ok: true } : "MUST NOT RUN";
    }, {
      policyHash: "p2", graphHash: "g1", journal: new FileJournal("run-1", dir), runId: "run-1",
      resume: { prior, priorGraphHash: "g1", priorRunId: "run-1" },
    });
    const s1 = second.find((r) => r.nodeId === "s1")!;
    expect(s1.resumed).toBeUndefined();
    expect(s1.status).toBe("blocked");
    expect(run2Calls).not.toContain("s1");
    // Jev carries no side effects: it evaluates fresh under the new policy.
    expect(run2Calls).toContain("j1");
    expect(second.find((r) => r.nodeId === "j1")?.resumed).toBeUndefined();
    expect(second.find((r) => r.nodeId === "j1")?.status).toBe("succeeded");
  });

  it("stale revisions cannot inherit: shells block, Jev evaluates fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-resume-stale-"));
    const journalPath = join(dir, "jeverb-graph-run-1.jsonl");
    const graph: Graph = {
      version: 1,
      nodes: [
        { id: "s1", kind: "shell", command: "echo hi" },
        { id: "j1", kind: "jev", question: "Ok?" },
      ],
    };
    await executeGraph(graph, allowAll, async (node) =>
      node.id === "j1" ? { output: "verdict=yes noul=0.9", jev: verdict("yes", 0.9), ok: true } : "hi",
      { policyHash: "p1", graphHash: "rev1", journal: new FileJournal("run-1", dir), runId: "run-1" });

    const { prior } = priorFrom(journalPath);
    expect(prior.get("s1")?.revisionHash).toBe("rev1");
    const run2Calls: string[] = [];
    const second = await executeGraph(graph, allowAll, async (node) => {
      run2Calls.push(node.id);
      return node.id === "j1" ? { output: "verdict=yes noul=0.9", jev: verdict("yes", 0.9), ok: true } : "MUST NOT RUN";
    }, {
      policyHash: "p1", graphHash: "rev2", journal: new FileJournal("run-1", dir), runId: "run-1",
      resume: { prior, priorGraphHash: "rev2", priorRunId: "run-1" },
    });
    const s1 = second.find((r) => r.nodeId === "s1")!;
    expect(s1.status).toBe("blocked");
    expect(s1.resumed).toBeUndefined();
    expect(s1.output).toMatch(/stale graph revision/);
    expect(run2Calls).not.toContain("s1");
    expect(run2Calls).toContain("j1");
    expect(second.find((r) => r.nodeId === "j1")?.resumed).toBeUndefined();
  });
});

describe("explicit traversal semantics", () => {
  it("condition-only nodes are rescue paths under halt: satisfied runs, unmet skips (never blocked)", async () => {
    const graph: Graph = {
      version: 1,
      nodes: [
        { id: "judge", kind: "jev", question: "Proceed?" },
        { id: "boom", kind: "shell", command: "fail" },
        { id: "rescue", kind: "shell", command: "recover", dependsOn: ["judge"], condition: { node: "judge", field: "decision.verdict", equals: "yes" } },
        { id: "other", kind: "shell", command: "skipme", dependsOn: ["judge"], condition: { node: "judge", field: "decision.verdict", equals: "no" } },
      ],
    };
    const calls: string[] = [];
    const results = await executeGraph(graph, allowAll, async (node) => {
      calls.push(node.id);
      if (node.id === "judge") return { output: "verdict=yes noul=0.9", jev: verdict("yes", 0.9), ok: true };
      if (node.id === "boom") throw new Error("boom");
      return "ok";
    }, { routing: ROUTING });
    expect(results.find((r) => r.nodeId === "boom")?.status).toBe("failed");
    // Satisfied typed condition runs despite the halt; unmet condition skips.
    expect(results.find((r) => r.nodeId === "rescue")?.status).toBe("succeeded");
    expect(calls).toContain("rescue");
    expect(results.find((r) => r.nodeId === "other")?.status).toBe("skipped");
    expect(calls).not.toContain("other");
  });
});
