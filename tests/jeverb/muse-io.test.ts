import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  MAX_STDIN_BYTES,
  readStdinText,
  StdinTooLargeError,
  StdinTimeoutError,
} from "../../src/hosts/muse/io.js";
import { toMuseOutput, type MuseEvent } from "../../src/hosts/muse/outputs.js";
import type { UnifiedDecision } from "../../src/decision/types.js";

function decision(enforcement: UnifiedDecision["enforcement"]): UnifiedDecision {
  return {
    event: "PreToolUse",
    enforcement,
    source: "deterministic",
    reasons: ["test reason"],
    evidence: [],
    policyVersion: "1",
    decisionId: "d1",
  };
}

describe("bounded hook stdin", () => {
  it("reads an ordinary payload", async () => {
    const text = await readStdinText(Readable.from(['{"tool_name":"Bash"}']));
    expect(text).toBe('{"tool_name":"Bash"}');
  });

  it("refuses an unbounded payload instead of buffering it", async () => {
    const huge = Readable.from([Buffer.alloc(MAX_STDIN_BYTES + 1, "x")]);
    await expect(readStdinText(huge)).rejects.toBeInstanceOf(StdinTooLargeError);
  });

  it("honors a caller-supplied cap", async () => {
    const stream = Readable.from([Buffer.alloc(100, "x")]);
    await expect(readStdinText(stream, { maxBytes: 10 })).rejects.toBeInstanceOf(StdinTooLargeError);
  });

  it("refuses to wait out the hook budget on a stuck pipe", async () => {
    const stuck = new Readable({ read() {} });
    await expect(readStdinText(stuck, { timeoutMs: 50 })).rejects.toBeInstanceOf(StdinTimeoutError);
    stuck.destroy();
  });
});

describe("muse output envelope", () => {
  it("uses Muse's PermissionRequest schema and never emits an approval", () => {
    for (const enforcement of ["allow", "advise", "ask", "deny", "continue_work"] as const) {
      const out = toMuseOutput("PermissionRequest", decision(enforcement));
      expect(JSON.stringify(out ?? {})).not.toContain("allow");
    }
    expect(toMuseOutput("PermissionRequest", decision("deny"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "test reason" },
      },
    });
    for (const enforcement of ["allow", "advise", "ask"] as const) {
      expect(toMuseOutput("PermissionRequest", decision(enforcement))).toBeUndefined();
    }
  });

  it("blocks Stop and SubagentStop only on continue_work", () => {
    for (const event of ["Stop", "SubagentStop"] as const) {
      expect(toMuseOutput(event, decision("continue_work"))).toMatchObject({ decision: "block" });
      expect(toMuseOutput(event, decision("deny"))).toBeUndefined();
    }
  });

  it("emits Muse's terminal stop signal only for evidence-backed mission outcomes", () => {
    const completed: UnifiedDecision = {
      ...decision("terminal"),
      event: "Stop",
      terminalOutcome: {
        status: "COMPLETE",
        missionId: "mission-1",
        missionRevision: "mission-r7",
        evidenceRevision: "evidence-r12",
        receiptCorrelationId: "a".repeat(64),
      },
      reasons: ["TOTAL_MISSION_COMPLETE", "verified receipt"],
    };
    expect(toMuseOutput("Stop", completed)).toEqual({
      continue: false,
      stopReason: "TOTAL_MISSION_COMPLETE: TOTAL_MISSION_COMPLETE\nverified receipt",
    });
    expect(toMuseOutput("SubagentStop", completed)).toBeUndefined();
    expect(toMuseOutput("Stop", decision("terminal"))).toBeUndefined();
  });

  it("returns no output for decisions the host cannot act on", () => {
    expect(toMuseOutput("PostToolUse", decision("deny"))).toBeUndefined();
    expect(toMuseOutput("SessionEnd", decision("advise"))).toBeUndefined();
    expect(toMuseOutput("PreToolUse", undefined)).toBeUndefined();
    expect(toMuseOutput("Nonexistent" as MuseEvent, decision("deny"))).toBeUndefined();
  });
});
