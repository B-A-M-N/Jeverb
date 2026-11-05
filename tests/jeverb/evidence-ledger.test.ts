import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLedger, isValidReceipt } from "../../src/evidence/ledger.js";
import { dispatchEvent } from "../../src/hooks/unified.js";
import { buildDeps } from "../../src/hooks/main.js";
import { loadHookConfig } from "../../src/hooks/config.js";
import { FakeModel, noul, score } from "../helpers/fake-model.js";
import { setTestSwitch, testHookConfig, testLedgerForFile } from "../helpers/control-state.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "jeverb-evidence-"));
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1 as const,
    id: "",
    ts: new Date(0).toISOString(),
    sessionId: "s1",
    event: "PreToolUse",
    subjectHash: "abc",
    policyVersion: "1",
    deterministicFindings: [] as string[],
    enforcement: "deny",
    reasons: ["blocked"],
    latencyMs: 1,
    ...overrides,
  };
}

describe("evidence ledger", () => {
  it("does not create or append evidence while the install-wide switch is off", () => {
    // Suppression authority is the protected control state, not a bare
    // marker file (Wave 1 D1a): only the control state can disable receipts.
    const root = dir();
    setTestSwitch(root, "OFF");
    const path = join(root, "evidence.log");
    const result = testLedgerForFile(path).appendDetailed(receipt());
    expect(result.ok).toBe(false);
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("mints unique receipt ids and preserves decision correlation", () => {
    const path = join(dir(), "evidence.log");
    const ledger = testLedgerForFile(path);
    expect(ledger.append(receipt({ decisionId: "d1", toolUseId: "t1", candidate: "sha-x" }))).toBe(true);
    expect(ledger.append(receipt({ decisionId: "d1", toolUseId: "t1", candidate: "sha-x" }))).toBe(true);
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const [a, b] = lines.map((l) => JSON.parse(l) as { id: string; decisionId: string; toolUseId: string; candidate: string });
    expect(a?.id).not.toBe(b?.id);
    expect(a?.decisionId).toBe("d1");
    expect(a?.toolUseId).toBe("t1");
    expect(a?.candidate).toBe("sha-x");
  });

  it("returns false instead of throwing when unwritable", () => {
    const blocked = dir();
    expect(testLedgerForFile(blocked).append(receipt())).toBe(false);
  });

  it("redacts bearer tokens, passwords, and URL credentials", () => {
    const path = join(dir(), "evidence.log");
    const ledger = testLedgerForFile(path);
    const secret = "Bearer abcdefgh12345678 and password=hunter2-secret https://user:p4ssw0rd@example.com/x";
    expect(ledger.append(receipt({ reasons: [secret], error: secret }))).toBe(true);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("abcdefgh12345678");
    expect(raw).not.toContain("hunter2-secret");
    expect(raw).not.toContain("p4ssw0rd");
    expect(raw).toContain("[REDACTED]");
  });

  it("validates receipt shape", () => {
    expect(isValidReceipt(receipt())).toBe(true);
    expect(isValidReceipt({ ...receipt(), schema: 2 })).toBe(false);
    expect(isValidReceipt({ ...receipt(), reasons: "nope" })).toBe(false);
    expect(isValidReceipt(null)).toBe(false);
  });

  it("durable append fsyncs a readable receipt", () => {
    const path = join(dir(), "evidence.log");
    const ledger = testLedgerForFile(path);
    expect(ledger.append(receipt({ id: "durable-1" }), { durable: true })).toBe(true);
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(isValidReceipt(JSON.parse(lines[0] as string))).toBe(true);
  });

  it("stamps the harness-planted candidate file when env is absent", () => {
    const savedEnv = process.env["JEVERB_CANDIDATE"];
    delete process.env["JEVERB_CANDIDATE"];
    try {
      const d = dir();
    writeFileSync(join(d, "candidate"), "  filesha99  \n");
    const ledger = testLedgerForFile(join(d, "evidence.log"));
    expect(ledger.append(receipt({ id: "c1" }))).toBe(true);
    const saved = JSON.parse(readFileSync(join(d, "evidence.log"), "utf8").split("\n")[0] as string) as {
      candidate?: string;
    };
    expect(saved.candidate).toBe("filesha99");
    } finally {
      if (savedEnv !== undefined) process.env["JEVERB_CANDIDATE"] = savedEnv;
    }
  });

  it("prefers an explicit record candidate over env and file", () => {
    const d = dir();
    writeFileSync(join(d, "candidate"), "filesha");
    const ledger = testLedgerForFile(join(d, "evidence.log"));
    expect(ledger.append(receipt({ id: "c2", candidate: "explicit" }))).toBe(true);
    const saved = JSON.parse(readFileSync(join(d, "evidence.log"), "utf8").split("\n")[0] as string) as {
      candidate?: string;
    };
    expect(saved.candidate).toBe("explicit");
  });

  it("refuses a symlinked ledger target instead of following it", () => {
    const outside = join(dir(), "real.log");
    writeFileSync(outside, "");
    const linkDir = dir();
    const link = join(linkDir, "evidence.log");
    symlinkSync(outside, link);
    expect(testLedgerForFile(link).append(receipt())).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("");
  });

  it("prunes by count and age, keeping newest", () => {
    const path = join(dir(), "evidence.log");
    const ledger = testLedgerForFile(path);
    for (const [ts, id] of [["2020-01-01T00:00:00.000Z", "old"], ["2024-01-01T00:00:00.000Z", "mid"], ["2024-06-01T00:00:00.000Z", "new"]] as const) {
      expect(ledger.append(receipt({ id, ts }))).toBe(true);
    }
    expect(ledger.prune({ maxCount: 2 })).toBe(2);
    let ids = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0).map((l) => (JSON.parse(l) as { id: string }).id);
    expect(ids).toEqual(["mid", "new"]);
    expect(ledger.prune({ maxAgeMs: 30 * 24 * 3600 * 1000 }, new Date("2024-07-01T00:00:00.000Z").getTime())).toBe(1);
    ids = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0).map((l) => (JSON.parse(l) as { id: string }).id);
    expect(ids).toEqual(["new"]);
  });
});

describe("implicit allow leaves exactly one advisory observation", () => {
  it("benign PreToolUse records advise (classified skip), never allow", async () => {
    const path = join(dir(), "evidence.log");
    const config = testHookConfig(dir());
    const deps = { ...buildDeps(config, null), ledger: testLedgerForFile(path) };
    const decision = await dispatchEvent(
      "PreToolUse",
      { session_id: "s1", tool_name: "Bash", tool_input: { command: "echo hi" } } as never,
      deps,
    );
    expect(decision).toBeUndefined();
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const receipt = JSON.parse(lines[0] as string) as {
      event: string;
      enforcement: string;
      reasons: string[];
      judgment?: string;
    };
    expect(receipt.event).toBe("PreToolUse");
    expect(receipt.enforcement).toBe("advise");
    expect(receipt.judgment).toBe("SKIPPED_READ_ONLY");
    expect(receipt.reasons.join("\n")).toMatch(/no judgment needed: read-only operation/);
  });
});

describe("completed judgment stamps the taxonomy on the receipt", () => {
  it("judgment-eligible PreToolUse records JUDGMENT_SUCCEEDED, not a bare allow", async () => {
    const path = join(dir(), "evidence.log");
    const config = testHookConfig(dir());
    const benign = new FakeModel(() => ({
      destructive: noul(0),
      outward_facing: noul(0),
      credential_exposure: noul(0),
      mentions_target: noul(0),
      same_task_area: noul(0),
      scope: score(0, ["unrelated", "ordinary step", "requested"], 1),
      blast_radius: score(0, ["none", "local", "shared", "production"], 1),
    }));
    const deps = { ...buildDeps(config, benign), ledger: testLedgerForFile(path) };
    const decision = await dispatchEvent(
      "PreToolUse",
      { session_id: "s1", tool_name: "Bash", tool_input: { command: "echo $(whoami)" } } as never,
      deps,
    );
    expect(decision?.enforcement).toBe("allow");
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const saved = JSON.parse(lines[0] as string) as { enforcement: string; judgment?: string; model?: string };
    expect(saved.enforcement).toBe("allow");
    expect(saved.judgment).toBe("JUDGMENT_SUCCEEDED");
    expect(typeof saved.model).toBe("string");
  });

  it("deterministic denial stamps DETERMINISTIC_DENY", async () => {
    const path = join(dir(), "evidence.log");
    const config = testHookConfig(dir());
    const deps = { ...buildDeps(config, null), ledger: testLedgerForFile(path) };
    const decision = await dispatchEvent(
      "PreToolUse",
      { session_id: "s1", tool_name: "Bash", tool_input: { command: "rm -rf /" } } as never,
      deps,
    );
    expect(decision?.enforcement).toBe("deny");
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    const saved = JSON.parse(lines[lines.length - 1] as string) as { judgment?: string };
    expect(saved.judgment).toBe("DETERMINISTIC_DENY");
  });
});

describe("receipt write failure on enforcing decisions", () => {
  it("deny stands and the gap is surfaced when the ledger is unwritable", async () => {
    const blocked = dir();
    const config = testHookConfig(dir());
    const deps = { ...buildDeps(config, null), ledger: testLedgerForFile(blocked) };
    const decision = await dispatchEvent(
      "PreToolUse",
      { session_id: "s1", tool_name: "Bash", tool_input: { command: "rm -rf /" } } as never,
      deps,
    );
    expect(decision?.enforcement).toBe("deny");
    expect(decision?.reasons.some((r) => r.includes("receipt write failed"))).toBe(true);
  });
});
