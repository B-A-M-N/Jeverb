import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchEvent } from "../../src/hooks/unified.js";
import { runEvent } from "../../src/hooks/dispatch.js";
import { buildDeps } from "../../src/hooks/main.js";
import { loadHookConfig } from "../../src/hooks/config.js";
import { ReviewService } from "../../src/review/service.js";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import type { HookOutput } from "../../src/hooks/types.js";
import type { UnifiedDecision } from "../../src/decision/types.js";
import { testHookConfig } from "../helpers/control-state.js";
import { testLedgerForFile } from "../helpers/control-state.js";

/**
 * Legacy (Claude command/daemon) vs unified (Muse) conformance.
 *
 * Both paths run the same HANDLERS, so a legacy verdict must never change
 * direction through the unified wrapper: deny stays deny, ask stays ask, a
 * block stays a block, silence stays silence — unless the case is one of the
 * two documented unified-only additions (router advisory fallback,
 * empty-deliverable gate), which are asserted as divergences, not drift.
 */

function testDeps() {
  const config = testHookConfig(mkdtempSync(join(tmpdir(), "jeverb-parity-data-")));
  const base = buildDeps(config, null);
  const review = new ReviewService(null, {
    checks: [],
    policy: { policy_version: "1", thresholds: { block: 0.85, security_review: 0.6 } },
  });
  const ledger = testLedgerForFile(join(mkdtempSync(join(tmpdir(), "jeverb-parity-")), "evidence.log"));
  return { ...base, review, ledger };
}

/** Collapse a legacy output to its enforcement direction. */
function legacyDirection(output: HookOutput | undefined): string {
  if (!output) return "allow";
  if (output.decision === "block") return "continue_work";
  const perm = output.hookSpecificOutput?.permissionDecision;
  if (perm === "deny") return "deny";
  if (perm === "ask") return "ask";
  if (output.hookSpecificOutput?.additionalContext ?? output.systemMessage) return "advise";
  return "allow";
}

function unifiedDirection(decision: UnifiedDecision | undefined): string {
  return decision?.enforcement ?? "allow";
}

const LONG_PROMPT =
  "please refactor the authentication module to support rotating keys, and migrate the session store";

describe("legacy vs unified parity", () => {
  it.each([
    ["PreToolUse deny", "PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf /" } }, "deny"],
    ["PreToolUse benign", "PreToolUse", { tool_name: "Bash", tool_input: { command: "echo hi" } }, "allow"],
    ["Stop supported message", "Stop", { last_assistant_message: "Done. The tests pass." }, "allow"],
    ["UserPromptSubmit short", "UserPromptSubmit", { prompt: "ok" }, "allow"],
  ])("%s agrees", async (_label, event, input, expected) => {
    const deps = testDeps();
    const legacy = await runEvent(event, JSON.stringify(input), deps);
    expect(legacyDirection(legacy)).toBe(expected);
    expect(unifiedDirection(await dispatchEvent(event, input as never, testDeps()))).toBe(expected);
  });

  it("documents the router advisory as an intentional divergence", async () => {
    const input = { prompt: LONG_PROMPT };
    expect(legacyDirection(await runEvent("UserPromptSubmit", JSON.stringify(input), testDeps()))).toBe("allow");
    const deps = testDeps();
    deps.config.routePrompts = true;
    expect(unifiedDirection(await dispatchEvent("UserPromptSubmit", input as never, deps))).toBe("advise");
  });

  it("documents the empty-deliverable gate as an intentional divergence", async () => {
    // SubagentStop is observable-only on an empty parent-facing message;
    // only Stop enforces the empty-deliverable gate.
    const input = { session_id: `parity-${Date.now()}-${Math.random()}`, last_assistant_message: "   " };
    expect(legacyDirection(await runEvent("SubagentStop", JSON.stringify(input), testDeps()))).toBe("allow");
    expect(unifiedDirection(await dispatchEvent("SubagentStop", input as never, testDeps()))).toBe("allow");
    const stopInput = { session_id: `parity-${Date.now()}-${Math.random()}`, last_assistant_message: "" };
    expect(unifiedDirection(await dispatchEvent("Stop", stopInput as never, testDeps()))).toBe("continue_work");
  });
});
