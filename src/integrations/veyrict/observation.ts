/**
 * `JeverbObservation` — the read-only, machine-readable surface for external
 * consumers such as Veyrict.
 *
 * A hook's `hookSpecificOutput.permissionDecision` is a host-control
 * envelope, not a stable API: its shape belongs to the host, and parsing it
 * as data couples the consumer to host internals. Observations are the
 * opposite — a versioned contract Jeverb owns, with exactly the fields an
 * external diagnoser needs and nothing it must not have.
 *
 * Deliberately absent: any permission, authorization, approval, acceptance,
 * or promotion field. An observation describes what Jeverb saw and judged;
 * it never grants, certifies, or signs off. The Veyrict adapter MUST
 * validate the schema and the caller-supplied correlation before use, and
 * MUST NOT treat an observation as an authority-signed acceptance verdict —
 * Jeverb is evidence, never acceptance authority.
 */

import { createHash } from "node:crypto";
import { redact } from "../../hooks/redact.js";
import { isValidReceipt, type EvidenceRecord } from "../../evidence/ledger.js";

export const JEVERB_OBSERVATION_VERSION = 1;

/**
 * Where the observed event originated. `"mcp"` names the retrieval
 * transport and is accepted as a retrieval hint, but it is never an
 * originating host: a receipt with no recorded host projects as
 * `"unknown"`, never as the transport that happened to read it.
 */
export type ObservationHost = "muse" | "claude" | "ci" | "mcp" | "unknown";
export type ObservationDisposition = "completed" | "unavailable" | "error";
export type ConfidenceBand = "strong" | "marginal" | "unknown";

/** Originating hosts: valid values for a receipt's recorded event host. */
const ORIGIN_HOSTS: readonly string[] = ["muse", "claude", "ci"];

/**
 * Resolve the host an observation carries. The receipt's recorded
 * `eventHost` always wins; the retrieval hint only stands in for legacy
 * receipts that predate host recording, and only when it names a real
 * originating host. Anything else — including the `"mcp"` retrieval
 * transport — resolves to `"unknown"`.
 */
export function resolveObservationHost(receipt: EvidenceRecord, retrievalHost: ObservationHost): ObservationHost {
  const recorded = (receipt as { eventHost?: unknown }).eventHost;
  if (typeof recorded === "string" && (ORIGIN_HOSTS as readonly string[]).includes(recorded)) {
    return recorded as ObservationHost;
  }
  if ((ORIGIN_HOSTS as readonly string[]).includes(retrievalHost)) return retrievalHost;
  return "unknown";
}

export interface JeverbObservation {
  /** Contract version. Consumers reject anything else. */
  schema: 1;
  host: ObservationHost;
  sessionId: string;
  event: string;
  /** The host's tool-use identifier, when the event belongs to one call. */
  toolUseId?: string;
  /** Ledger correlation: receipts from the same decision share it. */
  decisionId?: string;
  /** Full, opaque ledger correlation id; integrity/correlation only, not authentication. */
  correlationId?: string;
  /** Graph run id from the receipt's turnId, when this observation came from graph execution. */
  operationId?: string;
  /** Complete graph-node output digest, when present; hash only, never artifact content. */
  outputDigest?: string;
  /** Structured terminal graph-node status, when present. */
  executionStatus?: "succeeded" | "failed" | "skipped" | "blocked" | "cancelled" | "outcome_unknown";
  /** Host-reported token counts; diagnostic only, not provider-verified billing. */
  hostUsage?: { inputTokens?: number; outputTokens?: number };
  /** Opaque host-supplied turn / parent-execution hashes, never raw identifiers. */
  hostTurnCorrelationId?: string;
  parentExecutionCorrelationId?: string;
  /** Caller-supplied correlation (candidate SHA, operation id). Opaque to Jeverb. */
  candidate?: string;
  operation?: string;
  /** Deterministic findings: pattern hits, policy outcomes, structural facts. */
  deterministicFindings: string[];
  /**
   * Model-derived advice: prioritization hints, suspect-area pointers.
   * Advisory only — never permission, never certification.
   */
  advice: string[];
  model?: string;
  policyVersion: string;
  calibrated?: boolean;
  uncertainty: { confidence?: number; band: ConfidenceBand };
  disposition: ObservationDisposition;
  error?: string;
  evidence: {
    /** sha256 of the canonical backing receipt: proves what was observed. */
    receiptDigest: string;
    /** Hash of the judged subject; the subject itself is never included. */
    subjectHash: string;
  };
  observedAt: string;
}

/**
 * sha256 of the canonical JSON form — an integrity fingerprint, not
 * authenticity proof. Anyone holding the receipt recomputes the same digest,
 * so it proves what backs the observation, never who signed it.
 */
export function digestReceipt(receipt: EvidenceRecord): string {
  return createHash("sha256").update(JSON.stringify(receipt), "utf8").digest("hex");
}

function bandFor(confidence: number | undefined): ConfidenceBand {
  if (confidence === undefined) return "unknown";
  return confidence >= 0.7 ? "strong" : "marginal";
}

/**
 * Project a ledger receipt into an observation. Returns undefined for
 * anything that is not a valid receipt — callers must not fabricate
 * observations from unvalidated input.
 */
export function observationFromReceipt(
  receipt: unknown,
  retrievalHost: ObservationHost,
  opts: { candidate?: string; operation?: string; calibrated?: boolean } = {},
): JeverbObservation | undefined {
  if (!isValidReceipt(receipt)) return undefined;
  const advice = receipt.reasons.map((r) => redact(r)).filter((r) => r.length > 0);
  // Confidence needs a single, unambiguous probability. The maximum over
  // several questions is not a confidence in anything: without knowing
  // which question each probability answered, and in which direction,
  // combining them fabricates certainty. Multiple probabilities project
  // to an unknown band with no numeric confidence.
  const values = receipt.probabilities === undefined ? [] : Object.values(receipt.probabilities);
  // A confidence must be a real probability: finite and inside [0,1].
  // Out-of-range or non-numeric values project to the unknown band rather
  // than flowing onto the wire, where the validator would reject them.
  const raw = values.length === 1 ? values[0] : undefined;
  const confidence =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : undefined;
  const candidate = opts.candidate ?? receipt.candidate;
  return {
    schema: 1,
    host: resolveObservationHost(receipt, retrievalHost),
    sessionId: receipt.sessionId,
    event: receipt.event,
    ...(receipt.toolUseId === undefined ? {} : { toolUseId: receipt.toolUseId }),
    ...(receipt.decisionId === undefined ? {} : { decisionId: receipt.decisionId }),
    ...(receipt.correlationId === undefined ? {} : { correlationId: receipt.correlationId }),
    ...(receipt.turnId === undefined ? {} : { operationId: receipt.turnId }),
    ...(receipt.outputDigest === undefined ? {} : { outputDigest: receipt.outputDigest }),
    ...(receipt.executionStatus === undefined ? {} : { executionStatus: receipt.executionStatus }),
    ...(receipt.hostUsage === undefined ? {} : { hostUsage: receipt.hostUsage }),
    ...(receipt.hostTurnCorrelationId === undefined ? {} : { hostTurnCorrelationId: receipt.hostTurnCorrelationId }),
    ...(receipt.parentExecutionCorrelationId === undefined ? {} : { parentExecutionCorrelationId: receipt.parentExecutionCorrelationId }),
    ...(candidate === undefined ? {} : { candidate }),
    ...(opts.operation === undefined ? {} : { operation: opts.operation }),
    deterministicFindings: receipt.deterministicFindings.map((f) => redact(f)),
    advice,
    ...(receipt.model === undefined ? {} : { model: receipt.model }),
    policyVersion: receipt.policyVersion,
    ...(opts.calibrated === undefined ? {} : { calibrated: opts.calibrated }),
    uncertainty: { ...(confidence === undefined ? {} : { confidence }), band: bandFor(confidence) },
    disposition: receipt.error !== undefined ? "error" : receipt.enforcement === "unavailable" ? "unavailable" : "completed",
    ...(receipt.error === undefined ? {} : { error: redact(receipt.error) }),
    evidence: { receiptDigest: digestReceipt(receipt), subjectHash: receipt.subjectHash },
    observedAt: new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict validator for inbound observations. The Veyrict adapter runs this
 * before trusting any field — including correlation: a schema-valid
 * observation for the wrong candidate is still unusable.
 */
export function isJeverbObservation(value: unknown): value is JeverbObservation {
  if (!isRecord(value)) return false;
  if (value.schema !== 1) return false;
  if (!["muse", "claude", "ci", "mcp", "unknown"].includes(value.host as string)) return false;
  if (typeof value.sessionId !== "string" || typeof value.event !== "string") return false;
  for (const field of ["toolUseId", "decisionId", "correlationId", "operationId", "outputDigest", "candidate", "operation", "model", "error"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  if (value.correlationId !== undefined && !/^[0-9a-f]{64}$/.test(value.correlationId as string)) return false;
  for (const field of ["hostTurnCorrelationId", "parentExecutionCorrelationId"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "string" || !/^[0-9a-f]{64}$/.test(value[field] as string))) return false;
  }
  if (value.outputDigest !== undefined && !/^[0-9a-f]{64}$/.test(value.outputDigest as string)) return false;
  if (value.executionStatus !== undefined && !["succeeded", "failed", "skipped", "blocked", "cancelled", "outcome_unknown"].includes(value.executionStatus as string)) return false;
  if (value.hostUsage !== undefined) {
    if (!isRecord(value.hostUsage)) return false;
    const counters = value.hostUsage;
    if (Object.keys(counters).some((key) => key !== "inputTokens" && key !== "outputTokens")) return false;
    if (Object.keys(counters).length === 0 || Object.values(counters).some(
      (count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000,
    )) return false;
  }
  if (!Array.isArray(value.deterministicFindings) || !value.deterministicFindings.every((f) => typeof f === "string")) {
    return false;
  }
  if (!Array.isArray(value.advice) || !value.advice.every((a) => typeof a === "string")) return false;
  if (typeof value.policyVersion !== "string") return false;
  if (value.calibrated !== undefined && typeof value.calibrated !== "boolean") return false;
  if (!isRecord(value.uncertainty)) return false;
  if (!["strong", "marginal", "unknown"].includes(value.uncertainty.band as string)) return false;
  const confidence = value.uncertainty.confidence;
  if (confidence !== undefined && (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1))) {
    return false;
  }
  if (!["completed", "unavailable", "error"].includes(value.disposition as string)) return false;
  if (!isRecord(value.evidence)) return false;
  if (typeof value.evidence.receiptDigest !== "string" || typeof value.evidence.subjectHash !== "string") {
    return false;
  }
  if (typeof value.observedAt !== "string" || Number.isNaN(Date.parse(value.observedAt))) return false;
  // No authorization surface, ever: reject anything smuggling one in.
  for (const forbidden of ["permission", "allow", "approved", "accepted", "verdict", "authorized"]) {
    if (forbidden in value) return false;
  }
  return true;
}

/**
 * Validate an observation before consuming it. Checks the schema, then
 * the caller-supplied correlation: a schema-valid observation for the
 * wrong candidate or session is unusable, and a receipt-digest mismatch
 * proves the backing evidence is not what the observation claims.
 * Never certifies completion, permission, or acceptance — diagnosis only.
 */
export function validateObservationForUse(
  observation: unknown,
  expected: { candidate?: string; sessionId?: string; operationId?: string; correlationId?: string; receiptDigest?: string } = {},
): { ok: true; observation: JeverbObservation } | { ok: false; reason: string } {
  if (!isJeverbObservation(observation)) return { ok: false, reason: "invalid-observation" };
  if (expected.candidate !== undefined && observation.candidate !== expected.candidate) {
    return { ok: false, reason: "candidate-mismatch" };
  }
  if (expected.sessionId !== undefined && observation.sessionId !== expected.sessionId) {
    return { ok: false, reason: "session-mismatch" };
  }
  if (expected.operationId !== undefined && observation.operationId !== expected.operationId) {
    return { ok: false, reason: "operation-mismatch" };
  }
  if (expected.correlationId !== undefined && observation.correlationId !== expected.correlationId) {
    return { ok: false, reason: "correlation-mismatch" };
  }
  if (expected.receiptDigest !== undefined && observation.evidence.receiptDigest !== expected.receiptDigest) {
    return { ok: false, reason: "receipt-digest-mismatch" };
  }
  return { ok: true, observation };
}
