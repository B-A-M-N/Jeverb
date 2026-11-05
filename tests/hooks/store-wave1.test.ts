/**
 * Wave 1 Agent B — session persistence (D2 read taxonomy, D4 fail-closed claim).
 *
 * Fault injection is real where possible: malformed state bytes on disk,
 * a manually held session lock directory (live owner pid, fresh mtime), and
 * a mocked `node:fs` read failure with a transient errno code (EACCES).
 * No existing test files were modified.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { safeSessionId } from "../../src/hooks/store.js";
import { testStore } from "../helpers/control-state.js";
import { makeDeps } from "./helpers.js";
import { handlePostToolBatch } from "../../src/hooks/handlers/post-tool-batch.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((...args: unknown[]) => {
      const fault = (globalThis as { __wave1FsFault?: { suffix: string; code: string } }).__wave1FsFault;
      if (fault !== undefined && typeof args[0] === "string" && (args[0] as string).endsWith(fault.suffix)) {
        const error = new Error(`mocked transient failure (${fault.code})`) as NodeJS.ErrnoException;
        error.code = fault.code;
        throw error;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readFileSync,
  };
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sessionFile(dir: string, sessionId: string): string {
  return join(dir, "sessions", `${safeSessionId(sessionId)}.json`);
}

/** Hold the session lock from the outside: live owner, fresh mtime. */
function holdSessionLock(dataDir: string, sessionId: string): string {
  const lockDir = join(dataDir, `session-${safeSessionId(sessionId)}.lock`);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "owner"), `${process.pid}:${Date.now()}:wave1test`, "utf8");
  return lockDir;
}

afterEach(() => {
  delete (globalThis as { __wave1FsFault?: unknown }).__wave1FsFault;
  vi.restoreAllMocks();
});

describe("D2: failed reads never become durable state loss", () => {
  it("rejects an update over corrupt JSON and preserves the bytes", () => {
    const dir = tempDir("wave1-corrupt-update-");
    try {
      const store = testStore(dir);
      store.writeSession("corrupt-sess", { prompts: ["hi"], stop_blocks: 3 });
      writeFileSync(sessionFile(dir, "corrupt-sess"), "not json{{{", "utf8");
      const before = readFileSync(sessionFile(dir, "corrupt-sess"), "utf8");
      expect(() => store.updateSession("corrupt-sess", (s) => ({ ...s, stop_blocks: 99 }))).toThrow();
      expect(readFileSync(sessionFile(dir, "corrupt-sess"), "utf8")).toBe(before);
      // Read-only callers keep their tolerant fallback.
      expect(store.readSession("corrupt-sess")).toEqual({ prompts: [], stop_blocks: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a claim over corrupt JSON and leaves the event unclaimed", () => {
    const dir = tempDir("wave1-corrupt-claim-");
    try {
      const store = testStore(dir);
      store.writeSession("corrupt-sess", { prompts: ["hi"], stop_blocks: 3 });
      writeFileSync(sessionFile(dir, "corrupt-sess"), "{not json", "utf8");
      const before = readFileSync(sessionFile(dir, "corrupt-sess"), "utf8");
      expect(store.claimPostObservation("corrupt-sess", "toolu_1", "state", 1_700_000_000_000)).toBe(false);
      expect(readFileSync(sessionFile(dir, "corrupt-sess"), "utf8")).toBe(before);
      // Nothing was recorded, so the event is still unclaimed — not a duplicate.
      expect(store.readSession("corrupt-sess").processed_posts).toBeUndefined();
      expect(store.foldPostObservation("corrupt-sess", "toolu_1", "state", 1_700_000_000_000, (s) => s)).toBe(
        "error",
      );
      expect(readFileSync(sessionFile(dir, "corrupt-sess"), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a transaction on transient read failure (EACCES) and preserves the bytes", () => {
    const dir = tempDir("wave1-eacces-");
    try {
      const store = testStore(dir);
      store.writeSession("eacces-sess", { prompts: ["precious"], stop_blocks: 5 });
      const before = readFileSync(sessionFile(dir, "eacces-sess"), "utf8");
      (globalThis as { __wave1FsFault?: unknown }).__wave1FsFault = {
        suffix: "eacces-sess.json",
        code: "EACCES",
      };
      try {
        expect(() => store.updateSession("eacces-sess", (s) => ({ ...s, stop_blocks: 0 }))).toThrow();
        expect(store.claimPostObservation("eacces-sess", "toolu_9", "state", 1_700_000_000_000)).toBe(false);
        // Display paths still degrade to empty rather than throwing.
        expect(store.readSession("eacces-sess")).toEqual({ prompts: [], stop_blocks: 0 });
      } finally {
        delete (globalThis as { __wave1FsFault?: unknown }).__wave1FsFault;
      }
      expect(readFileSync(sessionFile(dir, "eacces-sess"), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still initializes a genuinely missing session and commits", () => {
    const dir = tempDir("wave1-missing-");
    try {
      const store = testStore(dir);
      expect(store.readSession("new-sess")).toEqual({ prompts: [], stop_blocks: 0 });
      expect(store.claimPostObservation("new-sess", "toolu_1", "state", 1_700_000_000_000)).toBe(true);
      expect(store.claimPostObservation("new-sess", "toolu_1", "state", 1_700_000_000_000)).toBe(false);
      const next = store.updateSession("new-sess", (s) => ({ ...s, stop_blocks: 1 }));
      expect(next.stop_blocks).toBe(1);
      expect(JSON.parse(readFileSync(sessionFile(dir, "new-sess"), "utf8") as string).stop_blocks).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps valid state (trips, claims) across a normal update", () => {
    const dir = tempDir("wave1-valid-");
    try {
      const store = testStore(dir);
      expect(store.claimPostObservation("s1", "toolu_1", "state", 1_700_000_000_000)).toBe(true);
      const next = store.updateSession("s1", (s) => ({ ...s, stop_blocks: 4 }));
      expect(next.stop_blocks).toBe(4);
      expect(next.processed_posts?.map((p) => p.key)).toEqual([expect.stringContaining("toolu_1")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("D4: claim path fails closed under contention", () => {
  it("claim returns not-claimed when the lock is unavailable, without committing", () => {
    const dir = tempDir("wave1-claim-lock-");
    let lockDir = "";
    try {
      const store = testStore(dir);
      lockDir = holdSessionLock(dir, "locked-sess");
      expect(store.claimPostObservation("locked-sess", "toolu_1", "receipt", 1_700_000_000_000)).toBe(false);
      expect(existsSync(sessionFile(dir, "locked-sess"))).toBe(false);
      expect(() =>
        store.updateSession("locked-sess", (s) => ({ ...s, stop_blocks: 1 })),
      ).toThrow();
      // After the lock clears, the event is still unclaimed: redelivery claims exactly once.
      rmSync(lockDir, { recursive: true, force: true });
      lockDir = "";
      expect(store.claimPostObservation("locked-sess", "toolu_1", "receipt", 1_700_000_000_000)).toBe(true);
      expect(store.claimPostObservation("locked-sess", "toolu_1", "receipt", 1_700_000_000_000)).toBe(false);
    } finally {
      if (lockDir !== "") rmSync(lockDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("batch handler still records the receipt under contention and redelivery does not duplicate it", async () => {
    const dir = tempDir("wave1-batch-");
    let lockDir = "";
    try {
      const deps = makeDeps(dir);
      const dataDir = deps.store.dir;
      const sessionId = "batch-sess";
      const input = {
        hook_event_name: "PostToolBatch",
        session_id: sessionId,
        tool_calls: [
          {
            tool_name: "Bash",
            tool_input: { command: "echo hi" },
            tool_response: "hi",
            tool_use_id: "toolu_batch1",
          },
        ],
      } as Parameters<typeof handlePostToolBatch>[0];
      // Emulate the real ledger's idempotencyKey dedupe: only the first
      // append per correlationId writes a row; redeliveries report success
      // without a new row.
      let receipts = 0;
      const seenKeys = new Set<string>();
      deps.ledger = {
        append: (record: { correlationId?: string }) => {
          if (record.correlationId !== undefined) {
            if (seenKeys.has(record.correlationId)) return true;
            seenKeys.add(record.correlationId);
          }
          receipts += 1;
          return true;
        },
      } as unknown as NonNullable<typeof deps.ledger>;

      // The receipt write does not hold the session lock, so contention on
      // the session file must not suppress it; the claim stays unclaimed
      // and redelivery still folds exactly once.
      lockDir = holdSessionLock(dataDir, sessionId);
      await handlePostToolBatch(input, deps);
      expect(receipts).toBe(1);
      rmSync(lockDir, { recursive: true, force: true });
      lockDir = "";

      // Redelivery after the lock clears does not duplicate the receipt.
      await handlePostToolBatch(input, deps);
      await handlePostToolBatch(input, deps);
      expect(receipts).toBe(1);
    } finally {
      if (lockDir !== "") rmSync(lockDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
