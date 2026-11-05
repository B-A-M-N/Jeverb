import { spawnSync } from "node:child_process";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleCandidate } from "../../scripts/assemble-candidate.js";
import { checkCandidate } from "../../scripts/plugin-integrity-check.js";

const SOURCE_ROOT = resolve(import.meta.dirname, "..", "..");

describe("candidate integrity path resolution", () => {
  it("accepts a valid candidate addressed relative to the current working directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-relative-candidate-"));
    const candidate = join(parent, "candidate");
    assembleCandidate(candidate, SOURCE_ROOT);

    expect(checkCandidate(relative(process.cwd(), candidate), SOURCE_ROOT)).toEqual([]);
  });

  it("accepts the same relative path through the integrity CLI", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-relative-candidate-cli-"));
    const candidate = join(parent, "candidate");
    assembleCandidate(candidate, SOURCE_ROOT);

    const result = spawnSync(process.execPath, [
      "--import", "tsx", join(SOURCE_ROOT, "scripts/plugin-integrity-check.ts"),
      "--candidate", relative(SOURCE_ROOT, candidate),
    ], { cwd: SOURCE_ROOT, encoding: "utf8", timeout: 10_000 });

    expect(result.status).toBe(0);
    expect(result.stdout, JSON.stringify({ stdout: result.stdout, stderr: result.stderr, error: result.error })).toContain("candidate integrity ok");
  });
});
