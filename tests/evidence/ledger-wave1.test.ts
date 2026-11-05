/**
 * Wave 1 (evidence & verification policy) — D1.
 *
 * D1a: ledger suppression must consult the protected install-wide control
 * state (the same source as `readMasterSwitch`), never a bare marker check —
 * in particular the `JEV_HOOKS_DISABLE` environment override is control
 * state, and the old marker-only read ignored it.
 *
 * D1b: enforcement paths must fail loudly (block), not log-and-continue,
 * when a receipt cannot be persisted.
 */

import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceLedger, type EvidenceRecord } from "../../src/evidence/ledger.js";
import { dispatchEvent } from "../../src/hooks/unified.js";
import type { HookInput } from "../../src/hooks/types.js";
import { setTestSwitch, testSwitchPath } from "../helpers/control-state.js";
import { makeDeps } from "../hooks/helpers.js";

/**
 * Ledger bound to a test control switch (ON), mirroring how production
 * call sites pass the configured switch through. Bare construction without
 * switch opts defaults to the install-wide protected path and fails closed
 * where that state is absent — covered explicitly below.
 */
function testLedger(dir: string): EvidenceLedger {
  setTestSwitch(dir, "ON");
  return new EvidenceLedger(join(dir, "evidence.log"), {
    switchPath: testSwitchPath(dir),
    requireRootOwnedSwitch: false,
  });
}

function receipt(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    schema: 1,
    id: "wave1-id-1",
    ts: new Date().toISOString(),
    sessionId: "sess-1",
    event: "PreToolUse",
    subjectHash: "ab".repeat(16),
    policyVersion: "p1",
    deterministicFindings: [],
    enforcement: "allow",
    reasons: ["ok"],
    latencyMs: 1,
    ...overrides,
  };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "jev-ledger-wave1-"));
}

const previousEnv = process.env.JEV_HOOKS_DISABLE;
afterEach(() => {
  if (previousEnv === undefined) delete process.env.JEV_HOOKS_DISABLE;
  else process.env.JEV_HOOKS_DISABLE = previousEnv;
});

describe("D1a ledger consults the protected control state", () => {
  it("suppresses receipts while the hooks-disable environment override is set", () => {
    const dir = freshDir();
    process.env.JEV_HOOKS_DISABLE = "1";
    const ledger = testLedger(dir);
    const result = ledger.appendDetailed(receipt());
    expect(result.ok).toBe(false);
  });

  it("appends once the override is cleared", () => {
    const dir = freshDir();
    process.env.JEV_HOOKS_DISABLE = "1";
    const ledger = testLedger(dir);
    expect(ledger.appendDetailed(receipt()).ok).toBe(false);
    delete process.env.JEV_HOOKS_DISABLE;
    expect(ledger.append(receipt())).toBe(true);
  });

  it("fails closed when the configured switch state is absent", () => {
    const dir = freshDir();
    // No switch file at the configured path: unreadable state suppresses
    // rather than allowing receipts to flow unrecorded.
    const ledger = new EvidenceLedger(join(dir, "evidence.log"), {
      switchPath: join(dir, "control-state.json"),
      requireRootOwnedSwitch: false,
    });
    expect(ledger.append(receipt())).toBe(false);
  });
});

describe("D1b enforcement blocks when the receipt cannot persist", () => {
  it("denies a pre-execution allow rather than proceeding without a receipt", async () => {
    const dir = freshDir();
    const deps = makeDeps(dir);
    // A directory is not a ledger target: every append fails closed.
    const ledger = new EvidenceLedger(dir);
    expect(ledger.append(receipt())).toBe(false);
    const input: HookInput = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/home/dev/project/src/index.ts" },
      cwd: "/home/dev/project",
    };
    const decision = await dispatchEvent("PreToolUse", input, { ...deps, ledger });
    expect(decision?.enforcement).toBe("deny");
    expect(decision?.reasons.join("\n")).toContain("receipt");
  });

  it("keeps allowing when the receipt persists", async () => {
    const dir = freshDir();
    const deps = makeDeps(dir);
    const ledger = testLedger(dir);
    const input: HookInput = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/home/dev/project/src/index.ts" },
      cwd: "/home/dev/project",
    };
    const decision = await dispatchEvent("PreToolUse", input, { ...deps, ledger });
    expect(decision?.enforcement).not.toBe("deny");
  });
});
