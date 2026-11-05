import { describe, expect, it } from "vitest";
import { runGraphExtractors } from "../../src/graph/extractors.js";
import type { GraphNode, NodeRunContext } from "../../src/graph/executor.js";

function context(output: string, outputAvailable = true): NodeRunContext {
  return {
    results: new Map([["source", {
      nodeId: "source",
      ok: true,
      output,
      outputAvailable,
      attempts: 1,
      status: "succeeded",
      inputHash: "a",
      outputHash: "b",
      outputDigest: "c",
    }]]),
    allResults: new Map(),
    fullOutputs: new Map([["source", output]]),
  };
}

function node(extractor: "json" | "lines", extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "judge",
    kind: "jev",
    question: "Inspect the extracted evidence",
    dependsOn: ["source"],
    extractors: [{ from: "source", as: "data", extractor, ...extra.extractors?.[0] }],
    ...extra,
  };
}

describe("graph Jev extractors", () => {
  it("fails visibly when recovered output content is unavailable", async () => {
    await expect(runGraphExtractors(node("json"), context("{}", false), { workspaceRoot: process.cwd(), timeoutMs: 1000, allowNetwork: false }))
      .rejects.toThrow(/requires available output/);
  });

  it("rejects oversized extractor input instead of truncating evidence", async () => {
    await expect(runGraphExtractors(node("json"), context("x".repeat(65 * 1024)), { workspaceRoot: process.cwd(), timeoutMs: 1000, allowNetwork: false }))
      .rejects.toThrow(/input exceeds 65536 bytes/);
  });

  it("rejects a JSON pointer that does not resolve", async () => {
    await expect(runGraphExtractors({
      ...node("json"),
      extractors: [{ from: "source", as: "data", extractor: "json", pointer: "/missing" }],
    }, context("{\"present\":true}"), { workspaceRoot: process.cwd(), timeoutMs: 1000, allowNetwork: false })).rejects.toThrow(/pointer does not resolve/);
  });

  it("bounds line collection size", async () => {
    await expect(runGraphExtractors({
      ...node("lines"),
      extractors: [{ from: "source", as: "data", extractor: "lines", maxItems: 1 }],
    }, context("first\nsecond\n"), { workspaceRoot: process.cwd(), timeoutMs: 1000, allowNetwork: false })).rejects.toThrow(/limit is 1/);
  });
});
