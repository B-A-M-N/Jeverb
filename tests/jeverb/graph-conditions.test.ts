import { describe, expect, it } from "vitest";
import {
  executeGraph,
  hashValue,
  parseJevDecision,
  parseJevVerdict,
  validateGraph,
  type GraphNode,
} from "../../src/graph/executor.js";
import { questionSetHashFor } from "../../src/jev/qualification.js";
import type { RoutingAdmission } from "../../src/decision/routing.js";

const allowAll = { authorize: async () => ({ allowed: true }) };

/**
 * Verifier-attested admission for the fake judgments below (provider
 * "fake", single question-set hash "0"): these tests pin branch-selection
 * semantics, not the verifier.
 */
const ROUTING: RoutingAdmission = {
  active: {
    backend: "fake",
    model: "fake-stub",
    modelVersion: "v-test",
    questionFamily: questionSetHashFor(["0"]),
    policyHash: "p0",
  },
  qualification: {
    verified: true,
    qualificationId: "qual-test-conditions",
    id: "qual-test-conditions",
    family: "consequential-routing",
    backend: "fake",
    model: "fake-stub",
    modelVersion: "v-test",
    questionFamily: questionSetHashFor(["0"]),
    policyHash: "p0",
    qualified: true,
  },
};

describe("graph conditional transitions", () => {
  it("runs whenAny branches on prior outcomes and skips the rest", async () => {
    const ran: string[] = [];
    const results = await executeGraph(
      {
        version: 1,
        parallel: true,
        nodes: [
          { id: "a", kind: "shell", command: "fail" },
          { id: "b", kind: "shell", command: "ok" },
          { id: "c", kind: "shell", command: "rescue", dependsOn: ["a", "b"], whenAny: ["b"] },
          { id: "d", kind: "shell", command: "never", dependsOn: ["a"], whenAny: ["a"] },
          { id: "e", kind: "shell", command: "after", dependsOn: ["c"] },
        ],
      },
      {
        authorize: async () => ({ allowed: true }),
      },
      async (node) => {
        if (node.id === "a") throw new Error("a failed");
        ran.push(node.id);
        return node.id;
      },
    );
    const byId = new Map(results.map((r) => [r.nodeId, r]));
    expect(byId.get("a")?.status).toBe("failed");
    expect(byId.get("b")?.status).toBe("succeeded");
    expect(byId.get("c")?.status).toBe("succeeded");
    expect(byId.get("d")?.status).toBe("skipped");
    expect(byId.get("d")?.output).toContain("condition not met");
    // Legacy rule still applies downstream of a skip: e is blocked, not run.
    expect(byId.get("e")?.status).toBe("blocked");
    expect(ran.sort()).toEqual(["b", "c"]);
  });

  it("lets the typed judgment override misleading presentation text", async () => {
    const ran: string[] = [];
    const results = await executeGraph(
      {
        version: 1,
        nodes: [
          { id: "v", kind: "jev", question: "ok?" },
          {
            id: "yes-branch",
            kind: "shell",
            command: "echo yes",
            dependsOn: ["v"],
            condition: { node: "v", field: "decision.verdict", equals: "yes" },
          },
          {
            id: "no-branch",
            kind: "shell",
            command: "echo no",
            dependsOn: ["v"],
            condition: { node: "v", field: "decision.verdict", equals: "no" },
          },
        ],
      },
      allowAll,
      async (node) => {
        ran.push(node.id);
        if (node.id === "v") {
          // Text claims yes@0.99; the typed judgment says no@0.1. Typed wins.
          return {
            output: "verdict=yes noul=0.99 provider=fake qhash=0",
            jev: { verdict: "no", noul: 0.1, provider: "fake", model: "fake-stub", questionHash: "0", calibrated: false },
          };
        }
        return node.id;
      },
      { routing: ROUTING, policyHash: "p0" },
    );
    const byId = new Map(results.map((r) => [r.nodeId, r]));
    expect(byId.get("yes-branch")?.status).toBe("skipped");
    expect(byId.get("no-branch")?.status).toBe("succeeded");
    expect(ran).toContain("no-branch");
    expect(ran).not.toContain("yes-branch");
  });

  it("rejects shell nodes branching on unknown verdicts", async () => {
    const errors = validateGraph({
      version: 1,
      nodes: [
        { id: "v", kind: "jev", question: "ok?" },
        {
          id: "doom",
          kind: "shell",
          command: "rm -rf /tmp/x",
          dependsOn: ["v"],
          condition: { node: "v", field: "decision.verdict", equals: "unknown" },
        },
      ],
    });
    expect(errors.join(";")).toMatch(/unknown/);
    await expect(
      executeGraph(
        {
          version: 1,
          nodes: [
            { id: "v", kind: "jev", question: "ok?" },
            {
              id: "doom",
              kind: "shell",
              command: "rm -rf /tmp/x",
              dependsOn: ["v"],
              condition: { node: "v", field: "decision.verdict", equals: "unknown" },
            },
          ],
        },
        allowAll,
        async () => "verdict=unknown noul=0 provider=fake qhash=0",
      ),
    ).rejects.toThrow(/unknown/);
  });

  it("allows unknown verdicts to route to jev diagnostic nodes", async () => {
    const ran: string[] = [];
    const results = await executeGraph(
      {
        version: 1,
        nodes: [
          { id: "v", kind: "jev", question: "ok?" },
          {
            id: "diag",
            kind: "jev",
            question: "what now?",
            dependsOn: ["v"],
            condition: { node: "v", field: "decision.verdict", equals: "unknown" },
          },
        ],
      },
      allowAll,
      async (node) => {
        ran.push(node.id);
        if (node.id === "v") {
          return {
            output: "verdict=unknown noul=0 provider=fake qhash=0",
            jev: { verdict: "unknown", noul: 0, provider: "fake", questionHash: "0", calibrated: false },
          };
        }
        return {
          output: "diagnosed",
          jev: { verdict: "no", noul: 0.2, provider: "fake", questionHash: "0", calibrated: false },
        };
      },
    );
    expect(results.find((r) => r.nodeId === "diag")?.status).toBe("succeeded");
    expect(ran).toContain("diag");
  });

  it("rejects condition references that are not declared dependencies", () => {
    expect(
      validateGraph({
        version: 1,
        nodes: [
          { id: "a", kind: "shell", command: "x" },
          { id: "b", kind: "shell", command: "y", dependsOn: ["a"], whenAll: ["zzz"] },
        ],
      }),
    ).toContain("node b whenAll references unknown zzz");
    expect(
      validateGraph({
        version: 1,
        nodes: [
          { id: "a", kind: "shell", command: "x" },
          { id: "b", kind: "shell", command: "y", dependsOn: ["a"], whenAny: ["b"] },
        ],
      }),
    ).toContain("node b whenAny references itself");
    expect(
      validateGraph({
        version: 1,
        nodes: [
          { id: "a", kind: "shell", command: "x" },
          { id: "c", kind: "shell", command: "z" },
          { id: "b", kind: "shell", command: "y", dependsOn: ["a"], whenAll: ["c"] },
        ],
      }).join(";"),
    ).toContain("not a declared dependency");
  });

  it("holds marginal verdicts below the default confidence band", async () => {
    const graph = (noul: number, extra?: { minConfidence?: number }) => ({
      version: 1 as const,
      nodes: [
        { id: "v", kind: "jev" as const, question: "ok?" },
        {
          id: "d",
          kind: "shell" as const,
          command: "echo deploy",
          dependsOn: ["v"],
          condition: { node: "v", field: "decision.verdict" as const, equals: "yes" as const, ...extra },
        },
      ],
    });
    // Legacy string-only judgments carry no model identity, so they route
    // advisory-only; the typed capsule below pins the run to the measured
    // deployment for the admitted cases.
    const QHASH_A = "a".repeat(64);
    const routingOpenrouter: RoutingAdmission = {
      active: {
        backend: "openrouter",
        model: "openrouter-stub",
        modelVersion: "v-test",
        questionFamily: questionSetHashFor([QHASH_A]),
        policyHash: "p0",
      },
      qualification: {
        verified: true,
        qualificationId: "qual-test-marginal",
        id: "qual-test-marginal",
        family: "consequential-routing",
        backend: "openrouter",
        model: "openrouter-stub",
        modelVersion: "v-test",
        questionFamily: questionSetHashFor([QHASH_A]),
        policyHash: "p0",
        qualified: true,
      },
    };
    const run = (noul: number, extra?: { minConfidence?: number }) =>
      executeGraph(graph(noul, extra), allowAll, async (n) =>
        n.id === "v"
          ? {
            output: `verdict=yes noul=${noul} provider=openrouter qhash=${QHASH_A}`,
            jev: {
              verdict: "yes" as const,
              noul,
              provider: "openrouter",
              model: "openrouter-stub",
              questionHash: QHASH_A,
              calibrated: false,
            },
          }
          : "deployed",
      { routing: routingOpenrouter, policyHash: "p0" });
    // 0.9 clears the default 0.7 floor; 0.6 is a yes that does not qualify.
    expect((await run(0.9)).find((r) => r.nodeId === "d")?.status).toBe("succeeded");
    const marginal = await run(0.6);
    expect(marginal.find((r) => r.nodeId === "d")?.status).toBe("skipped");
    expect(marginal.find((r) => r.nodeId === "d")?.output).toContain("@ >=0.7");
    // An explicit lower floor still admits; an explicit higher floor blocks.
    expect((await run(0.6, { minConfidence: 0.55 })).find((r) => r.nodeId === "d")?.status).toBe("succeeded");
    expect((await run(0.95, { minConfidence: 0.99 })).find((r) => r.nodeId === "d")?.status).toBe("skipped");
  });

  it("rejects confidence floors outside (0, 1)", async () => {
    const base = {
      version: 1 as const,
      nodes: [
        { id: "v", kind: "jev" as const, question: "ok?" },
        {
          id: "d",
          kind: "shell" as const,
          command: "echo x",
          dependsOn: ["v"],
          condition: { node: "v", field: "decision.verdict" as const, equals: "yes" as const, minConfidence: 1 },
        },
      ],
    };
    expect(validateGraph(base)).toContain("node d condition has invalid minConfidence 1");
    await expect(executeGraph(base, allowAll, async () => "x")).rejects.toThrow(/minConfidence/);
  });

  it("mixes the policy hash into every node input hash", async () => {
    const graph = { version: 1 as const, nodes: [{ id: "a", kind: "shell" as const, command: "echo a" }] };
    const run = (policyHash?: string) =>
      executeGraph(graph, allowAll, async () => "out", {
        ...(policyHash === undefined ? {} : { policyHash }),
      });
    const results = await run();
    const tagged = await run("abc123");
    expect(results[0]?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tagged[0]?.inputHash).not.toBe(results[0]?.inputHash);
    // Same policy, same nodes: stable.
    const again = await run("abc123");
    expect(again[0]?.inputHash).toBe(tagged[0]?.inputHash);
  });

  it("hands succeeded dependency results to run and hashes every outcome", async () => {
    const seen: Array<{ outputs: string[] }> = [];
    const node: GraphNode = { id: "j", kind: "jev", question: "ok?", dependsOn: ["a", "b"] };
    const results = await executeGraph(
      {
        version: 1,
        nodes: [{ id: "a", kind: "shell", command: "echo a" }, { id: "b", kind: "shell", command: "echo b" }, node],
      },
      allowAll,
      async (n, ctx) => {
        if (n.id === "j") {
          seen.push({ outputs: [...ctx.results.values()].map((r) => r.output) });
        }
        return `out-${n.id}`;
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.outputs.sort()).toEqual(["out-a", "out-b"]);
    for (const r of results) {
      expect(r.inputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.outputHash).toBe(hashValue(r.output));
    }
    const again = await executeGraph(
      {
        version: 1,
        nodes: [{ id: "a", kind: "shell", command: "echo a" }, { id: "b", kind: "shell", command: "echo b" }, node],
      },
      allowAll,
      async (n) => `different-${n.id}`,
    );
    // Input hashes describe the request, not the outcome: identical across runs.
    expect(again.map((r) => r.inputHash)).toEqual(results.map((r) => r.inputHash));
    expect(again[0]?.outputHash).not.toBe(results[0]?.outputHash);
  });

  it("never exposes failed dependency outputs to run", async () => {
    const seen: string[] = [];
    const results = await executeGraph(
      {
        version: 1,
        parallel: true,
        nodes: [
          { id: "a", kind: "shell", command: "fail" },
          { id: "ok", kind: "shell", command: "echo ok" },
          { id: "j", kind: "jev", question: "ok?", dependsOn: ["a", "ok"], whenAny: ["ok"] },
        ],
      },
      allowAll,
      async (n, ctx) => {
        if (n.id === "a") throw new Error("secret-failure-detail");
        if (n.id === "j") seen.push(...[...ctx.results.values()].map((r) => r.output));
        return n.id === "j" ? "j-out" : `out-${n.id}`;
      },
    );
    expect(results.find((r) => r.nodeId === "j")?.status).toBe("succeeded");
    expect(seen).toEqual(["out-ok"]);
    expect(seen.join("\n")).not.toContain("secret-failure-detail");
  });

  it("marks an aborted shell attempt as outcome unknown", async () => {
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 50);
    try {
      const results = await executeGraph(
        { version: 1, nodes: [{ id: "a", kind: "shell", command: "sleep" }] },
        allowAll,
        async (_n, ctx) =>
          new Promise<string>((_resolve, reject) => {
            const watchdog = setTimeout(() => reject(new Error("run was never aborted")), 5000);
            ctx.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(watchdog);
                reject(new Error("interrupted mid-run"));
              },
              { once: true },
            );
          }),
        { signal: ctrl.signal },
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("outcome_unknown");
      expect(results[0]?.ok).toBe(false);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it("parses structured verdict lines and rejects free text", () => {
    expect(parseJevVerdict("verdict=yes noul=0.9 provider=openrouter qhash=" + "a".repeat(64))).toEqual({
      verdict: "yes",
      confidence: 0.9,
      provider: "openrouter",
      questionHash: "a".repeat(64),
    });
    expect(parseJevVerdict("verdict=no noul=0.12")?.verdict).toBe("no");
    expect(parseJevVerdict("verdict=maybe noul=0.5")).toBeUndefined();
    expect(parseJevVerdict("the check looks fine to me")).toBeUndefined();
    expect(parseJevVerdict("verdict=yes noul=1.5")?.confidence).toBeUndefined();
  });

  it("parses only schema-valid typed Jev answer capsules", () => {
    const qhash = "b".repeat(64);
    const capsule = (answers: unknown) => Buffer.from(JSON.stringify({
      provider: "typesafe",
      questionHash: qhash,
      answers,
    }), "utf8").toString("base64url");
    const valid = capsule({
      route: { type: "choice", choice: "local", probabilities: { local: 0.9, remote: 0.1 }, confidence: 0.9 },
      risk: { type: "score", score: 1.5, legend: { "0": "low", "1": "medium", "2": "high" }, confidence: 0.8 },
    });
    expect(parseJevDecision(`provider=typesafe qhash=${qhash} typed=${valid}`)?.answers).toMatchObject({
      route: { type: "choice", choice: "local" },
      risk: { type: "score", score: 1.5 },
    });
    const invalid = capsule({ route: { type: "choice", choice: "local", probabilities: { local: 0.9, remote: 0.9 }, confidence: 1 } });
    expect(parseJevDecision(`typed=${invalid}`)).toBeUndefined();
    expect(parseJevDecision("typed=not-base64-json")).toBeUndefined();
  });

  it("rejects decision conditions that cannot name a jev verdict", () => {
    const base = { id: "d", kind: "shell" as const, command: "echo x", dependsOn: ["v"] };
    const jev = { id: "v", kind: "jev" as const, question: "ok?" };
    const shell = { id: "s", kind: "shell" as const, command: "echo s" };
    const cond = { node: "v", field: "decision.verdict", equals: "yes" } as const;
    // Target must be a declared jev dependency with a real expected verdict.
    // Unknown references are reported by both checks; neither is trusted.
    expect(validateGraph({ version: 1, nodes: [jev, { ...base, dependsOn: ["missing"], condition: { ...cond, node: "missing" } }] })).toEqual([
      "node d depends on unknown missing",
      "node d condition references unknown missing",
    ]);
    expect(validateGraph({ version: 1, nodes: [jev, shell, { ...base, dependsOn: ["v", "s"], condition: { ...cond, node: "s" } }] })).toEqual([
      "node d condition references s which does not produce decision.verdict",
    ]);
    expect(
      validateGraph({ version: 1, nodes: [jev, { ...base, condition: { ...cond, field: "other" as never } }] }),
    ).toEqual(['node d condition has invalid value "yes" for other']);
    expect(
      validateGraph({ version: 1, nodes: [jev, { ...base, condition: { ...cond, equals: "maybe" as never } }] }),
    ).toEqual(['node d condition has invalid value "maybe" for decision.verdict']);
    expect(validateGraph({ version: 1, nodes: [jev, { ...base, condition: cond }] })).toEqual([]);
  });

  it("settles sequential siblings preempted by an earlier failure", async () => {
    const ran: string[] = [];
    const results = await executeGraph(
      {
        version: 1,
        nodes: [
          { id: "a", kind: "shell", command: "fail" },
          { id: "b", kind: "shell", command: "echo b" },
          { id: "c", kind: "shell", command: "echo c", dependsOn: ["b"] },
        ],
      },
      allowAll,
      async (n) => {
        ran.push(n.id);
        if (n.id === "a") throw new Error("boom");
        return `out-${n.id}`;
      },
    );
    // Every declared node has exactly one terminal record: a failed first
    // sibling must not leave later siblings (or their dependents) unsettled.
    expect(results).toHaveLength(3);
    expect(results.find((r) => r.nodeId === "a")?.status).toBe("failed");
    const b = results.find((r) => r.nodeId === "b");
    expect(b?.status).toBe("blocked");
    expect(b?.ok).toBe(false);
    expect(b?.attempts).toBe(0);
    const c = results.find((r) => r.nodeId === "c");
    expect(c?.status).toBe("blocked");
    expect(c?.ok).toBe(false);
    expect(ran).toEqual(["a"]);
  });
});
