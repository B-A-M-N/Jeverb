/**
 * Post-tool dedup under real concurrency and real crashes.
 *
 * The in-process exactly-once behavior (individual + batch double
 * delivery) is covered in tests/jeverb/muse-events.test.ts. These tests
 * cover what in-process tests cannot: two hook *processes* racing the
 * same claim, SIGKILL landing mid-write, corrupt session files, and
 * restart replay. The store module is bundled with esbuild so child
 * processes run the production code, not a mock of it.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { Store } from "../../src/hooks/store.js";
import { evictProcessedPosts } from "../../src/hooks/observations.js";
import { setTestSwitch, testStore } from "../helpers/control-state.js";

const root = new URL("../../", import.meta.url).pathname;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Bundle the production store so child processes execute the real code. */
function bundleStore(dir: string): string {
  const out = join(dir, "store.bundle.mjs");
  buildSync({
    entryPoints: [join(root, "src/hooks/store.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    logLevel: "silent",
  });
  return out;
}

function writeChild(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

function runChild(node: string, script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(node, [script, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`child failed: ${String(stderr).slice(0, 500)}`));
        return;
      }
      resolve();
    });
  });
}

describe("cross-process post-tool dedup", () => {
  it("preserves concurrent session read-modify-write updates across processes", async () => {
    const dir = tempDir("jeverb-session-update-race-");
    let processes: Promise<void>[] = [];
    try {
      setTestSwitch(dir, "ON");
      const bundle = bundleStore(dir);
      const child = writeChild(
        dir,
        "update-child.mjs",
        `import { Store } from ${JSON.stringify(bundle)};
import { existsSync, writeFileSync } from "node:fs";
const [dataDir, readyPath, gatePath, sessionId, count] = process.argv.slice(2);
const store = new Store(dataDir, { masterSwitchPath: dataDir + "/control-state.json", requireRootOwnedMasterSwitch: false });
writeFileSync(readyPath, "ready");
while (!existsSync(gatePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
for (let i = 0; i < Number(count); i++) {
  store.updateSession(sessionId, (state) => ({ ...state, stop_blocks: state.stop_blocks + 1 }));
}`,
      );
      const gate = join(dir, "go");
      const ready = [join(dir, "update-a.ready"), join(dir, "update-b.ready")];
      processes = ready.map((marker) => runChild(process.execPath, child, [dir, marker, gate, "update-race", "40"]));
      const deadline = Date.now() + 10_000;
      while (!ready.every((marker) => existsSync(marker)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(ready.every((marker) => existsSync(marker))).toBe(true);
      writeFileSync(gate, "go");
      await Promise.all(processes);
      expect(testStore(dir).readSession("update-race").stop_blocks).toBe(80);
    } finally {
      writeFileSync(join(dir, "go"), "go");
      await Promise.allSettled(processes);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("folds one concurrent event exactly once across 8 processes", async () => {
    const dir = tempDir("jeverb-dedup-race-");
    try {
      setTestSwitch(dir, "ON");
      const bundle = bundleStore(dir);
      const child = writeChild(
        dir,
        "fold-child.mjs",
        `import { Store } from ${JSON.stringify(bundle)};
import { writeFileSync } from "node:fs";
const [dataDir, session, tool] = process.argv.slice(2);
const store = new Store(dataDir, { masterSwitchPath: dataDir + "/control-state.json", requireRootOwnedMasterSwitch: false });
const outcome = store.foldPostObservation(session, tool, "state", Date.now(), (s) => ({
  ...s,
  stop_blocks: (s.stop_blocks ?? 0) + 1,
}));
writeFileSync(process.argv[5], outcome);`,
      );
      const resultFiles = Array.from({ length: 8 }, (_, i) => join(dir, `fold-${i}.result`));
      await Promise.all(resultFiles.map((resultFile) => runChild(process.execPath, child, [dir, "race-sess", "toolu_race", resultFile])));
      const results = resultFiles.map((path) => readFileSync(path, "utf8"));
      expect(results.filter((r) => r === "folded"), results.join(",")).toHaveLength(1);
      expect(results.filter((r) => r === "duplicate"), results.join(",")).toHaveLength(7);
      const session = testStore(dir).readSession("race-sess");
      expect(session.stop_blocks).toBe(1);
      expect(session.processed_posts?.map((p) => p.key)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("grants one concurrent receipt claim across 8 processes", async () => {
    const dir = tempDir("jeverb-claim-race-");
    try {
      setTestSwitch(dir, "ON");
      const bundle = bundleStore(dir);
      const child = writeChild(
        dir,
        "claim-child.mjs",
        `import { Store } from ${JSON.stringify(bundle)};
import { writeFileSync } from "node:fs";
const [dataDir, session, tool, outputPath] = process.argv.slice(2);
const store = new Store(dataDir, { masterSwitchPath: dataDir + "/control-state.json", requireRootOwnedMasterSwitch: false });
writeFileSync(outputPath, store.claimPostObservation(session, tool, "receipt", Date.now()) ? "claimed" : "duplicate");`,
      );
      const resultFiles = Array.from({ length: 8 }, (_, i) => join(dir, `claim-${i}.result`));
      await Promise.all(resultFiles.map((resultFile) => runChild(process.execPath, child, [dir, "claim-sess", "toolu_claim", resultFile])));
      const results = resultFiles.map((path) => readFileSync(path, "utf8"));
      expect(results.filter((r) => r === "claimed"), results.join(",")).toHaveLength(1);
      expect(results.filter((r) => r === "duplicate"), results.join(",")).toHaveLength(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never leaves a torn session file when SIGKILL lands mid-write", async () => {
    const dir = tempDir("jeverb-kill-race-");
    try {
      setTestSwitch(dir, "ON");
      const bundle = bundleStore(dir);
      const child = writeChild(
        dir,
        "spin-child.mjs",
        `import { Store } from ${JSON.stringify(bundle)};
const [dataDir] = process.argv.slice(2);
const store = new Store(dataDir, { masterSwitchPath: dataDir + "/control-state.json", requireRootOwnedMasterSwitch: false });
let i = 0;
for (;;) {
  i += 1;
  store.writeSession("kill-sess", { prompts: ["p" + i], stop_blocks: i });
}`,
      );
      const proc = execFile(process.execPath, [child, dir]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      proc.kill("SIGKILL");
      await new Promise((resolve) => proc.on("exit", resolve));
      const raw = readFileSync(join(dir, "sessions", "kill-sess.json"), "utf8");
      const parsed = JSON.parse(raw) as { stop_blocks?: unknown; prompts?: unknown };
      expect(Number.isInteger(parsed.stop_blocks)).toBe(true);
      expect(Array.isArray(parsed.prompts)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses transactions over a corrupt session file and preserves the bytes", () => {
    // Intentional contract change (Wave 1 D2/D4): the old wipe-and-recover
    // semantics synthesized empty state over corrupt bytes and committed it,
    // durably destroying trips, claims, and verification folds. Corrupt
    // bytes are now preserved on disk; transactions fail closed and
    // redelivery recovers once the file is repaired. Display reads keep
    // their tolerant empty fallback.
    const dir = tempDir("jeverb-corrupt-");
    try {
      const store = testStore(dir);
      store.writeSession("corrupt-sess", { prompts: ["hi"], stop_blocks: 3 });
      const before = "not json{{{";
      writeFileSync(join(dir, "sessions", "corrupt-sess.json"), before, "utf8");
      const recovered = store.readSession("corrupt-sess");
      expect(recovered.prompts).toEqual([]);
      expect(recovered.stop_blocks).toBe(0);
      // Fail closed: no claim, no fold, bytes untouched.
      expect(store.claimPostObservation("corrupt-sess", "toolu_1", "state", 1_700_000_000_000)).toBe(false);
      expect(store.foldPostObservation("corrupt-sess", "toolu_1", "state", 1_700_000_000_000, (s) => s)).toBe(
        "error",
      );
      expect(readFileSync(join(dir, "sessions", "corrupt-sess.json"), "utf8")).toBe(before);
      // After operator repair, the event is still unclaimed: exactly once.
      store.writeSession("corrupt-sess", { prompts: ["hi"], stop_blocks: 3 });
      expect(store.claimPostObservation("corrupt-sess", "toolu_1", "state", 1_700_000_000_000)).toBe(true);
      expect(store.claimPostObservation("corrupt-sess", "toolu_1", "state", 1_700_000_000_000)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replays after restart as a duplicate without refolding", () => {
    const dir = tempDir("jeverb-restart-");
    try {
      const first = testStore(dir);
      const folded = first.foldPostObservation("restart-sess", "toolu_7", "state", 1_700_000_000_000, (s) => ({
        ...s,
        stop_blocks: (s.stop_blocks ?? 0) + 1,
      }));
      expect(folded).toBe("folded");
      // A new Store over the same dir is what a hook process after a
      // restart sees: all state is on disk, nothing in memory.
      const second = testStore(dir);
      const replay = second.foldPostObservation("restart-sess", "toolu_7", "state", 1_700_000_000_001, (s) => ({
        ...s,
        stop_blocks: (s.stop_blocks ?? 0) + 1,
      }));
      expect(replay).toBe("duplicate");
      expect(second.readSession("restart-sess").stop_blocks).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the legacy string claim shape and evicts it first", () => {
    const dir = tempDir("jeverb-legacy-");
    try {
      const store = testStore(dir);
      store.writeSession("legacy-sess", { prompts: [], stop_blocks: 0 });
      writeFileSync(
        join(dir, "sessions", "legacy-sess.json"),
        `${JSON.stringify({ prompts: [], stop_blocks: 0, processed_posts: ["1:state:old-tool"] })}\n`,
        "utf8",
      );
      const session = store.readSession("legacy-sess");
      expect(session.processed_posts).toEqual([{ key: "1:state:old-tool", ts: 0 }]);
      // Legacy entry still dedupes the same event under the new code.
      expect(store.claimPostObservation("legacy-sess", "old-tool", "state", 1_700_000_000_000)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("claim retention bounds", () => {
  it("evicts oldest-first and never drops fresh entries to fit the cap", () => {
    const now = 1_700_000_000_000;
    const olds = Array.from({ length: 5 }, (_, i) => ({ key: `old:${i}`, ts: now - 48 * 60 * 60 * 1000 }));
    const fresh = Array.from({ length: 1000 }, (_, i) => ({ key: `fresh:${i}`, ts: now }));
    const kept = evictProcessedPosts([...olds, ...fresh], now);
    expect(kept).toHaveLength(1000);
    expect(kept.every((p) => p.key.startsWith("fresh:"))).toBe(true);
  });

  it("applies the absolute bound when everything is fresh", () => {
    const now = 1_700_000_000_000;
    const fresh = Array.from({ length: 2500 }, (_, i) => ({ key: `fresh:${i}`, ts: now }));
    const kept = evictProcessedPosts(fresh, now);
    expect(kept).toHaveLength(2000);
    expect(kept[kept.length - 1]?.key).toBe("fresh:2499");
  });

  it("keeps small lists untouched", () => {
    const posts = [{ key: "a", ts: 1 }];
    expect(evictProcessedPosts(posts, 2)).toEqual(posts);
  });
});
