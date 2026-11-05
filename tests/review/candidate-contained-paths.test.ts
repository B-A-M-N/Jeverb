import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleCandidate } from "../../scripts/assemble-candidate.js";
import { checkCandidate } from "../../scripts/plugin-integrity-check.js";

const SOURCE_ROOT = resolve(import.meta.dirname, "..", "..");

describe("candidate path integrity", () => {
  it("rejects a hook bundle path that escapes the candidate root", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-candidate-escape-"));
    const candidate = join(parent, "candidate");
    assembleCandidate(candidate, SOURCE_ROOT);
    const manifestPath = join(candidate, ".muse-plugin/plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      capabilities: {
        hooks: Array<{ id: string; command: string[] }>;
        mcpServers: Array<{ id: string; command: string[] }>;
      };
    };
    const hook = manifest.capabilities.hooks[0];
    if (hook === undefined) throw new Error("assembled candidate has no hooks");
    hook.command[1] = relative(candidate, join(SOURCE_ROOT, "README.md"));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const problems = checkCandidate(candidate, SOURCE_ROOT);

    expect(problems.some((problem) => problem.includes("candidate hook") && problem.includes("escapes package root"))).toBe(true);
  });

  it("rejects an MCP bundle path that escapes the candidate root", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-candidate-mcp-escape-"));
    const candidate = join(parent, "candidate");
    assembleCandidate(candidate, SOURCE_ROOT);
    const manifestPath = join(candidate, ".muse-plugin/plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      capabilities: { mcpServers: Array<{ id: string; command: string[] }> };
    };
    const server = manifest.capabilities.mcpServers[0];
    if (server === undefined) throw new Error("assembled candidate has no MCP servers");
    server.command[1] = relative(candidate, join(SOURCE_ROOT, "README.md"));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const problems = checkCandidate(candidate, SOURCE_ROOT);

    expect(problems.some((problem) => problem.includes("candidate mcp server") && problem.includes("escapes package root"))).toBe(true);
  });

  it("rejects a runtime bundle symlink that resolves outside the candidate", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-candidate-symlink-"));
    const candidate = join(parent, "candidate");
    assembleCandidate(candidate, SOURCE_ROOT);
    const bundle = join(candidate, "plugin/dist/hook.mjs");
    const mcpBundle = join(candidate, "plugin/dist/mcp.mjs");
    unlinkSync(bundle);
    symlinkSync(join(SOURCE_ROOT, "plugin/dist/hook.mjs"), bundle);
    unlinkSync(mcpBundle);
    symlinkSync(join(SOURCE_ROOT, "plugin/dist/mcp.mjs"), mcpBundle);

    const problems = checkCandidate(candidate, SOURCE_ROOT);

    expect(problems).toContain("candidate contains a symlink: plugin/dist/hook.mjs");
    expect(problems).toContain("candidate contains a symlink: plugin/dist/mcp.mjs");
  });
});
