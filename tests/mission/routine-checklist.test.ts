import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveProvisionalChecklist,
  MAX_ROUTINE_ITEMS,
  readMissionContract,
  readProvisionalChecklist,
  ROUTINE_GUIDANCE_AUTHORITY,
  summarizeRoutineCoverage,
} from "../../src/mission/contract.js";
import { handleUserPromptSubmit } from "../../src/hooks/handlers/user-prompt-submit.js";
import type { HookInput } from "../../src/hooks/types.js";
import { FakeModel, score, choice } from "../helpers/fake-model.js";
import type { Answer } from "../../src/decision/types.js";
import { cleanup, makeDeps, tempDir } from "../hooks/helpers.js";

const PROMPT =
  "Add a daemon to the plugin and wire the http hooks up to it, then measure the latency of each hook";

function answers(): Record<string, Answer> {
  return {
    kind: choice("multi_file_implementation", { multi_file_implementation: 0.97, other: 0.03 }, 0.97),
    ambiguity: score(0.2, ["clear", "a detail open", "materially open"], 0.9),
  };
}

function input(overrides: Partial<HookInput> = {}): HookInput {
  return { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: PROMPT, ...overrides };
}

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  cleanup(dir);
});

describe("provisional routine checklist", () => {
  it("derives a bounded, namespaced, provisional checklist from an ordinary prompt", () => {
    const checklist = deriveProvisionalChecklist("s1", PROMPT, 100);
    expect(checklist).toBeDefined();
    expect(checklist?.source).toBe("provisional-derived");
    expect(checklist?.items.length).toBeGreaterThan(0);
    expect(checklist?.items.length).toBeLessThanOrEqual(MAX_ROUTINE_ITEMS);
    for (const [index, item] of (checklist?.items ?? []).entries()) {
      expect(item.id).toBe(`routine-${String(index + 1).padStart(2, "0")}`);
    }
    // Outside the user-criterion namespace: never confusable with a contract.
    expect(checklist?.items.every((item) => !/^criterion-[0-9]{2}$/.test(item.id))).toBe(true);
    expect(checklist?.checklistId.startsWith("routine-")).toBe(true);
  });

  it("returns undefined for prompts too short to carry task content", () => {
    expect(deriveProvisionalChecklist("s1", "fix it", 100)).toBeUndefined();
    expect(deriveProvisionalChecklist("unknown", PROMPT, 100)).toBeUndefined();
  });

  it("round-trips through the fail-closed reader and rejects criterion-style ids", () => {
    const checklist = deriveProvisionalChecklist("s1", PROMPT, 100)!;
    expect(readProvisionalChecklist(JSON.parse(JSON.stringify(checklist)))).toEqual(checklist);
    expect(readProvisionalChecklist({
      ...checklist,
      items: [{ id: "criterion-01", statement: "smuggled authority" }],
    })).toBeUndefined();
    expect(readProvisionalChecklist({ ...checklist, source: "user-prompt-acceptance-section" })).toBeUndefined();
  });

  it("is never readable as a mission contract", () => {
    const checklist = deriveProvisionalChecklist("s1", PROMPT, 100)!;
    expect(readMissionContract(checklist, "s1")).toBeUndefined();
    expect(readMissionContract({ ...checklist, source: "user-prompt-acceptance-section" }, "s1")).toBeUndefined();
  });

  it("summarises evidence state without ever reporting verification", () => {
    const checklist = deriveProvisionalChecklist("s1", PROMPT, 100)!;
    const missing = summarizeRoutineCoverage(checklist, undefined);
    expect(missing.authority).toBe(ROUTINE_GUIDANCE_AUTHORITY);
    expect(missing.terminalReceipt).toBe(false);
    expect(missing.items.every((item) => item.coverage === "evidence-missing")).toBe(true);
    expect(summarizeRoutineCoverage(checklist, { editsSince: 0, hasCurrentTest: true }).items[0]?.coverage)
      .toBe("evidence-current");
    expect(summarizeRoutineCoverage(checklist, { editsSince: 1, hasCurrentTest: true }).items[0]?.coverage)
      .toBe("evidence-stale");
    expect(JSON.stringify(missing)).not.toContain("verified");
  });

  it("stores provisional guidance for an ordinary prompt without creating a contract", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(answers) });
    await handleUserPromptSubmit(input(), deps);
    const session = deps.store.readSession("s1");
    expect(session.mission_contract).toBeUndefined();
    expect(session.routine_checklist?.source).toBe("provisional-derived");
    expect(session.routine_checklist?.items.length).toBeGreaterThan(0);
  });

  it("an explicit contract supersedes provisional guidance", async () => {
    const deps = makeDeps(dir, { model: new FakeModel(answers) });
    await handleUserPromptSubmit(input(), deps);
    expect(deps.store.readSession("s1").routine_checklist).toBeDefined();
    const contractPrompt =
      "Objective: complete the parser change\nAcceptance criteria:\n- Parser handles the new syntax\n- Tests pass";
    await handleUserPromptSubmit(input({ prompt: contractPrompt }), deps);
    const session = deps.store.readSession("s1");
    expect(session.mission_contract?.source).toBe("user-prompt-acceptance-section");
    expect(session.routine_checklist).toBeUndefined();
  });
});
