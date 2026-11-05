/**
 * REVIEW: graph terminal receipt idempotency scope (`persistGraphNodeReceipt`,
 * src/graph/receipt.ts) — first-write-wins per (runId, nodeId).
 *
 * Method: real `persistGraphNodeReceipt` against a real `EvidenceLedger` on
 * a temp dir (fake executor results, no inference, no network), plus a real
 * `FileJournal` + `reconcileJournal` projection for the attempt-history half.
 *
 * FINDINGS:
 *
 * 1. Idempotent redelivery is preserved: the same terminal projected twice
 *    (same runId, nodeId, hashes, status) appends once and reports the
 *    second as `duplicate` with the first correlation id. The ledger holds
 *    exactly one row.
 *
 * 2. CONFLICT SCOPE: a second terminal for the SAME (runId, nodeId) with a
 *    DIFFERENT outcome digest or status (a retry that settled differently,
 *    or a redelivery of a superseded attempt) also reports `duplicate` with
 *    the FIRST correlation id. The divergent terminal is not appended, no
 *    `conflict` status is surfaced, and the ledger keeps only the first
 *    row. A reader that follows the returned correlation id sees the first
 *    outcome only — the divergent history is hidden behind a `duplicate`
 *    label. This is the (runId, nodeId) scope obscuring a genuine conflict,
 *    demonstrated below.
 *
 * 3. Attempt history IS preserved one layer down: `reconcileJournal` keeps
 *    every authorized/running attempt id for the node (last-terminal-wins
 *    for the outcome, full lineage in `attemptIds`), and re-reconciling the
 *    same file is idempotent. So the journal answers "which attempts ran",
 *    while the receipt layer answers only "first terminal wins".
 *
 * RECOMMENDATION (for the graph owner — NOT fixed here; graph/* is outside
 * this workstream's write scope): when a second terminal under one
 * (runId, nodeId) carries a different outcome digest or status, surface
 * `conflict` (or a divergent-receipt row) instead of `duplicate`, so
 * buyers of the receipt can distinguish "same event redelivered" from
 * "the node settled differently on retry". The demonstration below is the
 * failing-direction test: it pins current behavior as `duplicate` so any
 * future change of scope is a deliberate, reviewed diff.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutorResult } from "../../src/graph/executor.js";
import { reconcileJournal, FileJournal } from "../../src/graph/journal.js";
import { persistGraphNodeReceipt } from "../../src/graph/receipt.js";
import { testLedgerForFile } from "../helpers/control-state.js";
import { mkdtempSync } from "../helpers/temp-directory.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jeverb-receipt-dedup-review-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function terminal(nodeId: string, status: "succeeded" | "failed", outputDigest: string): ExecutorResult {
  return {
    nodeId,
    ok: status === "succeeded",
    output: "output excerpt",
    attempts: 1,
    status,
    inputHash: "a".repeat(64),
    outputHash: "b".repeat(64),
    outputDigest,
  } as ExecutorResult;
}

describe("graph receipt dedup scope review", () => {
  it("redelivery of the identical terminal is idempotent (one row, duplicate)", () => {
    const dir = tempDir();
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const args = {
      ledger,
      runId: "run_1",
      graphHash: "d".repeat(64),
      policyHash: "e".repeat(64),
      result: terminal("build", "succeeded", "c".repeat(64)),
    };
    const first = persistGraphNodeReceipt(args);
    const second = persistGraphNodeReceipt(args);
    expect(first.status).toBe("appended");
    expect(second).toEqual({ status: "duplicate", correlationId: first.correlationId });
    expect(ledger.read().records.filter((record) => record.event === "GraphNodeTerminal")).toHaveLength(1);
  });

  it("DEMONSTRATED: a divergent retry terminal hides behind duplicate (conflict obscured)", () => {
    const dir = tempDir();
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const base = {
      ledger,
      runId: "run_1",
      graphHash: "d".repeat(64),
      policyHash: "e".repeat(64),
    };
    const first = persistGraphNodeReceipt({ ...base, result: terminal("build", "succeeded", "c".repeat(64)) });
    expect(first.status).toBe("appended");
    // The node retries and settles differently — a genuinely conflicting
    // terminal history for the same (runId, nodeId).
    const retry = persistGraphNodeReceipt({ ...base, result: terminal("build", "failed", "f".repeat(64)) });
    // Current behavior: reported as a duplicate of the first row. No
    // conflict is surfaced and no second row is recorded.
    expect(retry).toEqual({ status: "duplicate", correlationId: first.correlationId });
    const rows = ledger.read().records.filter((record) => record.event === "GraphNodeTerminal");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.correlationId).toBe(first.correlationId);
    expect(rows[0]?.executionStatus).toBe("succeeded");
  });

  it("journal reconcile preserves the full attempt lineage across a retry", () => {
    const dir = tempDir();
    const journal = new FileJournal("run-1", dir, "session-1");
    journal.record({ type: "run-started", runId: "run-1", ts: "2026-01-01T00:00:00.000Z", graphHash: "d".repeat(64), policyHash: "e".repeat(64) });
    journal.record({ type: "node-authorized", runId: "run-1", ts: "2026-01-01T00:00:01.000Z", nodeId: "build", attemptId: "build/1", allowed: true, inputHash: "a".repeat(64) });
    journal.record({ type: "node-running", runId: "run-1", ts: "2026-01-01T00:00:02.000Z", nodeId: "build", attemptId: "build/1", inputHash: "a".repeat(64) });
    journal.record({ type: "node-terminal", runId: "run-1", ts: "2026-01-01T00:00:03.000Z", nodeId: "build", attemptId: "build/1", status: "failed", inputHash: "a".repeat(64), outputDigest: "c".repeat(64) });
    journal.record({ type: "node-authorized", runId: "run-1", ts: "2026-01-01T00:00:04.000Z", nodeId: "build", attemptId: "build/2", allowed: true, inputHash: "a".repeat(64) });
    journal.record({ type: "node-running", runId: "run-1", ts: "2026-01-01T00:00:05.000Z", nodeId: "build", attemptId: "build/2", inputHash: "a".repeat(64) });
    journal.record({ type: "node-terminal", runId: "run-1", ts: "2026-01-01T00:00:06.000Z", nodeId: "build", attemptId: "build/2", status: "succeeded", inputHash: "a".repeat(64), outputDigest: "f".repeat(64) });

    const journalPath = join(dir, "jeverb-graph-run-1.jsonl");
    const first = reconcileJournal(journalPath);
    const second = reconcileJournal(journalPath);
    expect(second).toEqual(first);
    expect(first.nodes).toHaveLength(1);
    expect(first.nodes[0]?.status).toBe("succeeded");
    expect(first.nodes[0]?.outputDigest).toBe("f".repeat(64));
    // Both attempts survive: last-terminal-wins for the outcome, full
    // lineage for the history (authorized + running each record the attempt).
    expect(first.nodes[0]?.attemptIds).toEqual(["build/1", "build/1", "build/2", "build/2"]);
    expect([...new Set(first.nodes[0]?.attemptIds)]).toEqual(["build/1", "build/2"]);
  });
});
