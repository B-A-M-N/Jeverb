import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UnifiedDecision } from "../../src/decision/types.js";
import { dispatchEvent } from "../../src/hooks/unified.js";
import { runEvent } from "../../src/hooks/dispatch.js";
import { buildDeps } from "../../src/hooks/main.js";
import { loadHookConfig } from "../../src/hooks/config.js";
import { ReviewService } from "../../src/review/service.js";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import type { HookOutput } from "../../src/hooks/types.js";
import { toClaudeOutput } from "../../src/hosts/claude/outputs.js";
import { toMuseOutput, type MuseEvent } from "../../src/hosts/muse/outputs.js";
import { testHookConfig } from "../helpers/control-state.js";
import { testLedgerForFile } from "../helpers/control-state.js";

function testDeps() {
  const config = testHookConfig(mkdtempSync(join(tmpdir(), "jeverb-claude-data-")));
  const base = buildDeps(config, null);
  const review = new ReviewService(null, {
    checks: [],
    policy: { policy_version: "1", thresholds: { block: 0.85, security_review: 0.6 } },
  });
  const ledger = testLedgerForFile(join(mkdtempSync(join(tmpdir(), "jeverb-claude-")), "evidence.log"));
  return { ...base, review, ledger };
}

function decision(overrides: Partial<UnifiedDecision>): UnifiedDecision {
  return {
    event: "PreToolUse",
    enforcement: "allow",
    source: "deterministic",
    reasons: [],
    evidence: [],
    policyVersion: "1",
    decisionId: "test",
    ...overrides,
  };
}

/** Collapse any host's bytes to the enforcement direction they carry. */
function claudeDirection(output: HookOutput | undefined): string {
  if (!output) return "allow";
  if (output.decision === "block") return "continue_work";
  const perm = output.hookSpecificOutput?.permissionDecision;
  if (perm === "deny") return "deny";
  if (perm === "ask") return "ask";
  if (output.hookSpecificOutput?.additionalContext ?? output.systemMessage) return "advise";
  return "allow";
}

function museDirection(output: Record<string, unknown> | undefined): string {
  if (!output) return "allow";
  if ((output as { decision?: string }).decision === "block") return "continue_work";
  const specific = (output as { hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string } })
    .hookSpecificOutput;
  if (specific?.permissionDecision === "deny") return "deny";
  if (specific?.permissionDecision === "ask") return "ask";
  if (specific?.additionalContext) return "advise";
  return "allow";
}

describe("toClaudeOutput", () => {
  it("renders deny/ask with the reason where a blocked call can show it", () => {
    for (const enforcement of ["deny", "ask"] as const) {
      const out = toClaudeOutput("PreToolUse", decision({ enforcement, reasons: ["tripwire fired"] }));
      expect(out?.hookSpecificOutput?.permissionDecision).toBe(enforcement);
      expect(out?.hookSpecificOutput?.permissionDecisionReason).toBe("tripwire fired");
      expect(out?.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    }
  });

  it("renders advise as context and allow as silence", () => {
    expect(
      toClaudeOutput("PostToolUse", decision({ enforcement: "advise", reasons: ["note"] }))?.hookSpecificOutput
        ?.additionalContext,
    ).toBe("note");
    expect(toClaudeOutput("PreToolUse", decision({ enforcement: "allow" }))).toBeUndefined();
    expect(toClaudeOutput("PreToolUse", undefined)).toBeUndefined();
  });

  it("blocks only Stop/SubagentStop on continue_work", () => {
    const d = decision({ enforcement: "continue_work", reasons: ["empty deliverable"] });
    expect(toClaudeOutput("SubagentStop", d)).toEqual({ decision: "block", reason: "empty deliverable" });
    expect(toClaudeOutput("Stop", d)).toEqual({ decision: "block", reason: "empty deliverable" });
    expect(toClaudeOutput("PostToolUse", d)).toBeUndefined();
  });

  it("never emits an allow permission decision", () => {
    const seen = new Set<string>();
    for (const enforcement of ["allow", "advise", "ask", "deny", "continue_work"] as const) {
      const out = toClaudeOutput("PreToolUse", decision({ enforcement, reasons: ["r"] }));
      const perm = out?.hookSpecificOutput?.permissionDecision;
      if (perm !== undefined) seen.add(perm);
    }
    expect(seen).toEqual(new Set(["ask", "deny"]));
  });
});

describe("cross-host direction parity on shared fixtures", () => {
  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    ["PreToolUse deny", "PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf /" } }, "deny"],
    ["PreToolUse benign", "PreToolUse", { tool_name: "Bash", tool_input: { command: "echo hi" } }, "allow"],
    [
      "Stop supported message",
      "Stop",
      { last_assistant_message: "Done. The tests pass." },
      "allow",
    ],
    ["UserPromptSubmit short", "UserPromptSubmit", { prompt: "ok" }, "allow"],
  ];
  it.each(cases)("%s: legacy, Claude mapper, and Muse mapper agree", async (_label, event, input, expected) => {
    const legacy = await runEvent(event, JSON.stringify(input), testDeps());
    expect(claudeDirection(legacy)).toBe(expected);
    const unified = await dispatchEvent(event, input as never, testDeps());
    expect(claudeDirection(toClaudeOutput(event as never, unified))).toBe(expected);
    expect(museDirection(toMuseOutput(event as MuseEvent, unified))).toBe(expected);
  });
});
