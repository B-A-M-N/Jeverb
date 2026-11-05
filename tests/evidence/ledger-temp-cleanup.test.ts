import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameFailure = vi.hoisted(() => ({ destination: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (source: Parameters<typeof actual.renameSync>[0], destination: Parameters<typeof actual.renameSync>[1]) => {
      if (renameFailure.destination !== undefined && String(destination) === renameFailure.destination) {
        throw new Error("injected replacement rename failure");
      }
      return actual.renameSync(source, destination);
    },
  };
});

import { EvidenceLedger, type EvidenceRecord } from "../../src/evidence/ledger.js";
import { setTestSwitch, testLedgerForFile } from "../helpers/control-state.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "jeverb-ledger-temp-cleanup-"));
}

function receipt(id: string): EvidenceRecord {
  return {
    schema: 1,
    id,
    ts: new Date().toISOString(),
    sessionId: "temp-cleanup",
    event: "PreToolUse",
    subjectHash: "ab".repeat(16),
    policyVersion: "test",
    deterministicFindings: [],
    enforcement: "allow",
    reasons: [],
    latencyMs: 0,
  };
}

afterEach(() => {
  renameFailure.destination = undefined;
});

describe("evidence ledger replacement temporary-file cleanup", () => {
  it("removes a prune temporary file when atomic replacement fails", () => {
    const dir = freshDir();
    const path = join(dir, "evidence.log");
    const ledger = testLedgerForFile(path);
    setTestSwitch(dir, "ON");
    expect(ledger.appendDetailed(receipt("kept"), { durable: true }).ok).toBe(true);

    renameFailure.destination = path;
    expect(ledger.prune({ maxCount: 1 })).toBe(0);
    renameFailure.destination = undefined;

    expect(ledger.read().records.map((entry) => entry.id)).toEqual(["kept"]);
    expect(ledger.read().corrupt).toBeUndefined();
    expect(readdirSync(dir).filter((name) => name.startsWith("evidence.log."))).toEqual([]);
  });

  it("removes a repair temporary file when atomic replacement fails", () => {
    const dir = freshDir();
    const path = join(dir, "evidence.log");
    const ledger = testLedgerForFile(path);
    setTestSwitch(dir, "ON");
    expect(ledger.appendDetailed(receipt("kept"), { durable: true }).ok).toBe(true);
    appendFileSync(path, "{\"schema\":1,\"id\":\"torn\"");
    expect(ledger.read().corrupt?.reason).toBe("corrupt-truncated");

    renameFailure.destination = path;
    expect(ledger.repair()).toEqual({ repaired: false, reason: "unrepairable" });
    renameFailure.destination = undefined;

    expect(ledger.read().corrupt?.reason).toBe("corrupt-truncated");
    expect(readFileSync(path, "utf8")).toContain("torn");
    expect(readdirSync(dir).filter((name) => name.startsWith("evidence.log."))).toEqual([]);
  });
});
