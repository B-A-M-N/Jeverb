import { appendFileSync, chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EvidenceLedger,
  checkLedgerTarget,
  isValidReceipt,
  resolveEventHost,
  type EvidenceRecord,
} from "../../src/evidence/ledger.js";
import { setTestSwitch, testLedger, testLedgerForFile, testSwitchPath } from "../helpers/control-state.js";

function receipt(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    schema: 1,
    id: "test-id-1",
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
  return mkdtempSync(join(tmpdir(), "jev-ledger-"));
}

describe("ledger target validation (fail closed, machine-readable)", () => {
  it("rejects symlinks without following them", () => {
    const dir = freshDir();
    const real = join(dir, "real.log");
    writeFileSync(real, "", { mode: 0o600 });
    const link = join(dir, "evidence.log");
    symlinkSync(real, link);
    const check = checkLedgerTarget(link);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.code).toBe("LEDGER_SYMLINK");
    setTestSwitch(dir, "ON");
    const ledger = new EvidenceLedger(link, {
      switchPath: testSwitchPath(dir),
      requireRootOwnedSwitch: false,
    });
    expect(ledger.append(receipt())).toBe(false);
    const detailed = ledger.appendDetailed(receipt());
    expect(detailed.ok).toBe(false);
    if (!detailed.ok) expect(detailed.error.code).toBe("LEDGER_SYMLINK");
    // Fail closed: the link target gained no receipt.
    expect(readFileSync(real, "utf8")).toBe("");
  });

  it("rejects non-regular files", () => {
    const dir = freshDir();
    const check = checkLedgerTarget(dir);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.code).toBe("LEDGER_NOT_REGULAR");
  });

  it("rejects files not mode 0600", () => {
    const dir = freshDir();
    const path = join(dir, "evidence.log");
    writeFileSync(path, "", { mode: 0o644 });
    const check = checkLedgerTarget(path);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.code).toBe("LEDGER_MODE");
    expect(testLedger(dir).append(receipt())).toBe(false);
  });

  it("rejects world-writable parent directories", () => {
    const dir = freshDir();
    chmodSync(dir, 0o777);
    try {
      const check = checkLedgerTarget(join(dir, "evidence.log"));
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.error.code).toBe("LEDGER_PARENT_WORLD_WRITABLE");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("accepts a missing file (created 0600 on append)", () => {
    const dir = freshDir();
    const path = join(dir, "evidence.log");
    expect(checkLedgerTarget(path).ok).toBe(true);
    expect(testLedger(dir).append(receipt(), { durable: true })).toBe(true);
  });
});

describe("partial writes and corrupt reads", () => {
  it("reports a torn tail as corrupt-truncated with byte offset, keeping prior records", () => {
    const dir = freshDir();
    const path = join(dir, "evidence.log");
    const ledger = testLedger(dir);
    expect(ledger.append(receipt({ id: "r1" }), { durable: true })).toBe(true);
    const firstLen = Buffer.byteLength(readFileSync(path, "utf8"), "utf8");
    // Simulate a crashed write: partial bytes, no commit newline.
    writeFileSync(path, `{"schema":1,"id":"torn"`, { flag: "a" });
    const read = ledger.read();
    expect(read.records.map((r) => r.id)).toEqual(["r1"]);
    expect(read.corrupt?.reason).toBe("corrupt-truncated");
    expect(read.corrupt?.offset).toBe(firstLen);
  });

  it("reports a mid-file bad line as corrupt-record with byte offset", () => {
    const dir = freshDir();
    const path = join(dir, "evidence.log");
    const ledger = testLedger(dir);
    expect(ledger.append(receipt({ id: "r1" }), { durable: true })).toBe(true);
    const firstLen = Buffer.byteLength(readFileSync(path, "utf8"), "utf8");
    writeFileSync(path, "NOT-JSON\n", { flag: "a" });
    writeFileSync(path, `${JSON.stringify(receipt({ id: "r2" }))}\n`, { flag: "a" });
    const read = ledger.read();
    expect(read.records.map((r) => r.id)).toEqual(["r1"]);
    expect(read.corrupt?.reason).toBe("corrupt-record");
    expect(read.corrupt?.offset).toBe(firstLen);
  });

  it("reads a missing ledger as empty, not corrupt", () => {
    const read = new EvidenceLedger(join(freshDir(), "evidence.log")).read();
    expect(read).toEqual({ records: [] });
  });

  it("round-trips valid receipts written by append", () => {
    const dir = freshDir();
    const path = join(dir, "evidence.log");
    const ledger = testLedger(dir);
    expect(ledger.append(receipt({ id: "a" }))).toBe(true);
    expect(ledger.append(receipt({ id: "b" }), { durable: true })).toBe(true);
    const read = ledger.read();
    expect(read.corrupt).toBeUndefined();
    expect(read.records.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("receipt provenance schema (additive, optional)", () => {
  it("preserves eventHost, correlationId, and outcome verbatim; never mints correlationId", () => {
    const dir = freshDir();
    const path = join(dir, "evidence.log");
    const ledger = testLedger(dir);
    expect(
      ledger.append(
        receipt({ eventHost: "muse", correlationId: "corr-9", outcome: "host-action-enforced" }),
        { durable: true },
      ),
    ).toBe(true);
    expect(ledger.append(receipt({ id: "plain" }), { durable: true })).toBe(true);
    const read = ledger.read();
    expect(read.corrupt).toBeUndefined();
    expect(read.records[0]?.eventHost).toBe("muse");
    expect(read.records[0]?.correlationId).toBe("corr-9");
    expect(read.records[0]?.outcome).toBe("host-action-enforced");
    expect(read.records[1]?.correlationId).toBeUndefined();
  });

  it("resolveEventHost never overwrites the recorded host at retrieval", () => {
    const r = receipt({ eventHost: "muse" });
    expect(resolveEventHost(r, "mcp")).toBe("muse");
    expect(resolveEventHost(receipt(), "mcp")).toBe("mcp");
  });

  it("isValidReceipt accepts the additive fields and rejects a bad outcome", () => {
    expect(isValidReceipt(receipt({ outcome: "execution-observed" }))).toBe(true);
    expect(isValidReceipt({ ...receipt(), outcome: "allowed" })).toBe(false);
    expect(isValidReceipt({ ...receipt(), eventHost: 42 })).toBe(false);
    // Old receipts without the new fields still validate.
    expect(isValidReceipt(receipt())).toBe(true);
  });

  it("validates bounded host lifecycle counters and opaque identity hashes", () => {
    expect(isValidReceipt(receipt({
      hostUsage: { inputTokens: 224_582, outputTokens: 83 },
      hostTurnCorrelationId: "a".repeat(64),
      parentExecutionCorrelationId: "b".repeat(64),
    }))).toBe(true);
    expect(isValidReceipt(receipt({ hostUsage: { inputTokens: -1 } }))).toBe(false);
    expect(isValidReceipt({ ...receipt(), hostUsage: { inputTokens: 3, raw: "payload" } })).toBe(false);
    expect(isValidReceipt(receipt({ hostTurnCorrelationId: "raw-turn-id" }))).toBe(false);
    expect(isValidReceipt(receipt({ parentExecutionCorrelationId: "raw-parent-id" }))).toBe(false);
  });

  it("accepts every outcome class", () => {
    for (const outcome of [
      "decision-requested",
      "hook-output-emitted",
      "host-action-enforced",
      "execution-observed",
    ] as const) {
      expect(isValidReceipt(receipt({ outcome }))).toBe(true);
    }
  });
});

describe("ledger idempotency payload binding", () => {
  it("does not accept changed receipt content as a duplicate", () => {
    const dir = freshDir();
    const ledger = testLedger(dir);
    const idempotencyKey = "sess-1:PostToolBatch:tool-1";
    const original = receipt({
      correlationId: idempotencyKey,
      event: "PostToolBatch",
      toolUseId: "tool-1",
      subjectHash: "a".repeat(32),
      reasons: ["observed first payload"],
    });
    const changed = {
      ...original,
      id: "redelivery-id",
      ts: new Date(Date.now() + 1000).toISOString(),
      latencyMs: 9,
      subjectHash: "b".repeat(32),
      reasons: ["observed different payload"],
    };

    expect(ledger.appendDetailed(original, { durable: true, idempotencyKey }).ok).toBe(true);
    const conflict = ledger.appendDetailed(changed, { durable: true, idempotencyKey });

    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("LEDGER_IDEMPOTENCY_CONFLICT");
    const stored = ledger.read().records;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.subjectHash).toBe(original.subjectHash);
  });

  it("treats the same receipt as duplicate despite ledger-generated metadata changes", () => {
    const dir = freshDir();
    const ledger = testLedger(dir);
    const idempotencyKey = "sess-1:PostToolBatch:tool-1";
    const original = receipt({
      correlationId: idempotencyKey,
      event: "PostToolBatch",
      toolUseId: "tool-1",
      id: "first-id",
    });
    const redelivery = {
      ...original,
      id: "second-id",
      ts: new Date(Date.now() + 1000).toISOString(),
      latencyMs: 12,
    };

    expect(ledger.appendDetailed(original, { durable: true, idempotencyKey }).ok).toBe(true);
    expect(ledger.appendDetailed(redelivery, { durable: true, idempotencyKey })).toEqual({
      ok: true,
      duplicate: true,
    });
    expect(ledger.read().records).toHaveLength(1);
  });
});

describe("crash durability", () => {
  it("durable append and prune fsync without error and keep records readable", () => {
    const dir = freshDir();
    mkdirSync(join(dir, "sub"), { recursive: true });
    const path = join(dir, "sub", "evidence.log");
    const ledger = testLedger(dir);
    expect(ledger.append(receipt({ id: "k1" }), { durable: true })).toBe(true);
    expect(ledger.append(receipt({ id: "k2" }), { durable: true })).toBe(true);
    expect(ledger.prune({ maxCount: 1 })).toBe(1);
    const read = ledger.read();
    expect(read.corrupt).toBeUndefined();
    expect(read.records.map((r) => r.id)).toEqual(["k2"]);
  });
});

describe("candidate attribution channels", () => {
  function installedBundle(root: string): string {
    // Mirrors the installed layout: <root>/plugin/dist/muse/Hook.mjs.
    const bundle = join(root, "plugin", "dist", "muse", "SessionStart.mjs");
    mkdirSync(join(root, "plugin", "dist", "muse"), { recursive: true });
    writeFileSync(bundle, "// hook bundle", "utf8");
    return bundle;
  }

  it("stamps the bundle-adjacent candidate file when env and ledger dir miss", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-ledger-cand-"));
    const bundle = installedBundle(join(dir, "install-root"));
    writeFileSync(join(dir, "install-root", "candidate"), "sha-from-install-root\n", "utf8");
    const ledger = testLedger(dir, join("elsewhere", "evidence.log"), { bundlePath: bundle });
    expect(ledger.append(receipt())).toBe(true);
    const records = ledger.read().records;
    expect(records).toHaveLength(1);
    expect(records[0]?.candidate).toBe("sha-from-install-root");
  });

  it("prefers env over the bundle-adjacent file", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-ledger-cand-"));
    const bundle = installedBundle(join(dir, "install-root"));
    writeFileSync(join(dir, "install-root", "candidate"), "sha-from-file\n", "utf8");
    process.env.JEVERB_CANDIDATE = "sha-from-env";
    try {
      const ledger = testLedger(dir, join("elsewhere", "evidence.log"), { bundlePath: bundle });
      expect(ledger.append(receipt())).toBe(true);
      expect(ledger.read().records[0]?.candidate).toBe("sha-from-env");
    } finally {
      delete process.env.JEVERB_CANDIDATE;
    }
  });

  it("leaves receipts unattributed when no channel carries a candidate", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-ledger-cand-"));
    const bundle = installedBundle(join(dir, "install-root"));
    const ledger = testLedger(dir, join("elsewhere", "evidence.log"), { bundlePath: bundle });
    expect(ledger.append(receipt())).toBe(true);
    expect(ledger.read().records[0]?.candidate).toBeUndefined();
  });

  it("preserves a full dirty-tree identity instead of truncating it", () => {
    // Regression: the stamp bound was 80 chars, but a harness dirty-tree
    // identity is `hex+dirty:hex` (111 chars). Truncation silently broke
    // receipt-to-candidate correlation for every dirty run.
    const dirty = `${"a".repeat(40)}+dirty:${"b".repeat(64)}`;
    expect(dirty).toHaveLength(111);
    const dir = mkdtempSync(join(tmpdir(), "jev-ledger-cand-"));
    const bundle = installedBundle(join(dir, "install-root"));
    process.env.JEVERB_CANDIDATE = dirty;
    try {
      const ledger = testLedger(dir, join("elsewhere", "evidence.log"), { bundlePath: bundle });
      expect(ledger.append(receipt())).toBe(true);
      expect(ledger.read().records[0]?.candidate).toBe(dirty);
    } finally {
      delete process.env.JEVERB_CANDIDATE;
    }
  });
});

describe("ledger repair (torn-tail recovery)", () => {
  it("truncates a torn tail so reads go clean while valid records survive", () => {
    const dir = freshDir();
    const ledgerPath = join(dir, "evidence.log");
    const ledger = testLedgerForFile(ledgerPath);
    expect(ledger.appendDetailed(receipt({ correlationId: "a".repeat(64) }), { durable: true }).ok).toBe(true);
    // Simulate a machine crash mid-write: truncated JSON, no trailing newline.
    const full = `${JSON.stringify(receipt({ id: "test-id-2", correlationId: "b".repeat(64) }))}\n`;
    appendFileSync(ledgerPath, full.slice(0, Math.floor(full.length / 2)));
    expect(ledger.read().corrupt?.reason).toBe("corrupt-truncated");
    const repaired = ledger.repair();
    expect(repaired.repaired).toBe(true);
    const after = ledger.read();
    expect(after.corrupt).toBeUndefined();
    expect(after.records).toHaveLength(1);
    expect(after.records[0]?.correlationId).toBe("a".repeat(64));
  });

  it("leaves a clean ledger untouched", () => {
    const dir = freshDir();
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    expect(ledger.appendDetailed(receipt(), { durable: true }).ok).toBe(true);
    const result = ledger.repair();
    expect(result.repaired).toBe(false);
    expect(ledger.read().records).toHaveLength(1);
  });

  it("refuses to trim mid-file corruption it cannot interpret", () => {
    const dir = freshDir();
    const ledgerPath = join(dir, "evidence.log");
    const ledger = testLedgerForFile(ledgerPath);
    expect(ledger.appendDetailed(receipt(), { durable: true }).ok).toBe(true);
    appendFileSync(ledgerPath, "{not valid json}\n");
    expect(ledger.appendDetailed(receipt({ id: "test-id-3" }), { durable: true }).ok).toBe(true);
    expect(ledger.read().corrupt?.reason).toBe("corrupt-record");
    const result = ledger.repair();
    expect(result.repaired).toBe(false);
    // Nothing was destroyed: the valid records around the bad line survive.
    expect(ledger.read().records).toHaveLength(1);
  });
});
