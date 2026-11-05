/**
 * Purpose: summarize installed Jeverb decision/evidence logs without exporting raw session content.
 * Ownership: read-only hook telemetry aggregation for qualification audits.
 * Forbidden: inference, enforcement changes, or collecting unredacted prompts/errors.
 */
import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

function countObject(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.:/~-]{0,119}$/.test(trimmed) ? trimmed : undefined;
}

function parseJsonLines(text: string): { rows: JsonRecord[]; malformed: number; nonObject: number } {
  const rows: JsonRecord[] = [];
  let malformed = 0;
  let nonObject = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { malformed += 1; continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) { nonObject += 1; continue; }
    rows.push(value as JsonRecord);
  }
  return { rows, malformed, nonObject };
}

function errorClass(error: string): string {
  if (/unexpected status on \/api\/alpha\/decisions/i.test(error)) return "typed_decision_unexpected_status";
  if (/^AbortError:/i.test(error)) return "abort";
  if (/^SyntaxError:/i.test(error)) return "json_parse";
  if (/Jev(?:Protocol|Validation)Error|invalid (?:model )?response/i.test(error)) return "invalid_response";
  if (/timeout|timed out/i.test(error)) return "timeout";
  if (/\b(?:401|403|429|5\d\d)\b|httpStatus=\d{3}/i.test(error)) return "http_status";
  return "other";
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Produces only hashes, counts, and validated identity tokens; raw text never enters the result. */
export function summarizeInstalledTelemetry(args: { decisionsText: string; evidenceText: string; analyzedAt?: string }): JsonRecord {
  const decisions = parseJsonLines(args.decisionsText);
  const evidence = parseJsonLines(args.evidenceText);
  const eventDecision = new Map<string, number>();
  const errorClasses = new Map<string, number>();
  const errorsByEvent = new Map<string, number>();
  const backendValues = new Map<string, number>();
  const modelValues = new Map<string, number>();
  const providerValues = new Map<string, number>();
  const statusCodes = new Map<string, number>();
  const matchingToolNames = new Map<string, number>();
  const eventCounts = new Map<string, number>();
  const decisionsByName = new Map<string, number>();
  const topLevelIdentityCoverage = { backend: 0, model: 0, provider: 0 };

  for (const row of decisions.rows) {
    const event = safeLabel(row.event) ?? "other";
    const decision = safeLabel(row.decision) ?? "other";
    const pair = `${event}/${decision}`;
    eventDecision.set(pair, (eventDecision.get(pair) ?? 0) + 1);
    eventCounts.set(event, (eventCounts.get(event) ?? 0) + 1);
    decisionsByName.set(decision, (decisionsByName.get(decision) ?? 0) + 1);
    for (const field of ["backend", "model", "provider"] as const) {
      const value = safeLabel(row[field]);
      if (value !== undefined) {
        topLevelIdentityCoverage[field] += 1;
        const target = field === "backend" ? backendValues : field === "model" ? modelValues : providerValues;
        target.set(value, (target.get(value) ?? 0) + 1);
      }
    }
    if (typeof row.error === "string") {
      const cls = errorClass(row.error);
      errorClasses.set(cls, (errorClasses.get(cls) ?? 0) + 1);
      errorsByEvent.set(event, (errorsByEvent.get(event) ?? 0) + 1);
      const status = row.error.match(/httpStatus=(\d{3})/i)?.[1];
      if (status) statusCodes.set(status, (statusCodes.get(status) ?? 0) + 1);
      const embeddedBackend = row.error.match(/\bbackend=([A-Za-z][A-Za-z0-9_.:/~-]{0,119})/i)?.[1];
      const embeddedModel = row.error.match(/\bmodel=([A-Za-z][A-Za-z0-9_.:/~-]{0,119})/i)?.[1];
      const embeddedProvider = row.error.match(/\bprovider=([A-Za-z][A-Za-z0-9_.:/~-]{0,119})/i)?.[1];
      if (embeddedBackend && safeLabel(row.backend) === undefined) backendValues.set(embeddedBackend, (backendValues.get(embeddedBackend) ?? 0) + 1);
      if (embeddedModel && safeLabel(row.model) === undefined) modelValues.set(embeddedModel, (modelValues.get(embeddedModel) ?? 0) + 1);
      if (embeddedProvider && safeLabel(row.provider) === undefined) providerValues.set(embeddedProvider, (providerValues.get(embeddedProvider) ?? 0) + 1);
    }
    const toolName = safeLabel(row.tool_name);
    if (toolName && /graph|jev|mission|next[_-]?step|verify/i.test(toolName)) {
      matchingToolNames.set(toolName, (matchingToolNames.get(toolName) ?? 0) + 1);
    }
  }

  const judgmentCounts = new Map<string, number>();
  const evidenceEvents = new Map<string, number>();
  const enforcementCounts = new Map<string, number>();
  for (const row of evidence.rows) {
    for (const [field, target] of [["judgment", judgmentCounts], ["event", evidenceEvents], ["enforcement", enforcementCounts]] as const) {
      const value = safeLabel(row[field]);
      if (value !== undefined) target.set(value, (target.get(value) ?? 0) + 1);
    }
  }

  return {
    schema: "jeverb-installed-telemetry-audit/1",
    analyzedAt: args.analyzedAt ?? new Date().toISOString(),
    sources: {
      decisions: { sha256: digest(args.decisionsText), records: decisions.rows.length, malformedLines: decisions.malformed, nonObjectLines: decisions.nonObject },
      evidence: { sha256: digest(args.evidenceText), records: evidence.rows.length, malformedLines: evidence.malformed, nonObjectLines: evidence.nonObject },
    },
    decisions: {
      eventCounts: countObject(eventCounts),
      decisionCounts: countObject(decisionsByName),
      eventDecisionCounts: countObject(eventDecision),
      errorsByEvent: countObject(errorsByEvent),
      errorClassCounts: countObject(errorClasses),
      recordedHttpStatusCounts: countObject(statusCodes),
      identityFieldRows: topLevelIdentityCoverage,
      observedBackendLabels: countObject(backendValues),
      observedModelLabels: countObject(modelValues),
      observedProviderLabels: countObject(providerValues),
      graphOrJevToolNames: countObject(matchingToolNames),
    },
    evidence: {
      eventCounts: countObject(evidenceEvents),
      enforcementCounts: countObject(enforcementCounts),
      judgmentOutcomeCounts: countObject(judgmentCounts),
    },
  };
}
