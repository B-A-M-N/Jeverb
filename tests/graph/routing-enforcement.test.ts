import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeGraph,
  type Graph,
  type JevDecision,
} from "../../src/graph/executor.js";
import { FileJournal, reconcileJournal } from "../../src/graph/journal.js";
import { questionSetHashFor } from "../../src/jev/qualification.js";
import type { RoutingAdmission } from "../../src/decision/routing.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

const allowAll = { authorize: async () => ({ allowed: true }) };

const QUESTION_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function unqualifiedYes(): JevDecision {
  return {
    verdict: "yes",
    noul: 0.95,
    provider: "fake",
    model: "fake-model",
    questionHash: QUESTION_HASH,
    calibrated: false,
  };
}

function verdictGatedShell(): Graph {
  return {
    version: 1,
    nodes: [
      { id: "judge", kind: "jev", question: "Deploy?" },
      {
        id: "deploy",
        kind: "shell",
        command: "echo deploying",
        dependsOn: ["judge"],
        condition: { node: "judge", field: "decision.verdict", equals: "yes" },
      },
    ],
  };
}

function runWithJev(jev: JevDecision, ran: string[]) {
  return async (node: { id: string; kind: string }) => {
    ran.push(node.id);
    if (node.id === "judge") return { output: "verdict=yes noul=0.95 provider=fake", jev };
    return node.id;
  };
}

describe("consequential routing enforcement in the graph runtime", () => {
  it("does not let a Jev-selected non-shell branch indirectly release a shell through whenAll", async () => {
    const selected: JevDecision = {
      answers: {
        route: { type: "choice", choice: "execute", probabilities: { execute: 0.95, defer: 0.05 }, confidence: 0.95 },
      },
      provider: "fake",
      model: "fake-model",
      questionHash: QUESTION_HASH,
      calibrated: false,
    };
    const graph: Graph = {
      version: 1,
      nodes: [
        {
          id: "judge",
          kind: "jev",
          questions: { route: { type: "choice", instructions: "Choose a route.", criteria: { execute: null, defer: null } } },
        },
        {
          id: "execute-branch",
          kind: "jev",
          question: "Confirm the selected branch.",
          dependsOn: ["judge"],
          condition: { node: "judge", field: "decision.choice", question: "route", equals: "execute", minConfidence: 0.8 },
        },
        {
          id: "deploy",
          kind: "shell",
          command: "echo deploy",
          dependsOn: ["execute-branch"],
          whenAll: ["execute-branch"],
        },
      ],
    };
    const ran: string[] = [];
    const run = async (node: { id: string; kind: string }) => {
      ran.push(node.id);
      return node.id === "judge" ? { output: "selected execute", jev: selected } : node.id;
    };

    const results = await executeGraph(graph, allowAll, run as never);
    const selectedBranch = results.find((result) => result.nodeId === "execute-branch")!;
    const deploy = results.find((result) => result.nodeId === "deploy")!;
    expect(ran).not.toContain("deploy");
    expect(selectedBranch.status).toBe("skipped");
    expect(selectedBranch.output).toMatch(/consequential-routing/);
    expect(deploy.status).toBe("skipped");
    expect(deploy.attempts).toBe(0);
  });

  it("treats a dependent expansion template shell as a consequential descendant", async () => {
    const selected: JevDecision = {
      answers: {
        route: { type: "choice", choice: "execute", probabilities: { execute: 0.95, defer: 0.05 }, confidence: 0.95 },
      },
      provider: "fake",
      model: "fake-model",
      questionHash: QUESTION_HASH,
      calibrated: false,
    };
    const graph: Graph = {
      version: 1,
      nodes: [
        { id: "judge", kind: "jev", questions: { route: { type: "choice", instructions: "Choose a route.", criteria: { execute: null, defer: null } } }, captureOutput: true },
        {
          id: "execute-branch",
          kind: "jev",
          question: "Confirm the selected branch.",
          dependsOn: ["judge"],
          condition: { node: "judge", field: "decision.choice", question: "route", equals: "execute", minConfidence: 0.8 },
        },
        {
          id: "fanout",
          kind: "expand",
          dependsOn: ["judge", "execute-branch"],
          whenAll: ["execute-branch"],
          expansion: {
            itemsFrom: "judge",
            as: "ITEM",
            maxItems: 1,
            nodes: [
              { id: "inspect", kind: "jev", question: "Inspect the item." },
              { id: "deploy", kind: "shell", command: "echo deploy", dependsOn: ["inspect"] },
            ],
          },
        },
      ],
    };
    const ran: string[] = [];
    const run = async (node: { id: string; kind: string }) => {
      ran.push(node.id);
      return node.id === "judge" ? { output: "[]", jev: selected } : node.id;
    };

    const results = await executeGraph(graph, allowAll, run as never);
    const branch = results.find((result) => result.nodeId === "execute-branch")!;
    const fanout = results.find((result) => result.nodeId === "fanout")!;
    expect(ran).not.toContain("fanout");
    expect(branch.status).toBe("skipped");
    expect(branch.output).toMatch(/consequential-routing/);
    expect(fanout.status).toBe("skipped");
    expect(fanout.attempts).toBe(0);
  });

  it("refuses dynamic shell predicates that can inspect Jev results", async () => {
    const ran: string[] = [];
    let predicateCalled = false;
    const graph: Graph = {
      version: 1,
      nodes: [
        { id: "judge", kind: "jev", question: "Choose a route." },
        {
          id: "deploy",
          kind: "shell",
          command: "echo deploy",
          dependsOn: ["judge"],
          when: (_node, results) => {
            predicateCalled = true;
            return results.some((result) => result.nodeId === "judge" && result.status === "succeeded");
          },
        },
      ],
    };
    const results = await executeGraph(graph, allowAll, runWithJev(unqualifiedYes(), ran) as never);
    const deploy = results.find((result) => result.nodeId === "deploy")!;
    expect(predicateCalled).toBe(false);
    expect(ran).not.toContain("deploy");
    expect(deploy.status).toBe("skipped");
    expect(deploy.output).toContain("dynamic shell predicates cannot bind a Jev judgment");
    expect(deploy.attempts).toBe(0);
  });

  it("refuses a verdict-gated shell on an unqualified yes judgment despite a permissive shell policy", async () => {
    const ran: string[] = [];
    const results = await executeGraph(verdictGatedShell(), allowAll, runWithJev(unqualifiedYes(), ran) as never);
    const deploy = results.find((r) => r.nodeId === "deploy")!;
    // The branch predicate is satisfied (yes @ 0.95) and the authorizer
    // permits everything, yet the shell must not run: no verified
    // consequential-routing qualification admits the route.
    expect(ran).not.toContain("deploy");
    expect(deploy.status).toBe("skipped");
    expect(deploy.attempts).toBe(0);
    expect(deploy.output).toMatch(/consequential-routing/);
  });

  it("treats a caller-supplied qualified:true without verifier attestation as insufficient", async () => {
    const ran: string[] = [];
    const routing = {
      active: {
        backend: "fake",
        model: "fake-model",
        modelVersion: "v1",
        questionFamily: questionSetHashFor([QUESTION_HASH]),
        policyHash: "policy-hash",
      },
      // No `verified: true` attestation: this is a caller assertion, never
      // a verifier-admitted qualification.
      qualification: {
        family: "consequential-routing",
        backend: "fake",
        model: "fake-model",
        modelVersion: "v1",
        questionFamily: questionSetHashFor([QUESTION_HASH]),
        policyHash: "policy-hash",
        qualified: true,
      },
    } as unknown as RoutingAdmission;
    const results = await executeGraph(verdictGatedShell(), allowAll, runWithJev(unqualifiedYes(), ran) as never, {
      routing,
    });
    const deploy = results.find((r) => r.nodeId === "deploy")!;
    expect(ran).not.toContain("deploy");
    expect(deploy.status).toBe("skipped");
    expect(deploy.attempts).toBe(0);
  });

  it("refuses when the verified record is malformed", async () => {
    const ran: string[] = [];
    const routing = {
      active: {
        backend: "fake",
        model: "fake-model",
        modelVersion: "v1",
        questionFamily: questionSetHashFor([QUESTION_HASH]),
        policyHash: "policy-hash",
      },
      qualification: {
        verified: true,
        qualificationId: "qual-malformed",
        family: "consequential-routing",
        backend: "",
        model: "fake-model",
        modelVersion: "v1",
        questionFamily: questionSetHashFor([QUESTION_HASH]),
        policyHash: "policy-hash",
        qualified: true,
      },
    } as unknown as RoutingAdmission;
    const results = await executeGraph(verdictGatedShell(), allowAll, runWithJev(unqualifiedYes(), ran) as never, {
      routing,
    });
    const deploy = results.find((r) => r.nodeId === "deploy")!;
    expect(ran).not.toContain("deploy");
    expect(deploy.attempts).toBe(0);
  });

  it("admits the protected shell under a verified qualification bound to the actual run identity", async () => {
    const ran: string[] = [];
    const routing: RoutingAdmission = {
      active: {
        backend: "fake",
        model: "fake-model",
        modelVersion: "v1",
        questionFamily: questionSetHashFor([QUESTION_HASH]),
        policyHash: "policy-hash",
      },
      qualification: {
        verified: true,
        qualificationId: "qual-routing-001",
        family: "consequential-routing",
        backend: "fake",
        model: "fake-model",
        modelVersion: "v1",
        questionFamily: questionSetHashFor([QUESTION_HASH]),
        policyHash: "policy-hash",
        qualified: true,
      },
    };
    const results = await executeGraph(verdictGatedShell(), allowAll, runWithJev(unqualifiedYes(), ran) as never, {
      routing,
    });
    const deploy = results.find((r) => r.nodeId === "deploy")!;
    expect(ran).toContain("deploy");
    expect(deploy.status).toBe("succeeded");
  });

  it("still skips when the judgment itself is below the branch confidence floor", async () => {
    const ran: string[] = [];
    const weak: JevDecision = { ...unqualifiedYes(), noul: 0.5 };
    const results = await executeGraph(verdictGatedShell(), allowAll, runWithJev(weak, ran) as never);
    const deploy = results.find((r) => r.nodeId === "deploy")!;
    expect(ran).not.toContain("deploy");
    expect(deploy.status).toBe("skipped");
  });

  it("persists the selected transition and verified qualification identity for replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-routing-replay-"));
    const journalPath = join(dir, "jeverb-graph-run-1.jsonl");
    const routing: RoutingAdmission = {
      active: {
        backend: "fake",
        model: "fake-model",
        modelVersion: "v1",
        questionFamily: questionSetHashFor([QUESTION_HASH]),
        policyHash: "policy-hash",
      },
      qualification: {
        verified: true,
        qualificationId: "qual-routing-001",
        family: "consequential-routing",
        backend: "fake",
        model: "fake-model",
        modelVersion: "v1",
        questionFamily: questionSetHashFor([QUESTION_HASH]),
        policyHash: "policy-hash",
        qualified: true,
      },
    };
    // Admitted run: the journal carries the route, the mode, and the
    // qualification identity a restart replays instead of re-deriving.
    const ran: string[] = [];
    await executeGraph(verdictGatedShell(), allowAll, runWithJev(unqualifiedYes(), ran) as never, {
      journal: new FileJournal("run-1", dir),
      runId: "run-1",
      routing,
    });
    const admitted = reconcileJournal(journalPath).nodes.find((n) => n.nodeId === "deploy")!;
    expect(admitted.status).toBe("succeeded");
    expect(admitted.decisionKind).toBe("routing");
    expect(admitted.decisionMode).toBe("consequential");
    expect(admitted.qualificationId).toBe("qual-routing-001");
    expect(admitted.branch).toContain("qual-routing-001");
    // Refused run: the refusal itself is journaled as routing/advisory with
    // no qualification identity, so a restart cannot mistake it for admission.
    const dir2 = mkdtempSync(join(tmpdir(), "jeverb-routing-refused-"));
    const journalPath2 = join(dir2, "jeverb-graph-run-2.jsonl");
    await executeGraph(verdictGatedShell(), allowAll, runWithJev(unqualifiedYes(), []) as never, {
      journal: new FileJournal("run-2", dir2),
      runId: "run-2",
    });
    const refused = reconcileJournal(journalPath2).nodes.find((n) => n.nodeId === "deploy")!;
    expect(refused.status).toBe("skipped");
    expect(refused.decisionKind).toBe("routing");
    expect(refused.decisionMode).toBe("advisory");
    expect(refused.qualificationId).toBeUndefined();
  });
});
