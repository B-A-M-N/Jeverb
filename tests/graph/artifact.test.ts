import { chmodSync, existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GraphOutputArtifactStore } from "../../src/graph/artifact.js";

describe("private graph output artifacts", () => {
  it("round trips complete output through an opaque id and verifies the digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-output-artifact-"));
    chmodSync(dir, 0o700);
    const store = new GraphOutputArtifactStore(join(dir, "artifacts"));
    const content = "first line\nsecond line\n";
    const written = store.write("run-123", "node-a", content);
    const artifact = store.read("run-123", written.artifactId);
    expect(artifact).toMatchObject({ runId: "run-123", nodeId: "node-a", digest: written.digest, bytes: written.bytes, content });
  });

  it("rejects modified artifacts and references outside the requested run", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-output-artifact-"));
    chmodSync(dir, 0o700);
    const store = new GraphOutputArtifactStore(join(dir, "artifacts"));
    const written = store.write("run-123", "node-a", "original");
    const path = join(dir, "artifacts", `jeverb-graph-output-run-123-${written.artifactId}.json`);
    const value = JSON.parse(readFileSync(path, "utf8")) as { content: string };
    value.content = "changed";
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    expect(() => store.read("run-123", written.artifactId)).toThrow(/integrity/);
    expect(() => store.read("other-run", written.artifactId)).toThrow();
  });

  it("reaps old dead-owner temps while preserving live-owner temps", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-output-artifact-reap-"));
    chmodSync(dir, 0o700);
    const artifactDir = join(dir, "artifacts");
    const store = new GraphOutputArtifactStore(artifactDir);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const stale = join(artifactDir, `jeverb-graph-output-run-old.json.2000000000.${old.getTime()}.dead.tmp`);
    const live = join(artifactDir, `jeverb-graph-output-run-live.json.${process.pid}.${old.getTime()}.live.tmp`);
    writeFileSync(stale, "partial", { mode: 0o600 });
    writeFileSync(live, "still-owned", { mode: 0o600 });
    utimesSync(stale, old, old);
    utimesSync(live, old, old);

    store.write("run-new", "node-a", "output");

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});
