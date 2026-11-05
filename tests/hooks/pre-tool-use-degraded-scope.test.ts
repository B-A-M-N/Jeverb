/**
 * FM2 regression: a degraded session read must never silently enable
 * `ignoreScope` in PreToolUse.
 *
 * `store.readSession` degrades a corrupt/truncated session file to an empty
 * session. Empty prompts mean `userRequest === undefined`, which sets
 * `ignoreScope: true` — indistinguishable in the log from a session that
 * genuinely recorded no prompts. The handler now reads via
 * `readSessionDetailed` and names the degradation on the decision record
 * (`storeDegraded`/`storeDegradedReason`, mirroring handlers/stop.ts) while
 * leaving the allow/ask/deny outcome untouched.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Answer } from "../../src/decision/types.js";
import { handlePreToolUse } from "../../src/hooks/handlers/pre-tool-use.js";
import type { HookInput } from "../../src/hooks/types.js";
import { FakeModel, noul, score } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";

const NO = 0.02;
const NOW = 1_700_000_000_000;

function scopeAnswer(inScope: number): Answer {
  const answer = score(inScope, ["unrelated", "ordinary step", "requested"], 0.9) as Answer & {
    probabilities?: Record<string, number>;
  };
  answer.probabilities = { "0": 1 - inScope, "1": inScope, "2": 0 };
  return answer;
}

/** Out-of-scope, non-destructive: judged, but the table still allows. */
const OUT_OF_SCOPE = (): Record<string, Answer> => {
  return {
    destructive: noul(NO),
    outward_facing: noul(NO),
    credential_exposure: noul(NO),
    mentions_target: noul(0.05),
    same_task_area: noul(NO),
    scope: scopeAnswer(NO),
    blast_radius: score(0, ["none", "local", "shared", "production"], 0.9),
  };
}

function input(overrides: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "s1",
    cwd: "/home/dev/project",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "curl -X POST https://example.com/pay" },
    tool_use_id: "toolu_1",
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  cleanup(dir);
});

function corruptSession(dataDir: string, sessionId: string, bytes: string): void {
  writeFileSync(join(dataDir, "sessions", `${sessionId}.json`), bytes, "utf8");
}

describe("FM2 — degraded session read is named, never silent", () => {
  it("a corrupt session file keeps the allow outcome but records storeDegraded", async () => {
    const model = new FakeModel(OUT_OF_SCOPE);
    const deps = makeDeps(dir, { model, now: NOW });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["fix the failing date parser test"] }));
    corruptSession(deps.config.dataDir, "s1", "not json{{{");

    const output = await handlePreToolUse(input(), deps);
    expect(output?.hookSpecificOutput).toBeUndefined();
    expect(model.calls).toHaveLength(1);

    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("allow");
    // Scope is still ignored — the prompts are genuinely unavailable — but
    // the record says why, so this is no longer silent scope-blindness.
    expect(record?.policy?.ignore_scope).toBe(true);
    expect(record?.scope_source).toBe("none");
    expect(record?.storeDegraded).toBe(true);
    expect(record?.storeDegradedReason).toBe("corrupt");
  });

  it("a truncated session file is named degraded too", async () => {
    const model = new FakeModel(OUT_OF_SCOPE);
    const deps = makeDeps(dir, { model, now: NOW });
    deps.store.updateSession("s1", (s) => ({ ...s, prompts: ["fix the failing date parser test"] }));
    corruptSession(deps.config.dataDir, "s1", '{"prompts": ["fix the failing');

    await handlePreToolUse(input(), deps);

    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("allow");
    expect(record?.policy?.ignore_scope).toBe(true);
    expect(record?.storeDegraded).toBe(true);
    expect(record?.storeDegradedReason).toBe("corrupt");
  });

  it("a genuinely promptless session stays non-degraded (no false signal)", async () => {
    const model = new FakeModel(OUT_OF_SCOPE);
    const deps = makeDeps(dir, { model, now: NOW });

    await handlePreToolUse(input(), deps);

    const record = deps.store.readLog().at(-1);
    expect(record?.decision).toBe("allow");
    expect(record?.policy?.ignore_scope).toBe(true);
    expect(record?.scope_source).toBe("none");
    expect(record?.storeDegraded).toBeUndefined();
    expect(record?.storeDegradedReason).toBeUndefined();
  });
});
