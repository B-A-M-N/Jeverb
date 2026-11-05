import { chmodSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCK_WAIT_MS, withFileLockAsync } from "../../src/hooks/store-lock.js";

describe("withFileLockAsync", () => {
  it("keeps a cross-await critical section exclusive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-async-lock-"));
    let active = 0;
    let maxActive = 0;
    let privateModes = false;
    const enter = () => withFileLockAsync(dir, "same-operation", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const lockMode = statSync(join(dir, "same-operation.lock")).mode & 0o777;
      const ownerMode = statSync(join(dir, "same-operation.lock", "owner")).mode & 0o777;
      privateModes = privateModes || (lockMode === 0o700 && ownerMode === 0o600);
      await new Promise((resolve) => setTimeout(resolve, 35));
      active -= 1;
      return active;
    });

    const [first, second] = await Promise.all([enter(), enter()]);
    expect(first.locked).toBe(true);
    expect(second.locked).toBe(true);
    expect(maxActive).toBe(1);
    expect(privateModes).toBe(true);
  });

  it("gives up within the wait budget when a stale lock can neither be taken nor cleared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-async-lock-"));
    const lockDir = join(dir, "stuck-op.lock");
    mkdirSync(lockDir, { mode: 0o700 });
    // A stale lock whose owner is provably dead: takeover is attempted, but
    // the read-only directory makes both acquiring and clearing fail.
    writeFileSync(join(lockDir, "owner"), `${2 ** 22 + 7}:${Date.now()}:deadbeef`, { mode: 0o600 });
    const ancient = new Date(Date.now() - 60_000);
    utimesSync(lockDir, ancient, ancient);
    chmodSync(dir, 0o555);
    try {
      const started = Date.now();
      const outcome = await withFileLockAsync(dir, "stuck-op", async () => true);
      expect(outcome.locked).toBe(false);
      expect(Date.now() - started).toBeLessThan(LOCK_WAIT_MS + 5_000);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
