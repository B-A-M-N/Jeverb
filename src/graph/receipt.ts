import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describeLedgerCorrupt, EvidenceLedger, hashSubject } from "../evidence/ledger.js";
import { withFileLock } from "../hooks/store-lock.js";
import type { ExecutorResult } from "./executor.js";

export type GraphReceiptResult =
  | { status: "appended" | "duplicate"; correlationId: string }
  | { status: "conflict" | "unavailable"; correlationId: string; reason: string };

/**
 * Project one compact graph terminal outcome into the shared evidence ledger.
 * Output content is never copied: the journal digest and graph/input hashes
 * preserve provenance without turning command output into an evidence leak.
 */
export function persistGraphNodeReceipt(args: {
  ledger: EvidenceLedger;
  runId: string;
  graphHash: string;
  policyHash: string;
  result: ExecutorResult;
  museSessionId?: string;
  candidate?: string;
}): GraphReceiptResult {
  const { ledger, runId, graphHash, policyHash, result } = args;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId) || !/^[0-9a-f]{64}$/.test(graphHash) || !/^[0-9a-f]{64}$/.test(policyHash)) {
    return { status: "unavailable", correlationId: "", reason: "graph receipt identity failed validation" };
  }
  const hostSessionId = args.museSessionId !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(args.museSessionId)
    ? args.museSessionId
    : undefined;
  const correlationId = createHash("sha256")
    .update([hostSessionId ?? "", runId, graphHash, policyHash, args.candidate ?? "", result.nodeId, result.inputHash, result.outputDigest, result.status].join("\0"))
    .digest("hex");
  const deterministicFindings = [
    `node_id_hash=${hashSubject(result.nodeId)}`,
    `node_status=${result.status}`,
    `input_hash=${result.inputHash}`,
    `output_digest=${result.outputDigest}`,
  ];
  const record = {
    schema: 1 as const,
    id: "",
    ts: new Date().toISOString(),
    // MCP stdio has no authenticated Muse session identity. Keep the run
    // namespace explicit instead of attributing it to a claimed source.
    sessionId: hostSessionId ?? `mcp-run:${runId}`,
    turnId: runId,
    decisionId: correlationId.slice(0, 32),
    correlationId,
    eventHost: hostSessionId === undefined ? "mcp" : "muse-mcp",
    outcome: "execution-observed" as const,
    ...(args.candidate === undefined ? {} : { candidate: args.candidate }),
    outputDigest: result.outputDigest,
    executionStatus: result.status,
    event: "GraphNodeTerminal",
    subjectHash: hashSubject(`${graphHash}\n${result.inputHash}\n${result.outputDigest}`),
    policyVersion: `graph-execution/${policyHash}`,
    deterministicFindings,
    enforcement: `execution_${result.status}`,
    reasons: ["terminal graph status recorded; output text excluded"],
    latencyMs: 0,
  };
  // Idempotency scope for one node terminal: every duplicate projection of
  // the same (runId, nodeId) — retries, redeliveries, racing attempts — maps
  // to this key regardless of its outcome digest. ExecutorResult carries no
  // per-attempt or branch identity (attempts is a total count, identical
  // across duplicates), so the key scopes to (runId, nodeId). The lock name
  // and the duplicate check both derive from it, so check-and-act for one
  // node share a single lock instead of one lock per correlation id.
  // The ledger also accepts an idempotencyKey, but its duplicate scope
  // includes the receipt correlation/session/event/tool-use tuple. This graph
  // receipt uses the stronger (runId, nodeId) scope across changing outcome
  // digests, so its dedicated lock plus verify-and-retry read remains the
  // authoritative check-and-act boundary here.
  const idempotencyKey = createHash("sha256")
    .update(["graph-node-terminal", runId, result.nodeId].join("\0"))
    .digest("hex");
  const nodeIdFinding = `node_id_hash=${hashSubject(result.nodeId)}`;
  const lockName = `graph-receipt-node-${idempotencyKey.slice(0, 32)}`;
  try {
    mkdirSync(dirname(ledger.path), { recursive: true, mode: 0o700 });
  } catch (error) {
    return { status: "unavailable", correlationId, reason: error instanceof Error ? error.message : String(error) };
  }
  // Bounded stabilization: a concurrent prune can rename the ledger between
  // our check and our append (prune holds the ledger basename lock, not this
  // lock). A final verification read detects the detached write and retries
  // instead of reporting a receipt that is not on disk.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const locked = withFileLock(dirname(ledger.path), lockName, (): GraphReceiptResult | { status: "retry"; correlationId: string } => {
      try {
        const current = ledger.read();
        if (current.corrupt !== undefined) return { status: "unavailable" as const, correlationId, reason: describeLedgerCorrupt(current.corrupt) };
        const existing = current.records.find((entry) => entry.event === record.event && entry.correlationId === correlationId);
        let winner: string | undefined;
        let appendedNow: boolean;
        if (existing !== undefined) {
          const same =
            existing.sessionId === record.sessionId &&
            existing.eventHost === record.eventHost &&
            existing.outcome === record.outcome &&
            existing.candidate === record.candidate &&
            existing.subjectHash === record.subjectHash &&
            existing.policyVersion === record.policyVersion &&
            existing.enforcement === record.enforcement &&
            JSON.stringify(existing.deterministicFindings) === JSON.stringify(record.deterministicFindings);
          if (!same) {
            return { status: "conflict" as const, correlationId, reason: "a different graph terminal receipt already uses this correlation id" };
          }
          winner = existing.correlationId;
          appendedNow = false;
        } else {
          // First write wins per (runId, nodeId): a duplicate projection
          // with a different outcome digest reports the existing row
          // instead of appending a conflicting second terminal row.
          const scoped = current.records.find(
            (entry) => entry.event === record.event && entry.turnId === runId && entry.deterministicFindings.includes(nodeIdFinding),
          );
          if (scoped !== undefined) {
            winner = scoped.correlationId;
            appendedNow = false;
          } else {
            const appended = ledger.appendDetailed(record, { durable: true });
            if (!appended.ok) return { status: "unavailable" as const, correlationId, reason: appended.error.message };
            winner = correlationId;
            appendedNow = true;
          }
        }
        if (winner === undefined) return { status: "unavailable" as const, correlationId, reason: "existing graph terminal receipt lacks a correlation id" };
        const verify = ledger.read();
        if (verify.corrupt !== undefined) return { status: "unavailable" as const, correlationId, reason: describeLedgerCorrupt(verify.corrupt) };
        const present = verify.records.some((entry) => entry.event === record.event && entry.correlationId === winner);
        if (!present) return { status: "retry" as const, correlationId };
        return appendedNow
          ? { status: "appended" as const, correlationId }
          : { status: "duplicate" as const, correlationId: winner };
      } catch (error) {
        return { status: "unavailable" as const, correlationId, reason: error instanceof Error ? error.message : String(error) };
      }
    });
    if (!locked.locked || locked.value === undefined) {
      return { status: "unavailable", correlationId, reason: "could not acquire graph receipt lock" };
    }
    if (locked.value.status !== "retry") return locked.value;
  }
  return { status: "unavailable", correlationId, reason: "could not stabilize graph terminal receipt" };
}
