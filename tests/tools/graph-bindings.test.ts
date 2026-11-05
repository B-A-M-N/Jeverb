import { describe, expect, it } from "vitest";
import {
  expandPointer,
  MAX_BINDING_VALUE_CHARS,
  policyHash,
  selectOutput,
} from "../../src/tools/graph-bindings.js";
import type { ExecutionPolicy } from "../../src/graph/policy.js";

const policy = (overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy => ({
  allowShell: true,
  workspaceRoot: "/tmp/ws",
  maxParallelShells: 4,
  nodeTimeoutMs: 60_000,
  graphTimeoutMs: 300_000,
  denyPrivileged: true,
  allowShellRetry: false,
  allowOutputArtifacts: false,
  allowNetwork: false,
  profile: "inspect",
  resourceLimits: { maxMemoryMb: 512, maxProcesses: 16, maxFileBytes: 1024, maxCpuSeconds: 60 },
  readOnlyWorkspace: true,
  ...overrides,
});

describe("graph bindings", () => {
  it("selects whole output without a pointer", () => {
    expect(selectOutput("hello")).toBe("hello");
  });

  it("resolves JSON pointers with escapes", () => {
    expect(selectOutput(`{"a/b": {"~key": 7}}`, "/a~1b/~0key")).toBe("7");
    expect(selectOutput(`[10, 20]`, "/1")).toBe("20");
  });

  it("rejects missing pointers and non-JSON output", () => {
    expect(() => selectOutput(`{"a": 1}`, "/b")).toThrow(/does not exist/);
    expect(() => selectOutput("plain", "/a")).toThrow(/not valid JSON/);
  });

  it("expands values for dynamic subgraphs", () => {
    expect(expandPointer(`{"items": [1, 2]}`, "/items")).toEqual([1, 2]);
    expect(() => expandPointer("plain", undefined)).toThrow(/not valid JSON/);
    expect(() => expandPointer(`{"a": 1}`, "/b")).toThrow(/does not exist/);
  });

  it("fingerprints behavior-affecting policy, so different policies never share a hash", () => {
    expect(policyHash(policy())).toBe(policyHash(policy()));
    expect(policyHash(policy())).not.toBe(policyHash(policy({ allowShell: false })));
    expect(policyHash(policy())).toHaveLength(64);
    expect(MAX_BINDING_VALUE_CHARS).toBe(64 * 1024);
  });
});
