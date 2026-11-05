import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleCandidate } from "../../scripts/assemble-candidate.js";
import { assertOutputPathAvailable, writeDeterministicArtifact, writeNewArtifact } from "../../scripts/artifact-output.js";
import { buildMusePackages } from "../../scripts/build-muse-packages.js";

const SOURCE_ROOT = resolve(import.meta.dirname, "..", "..");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "jeverb-output-safety-"));
}

describe("packaging output ownership", () => {
  it("preserves existing measured output and rejects a collision before work starts", () => {
    const dir = tempDir();
    const output = join(dir, "receipts.jsonl");
    try {
      writeFileSync(output, "old measured evidence\n");
      expect(() => assertOutputPathAvailable(output)).toThrow("refusing to overwrite existing output");
      expect(() => writeNewArtifact(output, "new measured evidence\n")).toThrow();
      expect(readFileSync(output, "utf8")).toBe("old measured evidence\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows identical deterministic regeneration and rejects changed content", () => {
    const dir = tempDir();
    const output = join(dir, "dataset.jsonl");
    try {
      expect(writeDeterministicArtifact(output, "stable data\n")).toBe("created");
      expect(writeDeterministicArtifact(output, "stable data\n")).toBe("unchanged");
      expect(() => writeDeterministicArtifact(output, "different data\n")).toThrow("refusing to overwrite differing generated output");
      expect(readFileSync(output, "utf8")).toBe("stable data\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves non-empty custom Muse package output", () => {
    const dir = tempDir();
    const sentinel = join(dir, "user-data.txt");
    try {
      writeFileSync(sentinel, "preserve me\n");
      expect(() => buildMusePackages(dir, SOURCE_ROOT)).toThrow("refusing to replace non-empty custom output directory");
      expect(readFileSync(sentinel, "utf8")).toBe("preserve me\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects source-tree Muse package output before touching the tree", () => {
    expect(() => buildMusePackages(SOURCE_ROOT, SOURCE_ROOT)).toThrow("refusing to write Muse packages inside the source tree");
    expect(existsSync(join(SOURCE_ROOT, "package.json"))).toBe(true);
  });

  it("preserves non-empty install candidate output", () => {
    const dir = tempDir();
    const sentinel = join(dir, "user-data.txt");
    try {
      writeFileSync(sentinel, "preserve me\n");
      expect(() => assembleCandidate(dir, SOURCE_ROOT)).toThrow("refusing to replace non-empty candidate output directory");
      expect(readFileSync(sentinel, "utf8")).toBe("preserve me\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects install candidate output inside the source tree", () => {
    expect(() => assembleCandidate(SOURCE_ROOT, SOURCE_ROOT)).toThrow("refusing to assemble a candidate inside the source tree");
    expect(existsSync(join(SOURCE_ROOT, "package.json"))).toBe(true);
  });
});
