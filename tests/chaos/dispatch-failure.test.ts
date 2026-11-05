/**
 * CHAOS — dispatch failure semantics under combined faults (class F/G).
 *
 * E3 hypothesis: a throwing PreToolUse handler combined with a ledger that
 * cannot persist the error receipt must deny the tool call
 * (receiptFailureBlock). The enforcement decision may never depend on a
 * receipt that does not exist.
 *
 * E3b (control): the same throw with a working ledger resolves to undefined
 * (documented fail-open with a persisted error receipt) — pinned here so a
 * future change cannot silently flip it in either direction.
 *
 * E4 hypothesis: a benign PreToolUse that yields no decision (implicit
 * allow) combined with a ledger that cannot persist the allow receipt must
 * also deny. An unrecorded allow on the gating path is a silent
 * unenforced execution.
 *
 * Invariants: no silent allow without a persisted receipt; enforcement
 * stated explicitly in every terminal outcome.
 * Blast radius: in-process only, disposable temp dirs, no network.
 */

import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchEvent } from "../../src/hooks/unified.js";
import { HANDLERS } from "../../src/hooks/dispatch.js";
import type { EvidenceLedger } from "../../src/evidence/ledger.js";
import type { HookInput } from "../../src/hooks/types.js";
import { setTestSwitch, testHookConfig, testLedger, testStore } from "../helpers/control-state.js";

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  setTestSwitch(dir, "ON");
  return dir;
}

function benignPreToolUse(): HookInput {
  return {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
    tool_response: undefined,
  } as unknown as HookInput;
}

/** A ledger whose every append fails closed: receipts never persist. */
function failingLedger(): EvidenceLedger {
  return { append: () => false } as unknown as EvidenceLedger;
}

describe("chaos: gating-path failure combinations (E3/E4)", () => {
  it("denies when the handler throws and the error receipt cannot persist (E3)", async () => {
    const dir = tempDir("chaos-dispatch-throw-");
    try {
      const store = testStore(dir);
      const deps = {
        model: null,
        config: testHookConfig(dir),
        store,
        ledger: failingLedger(),
        now: () => 1_700_000_000_000,
      };
      const original = HANDLERS["PreToolUse"] as (typeof HANDLERS)["PreToolUse"];
      HANDLERS["PreToolUse"] = () => {
        throw new Error("chaos: handler exploded");
      };
      try {
        // Awaited before cleanup: deleting the store dir mid-flight would
        // make the switch unreadable and mask the deny under test.
        const d = await dispatchEvent("PreToolUse", benignPreToolUse(), deps);
        expect(d).not.toBeUndefined();
        const rec = d as unknown as { enforcement?: string; reasons?: string[] };
        expect(rec.enforcement).toBe("deny");
        expect(rec.reasons?.join(" ")).toContain("receipt");
      } finally {
        HANDLERS["PreToolUse"] = original;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("documents fail-open-with-receipt when the handler throws and the receipt persists (E3b control)", async () => {
    const dir = tempDir("chaos-dispatch-throw-ok-");
    try {
      const store = testStore(dir);
      const deps = {
        model: null,
        config: testHookConfig(dir),
        store,
        ledger: testLedger(dir),
        now: () => 1_700_000_000_000,
      };
      const original = HANDLERS["PreToolUse"] as (typeof HANDLERS)["PreToolUse"];
      HANDLERS["PreToolUse"] = () => {
        throw new Error("chaos: handler exploded");
      };
      try {
        await expect(dispatchEvent("PreToolUse", benignPreToolUse(), deps)).resolves.toBeUndefined();
      } finally {
        HANDLERS["PreToolUse"] = original;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies an unrecordable implicit allow when a real ledger cannot append (E4b)", async () => {
    // Same contract as E4, but the failure is a real filesystem fault
    // (EISDIR on the ledger path) rather than a stub, validating the seam
    // between the dispatch rule and the production ledger.
    const dir = tempDir("chaos-dispatch-ledger-fault-");
    try {
      const store = testStore(dir);
      mkdirSync(join(dir, "evidence.log"), { recursive: true });
      const deps = {
        model: null,
        config: testHookConfig(dir),
        store,
        ledger: testLedger(dir),
        now: () => 1_700_000_000_000,
      };
      const decision = await dispatchEvent("PreToolUse", benignPreToolUse(), deps);
      expect(decision).not.toBeUndefined();
      const rec = decision as unknown as { enforcement?: string; reasons?: string[] };
      expect(rec.enforcement).toBe("deny");
      expect(rec.reasons?.join(" ")).toContain("receipt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies an unrecordable implicit allow on the gating path (E4)", async () => {
    const dir = tempDir("chaos-dispatch-allow-");
    try {
      const store = testStore(dir);
      const deps = {
        model: null,
        config: testHookConfig(dir),
        store,
        ledger: failingLedger(),
        now: () => 1_700_000_000_000,
      };
      const decision = await dispatchEvent("PreToolUse", benignPreToolUse(), deps);
      expect(decision).not.toBeUndefined();
      const rec = decision as unknown as { enforcement?: string; reasons?: string[] };
      expect(rec.enforcement).toBe("deny");
      expect(rec.reasons?.join(" ")).toContain("receipt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
