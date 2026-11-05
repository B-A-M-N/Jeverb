import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleCandidate, candidateDigest } from "../../scripts/assemble-candidate.js";
import { buildMusePackages } from "../../scripts/build-muse-packages.js";
import { checkCandidate } from "../../scripts/plugin-integrity-check.js";
import { loadReviewConfig } from "../../src/review/load-config.js";

const SOURCE_ROOT = resolve(import.meta.dirname, "..", "..");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "jeverb-packaging-"));
}

describe("install candidate packaging", () => {
  it("builds the jeverb runtime and jev command alias as separate plugin roots", () => {
    const dir = tempDir();
    try {
      buildMusePackages(dir, SOURCE_ROOT);
      const main = JSON.parse(readFileSync(join(dir, "jeverb", ".muse-plugin/plugin.json"), "utf8")) as { name: string };
      const alias = JSON.parse(readFileSync(join(dir, "jev", ".muse-plugin/plugin.json"), "utf8")) as { name: string };
      expect(main.name).toBe("jeverb");
      expect(alias.name).toBe("jev");
      expect(readFileSync(join(dir, "jeverb", "plugin/dist/hook.mjs"), "utf8")).toContain("UserPromptSubmit");
      const offCommand = readFileSync(join(dir, "jev", "commands/off.md"), "utf8");
      expect(offCommand).toContain("trusted operator-origin evidence");
      expect(offCommand).toContain("refuses to change state");
      expect(existsSync(join(dir, "jeverb", "jev-control-plugin"))).toBe(false);
      expect(existsSync(join(dir, "jev", "plugin"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses non-empty custom output without deleting its contents", () => {
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

  it("refuses source-tree output paths before touching repository files", () => {
    expect(() => buildMusePackages(SOURCE_ROOT, SOURCE_ROOT)).toThrow("refusing to write Muse packages inside the source tree");
    expect(existsSync(join(SOURCE_ROOT, "package.json"))).toBe(true);
  });

  it("refuses to replace non-empty candidate output and preserves its contents", () => {
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

  it("refuses candidate output inside the source tree", () => {
    expect(() => assembleCandidate(SOURCE_ROOT, SOURCE_ROOT)).toThrow("refusing to assemble a candidate inside the source tree");
    expect(existsSync(join(SOURCE_ROOT, "package.json"))).toBe(true);
  });

  it("ships command registrations and exact command files for both Muse namespaces", () => {
    const dir = tempDir();
    try {
      const manifest = assembleCandidate(dir, SOURCE_ROOT);
      const paths = new Set(manifest.entries.map((entry) => entry.path));
      expect(paths.has("plugin/commands/off.md")).toBe(true);
      expect(paths.has("plugin/commands/on.md")).toBe(true);
      expect(paths.has("jev-control-plugin/.muse-plugin/plugin.json")).toBe(true);
      expect(paths.has("jev-control-plugin/commands/off.md")).toBe(true);
      expect(paths.has("jev-control-plugin/commands/on.md")).toBe(true);
      const native = JSON.parse(readFileSync(join(dir, ".muse-plugin/plugin.json"), "utf8"));
      const alias = JSON.parse(readFileSync(join(dir, "jev-control-plugin/.muse-plugin/plugin.json"), "utf8"));
      expect(native.capabilities.commands).toEqual([]);
      expect(alias.name).toBe("jev");
      expect(alias.capabilities.commands).toEqual([{ id: "off", path: "commands/off.md" }, { id: "on", path: "commands/on.md" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assembles byte-exact review files and a stable digest", () => {
    const first = tempDir();
    const second = tempDir();
    try {
      const manifest = assembleCandidate(first, SOURCE_ROOT);
      const reviewFiles = manifest.entries.filter((entry) => entry.path.startsWith("config/review/")).map((entry) => entry.path).sort();
      expect(reviewFiles).toEqual(["config/review/checks.json", "config/review/policy.json"]);
      for (const rel of reviewFiles) {
        expect(readFileSync(join(first, rel), "utf8")).toBe(readFileSync(join(SOURCE_ROOT, rel), "utf8"));
      }
      // No symlinks, no surprises: every entry is a regular file under the root.
      expect(manifest.entries.length).toBeGreaterThan(10);
      expect(manifest.entries.every((entry) => !entry.path.includes(".."))).toBe(true);
      const again = assembleCandidate(second, SOURCE_ROOT);
      expect(candidateDigest(again)).toBe(candidateDigest(manifest));
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("passes integrity on a fresh assembly", () => {
    const dir = tempDir();
    try {
      assembleCandidate(dir, SOURCE_ROOT);
      expect(checkCandidate(dir, SOURCE_ROOT)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a candidate missing either review file", () => {
    const dir = tempDir();
    try {
      assembleCandidate(dir, SOURCE_ROOT);
      rmSync(join(dir, "config", "review", "policy.json"));
      const problems = checkCandidate(dir, SOURCE_ROOT);
      expect(problems.some((problem) => problem.includes("config/review/policy.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a candidate whose review bytes differ from the source checkout", () => {
    const dir = tempDir();
    try {
      assembleCandidate(dir, SOURCE_ROOT);
      writeFileSync(join(dir, "config", "review", "policy.json"), JSON.stringify({ policy_version: "1", thresholds: { block: 0.5, security_review: 0.4 } }));
      const problems = checkCandidate(dir, SOURCE_ROOT);
      expect(problems.some((problem) => problem.includes("inconsistently sourced"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never substitutes the working directory for a root without review config", () => {
    // The vitest process runs with CWD at the repo root, which HAS valid
    // review files. An explicit root without them must still report absent.
    const empty = tempDir();
    try {
      const loaded = loadReviewConfig([empty]);
      expect(loaded.status).toBe("absent");
      expect(loaded.source).toBeUndefined();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("resolves an installed-style package from its own root", () => {
    const dir = tempDir();
    try {
      assembleCandidate(dir, SOURCE_ROOT);
      const loaded = loadReviewConfig([dir]);
      expect(loaded.source).toContain(dir);
      expect(loaded.status).toBe("uncalibrated");
      expect(loaded.calibration).toMatchObject({ backend: "typesafe", model: "jev-1.14.0", calibrated: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
