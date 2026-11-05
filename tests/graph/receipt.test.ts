import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import { persistGraphNodeReceipt } from "../../src/graph/receipt.js";
import type { ExecutorResult } from "../../src/graph/executor.js";
import { testLedgerForFile } from "../helpers/control-state.js";

const result: ExecutorResult = {
  nodeId: "compile",
  ok: true,
  output: "sensitive command output",
  attempts: 1,
  status: "succeeded",
  inputHash: "a".repeat(64),
  outputHash: "b".repeat(64),
  outputDigest: "c".repeat(64),
};

describe("graph evidence receipts", () => {
  it("persists compact provenance without copying output text and deduplicates redelivery", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-graph-receipts-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const args = {
      ledger,
      runId: "run_123",
      graphHash: "d".repeat(64),
      policyHash: "e".repeat(64),
      result,
    };
    const first = persistGraphNodeReceipt(args);
    const second = persistGraphNodeReceipt(args);
    expect(first.status).toBe("appended");
    expect(second).toEqual({ status: "duplicate", correlationId: first.correlationId });
    const records = ledger.read().records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "GraphNodeTerminal",
      eventHost: "mcp",
      outcome: "execution-observed",
      sessionId: "mcp-run:run_123",
      correlationId: first.correlationId,
      subjectHash: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    const raw = readFileSync(ledger.path, "utf8");
    expect(raw).toContain("output_digest=");
    expect(raw).not.toContain("sensitive command output");
  });

  it("fails closed on corrupt evidence instead of reporting a persisted projection", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-graph-receipts-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    writeFileSync(ledger.path, "{truncated", { mode: 0o600 });
    const outcome = persistGraphNodeReceipt({
      ledger,
      runId: "run_123",
      graphHash: "d".repeat(64),
      policyHash: "e".repeat(64),
      result,
    });
    expect(outcome.status).toBe("unavailable");
    // The denial names the corruption kind and byte offset so the operator
    // knows a torn tail (maintenance repair) from deeper damage.
    if (outcome.status === "unavailable") {
      expect(outcome.reason).toMatch(/corrupt-truncated at byte 0/);
    } else {
      throw new Error("expected unavailable");
    }
  });

  it("reports conflict instead of appending when a forged row reuses a terminal correlation id", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-graph-receipts-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const runId = "run_123";
    const graphHash = "d".repeat(64);
    const policyHash = "e".repeat(64);
    // Mirrors the correlation formula in persistGraphNodeReceipt: same
    // (runId, node, hashes, status) always yields this id.
    const expectedId = createHash("sha256")
      .update(["", runId, graphHash, policyHash, "", result.nodeId, result.inputHash, result.outputDigest, result.status].join("\0"))
      .digest("hex");
    const planted = ledger.appendDetailed({
      schema: 1,
      id: "",
      ts: new Date().toISOString(),
      sessionId: "mcp-run:run_123",
      turnId: runId,
      decisionId: expectedId.slice(0, 32),
      correlationId: expectedId,
      event: "GraphNodeTerminal",
      eventHost: "mcp",
      outcome: "execution-observed",
      subjectHash: "f".repeat(32),
      policyVersion: `graph-execution/${policyHash}`,
      outputDigest: result.outputDigest,
      executionStatus: result.status,
      deterministicFindings: [`node_id_hash=forged`, `node_status=${result.status}`],
      enforcement: `execution_${result.status}`,
      reasons: ["forged row planted by test"],
      latencyMs: 0,
    }, { durable: true });
    expect(planted.ok).toBe(true);
    const outcome = persistGraphNodeReceipt({ ledger, runId, graphHash, policyHash, result });
    expect(outcome.status).toBe("conflict");
    expect(outcome.correlationId).toBe(expectedId);
    if (outcome.status === "conflict") {
      expect(outcome.reason).toContain("different graph terminal receipt");
    }
    expect(ledger.read().records).toHaveLength(1);
  });

  it("rejects invalid run and graph identities", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-graph-receipts-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    expect(persistGraphNodeReceipt({
      ledger,
      runId: "../outside",
      graphHash: "d".repeat(64),
      policyHash: "e".repeat(64),
      result,
    }).status).toBe("unavailable");
  });
});
