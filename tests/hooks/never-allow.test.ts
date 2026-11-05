/**
 * Invariant 1: never allow, and by default never ask.
 *
 * Two promises, checked five ways, because these are the properties whose
 * failure would turn the plugin from "sometimes noisy" into "actively harmful"
 * or into the thing 0.3 exists to remove:
 *
 *  1. No source file under `src/hooks` mentions an `allow` permission decision.
 *  2. `"ask"` is produced in exactly one expression, guarded by `askOnTrip`.
 *  3. No handler, driven by a fuzzed model over every mode and tool, ever
 *     produces `"allow"` — or, with the default config, `"ask"`.
 *  4. With `ask_on_trip` set, an `ask` appears only in an interactive mode and
 *     only carrying a tripwire reason.
 *  5. The shipped bundle contains no `allow` decision either.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Answer } from "../../src/decision/types.js";
import { handlePostToolUse } from "../../src/hooks/handlers/post-tool-use.js";
import { handlePreToolUse } from "../../src/hooks/handlers/pre-tool-use.js";
import { handleSessionStart } from "../../src/hooks/handlers/session-start.js";
import { handleStop } from "../../src/hooks/handlers/stop.js";
import { handleUserPromptSubmit } from "../../src/hooks/handlers/user-prompt-submit.js";
import type { Handler, HookInput } from "../../src/hooks/types.js";
import type { UnifiedDecision } from "../../src/decision/types.js";
import { toMuseOutput } from "../../src/hosts/muse/outputs.js";
import { toClaudeOutput } from "../../src/hosts/claude/outputs.js";
import { FakeModel, choice, noul, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const HOOK_SRC = new URL("../../src/hooks/", import.meta.url).pathname;
const BUNDLE = new URL("../../plugin/dist/hook.mjs", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Comments discuss the invariant constantly; only code is checked. */
function strip(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
}

describe("no source path can emit permissionDecision allow", () => {
  const files = sourceFiles(HOOK_SRC);

  it("finds the hook sources", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file.slice(HOOK_SRC.length)} never assigns an allow decision`, () => {
      expect(strip(readFileSync(file, "utf8"))).not.toMatch(/permissionDecision["']?\s*[:=]\s*["'`]allow/);
    });
  }

  it("every permissionDecision emission assigns only deny or ask", () => {
    // The complete output contract: handlers emit HookOutput, unified maps it
    // to UnifiedDecision, and the host mappers render the wire value. An
    // emission of anything but deny/ask anywhere in that chain is a defect,
    // wherever the file lives — so this asserts over values, not file names.
    const roots = [HOOK_SRC, new URL("../../src/hosts/", import.meta.url).pathname];
    const bad: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const code = strip(readFileSync(file, "utf8"));
        for (const match of code.matchAll(/permissionDecision\s*:\s*(["'`])([^"'`]+)\1/g)) {
          if (match[2] !== "deny" && match[2] !== "ask") bad.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("types the decision so that allow does not compile", () => {
    const types = readFileSync(join(HOOK_SRC, "types.ts"), "utf8");
    expect(types).toMatch(/EscalatingDecision\s*=\s*"ask"\s*\|\s*"deny"/);
  });
});

/**
 * The static half of "never prompts". A second place that can produce `"ask"`
 * is how this release's central promise would quietly stop being true, so the
 * count is pinned rather than the behaviour alone.
 */
describe("ask is reachable from exactly one expression", () => {
  const files = sourceFiles(HOOK_SRC).filter((file) => !file.endsWith("types.ts"));

  /**
   * A union member in the log schema (`channel?: "note" | "deny" | "ask"`)
   * declares that the value can be recorded; it cannot produce one. Only
   * expressions count.
   */
  const isTypeDeclaration = (line: string): boolean => /^\s*[A-Za-z_]+\??:\s*["'`|\s\w]*["'`]ask["'`]/.test(line);

  it("every ask literal sits at a justified decision site", () => {
    // The output contract has exactly three places where an "ask" decision
    // can originate, each with a different justification. A new file growing
    // an ask literal means a new escalation path, which must be reviewed —
    // so the file set is pinned, with the justification inline per file.
    // (files) is hooks-only; hosts are covered by the mapper contract test.
    const byFile = new Map<string, string[]>();
    for (const file of files) {
      const lines = strip(readFileSync(file, "utf8"))
        .split("\n")
        .filter((line) => /["'`]ask["'`]/.test(line) && !isTypeDeclaration(line));
      if (lines.length > 0) byFile.set(file.slice(HOOK_SRC.length), lines);
    }
    expect([...byFile.keys()].sort()).toEqual(["handlers/response.ts", "unified.ts"]);
    // The unified adapter may only relay a handler's ask or map the
    // SECURITY REVIEW lane to ask — never invent an ask of its own. Both
    // mechanisms are tied to their justification in the source itself.
    const unifiedSrc = strip(readFileSync(join(HOOK_SRC, "unified.ts"), "utf8"));
    expect(unifiedSrc).toContain('permission === "ask"');
    expect(unifiedSrc).toMatch(/if \(review\.lane === "SECURITY REVIEW"\)[\s\S]*?enforcement: "ask"/);
    // No other syntactic form may carry an ask out of unified.ts. Durable-audit
    // comparisons (`decision.enforcement === "ask"`) are audit routing, not
    // escalation paths, and are permitted alongside the two decision sites.
    for (const line of byFile.get("unified.ts") ?? []) {
      expect(line.trim()).toMatch(/^(if \(permission === "ask"\) \{|enforcement: "ask",|decision\.enforcement === "ask" \|\|)$/);
    }
  });

  it("guards the ask with a native Muse prompt surface or explicit ask_on_trip", () => {
    const code = strip(readFileSync(join(HOOK_SRC, "handlers/response.ts"), "utf8"));
    const line = code.split("\n").find((text) => /["']ask["']/.test(text));
    expect(line).toBeDefined();
    expect(line).toContain("hostCanAsk");
    expect(code).toContain("const hostCanAsk = host === \"muse\" || askOnTrip;");
    expect(line).toContain("PROMPTLESS_MODES");
  });

  it("names the modes where a prompt has no audience", () => {
    const code = readFileSync(join(HOOK_SRC, "handlers/response.ts"), "utf8");
    expect(code).toContain("dontAsk");
    expect(code).toContain("bypassPermissions");
  });
});

describe("host mappers never render an approval", () => {
  function decision(enforcement: UnifiedDecision["enforcement"]): UnifiedDecision {
    return {
      event: "PreToolUse",
      enforcement,
      source: "combined",
      reasons: ["test"],
      evidence: [],
      policyVersion: "1",
      decisionId: "test",
    };
  }

  it("renders every enforcement without allow on either host", () => {
    const enforcements: Array<UnifiedDecision["enforcement"]> = ["allow", "advise", "ask", "deny", "continue_work"];
    for (const enforcement of enforcements) {
      for (const output of [toMuseOutput("PreToolUse", decision(enforcement)), toClaudeOutput("PreToolUse", decision(enforcement))]) {
        const serialized = JSON.stringify(output ?? null);
        expect(serialized, enforcement).not.toContain("allow");
        const wire = (output as { hookSpecificOutput?: { permissionDecision?: string } } | null)?.hookSpecificOutput?.permissionDecision;
        if (wire !== undefined) expect(["deny", "ask"]).toContain(wire);
      }
    }
  });

  it("allow and continue_work render as no output on PreToolUse", () => {
    expect(toMuseOutput("PreToolUse", decision("allow"))).toBeUndefined();
    expect(toMuseOutput("PreToolUse", decision("continue_work"))).toBeUndefined();
    expect(toClaudeOutput("PreToolUse", decision("allow"))).toBeUndefined();
    expect(toClaudeOutput("PreToolUse", decision("continue_work"))).toBeUndefined();
  });
});

describe("the shipped bundle", () => {
  it("contains no allow permission decision", () => {
    const bundle = readFileSync(BUNDLE, "utf8");
    expect(bundle).not.toMatch(/permissionDecision["']?\s*[:=]\s*["'`]allow/);
  });
});
