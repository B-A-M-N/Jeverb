import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveGraphDefinition } from "../../src/graph/store.js";

describe("graph definition storage", () => {
  it("reaps dead-owner crash temps in its runtime subdirectory and keeps live-owner temps", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jeverb-graph-definition-store-"));
    const definitionsDir = join(dataDir, "graph-definitions");
    mkdirSync(definitionsDir, { mode: 0o700 });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const stale = join(definitionsDir, `graph-orphan.json.2000000000.${old.getTime()}.dead.tmp`);
    const live = join(definitionsDir, `graph-orphan.json.${process.pid}.${old.getTime()}.live.tmp`);
    writeFileSync(stale, "partial", { mode: 0o600 });
    writeFileSync(live, "still-owned", { mode: 0o600 });
    utimesSync(stale, old, old);
    utimesSync(live, old, old);

    saveGraphDefinition(dataDir, "fresh-run", { version: 1, nodes: [] });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});
