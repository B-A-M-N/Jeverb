import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeModel } from "../helpers/fake-model.js";
import { cleanup, makeDeps, tempDir } from "./helpers.js";
import { HANDLERS, MODES, RESPONSES, TOOLS, fuzzInput } from "./never-allow-matrix.fixtures.js";

describe("no handler output contains allow, and none asks by default", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => cleanup(dir));

  // Every handler × mode × tool × answer combination remains covered, but
  // separate answer-shape tasks keep Vitest's worker update calls responsive.
  for (const [responseIndex, responder] of RESPONSES.entries()) {
    it(`holds across every handler, mode and tool (answer shape ${responseIndex + 1})`, async () => {
      const deps = makeDeps(dir, {
        model: new FakeModel(() => responder()),
        config: { routePrompts: true },
      });
      let checked = 0;
      for (const [name, handler] of HANDLERS) {
        for (const mode of MODES) {
          for (const [tool, toolInput] of TOOLS) {
            deps.store.updateSession("s1", (state) => ({ ...state, prompts: ["do the thing"], stop_blocks: 0 }));
            const output = await handler(fuzzInput(name, mode, tool, toolInput), deps);
            const serialized = JSON.stringify(output ?? null);
            expect(serialized, `${name}/${mode}/${tool}`).not.toContain('"allow"');
            expect(serialized, `${name}/${mode}/${tool}`).not.toContain('permissionDecision":"allow');
            const decision = output?.hookSpecificOutput?.permissionDecision;
            if (decision !== undefined) expect(decision, `${name}/${mode}/${tool}`).toBe("deny");
            checked += 1;
          }
        }
      }
      expect(checked).toBe(HANDLERS.length * MODES.length * TOOLS.length);
    });
  }
});
