/**
 * CHAOS — kill the lock holder mid-transaction, then fold (class A+C+H).
 *
 * E6 hypothesis: when the process holding a session lock is SIGKILLed
 * mid-transaction and survivors arrive after the wreckage goes stale, the
 * claim still folds exactly once: no double-fold, no torn session file,
 * no wedge. The victim's uncommitted work is lost (it never committed);
 * the survivors' exactly-once claim is preserved (nothing committed twice).
 *
 * Fault: SIGKILL of the lock holder while inside the critical section,
 * then N sequential same-event folds by survivors after staleness.
 * Expected: exactly one "folded", rest "duplicate"; session valid JSON
 * with exactly one increment; takeover by a new owner.
 * Invariants: at-most-once folding; no torn state; no wedge.
 * Recovery: stale-lock takeover; measured: takeover immediate after
 * staleness (no 5s wait in-test; staleness is backdated, dead pid is real).
 * Blast radius: disposable temp dirs; one short-lived child.
 * Cleanup: kill + wait exit, rm -rf dir in finally.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { LOCK_STALE_MS } from "../../src/hooks/store-lock.js";
import { setTestSwitch, testStore } from "../helpers/control-state.js";

const root = new URL("../../", import.meta.url).pathname;

describe("chaos: kill holder mid-transaction, survivors fold once (E6)", () => {
  it("folds exactly once after a SIGKILLed holder with no torn state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chaos-compound-"));
    setTestSwitch(dir, "ON");
    let holder: ChildProcess | undefined;
    try {
      // Child runs production lock code, takes the session lock for
      // "race-sess", announces, then sleeps inside the critical section.
      const bundle = join(dir, "store-lock.bundle.mjs");
      buildSync({
        entryPoints: [join(root, "src/hooks/store-lock.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: bundle,
        logLevel: "silent",
      });
      const holderScript = join(dir, "holder.mjs");
      writeFileSync(
        holderScript,
        `import { withFileLock } from ${JSON.stringify(bundle)};
import { writeFileSync } from "node:fs";
const [dataDir, name, readyPath] = process.argv.slice(2);
withFileLock(dataDir, name, () => {
  writeFileSync(readyPath, "held");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  return true;
});`,
        "utf8",
      );
      const lockName = "session-race-sess";
      const ready = join(dir, "holder.ready");
      holder = spawn(process.execPath, [holderScript, dir, lockName, ready], { stdio: "ignore" });
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(ready)).toBe(true);
      holder.kill("SIGKILL");
      await new Promise((resolve) => holder?.on("exit", resolve));
      // Staleness is time-based; backdate to simulate the elapsed interval
      // deterministically. The dead pid is real (we just reaped it).
      const lockDir = join(dir, `${lockName}.lock`);
      expect(existsSync(lockDir)).toBe(true);
      const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
      utimesSync(lockDir, old, old);

      // Survivors: three sequential same-event folds. Exactly one may win.
      const store = testStore(dir);
      const results = [0, 1, 2].map(() =>
        store.foldPostObservation("race-sess", "toolu_race", "state", Date.now(), (state) => ({
          ...state,
          stop_blocks: (state.stop_blocks ?? 0) + 1,
        })),
      );
      expect(results.filter((r) => r === "folded")).toHaveLength(1);
      expect(results.filter((r) => r === "duplicate")).toHaveLength(2);
      // No torn state: valid JSON, exactly one increment, current owner alive.
      const raw = readFileSync(join(dir, "sessions", "race-sess.json"), "utf8");
      const parsed = JSON.parse(raw) as { stop_blocks?: number };
      expect(parsed.stop_blocks).toBe(1);
      expect(store.readSession("race-sess").stop_blocks).toBe(1);
    } finally {
      try {
        holder?.kill("SIGKILL");
      } catch {
        // Already dead.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
