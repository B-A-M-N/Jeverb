import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMusePackages } from "../../scripts/build-muse-packages.js";

function makeIncompleteSource(parent: string): string {
  const source = join(parent, "source");
  mkdirSync(join(source, ".muse-plugin"), { recursive: true });
  mkdirSync(join(source, "plugin"), { recursive: true });
  mkdirSync(join(source, "skills"), { recursive: true });
  mkdirSync(join(source, "config/review"), { recursive: true });
  writeFileSync(join(source, ".muse-plugin/plugin.json"), "{}\n");
  writeFileSync(join(source, "plugin/entry.js"), "export {};\n");
  writeFileSync(join(source, "README.md"), "source\n");
  return source;
}

function deadBuilderPid(): number {
  for (let pid = 2_000_000_000; pid < 2_000_000_100; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find a dead builder PID for recovery fixture");
}

describe("Muse package build failure lifecycle", () => {
  it("preserves the last package when a required source file is missing", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-muse-package-failure-"));
    const source = makeIncompleteSource(parent);
    const output = join(source, "dist/muse-plugins");
    const previous = join(output, "jeverb/previous-package.txt");
    mkdirSync(join(output, "jeverb"), { recursive: true });
    writeFileSync(previous, "last good package\n");

    expect(() => buildMusePackages(output, source)).toThrow(/missing Muse package input/);

    expect(existsSync(previous)).toBe(true);
    expect(readFileSync(previous, "utf8")).toBe("last good package\n");
    expect(readdirSync(join(source, "dist"))).toEqual(["muse-plugins"]);
  });

  it("restores a previous package after interruption between the two renames", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-muse-package-recover-"));
    const source = makeIncompleteSource(parent);
    const output = join(source, "dist/muse-plugins");
    const stage = join(source, "dist", `.muse-plugins.stage-${deadBuilderPid()}-interrupted`);
    const backup = `${stage}.previous`;
    mkdirSync(join(stage, "jeverb"), { recursive: true });
    writeFileSync(join(stage, "partial.txt"), "partial new package\n");
    mkdirSync(join(backup, "jeverb"), { recursive: true });
    const previous = join(backup, "jeverb/previous-package.txt");
    writeFileSync(previous, "last good package\n");

    expect(() => buildMusePackages(output, source)).toThrow(/missing Muse package input/);

    expect(readFileSync(join(output, "jeverb/previous-package.txt"), "utf8")).toBe("last good package\n");
    expect(existsSync(stage)).toBe(false);
    expect(existsSync(backup)).toBe(false);
    expect(readdirSync(join(source, "dist"))).toEqual(["muse-plugins"]);
  });

  it("reaps the old backup after interruption following package promotion", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-muse-package-reap-"));
    const source = makeIncompleteSource(parent);
    const output = join(source, "dist/muse-plugins");
    const stage = join(source, "dist", `.muse-plugins.stage-${deadBuilderPid()}-interrupted`);
    const backup = `${stage}.previous`;
    mkdirSync(join(output, "jeverb"), { recursive: true });
    writeFileSync(join(output, "jeverb/current-package.txt"), "published package\n");
    mkdirSync(join(backup, "jeverb"), { recursive: true });
    writeFileSync(join(backup, "jeverb/previous-package.txt"), "old package\n");

    expect(() => buildMusePackages(output, source)).toThrow(/missing Muse package input/);

    expect(readFileSync(join(output, "jeverb/current-package.txt"), "utf8")).toBe("published package\n");
    expect(existsSync(backup)).toBe(false);
    expect(readdirSync(join(source, "dist"))).toEqual(["muse-plugins"]);
  });

  it("refuses to reap staging owned by a live builder process", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-muse-package-live-"));
    const source = makeIncompleteSource(parent);
    const output = join(source, "dist/muse-plugins");
    const stage = join(source, "dist", `.muse-plugins.stage-${process.pid}-active`);
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "owner-marker.txt"), "keep\n");

    expect(() => buildMusePackages(output, source)).toThrow(/another Muse package build is active/);

    expect(readFileSync(join(stage, "owner-marker.txt"), "utf8")).toBe("keep\n");
    expect(readdirSync(join(source, "dist"))).toEqual([`.muse-plugins.stage-${process.pid}-active`]);
  });
});
