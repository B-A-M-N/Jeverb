import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleCandidate } from "../../scripts/assemble-candidate.js";

const SOURCE_ROOT = resolve(import.meta.dirname, "..", "..");

describe("candidate staging lifecycle", () => {
  it("reaps only stale dead-owner candidate stages in the output parent", () => {
    const parent = mkdtempSync(join(tmpdir(), "jeverb-candidate-stage-"));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const staleName = `.jeverb-candidate.2000000000.${old.getTime()}.00000000-0000-4000-8000-000000000001.tmp`;
    const liveName = `.jeverb-candidate.${process.pid}.${old.getTime()}.00000000-0000-4000-8000-000000000002.tmp`;
    const stale = join(parent, staleName);
    const live = join(parent, liveName);
    mkdirSync(stale, { mode: 0o700 });
    mkdirSync(live, { mode: 0o700 });
    writeFileSync(join(stale, "partial"), "incomplete");
    writeFileSync(join(live, "partial"), "still-owned");
    utimesSync(stale, old, old);
    utimesSync(live, old, old);

    assembleCandidate(join(parent, "candidate"), SOURCE_ROOT);

    const remaining = readdirSync(parent);
    expect(remaining).not.toContain(staleName);
    expect(remaining).toContain(liveName);
  });
});
