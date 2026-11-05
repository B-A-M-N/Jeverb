import { readFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import { toMuseOutput } from "../../src/hosts/muse/outputs.js";
import { dispatchEvent } from "../../src/hooks/unified.js";
import { buildDeps } from "../../src/hooks/main.js";
import { loadHookConfig } from "../../src/hooks/config.js";
import { ReviewService } from "../../src/review/service.js";
import { classifySubagent } from "../../src/routing/policy.js";
import { choice, FakeModel, score } from "../helpers/fake-model.js";
import { testHookConfig } from "../helpers/control-state.js";
import { testLedgerForFile } from "../helpers/control-state.js";

function testDeps(ledgerPath?: string, model?: FakeModel | null, routePrompts = false) {
  const dir = mkdtempSync(join(tmpdir(), "jeverb-router-"));
  const config = testHookConfig(dir);
  config.routePrompts = routePrompts;
  const base = buildDeps(config, model === undefined ? null : model);
  const review = new ReviewService(null, {
    checks: [],
    policy: { policy_version: "1", thresholds: { block: 0.85, security_review: 0.6 } },
  });
  const ledger = testLedgerForFile(ledgerPath ?? join(dir, "evidence.log"));
  return { ...base, review, ledger, dir };
}

function readReceipts(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, "evidence.log"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const LONG_PROMPT =
  "please refactor the authentication module to support rotating keys, and migrate the session store";

describe("router advisory context", () => {
  it("falls back to deterministic effort hint when no model judged the prompt", async () => {
    const deps = testDeps(undefined, null, true);
    const decision = await dispatchEvent("UserPromptSubmit", { prompt: LONG_PROMPT } as never, deps);
    expect(decision?.enforcement).toBe("advise");
    expect(decision?.source).toBe("deterministic");
    expect(decision?.reasons.join("\n")).toContain("suggested effort");
    expect(decision?.reasons.join("\n")).toContain("advisory only");
  });

  it("does not emit deterministic routing advice unless routePrompts is enabled", async () => {
    const deps = testDeps();
    expect(await dispatchEvent("UserPromptSubmit", { prompt: LONG_PROMPT } as never, deps)).toBeUndefined();
  });

  it("stays silent on short prompts", async () => {
    const deps = testDeps();
    expect(await dispatchEvent("UserPromptSubmit", { prompt: "ok thanks" } as never, deps)).toBeUndefined();
  });

  it("does not double-advise when the Jev classifier already spoke", async () => {
    const model = new FakeModel(() => ({
      kind: choice("multi_file_implementation", { multi_file_implementation: 0.9, other: 0.1 }, 0.95),
      ambiguity: score(0.4, ["low", "mid", "high"], 0.8),
    }));
    const deps = testDeps(undefined, model, true);
    const decision = await dispatchEvent(
      "UserPromptSubmit",
      { prompt: LONG_PROMPT, session_id: "s1" } as never,
      deps,
    );
    expect(decision?.enforcement).toBe("advise");
    expect(decision?.reasons.join("\n")).not.toContain("[router]");
  });

  it("notes subagent starts by type, silently without one", async () => {
    const deps = testDeps();
    const decision = await dispatchEvent("SubagentStart", { agent_type: "Explore" } as never, deps);
    expect(decision?.enforcement).toBe("advise");
    expect(decision?.reasons.join("\n")).toContain("Explore");
    expect(decision?.reasons.join("\n")).toContain("suitability not established");
    expect(decision?.reasons.join("\n")).toContain("unavailable or ambiguous");
    expect(await dispatchEvent("SubagentStart", {} as never, testDeps())).toBeUndefined();
  });

  it("classifies only bounded tasks with an action and deliverable as suitable", () => {
    expect(classifySubagent("Implement graph journal recovery and add regression tests.")).toMatchObject({
      suitable: true,
      reason: "task names an action and an expected deliverable",
    });
    expect(classifySubagent("Take a look at the codebase.").suitable).toBe(false);
    expect(classifySubagent("Review deployment notes and report findings.").suitable).toBe(true);
    expect(classifySubagent("Deploy the release to production.")).toMatchObject({
      suitable: false,
      reason: "task requests a protected or externally effectful action",
    });
  });

  it("uses the unique captured spawn task without echoing its contents", async () => {
    const deps = testDeps();
    const sessionId = "subagent-advisory";
    const task = "Implement graph journal recovery and report the regression test results.";
    deps.store.rememberSubagentTask(sessionId, { agent_type: "Explore", prompt: task, ts: deps.now() }, deps.now());
    expect(deps.store.takeSubagentTask(sessionId, "Explore", deps.now())?.prompt).toBe(task);
    const decision = await dispatchEvent(
      "SubagentStart",
      { session_id: sessionId, subagent_id: "child-1", agent_type: "Explore" } as never,
      deps,
    );
    expect(decision?.reasons.join("\n")).toContain("suitability suitable");
    expect(decision?.reasons.join("\n")).toContain("action and an expected deliverable");
    expect(decision?.reasons.join("\n")).not.toContain(task);
  });

  it("advises on suitability before Agent and Task spawn operations run", async () => {
    for (const tool_name of ["Agent", "Task"]) {
      const deps = testDeps();
      const task = "Implement the parser fix and add regression tests.";
      const decision = await dispatchEvent(
        "PreToolUse",
        {
          session_id: `spawn-${tool_name}`,
          tool_name,
          tool_input: { subagent_type: "Worker", prompt: task },
        } as never,
        deps,
      );
      expect(decision?.enforcement).toBe("advise");
      expect(decision?.reasons.join("\n")).toContain("suitability suitable");
      expect(deps.store.takeSubagentTask(`spawn-${tool_name}`, "Worker", deps.now())?.prompt).toBe(task);
      expect(toMuseOutput("PreToolUse", decision)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: expect.stringContaining("suitability suitable"),
        },
      });
    }
  });

  it("marks a direct external effect unsuitable before spawn without denying it", async () => {
    const decision = await dispatchEvent(
      "PreToolUse",
      {
        session_id: "spawn-protected",
        tool_name: "Agent",
        tool_input: { subagent_type: "Worker", prompt: "Deploy this release to production." },
      } as never,
      testDeps(),
    );
    expect(decision?.enforcement).toBe("advise");
    expect(decision?.reasons.join("\n")).toContain("suitability not established");
    expect(decision?.reasons.join("\n")).toContain("protected or externally effectful action");
  });

  it("does not guess a task when same-type subagents are ambiguous", async () => {
    const deps = testDeps();
    const sessionId = "subagent-ambiguous";
    for (const prompt of ["Implement the first fix and add tests.", "Review the second plan and return findings."]) {
      deps.store.rememberSubagentTask(sessionId, { agent_type: "Explore", prompt, ts: deps.now() }, deps.now());
    }
    const decision = await dispatchEvent(
      "SubagentStart",
      { session_id: sessionId, agent_type: "Explore" } as never,
      deps,
    );
    expect(decision?.reasons.join("\n")).toContain("suitability not established");
    expect(decision?.reasons.join("\n")).toContain("unavailable or ambiguous");
  });

  it("records advisory decisions as receipts", async () => {
    const deps = testDeps(undefined, null, true);
    await dispatchEvent("UserPromptSubmit", { prompt: LONG_PROMPT } as never, deps);
    const receipts = readReceipts(deps.dir);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ event: "UserPromptSubmit", enforcement: "advise" });
  });
});
