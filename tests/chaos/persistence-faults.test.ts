/**
 * CHAOS — persistence faults (class D): permission loss and crash orphans.
 *
 * E5 hypothesis: an unreadable-or-unwritable sessions directory degrades
 * pruneSessions to a no-op (returns 0) instead of throwing or deleting.
 * Invariants: no throw, no deletion, no partial state.
 *
 * E2 hypothesis: a SIGKILLed writer's orphaned atomic-write temp file does
 * not accumulate forever; maintenance reaps it once its owner is provably
 * dead and it is old, and never touches live or foreign temp files.
 * Invariants: bounded residual growth; never delete a live writer's tmp.
 *
 * Blast radius: disposable temp dirs only. Cleanup: rm -rf in finally.
 */

import { existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setTestSwitch, testStore } from "../helpers/control-state.js";

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  setTestSwitch(dir, "ON");
  return dir;
}

describe("chaos: sessions-dir permission loss (E5)", () => {
  it("prune returns 0 and deletes nothing when the sessions entry is not a directory", () => {
    // A damaged data dir (file where `sessions/` belongs) must degrade to
    // a no-op, never a throw and never a partial delete. (Plain mode bits
    // cannot model EACCES here: the store deliberately re-tightens state
    // directories to 0700 on entry, which is itself the recovery.)
    const dir = freshDir("chaos-prune-enotdir-");
    try {
      const store = testStore(dir);
      store.writeSession("keep-me", { prompts: ["hi"], stop_blocks: 1 });
      const target = join(dir, "sessions", "keep-me.json");
      rmSync(join(dir, "sessions"), { recursive: true, force: true });
      writeFileSync(join(dir, "sessions"), "not a directory\n");
      let removed = -1;
      expect(() => {
        removed = store.pruneSessions(Date.now());
      }).not.toThrow();
      expect(removed).toBe(0);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("chaos: orphaned atomic-write temp files (E2)", () => {
  it("reaps a dead writer's stale tmp and keeps live and foreign tmps", () => {
    const dir = freshDir("chaos-tmp-sweep-");
    try {
      const store = testStore(dir);
      store.writeSession("live", { prompts: [], stop_blocks: 0 });
      const sessions = join(dir, "sessions");
      // Orphan from a dead writer: pid that cannot exist, mtime 2h old.
      const staleTmp = join(sessions, `live.json.4194304.${Date.now() - 3 * 3_600_000}.deadbeef.tmp`);
      writeFileSync(staleTmp, "{\"partial\":true}\n");
      const old = (Date.now() - 2 * 3_600_000) / 1000;
      utimesSync(staleTmp, old, old);
      // Live writer's tmp: our own pid, fresh.
      const liveTmp = join(sessions, `live.json.${process.pid}.${Date.now()}.cafe01.tmp`);
      writeFileSync(liveTmp, "{\"partial\":true}\n");
      // Foreign shape: not our atomic-write pattern, must never be touched.
      const foreignTmp = join(sessions, "unrelated-export.tmp");
      writeFileSync(foreignTmp, "do not touch\n");

      store.pruneSessions(Date.now());

      expect(existsSync(staleTmp)).toBe(false);
      expect(existsSync(liveTmp)).toBe(true);
      expect(existsSync(foreignTmp)).toBe(true);
      const remaining = readdirSync(sessions)
        .filter((n) => n.endsWith(".tmp"))
        .sort();
      expect(remaining).toEqual([liveTmp.split("/").pop(), foreignTmp.split("/").pop()].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
