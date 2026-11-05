/**
 * Purpose: correlate retained Jeverb receipt IDs with gateway request records without exporting IDs.
 * Ownership: bounded, content-free correlation of receipt and gateway metadata.
 * Forbidden: reading or retaining request/response bodies, headers, credentials, or case content.
 */
export type ReceiptRun = "mission-completion-lockbox-v3-jevgateway-3stage-r1" | "mission-completion-dev-v3-jevgateway-3stage-r1";
export type ReceiptStage = "model_only" | "integrated";

export interface ExpectedReceiptRequest {
  run: ReceiptRun;
  stage: ReceiptStage;
}

export interface GatewayRequestMetadata {
  incoming_request_id?: unknown;
  provider_id?: unknown;
  endpoint?: unknown;
  model?: unknown;
  http_status?: unknown;
  upstream_status?: unknown;
  downstream_status?: unknown;
  final_gateway_outcome?: unknown;
  timestamp_started?: unknown;
}

export interface GatewayReceiptCorrelation {
  expectedRequests: Record<ReceiptRun, Record<ReceiptStage, number>>;
  matchedRequests: Record<ReceiptRun, Record<ReceiptStage, number>>;
  unmatchedRequests: Record<ReceiptRun, Record<ReceiptStage, number>>;
  duplicateIncomingIds: number;
  matchedGatewayOutcomes: Array<{
    run: ReceiptRun;
    stage: ReceiptStage;
    dayUtc: string;
    provider: string;
    endpoint: string;
    model: string;
    httpStatus: number | null;
    upstreamStatus: number | null;
    downstreamStatus: number | null;
    finalOutcome: string;
    requests: number;
  }>;
}

export function parseReceiptRequestIds(text: string, run: ReceiptRun): {
  ids: Map<string, ExpectedReceiptRequest>;
  rows: number;
  malformedRows: number;
} {
  const ids = new Map<string, ExpectedReceiptRequest>();
  let rows = 0;
  let malformedRows = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { malformedRows += 1; continue; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      malformedRows += 1;
      continue;
    }
    rows += 1;
    const row = value as Record<string, unknown>;
    for (const [field, stage] of [["modelRequestId", "model_only"], ["integratedRequestId", "integrated"]] as const) {
      const id = row[field];
      if (typeof id !== "string" || id.length < 8 || id.length > 160 || !/^[A-Za-z0-9_.:-]+$/.test(id)) continue;
      if (!ids.has(id)) ids.set(id, { run, stage });
    }
  }
  return { ids, rows, malformedRows };
}

function safeToken(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:/~-]{1,120}$/.test(value) ? value : fallback;
}

function status(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 599 ? value : null;
}

function dayUtc(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  try { return new Date(value * 1000).toISOString().slice(0, 10); } catch { return "unknown"; }
}

export function createGatewayReceiptCorrelator(expected: Map<string, ExpectedReceiptRequest>): {
  observe(row: GatewayRequestMetadata): void;
  finish(): GatewayReceiptCorrelation;
} {
  const matched = new Set<string>();
  const outcomeCounts = new Map<string, { values: Omit<GatewayReceiptCorrelation["matchedGatewayOutcomes"][number], "requests">; requests: number }>();
  let duplicateIncomingIds = 0;

  return {
    observe(row) {
      const id = row.incoming_request_id;
      if (typeof id !== "string") return;
      const receipt = expected.get(id);
      if (!receipt) return;
      if (matched.has(id)) duplicateIncomingIds += 1;
      matched.add(id);
      const values = {
        run: receipt.run,
        stage: receipt.stage,
        dayUtc: dayUtc(row.timestamp_started),
        provider: safeToken(row.provider_id),
        endpoint: row.endpoint === "/jev/api/alpha/decisions" ? row.endpoint : "other",
        model: safeToken(row.model),
        httpStatus: status(row.http_status),
        upstreamStatus: status(row.upstream_status),
        downstreamStatus: status(row.downstream_status),
        finalOutcome: safeToken(row.final_gateway_outcome),
      };
      const key = JSON.stringify(values);
      const entry = outcomeCounts.get(key);
      if (entry) entry.requests += 1;
      else outcomeCounts.set(key, { values, requests: 1 });
    },
    finish() {
      const runs: ReceiptRun[] = [
        "mission-completion-lockbox-v3-jevgateway-3stage-r1",
        "mission-completion-dev-v3-jevgateway-3stage-r1",
      ];
      const stages: ReceiptStage[] = ["model_only", "integrated"];
      const expectedRequests = Object.fromEntries(runs.map((run) => [run, Object.fromEntries(stages.map((stage) => [stage, 0]))])) as GatewayReceiptCorrelation["expectedRequests"];
      const matchedRequests = Object.fromEntries(runs.map((run) => [run, Object.fromEntries(stages.map((stage) => [stage, 0]))])) as GatewayReceiptCorrelation["matchedRequests"];
      for (const request of expected.values()) expectedRequests[request.run][request.stage] += 1;
      for (const id of matched) {
        const request = expected.get(id)!;
        matchedRequests[request.run][request.stage] += 1;
      }
      const unmatchedRequests = Object.fromEntries(runs.map((run) => [run, Object.fromEntries(stages.map((stage) => [stage, expectedRequests[run][stage] - matchedRequests[run][stage]]))])) as GatewayReceiptCorrelation["unmatchedRequests"];
      return {
        expectedRequests,
        matchedRequests,
        unmatchedRequests,
        duplicateIncomingIds,
        matchedGatewayOutcomes: [...outcomeCounts.values()].map(({ values, requests }) => ({ ...values, requests })).sort((a, b) =>
          `${a.run}/${a.stage}/${a.dayUtc}/${a.provider}/${a.httpStatus}`.localeCompare(`${b.run}/${b.stage}/${b.dayUtc}/${b.provider}/${b.httpStatus}`)),
      };
    },
  };
}
