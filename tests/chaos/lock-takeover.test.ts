/**
 * CHAOS — lock-holder death and stale takeover (class A/C).
 *
 * E1 hypothesis: when a hook process holding a session lock is SIGKILLed
 * mid-transaction, the lock is wreckage, not a wedge. A later contender
 * takes it over once the owner is provably dead and the lock is stale,
 * and the session file is intact (old or new content, never torn).
 * A fresh lock whose owner just died is NOT taken over immediately —
 * only staleness plus certain death releases it.
 *
 * Invariants: no torn session bytes; no indefinite wedge; no takeover of
 * a lock that might still belong to a live holder.
 * Blast radius: disposable temp dirs; one short-lived child each.
 * Cleanup: kill + wait exit, rm -rf dir in finally.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { LOCK_STALE_MS, withFileLock } from "../../src/hooks/store-lock.js";
import { setTestSwitch, testStore } from "../helpers/control-state.js";

const root = new URL("../../", import.meta.url).pathname;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  setTestSwitch(dir, "ON");
  return dir;
}

/** Bundle the zero-dependency lock module so the child runs production code. */
function bundleLock(dir: string): string {
  const out = join(dir, "store-lock.bundle.mjs");
  buildSync({
    entryPoints: [join(root, "src/hooks/store-lock.ts")],
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

function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (existsSync(path)) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return existsSync(path);
  })();
}

/** A pid that is certainly dead (spawned and reaped). */
async function deadPid(): Promise<number> {
  const proc = execFile(process.execPath, ["-e", ""]);
  const code: number | null = await new Promise((resolve) => proc.on("exit", resolve));
  expect(code).toBe(0);
  const pid = proc.pid;
  expect(pid).toBeDefined();
  return pid as number;
}

describe("chaos: SIGKILLed lock holder is taken over, never wedges (E1)", () => {
  it("recovers the session lock after the holder is killed", async () => {
    const dir = tempDir("chaos-lock-takeover-");
    let holder: ChildProcess | undefined;
    try {
      const bundle = bundleLock(dir);
      const lockName = "session-victim";
      const ready = join(dir, "holder.ready");
      // Holder: acquire the real session lock, announce, then sleep inside
      // the critical section until killed. It never commits, so there is
      // nothing to roll back — the session file must be untouched.
      const holderScript = writeChild(
        dir,
        "holder2.mjs",
        `import { withFileLock } from ${JSON.stringify(bundle)};
import { writeFileSync } from "node:fs";
const [dataDir, name, readyPath] = process.argv.slice(2);
withFileLock(dataDir, name, () => {
  writeFileSync(readyPath, "held");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  return true;
});`,
      );
      const store = testStore(dir);
      store.writeSession("victim", { prompts: ["before"], stop_blocks: 7 });
      holder = spawn(process.execPath, [holderScript, dir, lockName, ready]);
      expect(await waitFor(ready, 10_000)).toBe(true);
      // The holder is inside the critical section. Kill -9: no cleanup runs.
      holder.kill("SIGKILL");
      await new Promise((resolve) => holder?.on("exit", resolve));
      // Staleness is time-based; simulate the elapsed interval
      // deterministically instead of sleeping through LOCK_STALE_MS.
      const lockDir = join(dir, `${lockName}.lock`);
      expect(existsSync(lockDir)).toBe(true);
      const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
      utimesSync(lockDir, old, old);
      // Takeover: the next transaction proceeds under new ownership and
      // the pre-crash session bytes are intact.
      const outcome = withFileLock(dir, lockName, () => {
        const owner = readFileSync(join(lockDir, "owner"), "utf8");
        expect(Number.parseInt(owner.split(":")[0] ?? "", 10)).toBe(process.pid);
        return "takeover";
      });
      expect(outcome.locked).toBe(true);
      expect(outcome.value).toBe("takeover");
      store.writeSession("victim", { prompts: ["after"], stop_blocks: 8 });
      const session = store.readSession("victim");
      expect(session.prompts).toEqual(["after"]);
      expect(session.stop_blocks).toBe(8);
    } finally {
      try {
        holder?.kill("SIGKILL");
      } catch {
        // Already dead.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not take over a fresh lock even when the owner pid is dead", async () => {
    const dir = tempDir("chaos-lock-fresh-");
    try {
      const pid = await deadPid();
      const lockDir = join(dir, "fresh.lock");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, "owner"), `${pid}:${Date.now()}:chaos`, "utf8");
      // Fresh mtime + dead pid: could be a slow starter, never provably
      // abandoned. The contender must wait out the full window and give up.
      const outcome = withFileLock(dir, "fresh", () => true);
      expect(outcome.locked).toBe(false);
      expect(outcome.value).toBeUndefined();
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
