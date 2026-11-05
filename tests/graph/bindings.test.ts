import { describe, expect, it } from "vitest";
import { validateGraph } from "../../src/graph/executor.js";

describe("explicit graph output bindings", () => {
  const producer = { id: "produce", kind: "shell" as const, command: "printf data" };
  const consumer = {
    id: "consume",
    kind: "shell" as const,
    command: "printf '%s' \"$JIVE_REF_VALUE\"",
    dependsOn: ["produce"],
    bindings: [{ from: "produce", as: "VALUE", pointer: "/value" }],
  };

  it("accepts bounded references from declared dependencies", () => {
    expect(validateGraph({ version: 1, nodes: [producer, consumer] })).toEqual([]);
  });

  it("rejects undeclared sources, invalid variable names, and malformed JSON pointers", () => {
    expect(validateGraph({
      version: 1,
      nodes: [{ ...consumer, bindings: [{ from: "other", as: "VALUE" }] }],
    })).toContain("node consume binding VALUE must reference a declared dependency");
    expect(validateGraph({
      version: 1,
      nodes: [{ ...consumer, bindings: [{ from: "produce", as: "PATH;RM" }] }],
    })).toContain('node consume has invalid binding name "PATH;RM"');
    expect(validateGraph({
      version: 1,
      nodes: [{ ...consumer, bindings: [{ from: "produce", as: "VALUE", pointer: "/value/~2" }] }],
    })).toContain("node consume binding VALUE JSON pointer has an invalid escape");
  });

  it("rejects bindings on non-shell nodes", () => {
    expect(validateGraph({
      version: 1,
      nodes: [{ id: "judge", kind: "jev", question: "is it?", dependsOn: ["produce"], bindings: [{ from: "produce", as: "VALUE" } as never], }, producer],
    })).toContain("node judge output bindings are only supported on shell nodes");
  });
});
