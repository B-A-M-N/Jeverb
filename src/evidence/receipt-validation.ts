/**
 * Receipt vocabulary and structural validation for the evidence ledger.
 * Mission-closure terminal receipts accept only providers with a separately
 * qualified runtime identity; the provider request id is mandatory for the
 * gateway and OpenRouter adapters.
 *
 * Leaf module: only a type reference to `ledger.ts` (erased at runtime),
 * so the runtime direction stays one-way. `ledger.ts` re-exports these so
 * existing `evidence/ledger.js` importers keep working.
 */

import { createHash } from "node:crypto";
import type { EvidenceRecord } from "./ledger.js";

export type ReceiptOutcome =
  | "decision-requested"
  | "hook-output-emitted"
  | "host-action-enforced"
  | "execution-observed";

export const RECEIPT_OUTCOMES: readonly ReceiptOutcome[] = [
  "decision-requested",
  "hook-output-emitted",
  "host-action-enforced",
  "execution-observed",
];
/**
 * Integrity fingerprint of a subject (truncated sha256 hex).
 * Tamper-evidence only — explicitly NOT authentication: no key, no
 * signature, no authority is involved, and the output must never be treated
 * as permission or certification.
 */
export function hashSubject(subject: string): string {
  return createHash("sha256").update(subject, "utf8").digest("hex").slice(0, 32);
}

/**
 * Resolve the host to present at retrieval: the receipt's recorded
 * `eventHost` always wins and is never overwritten by the retrieving host.
 * `fallback` applies only when the receipt predates `eventHost`.
 */
export function resolveEventHost(receipt: EvidenceRecord, fallback: string): string {
  return receipt.eventHost ?? fallback;
}
const MISSION_CLOSURE_CHOICES = ["COMPLETE", "INCOMPLETE", "BLOCKED", "INSUFFICIENT_EVIDENCE"] as const;
const REQUIRED_MISSION_CHECKS = [
  "objectivePresent", "objectiveCoverageEstablished", "revisionsMatch", "criteriaPresent", "allCriteriaVerified", "testsPassed",
  "independentVerificationPassed", "noPendingOperations", "noUncertainOperations", "noUnresolvedBlockers", "calibrationBound",
] as const;
export function isValidReceipt(value: unknown): value is EvidenceRecord {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (
    r["schema"] !== 1 ||
    typeof r["id"] !== "string" ||
    typeof r["ts"] !== "string" ||
    typeof r["sessionId"] !== "string" ||
    typeof r["event"] !== "string" ||
    typeof r["subjectHash"] !== "string" ||
    typeof r["policyVersion"] !== "string" ||
    !Array.isArray(r["deterministicFindings"]) ||
    typeof r["enforcement"] !== "string" ||
    !Array.isArray(r["reasons"]) ||
    typeof r["latencyMs"] !== "number"
  ) {
    return false;
  }
  // Additive optional provenance fields: accepted, never required.
  if (r["judgment"] !== undefined && typeof r["judgment"] !== "string") return false;
  if (r["turnId"] !== undefined && typeof r["turnId"] !== "string") return false;
  if (r["eventHost"] !== undefined && typeof r["eventHost"] !== "string") return false;
  if (r["correlationId"] !== undefined && typeof r["correlationId"] !== "string") return false;
  for (const key of ["hostTurnCorrelationId", "parentExecutionCorrelationId"] as const) {
    if (r[key] !== undefined && (typeof r[key] !== "string" || !/^[0-9a-f]{64}$/.test(r[key] as string))) return false;
  }
  if (r["hostUsage"] !== undefined) {
    const usage = r["hostUsage"];
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return false;
    const counters = usage as Record<string, unknown>;
    if (Object.keys(counters).some((key) => key !== "inputTokens" && key !== "outputTokens")) return false;
    if (Object.keys(counters).length === 0) return false;
    if (Object.values(counters).some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 1_000_000_000)) return false;
  }
  if (r["outputDigest"] !== undefined && (typeof r["outputDigest"] !== "string" || !/^[0-9a-f]{64}$/.test(r["outputDigest"]))) return false;
  if (r["executionStatus"] !== undefined && !["succeeded", "failed", "skipped", "blocked", "cancelled", "outcome_unknown"].includes(r["executionStatus"] as string)) return false;
  if (r["missionClosure"] !== undefined) {
    if (r["event"] !== "MissionClosure" || typeof r["correlationId"] !== "string" || !/^[0-9a-f]{64}$/.test(r["correlationId"])) return false;
    const closure = r["missionClosure"];
    if (typeof closure !== "object" || closure === null || Array.isArray(closure)) return false;
    const value = closure as Record<string, unknown>;
    const validStatuses = ["COMPLETE", "INCOMPLETE", "BLOCKED", "INSUFFICIENT_EVIDENCE"];
    if (
      typeof value["missionId"] !== "string" ||
      typeof value["missionRevision"] !== "string" ||
      typeof value["evidenceRevision"] !== "string" ||
      typeof value["complete"] !== "boolean" ||
      typeof value["status"] !== "string" ||
      !validStatuses.includes(value["status"]) ||
      value["confidenceIsProof"] !== false ||
      typeof value["checks"] !== "object" || value["checks"] === null || Array.isArray(value["checks"]) ||
      !Object.values(value["checks"] as Record<string, unknown>).every((check) => typeof check === "boolean") ||
      (value["candidateDigest"] !== undefined && typeof value["candidateDigest"] !== "string") ||
      (value["model"] !== undefined && typeof value["model"] !== "string") ||
      (value["modelVersion"] !== undefined && typeof value["modelVersion"] !== "string") ||
      (value["provider"] !== undefined && typeof value["provider"] !== "string") ||
      (value["providerRequestId"] !== undefined && typeof value["providerRequestId"] !== "string") ||
      (value["questionHash"] !== undefined && typeof value["questionHash"] !== "string") ||
      (value["calibrationVersion"] !== undefined && typeof value["calibrationVersion"] !== "string") ||
      (value["confidence"] !== undefined && (typeof value["confidence"] !== "number" || !Number.isFinite(value["confidence"]))) ||
      (value["probabilities"] !== undefined && (typeof value["probabilities"] !== "object" || value["probabilities"] === null || Array.isArray(value["probabilities"])))
    ) return false;
    if ((value["status"] === "COMPLETE") !== value["complete"]) return false;
    if (value["confidence"] !== undefined && ((value["confidence"] as number) < 0 || (value["confidence"] as number) > 1)) return false;
    if (value["questionHash"] !== undefined && !/^[0-9a-f]{64}$/.test(value["questionHash"] as string)) return false;
    if (value["probabilities"] !== undefined && !Object.values(value["probabilities"] as Record<string, unknown>).every(
      (probability) => typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1,
    )) return false;
    if (value["complete"] === true) {
      const checks = value["checks"] as Record<string, unknown>;
      const checkKeys = Object.keys(checks).sort();
      const expectedChecks = [...REQUIRED_MISSION_CHECKS].sort();
      if (checkKeys.length !== expectedChecks.length || checkKeys.some((key, index) => key !== expectedChecks[index])) return false;
      if (!REQUIRED_MISSION_CHECKS.every((key) => checks[key] === true)) return false;
      if (
        typeof value["model"] !== "string" || value["model"].trim() === "" ||
        value["modelVersion"] !== value["model"] ||
        (value["provider"] !== "typesafe" && value["provider"] !== "jev-gateway" && value["provider"] !== "openrouter") ||
        ((value["provider"] === "jev-gateway" || value["provider"] === "openrouter") &&
          (typeof value["providerRequestId"] !== "string" || value["providerRequestId"].trim() === "")) ||
        typeof value["questionHash"] !== "string" || !/^[0-9a-f]{64}$/.test(value["questionHash"]) ||
        typeof value["calibrationVersion"] !== "string" || value["calibrationVersion"].trim() === "" ||
        typeof value["confidence"] !== "number" || !Number.isFinite(value["confidence"]) ||
        value["confidence"] < 0 || value["confidence"] > 1
      ) return false;
      const probabilities = value["probabilities"] as Record<string, number> | undefined;
      if (probabilities === undefined) return false;
      const probabilityKeys = Object.keys(probabilities).sort();
      const expectedChoices = [...MISSION_CLOSURE_CHOICES].sort();
      if (probabilityKeys.length !== expectedChoices.length || probabilityKeys.some((key, index) => key !== expectedChoices[index])) return false;
      const values = Object.values(probabilities);
      if (Math.abs(values.reduce((sum, probability) => sum + probability, 0) - 1) > 1e-6) return false;
      const completeProbability = probabilities["COMPLETE"];
      if (completeProbability === undefined || completeProbability + 1e-6 < Math.max(...values)) return false;
      if ((value["confidence"] as number) >= 1 - 1e-6 && completeProbability < 1 - 1e-6) return false;
    }
  }
  if (r["event"] === "MissionClosure" && r["missionClosure"] === undefined) return false;
  if (r["controlAction"] !== undefined) {
    if (r["event"] !== "ControlAction" || typeof r["correlationId"] !== "string" || !/^[0-9a-f]{64}$/.test(r["correlationId"])) return false;
    const action = r["controlAction"];
    if (typeof action !== "object" || action === null || Array.isArray(action)) return false;
    const value = action as Record<string, unknown>;
    if (
      typeof value["missionId"] !== "string" ||
      typeof value["missionRevision"] !== "string" ||
      typeof value["evidenceRevision"] !== "string" ||
      typeof value["action"] !== "string" ||
      (value["candidateDigest"] !== undefined && typeof value["candidateDigest"] !== "string") ||
      (value["criterionId"] !== undefined && typeof value["criterionId"] !== "string") ||
      (value["defectKind"] !== undefined && typeof value["defectKind"] !== "string") ||
      (value["requiredOutcome"] !== undefined && typeof value["requiredOutcome"] !== "string") ||
      (value["maxAttempts"] !== undefined && (typeof value["maxAttempts"] !== "number" || !Number.isFinite(value["maxAttempts"]))) ||
      (value["attempt"] !== undefined && (typeof value["attempt"] !== "number" || !Number.isFinite(value["attempt"]))) ||
      (value["terminalReceipt"] !== undefined && typeof value["terminalReceipt"] !== "string") ||
      (value["evidenceRefs"] !== undefined && (!Array.isArray(value["evidenceRefs"]) || value["evidenceRefs"].length > 16 ||
        value["evidenceRefs"].some((ref) => typeof ref !== "string" || ref.length === 0 || ref.length > 512))) ||
      (value["stalled"] !== undefined && typeof value["stalled"] !== "boolean")
    ) return false;
  }
  if (r["event"] === "ControlAction" && r["controlAction"] === undefined) return false;
  if (r["outcome"] !== undefined) {
    if (typeof r["outcome"] !== "string") return false;
    if (!(RECEIPT_OUTCOMES as readonly string[]).includes(r["outcome"])) return false;
  }
  return true;
}
