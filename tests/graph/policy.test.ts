import { describe, expect, it } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExecutionPolicy, limitsFor, resolveExecutionPolicy, SANDBOX_PROFILES } from "../../src/graph/policy.js";

describe("execution policy profiles", () => {
  it("defaults to the implement profile with a writable workspace", () => {
    const policy = resolveExecutionPolicy({}, "/repo");
    expect(policy.profile).toBe("implement");
    expect(policy.readOnlyWorkspace).toBe(false);
    expect(policy.allowOutputArtifacts).toBe(false);
    expect(limitsFor(policy)).toEqual(SANDBOX_PROFILES.implement);
  });

  it("parses the inspect profile and read-only flag from env", () => {
    const policy = resolveExecutionPolicy({ JEV_GRAPH_SHELL: "allow", JEV_GRAPH_PROFILE: "inspect", JEV_GRAPH_READONLY: "allow" }, "/repo");
    expect(policy.profile).toBe("inspect");
    expect(policy.readOnlyWorkspace).toBe(true);
    expect(limitsFor(policy)).toEqual(SANDBOX_PROFILES.inspect);
  });

  it("rejects unknown profiles to implement (fail-safe default)", () => {
    const policy = resolveExecutionPolicy({ JEV_GRAPH_PROFILE: "unrestricted" }, "/repo");
    expect(policy.profile).toBe("implement");
  });

  it("reads Muse data-dir graph policy with default-deny and environment precedence", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jeverb-graph-policy-"));
    const path = join(dataDir, "config.json");
    writeFileSync(path, JSON.stringify({ graph_shell: "allow", graph_retry: "allow", graph_network: "allow", graph_capture_output: true, graph_profile: "inspect" }), { mode: 0o600 });
    const fromFile = resolveExecutionPolicy({}, "/repo", dataDir);
    expect(fromFile.allowShell).toBe(true);
    expect(fromFile.allowShellRetry).toBe(true);
    expect(fromFile.allowNetwork).toBe(true);
    expect(fromFile.profile).toBe("inspect");
    expect(fromFile.allowOutputArtifacts).toBe(true);
    expect(resolveExecutionPolicy({ JEV_GRAPH_SHELL: "deny" }, "/repo", dataDir).allowShell).toBe(false);
    expect(resolveExecutionPolicy({ JEV_GRAPH_CAPTURE_OUTPUT: "deny" }, "/repo", dataDir).allowOutputArtifacts).toBe(false);

    chmodSync(path, 0o666);
    expect(resolveExecutionPolicy({}, "/repo", dataDir).allowShell).toBe(false);
  });

  it("prefers an explicit operator override over the preset", () => {
    const policy = defaultExecutionPolicy("/repo", {
      resourceLimits: { maxMemoryMb: 64, maxProcesses: 8, maxFileBytes: 1024, maxCpuSeconds: 5 },
    });
    expect(limitsFor(policy)).toEqual({ maxMemoryMb: 64, maxProcesses: 8, maxFileBytes: 1024, maxCpuSeconds: 5 });
    expect(policy.profile).toBe("implement");
  });
});
