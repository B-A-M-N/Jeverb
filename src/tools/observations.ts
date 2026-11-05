/**
 * `jev_observations` — read-only retrieval of Jeverb observations for
 * external consumers such as Veyrict.
 *
 * Reads the local evidence ledger, projects receipts into the versioned
 * `JeverbObservation` contract, and returns the matching ones. Takes no
 * model, spends no tokens, writes nothing, and needs no API key: it only
 * re-presents evidence this install already recorded.
 *
 * What it is not: permission, approval, acceptance, or certification. The
 * contract carries no authorization surface by construction (the validator
 * rejects anything smuggling one in), and consumers must validate schema
 * and correlation before use.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  isJeverbObservation,
  observationFromReceipt,
  type JeverbObservation,
  type ObservationHost,
} from "../integrations/veyrict/observation.js";
import { isValidReceipt } from "../evidence/receipt-validation.js";
import type { ToolConfig } from "./shared.js";

export const name = "jev_observations";

export const description = [
  "Read Jeverb's recorded observations: deterministic findings and advisory model judgments for past hook and graph events.",
  "Filter by session, candidate, graph operation/run id, or event. Muse lifecycle observations may include opaque request, turn, and parent-tool correlations and host-reported token counters for diagnosis; turn IDs are not guaranteed whole-run IDs, and counters are not provider-verified billing or an enforced run budget.",
  "Observations retain full opaque receipt correlation ids and receipt digests for exact matching; these are integrity fingerprints, not authentication.",
  "Read-only: takes no model, spends no tokens, needs no API key. An observation is evidence for diagnosis, routing, or test selection — never permission, approval, acceptance, or certification. Validate the schema and your correlation before use.",
].join("\n");

export const inputShape = {
  sessionId: z.string().min(1).max(200).optional().describe("Only observations from this session."),
  candidate: z.string().min(1).max(200).optional().describe("Only observations carrying this candidate correlation."),
  operationId: z.string().min(1).max(200).optional().describe("Only observations for this graph run id (receipt turnId)."),
  event: z.string().min(1).max(100).optional().describe("Only observations for this event (e.g. PreToolUse, post-tool-batch)."),
  limit: z.number().int().min(1).max(200).default(50).describe("Maximum observations to return, newest first."),
  cursor: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe("Opaque page cursor from a previous truncated response; omit for the newest page."),
} as const;

export const inputSchema = z.object(inputShape);
export type ObservationsToolInput = z.infer<typeof inputSchema>;

/**
 * JSON-Schema-representable form of the observation contract (the MCP SDK
 * cannot publish `z.custom`). The runtime validator `isJeverbObservation`
 * remains authoritative; this shape mirrors it field for field.
 */
export const observationShape = {
  schema: z.literal(1),
  host: z.enum(["muse", "claude", "ci", "mcp", "unknown"]),
  sessionId: z.string(),
  event: z.string(),
  toolUseId: z.string().optional(),
  decisionId: z.string().optional(),
  correlationId: z.string().optional(),
  operationId: z.string().optional(),
  outputDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  executionStatus: z.enum(["succeeded", "failed", "skipped", "blocked", "cancelled", "outcome_unknown"]).optional(),
  hostUsage: z.object({
    inputTokens: z.number().int().min(0).max(1_000_000_000).optional(),
    outputTokens: z.number().int().min(0).max(1_000_000_000).optional(),
  }).refine((value) => value.inputTokens !== undefined || value.outputTokens !== undefined).optional(),
  hostTurnCorrelationId: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  parentExecutionCorrelationId: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  candidate: z.string().optional(),
  operation: z.string().optional(),
  deterministicFindings: z.array(z.string()),
  advice: z.array(z.string()),
  model: z.string().optional(),
  policyVersion: z.string(),
  calibrated: z.boolean().optional(),
  uncertainty: z.object({
    confidence: z.number().min(0).max(1).optional(),
    band: z.enum(["strong", "marginal", "unknown"]),
  }),
  disposition: z.enum(["completed", "unavailable", "error"]),
  error: z.string().optional(),
  evidence: z.object({ receiptDigest: z.string(), subjectHash: z.string() }),
  observedAt: z.string(),
} as const;

export const outputShape = {
  observations: z.array(z.object(observationShape)).describe("Newest first, already filtered. Empty when nothing matches."),
  truncated: z.boolean().describe("True when more receipts matched than `limit` allows."),
  status: z
    .enum(["ok", "empty", "unavailable", "corrupt", "truncated"])
    .describe(
      "Result state: ok (page complete), empty (ledger holds no receipts), unavailable (no ledger, unreadable, or unscoped request), corrupt (some lines failed validation — see detail), truncated (more matches remain; follow nextCursor).",
    ),
  detail: z.string().optional().describe("Machine-readable note for non-ok statuses."),
  nextCursor: z.string().optional().describe("Opaque cursor for the next older page; present when truncated is true."),
} as const;

export const outputSchema = z.object(outputShape);
export type ObservationsToolOutput = z.infer<typeof outputSchema>;

function ledgerPathFor(config: ToolConfig): string | undefined {
  const dir = config.dataDir;
  if (typeof dir !== "string" || dir === "") return undefined;
  return join(dir, "evidence.log");
}

interface ScanFilter {
  sessionId?: string;
  candidate?: string;
  operationId?: string;
  event?: string;
}

/** Field-level match on the raw receipt, before projection. */
function receiptMatches(parsed: unknown, filter: ScanFilter): boolean {
  if (!isRecord(parsed)) return false;
  if (filter.sessionId !== undefined && parsed.sessionId !== filter.sessionId) return false;
  if (filter.candidate !== undefined && parsed.candidate !== filter.candidate) return false;
  if (filter.operationId !== undefined && parsed.turnId !== filter.operationId) return false;
  if (filter.event !== undefined && parsed.event !== filter.event) return false;
  return isValidReceipt(parsed);
}

/**
 * Stream one pass over the ledger. Counts every match and records the
 * first corrupt line; collects nothing, so memory stays flat no matter
 * how large the ledger grows.
 */
async function scanLedger(
  path: string,
  filter: ScanFilter,
): Promise<{ matches: number; lines: number; nonBlank: number; firstBadLine?: number; badLines: number }> {
  let matches = 0;
  let lines = 0;
  let nonBlank = 0;
  let firstBadLine: number | undefined;
  let badLines = 0;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    lines += 1;
    const text = line.trim();
    if (text === "") continue;
    nonBlank += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      badLines += 1;
      if (firstBadLine === undefined) firstBadLine = lines;
      continue;
    }
    if (!receiptMatches(parsed, filter)) {
      // A line outside the field filter is not our corruption to report;
      // a non-object line, or an object in our result set that fails
      // receipt validation, is.
      if (!isRecord(parsed) || (filterMatchesFields(parsed, filter) && !isValidReceipt(parsed))) {
        badLines += 1;
        if (firstBadLine === undefined) firstBadLine = lines;
      }
      continue;
    }
    matches += 1;
  }
  return { matches, lines, nonBlank, ...(firstBadLine === undefined ? {} : { firstBadLine }), badLines };
}

/** Field filter without receipt validation (for corruption attribution). */
function filterMatchesFields(parsed: Record<string, unknown>, filter: ScanFilter): boolean {
  if (filter.sessionId !== undefined && parsed.sessionId !== filter.sessionId) return false;
  if (filter.candidate !== undefined && parsed.candidate !== filter.candidate) return false;
  if (filter.operationId !== undefined && parsed.turnId !== filter.operationId) return false;
  if (filter.event !== undefined && parsed.event !== filter.event) return false;
  return true;
}

/**
 * Collect one newest-first page. Pass 1 counts matches; pass 2 keeps
 * only the window — memory stays bounded by `limit` however large the
 * ledger is. Concurrent appends between passes may shift which receipts
 * are newest; cursors stay stable for already-returned prefixes because
 * the ledger is append-only.
 */
async function collectPage(
  path: string,
  filter: ScanFilter,
  skip: number,
  end: number,
  limit: number,
  retrievalHost: ObservationHost,
): Promise<JeverbObservation[]> {
  const kept: JeverbObservation[] = [];
  let seen = 0;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim();
    if (text === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!receiptMatches(parsed, filter)) continue;
    // Oldest-first window [skip, min(skip + limit, end)): the caller
    // passes skip = total - start - limit and end = total - start, so
    // this is exactly the newest page ending `start` from the tail.
    if (seen >= skip && seen < end && kept.length < limit) {
      const obs = observationFromReceipt(parsed, retrievalHost);
      if (obs !== undefined) kept.push(obs);
    }
    seen += 1;
  }
  return kept.reverse();
}

export async function run(
  _model: unknown,
  input: ObservationsToolInput,
  config: ToolConfig,
): Promise<ObservationsToolOutput> {
  // Scope first: this read-only tool re-presents recorded evidence, and
  // an unscoped read would expose other sessions' material to any caller.
  if (input.sessionId === undefined && input.candidate === undefined && input.operationId === undefined) {
    return {
      observations: [],
      truncated: false,
      status: "unavailable",
      detail: "scope-required: pass sessionId or candidate",
    };
  }
  const path = ledgerPathFor(config);
  if (path === undefined) {
    return { observations: [], truncated: false, status: "unavailable", detail: "no-data-dir" };
  }
  try {
    await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      observations: [],
      truncated: false,
      status: "unavailable",
      detail: code === "ENOENT" ? "ledger-not-found" : `ledger-unreadable:${code ?? "io"}`,
    };
  }
  const filter: ScanFilter = {
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.event === undefined ? {} : { event: input.event }),
  };
  const cursor = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
  const skip = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  const scan = await scanLedger(path, filter);
  // `empty` describes the ledger (no receipts recorded at all), not the
  // query: a filter that matches nothing on a non-empty ledger is a
  // successful query with zero results (`ok`).
  if (scan.nonBlank === 0) {
    return { observations: [], truncated: false, status: "empty" };
  }
  const total = scan.matches;
  const start = Math.min(skip, total);
  const page = await collectPage(
    path,
    filter,
    Math.max(total - start - input.limit, 0),
    total - start,
    input.limit,
    "mcp",
  );
  const truncated = total > start + page.length;
  const base = {
    observations: page,
    truncated,
  };
  if (scan.badLines > 0) {
    return {
      ...base,
      status: "corrupt",
      detail: `corrupt-lines:${scan.badLines}:first-line:${scan.firstBadLine ?? 0}`,
    };
  }
  if (truncated) {
    return {
      ...base,
      status: "truncated",
      nextCursor: String(start + page.length),
    };
  }
  return { ...base, status: "ok" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
