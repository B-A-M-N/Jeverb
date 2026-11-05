import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";
import { HANDLERS, MODES, RESPONSES, TOOLS, fuzzInput } from "./never-allow-matrix.fixtures.js";

const asked: string[] = [];

describe("ask_on_trip only escalates interactive pre-tool tripwires", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => cleanup(dir));

  for (const [responseIndex, responder] of RESPONSES.entries()) {
    it(`checks every handler, mode and tool (answer shape ${responseIndex + 1})`, async () => {
      const deps = makeDeps(dir, {
        model: new FakeModel(() => responder()),
        config: { routePrompts: true, askOnTrip: true },
      });
      for (const [name, handler] of HANDLERS) {
        for (const mode of MODES) {
          for (const [tool, toolInput] of TOOLS) {
            deps.store.updateSession("s1", (state) => ({ ...state, prompts: ["do the thing"], stop_blocks: 0 }));
            const output = await handler(fuzzInput(name, mode, tool, toolInput), deps);
            const decision = output?.hookSpecificOutput?.permissionDecision;
            if (decision === undefined) continue;
            expect(["ask", "deny"], `${name}/${mode}/${tool}`).toContain(decision);
            if (decision !== "ask") continue;
            asked.push(`${name}/${mode}/${tool}`);
            expect(name, `${name} may not ask`).toBe("PreToolUse");
            expect(["dontAsk", "bypassPermissions"], mode).not.toContain(mode);
            expect(output?.hookSpecificOutput?.permissionDecisionReason, `${name}/${mode}/${tool}`).toContain("[jev] tripwire");
          }
        }
      }
    });
  }

  it("keeps the interactive tripwire escalation path reachable", () => {
    expect(asked.length).toBeGreaterThan(0);
  });
});
