import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverExtractorPlugins } from "../../src/graph/extractor-registry.js";

describe("extractor plugin registry", () => {
  it("discovers project modules and fingerprints their complete tree", () => {
    const workspace = mkdtempSync(join(tmpdir(), "jeverb-extractor-registry-"));
    const root = join(workspace, ".jev", "extractors");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "records.ts"), "export default { name: 'records' };\n");
    writeFileSync(join(root, "helper.js"), "export const marker = true;\n");
    const plugin = discoverExtractorPlugins(workspace).get("records");
    expect(plugin).toMatchObject({ name: "records", scope: "project", root });
    expect(plugin?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits ambiguous module stems and rejects symlinked plugin trees", () => {
    const workspace = mkdtempSync(join(tmpdir(), "jeverb-extractor-registry-"));
    const root = join(workspace, ".jev", "extractors");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "ambiguous.ts"), "export default {};\n");
    writeFileSync(join(root, "ambiguous.mjs"), "export default {};\n");
    expect(discoverExtractorPlugins(workspace).has("ambiguous")).toBe(false);
    symlinkSync(join(root, "ambiguous.ts"), join(root, "linked.mjs"));
    expect(discoverExtractorPlugins(workspace).size).toBe(0);
  });

  it("discovers private global modules and lets project modules shadow them", () => {
    const previousHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "jeverb-extractor-home-"));
    const workspace = mkdtempSync(join(tmpdir(), "jeverb-extractor-project-"));
    const globalRoot = join(home, ".config", "jev-agent", "extractors");
    const projectRoot = join(workspace, ".jev", "extractors");
    try {
      process.env.HOME = home;
      mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(globalRoot, "shared.mjs"), "export default { name: 'shared' };\n", { mode: 0o600 });
      expect(discoverExtractorPlugins(workspace).get("shared")?.scope).toBe("global");
      mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(projectRoot, "shared.mjs"), "export default { name: 'shared', project: true };\n", { mode: 0o600 });
      expect(discoverExtractorPlugins(workspace).get("shared")?.scope).toBe("project");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
