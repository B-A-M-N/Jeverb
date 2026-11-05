#!/usr/bin/env tsx
/** Correlate receipt request IDs with gateway metadata; never emit the IDs. */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  createGatewayReceiptCorrelator,
  parseReceiptRequestIds,
  type GatewayRequestMetadata,
  type ReceiptRun,
} from "../src/jev/gateway-receipt-correlation.js";
import { assertOutputPathAvailable } from "./artifact-output.js";

function required(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const gatewayPath = required("--gateway");
  const finalPath = required("--final-receipts");
  const devPath = required("--dev-receipts");
  const outPath = required("--out");
  const receiptSpecs: Array<[ReceiptRun, string]> = [
    ["mission-completion-lockbox-v3-jevgateway-3stage-r1", finalPath],
    ["mission-completion-dev-v3-jevgateway-3stage-r1", devPath],
  ];
  const expected = new Map<string, { run: ReceiptRun; stage: "model_only" | "integrated" }>();
  const receiptSources: Record<string, { sha256: string; bytes: number; rows: number; malformedRows: number }> = {};
  for (const [run, path] of receiptSpecs) {
    const bytes = readFileSync(path);
    const parsed = parseReceiptRequestIds(bytes.toString("utf8"), run);
    for (const [id, item] of parsed.ids) {
      if (expected.has(id)) throw new Error("receipt request ID collision across runs");
      expected.set(id, item);
    }
    receiptSources[run] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      rows: parsed.rows,
      malformedRows: parsed.malformedRows,
    };
  }

  const gatewayHash = createHash("sha256");
  const correlator = createGatewayReceiptCorrelator(expected);
  let gatewayRecords = 0;
  let malformedLines = 0;
  const input = createReadStream(gatewayPath);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    gatewayHash.update(`${line}\n`);
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line) as unknown; } catch { malformedLines += 1; continue; }
    if (typeof row !== "object" || row === null || Array.isArray(row)) { malformedLines += 1; continue; }
    gatewayRecords += 1;
    correlator.observe(row as GatewayRequestMetadata);
  }

  const summary = {
    schema: "jeverb-gateway-receipt-correlation/1",
    analyzedAt: new Date().toISOString(),
    gatewaySource: {
      name: "gateway-requests.jsonl",
      bytes: statSync(gatewayPath).size,
      sha256: gatewayHash.digest("hex"),
      records: gatewayRecords,
      malformedLines,
    },
    receiptSources,
    correlationBasis: "receipt modelRequestId/integratedRequestId equals Locus incoming_request_id captured from X-Request-ID",
    correlation: correlator.finish(),
    redaction: "No request IDs, case IDs, request/response payloads, headers, credentials, or client identity are emitted.",
  };
  assertOutputPathAvailable(outPath);
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const correlation = summary.correlation;
  console.log(JSON.stringify({
    status: "correlated",
    gatewayRecords,
    malformedLines,
    expected: correlation.expectedRequests,
    matched: correlation.matchedRequests,
    unmatched: correlation.unmatchedRequests,
    duplicateIncomingIds: correlation.duplicateIncomingIds,
    rawIdsEmitted: false,
  }));
}

main().catch((error: unknown) => {
  console.error(`jev-correlate-gateway-receipts: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
