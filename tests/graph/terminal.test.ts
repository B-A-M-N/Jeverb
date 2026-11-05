import { describe, expect, it } from "vitest";
import { NullJournal, type JournalEvent, type JournalWriter } from "../../src/graph/journal.js";
import { buildTerminalResult, TERMINAL_EXCERPT_CHARS, type TerminalContext } from "../../src/graph/terminal.js";
import type { GraphNode } from "../../src/graph/executor.js";

const node = (overrides: Partial<GraphNode> = {}): GraphNode => ({ id: "n-1", kind: "shell", ...overrides });

function ctx(overrides: Partial<TerminalContext> = {}): { ctx: TerminalContext; events: JournalEvent[] } {
  const events: JournalEvent[] = [];
  const journal: JournalWriter = {
    path: "<test>",
    record: (event) => {
      events.push(event);
    },
  };
  return {
    ctx: {
      policyTag: "policy-1",
      runId: "run-1",
      journal,
      fullOutputs: new Map(),
      cancelled: false,
      ...overrides,
    },
    events,
  };
}

describe("buildTerminalResult", () => {
  it("truncates the excerpt but digests the full output", () => {
    const { ctx: c, events } = ctx();
    const fullOutput = `x`.repeat(TERMINAL_EXCERPT_CHARS + 100);
    const result = buildTerminalResult(node(), { ok: true, fullOutput, attempts: 1, status: "succeeded" }, c);
    expect(result.output).toHaveLength(TERMINAL_EXCERPT_CHARS);
    expect(result.outputHash).not.toBe(result.outputDigest);
    expect(c.fullOutputs.get("n-1")).toBe(fullOutput);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "node-terminal", nodeId: "n-1", status: "succeeded" });
  });

  it("binds the input hash to the policy tag", () => {
    const first = buildTerminalResult(node(), { ok: true, fullOutput: "out", attempts: 1, status: "succeeded" }, ctx().ctx);
    const second = buildTerminalResult(
      node(),
      { ok: true, fullOutput: "out", attempts: 1, status: "succeeded" },
      ctx({ policyTag: "policy-2" }).ctx,
    );
    expect(first.inputHash).not.toBe(second.inputHash);
  });

  it("reports artifact errors instead of throwing", () => {
    const { ctx: c } = ctx({ outputArtifactsAllowed: true });
    const noStore = buildTerminalResult(
      node({ captureOutput: true }),
      { ok: true, fullOutput: "out", attempts: 1, status: "succeeded" },
      c,
    );
    expect(noStore.outputArtifact).toBeUndefined();
    expect(noStore.outputArtifactError).toBe("full-output artifact store is not configured");
    const disallowed = buildTerminalResult(
      node({ captureOutput: true }),
      { ok: true, fullOutput: "out", attempts: 1, status: "succeeded" },
      ctx({ outputArtifactsAllowed: false }).ctx,
    );
    expect(disallowed.outputArtifactError).toBe("operator policy does not allow full-output artifacts");
    const cancelled = buildTerminalResult(
      node({ captureOutput: true }),
      { ok: true, fullOutput: "out", attempts: 1, status: "succeeded" },
      ctx({ cancelled: true }).ctx,
    );
    expect(cancelled.outputArtifactError).toBe("output artifact omitted because graph execution was cancelled");
  });

  it("accepts a NullJournal without recording", () => {
    const { ctx: c } = ctx({ journal: new NullJournal() });
    const result = buildTerminalResult(node(), { ok: false, fullOutput: "nope", attempts: 0, status: "blocked" }, c);
    expect(result.status).toBe("blocked");
  });
});
