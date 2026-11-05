import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describeLedgerCorrupt, EvidenceLedger, hashSubject, type EvidenceRecord } from "../evidence/ledger.js";
import { withFileLock } from "../hooks/store-lock.js";
import type { MissionClosureDecision } from "./closure.js";

export type MissionClosureReceiptResult =
  | { status: "appended" | "duplicate"; correlationId: string }
  | { status: "conflict" | "unavailable"; correlationId: string; reason: string };

const REQUIRED_CHECKS = [
  "objectivePresent",
  "objectiveCoverageEstablished",
  "revisionsMatch",
  "criteriaPresent",
  "allCriteriaVerified",
  "testsPassed",
  "independentVerificationPassed",
  "noPendingOperations",
  "noUncertainOperations",
  "noUnresolvedBlockers",
  "calibrationBound",
] as const;
const CHOICES = ["COMPLETE", "INCOMPLETE", "BLOCKED", "INSUFFICIENT_EVIDENCE"] as const;

function validAdversarialSummary(adversarial: NonNullable<MissionClosureDecision["adversarial"]>): boolean {
  if (
    !(["ACCEPT", "REPAIR", "GATHER_EVIDENCE", "BLOCKED"] as readonly string[]).includes(adversarial.state) ||
    !(["SUPPORTED_GAP", "NO_GAP_FOUND", "UNKNOWN"] as readonly string[]).includes(adversarial.gap) ||
    !Array.isArray(adversarial.targets) ||
    !adversarial.targets.every((target) => typeof target === "string" && target !== "") ||
    typeof adversarial.priorChallengeRepeated !== "boolean" ||
    (adversarial.repairCriterion !== undefined && (typeof adversarial.repairCriterion !== "string" || adversarial.repairCriterion === ""))
  ) return false;
  return true;
}

function decisionIsStructurallyValid(decision: MissionClosureDecision): boolean {
  if (
    decision.missionId.trim() === "" ||
    decision.missionRevision.trim() === "" ||
    decision.evidenceRevision.trim() === "" ||
    decision.confidenceIsProof !== false ||
    (decision.status === "COMPLETE") !== decision.complete ||
    (decision.adversarial !== undefined && !validAdversarialSummary(decision.adversarial))
  ) return false;
  // Unanimous approval is necessary for completion: a COMPLETE verdict with
  // a recorded pair outcome must carry adversarial ACCEPT with no gap found.
  if (
    decision.complete && decision.adversarial !== undefined &&
    (decision.adversarial.state !== "ACCEPT" || decision.adversarial.gap !== "NO_GAP_FOUND")
  ) return false;
  if (decision.complete) {
    const checkKeys = Object.keys(decision.checks).sort();
    const expectedKeys = [...REQUIRED_CHECKS].sort();
    if (checkKeys.length !== expectedKeys.length || checkKeys.some((key, index) => key !== expectedKeys[index])) return false;
    if (!REQUIRED_CHECKS.every((key) => decision.checks[key] === true)) return false;
    if (
      typeof decision.model !== "string" || decision.model.trim() === "" ||
      decision.modelVersion !== decision.model ||
      (decision.provider !== "typesafe" && decision.provider !== "jev-gateway" && decision.provider !== "openrouter") ||
      ((decision.provider === "jev-gateway" || decision.provider === "openrouter") &&
        (typeof decision.providerRequestId !== "string" || decision.providerRequestId.trim() === "")) ||
      typeof decision.questionHash !== "string" || !/^[0-9a-f]{64}$/.test(decision.questionHash) ||
      typeof decision.calibrationVersion !== "string" || decision.calibrationVersion.trim() === "" ||
      typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1 ||
      decision.probabilities === undefined
    ) return false;
    const probabilityKeys = Object.keys(decision.probabilities).sort();
    const expectedChoices = [...CHOICES].sort();
    if (probabilityKeys.length !== expectedChoices.length || probabilityKeys.some((key, index) => key !== expectedChoices[index])) return false;
    const probabilities = Object.values(decision.probabilities);
    if (!probabilities.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return false;
    if (Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > 1e-6) return false;
    const completeProbability = decision.probabilities["COMPLETE"];
    if (
      completeProbability === undefined ||
      completeProbability + 1e-6 < Math.max(...probabilities) ||
      (decision.confidence >= 1 - 1e-6 && completeProbability < 1 - 1e-6)
    ) return false;
  }
  return true;
}

function closurePayload(decision: MissionClosureDecision): NonNullable<EvidenceRecord["missionClosure"]> {
  return {
    missionId: decision.missionId,
    status: decision.status,
    complete: decision.complete,
    missionRevision: decision.missionRevision,
    evidenceRevision: decision.evidenceRevision,
    ...(decision.candidateDigest === undefined ? {} : { candidateDigest: decision.candidateDigest }),
    checks: { ...decision.checks },
    ...(decision.model === undefined ? {} : { model: decision.model }),
    ...(decision.modelVersion === undefined ? {} : { modelVersion: decision.modelVersion }),
    ...(decision.provider === undefined ? {} : { provider: decision.provider }),
    ...(decision.providerRequestId === undefined ? {} : { providerRequestId: decision.providerRequestId }),
    ...(decision.questionHash === undefined ? {} : { questionHash: decision.questionHash }),
    ...(decision.calibrationVersion === undefined ? {} : { calibrationVersion: decision.calibrationVersion }),
    ...(decision.confidence === undefined ? {} : { confidence: decision.confidence }),
    ...(decision.probabilities === undefined ? {} : { probabilities: { ...decision.probabilities } }),
    confidenceIsProof: false,
    ...(decision.adversarial === undefined ? {} : {
      adversarial: {
        state: decision.adversarial.state,
        gap: decision.adversarial.gap,
        targets: [...decision.adversarial.targets],
        ...(decision.adversarial.repairCriterion === undefined ? {} : { repairCriterion: decision.adversarial.repairCriterion }),
        priorChallengeRepeated: decision.adversarial.priorChallengeRepeated,
      },
    }),
  };
}

/**
 * Append one durable, idempotent receipt for this mission/evidence revision.
 * This records a decision; it does not establish that the caller assembled
 * trustworthy evidence. Keep this helper internal to the gate/host integration;
 * never expose it as an agent-facing tool or public package API.
 */
export function persistMissionClosureReceipt(
  ledger: EvidenceLedger,
  sessionId: string,
  decision: MissionClosureDecision,
): MissionClosureReceiptResult {
  if (!decisionIsStructurallyValid(decision)) {
    return { status: "unavailable", correlationId: "", reason: "mission-closure decision failed structural validation" };
  }
  const payload = closurePayload(decision);
  // Correlation stays on mission/mission-revision/evidence-revision so
  // previously persisted receipts dedupe; a different candidate for the
  // same revisions surfaces as a payload conflict below, never a silent
  // overwrite.
  const correlationId = createHash("sha256")
    .update(`${decision.missionId}\0${decision.missionRevision}\0${decision.evidenceRevision}`)
    .digest("hex");
  const lockName = `mission-closure-${correlationId.slice(0, 32)}`;
  try {
    mkdirSync(dirname(ledger.path), { recursive: true, mode: 0o700 });
  } catch (error) {
    return { status: "unavailable", correlationId, reason: error instanceof Error ? error.message : String(error) };
  }
  const lock = withFileLock(dirname(ledger.path), lockName, () => {
    let existing;
    try {
      const read = ledger.read();
      if (read.corrupt !== undefined) return { status: "unavailable" as const, reason: describeLedgerCorrupt(read.corrupt) };
      existing = read.records.find((record) => record.event === "MissionClosure" && record.correlationId === correlationId);
    } catch (error) {
      return { status: "unavailable" as const, reason: error instanceof Error ? error.message : String(error) };
    }
    if (existing !== undefined) {
      const { providerRequestId: _existingRequestId, ...existingDecision } = existing.missionClosure!;
      const { providerRequestId: _currentRequestId, ...currentDecision } = payload;
      const same = JSON.stringify(existingDecision) === JSON.stringify(currentDecision);
      return same
        ? { status: "duplicate" as const }
        : { status: "conflict" as const, reason: "a different verdict is already recorded for this mission/evidence revision" };
    }
    const record: EvidenceRecord = {
      schema: 1,
      id: "",
      ts: new Date().toISOString(),
      sessionId,
      decisionId: correlationId.slice(0, 32),
      correlationId,
      event: "MissionClosure",
      subjectHash: hashSubject(`${decision.missionId}\n${decision.missionRevision}\n${decision.evidenceRevision}`),
      policyVersion: decision.policyVersion,
      deterministicFindings: [],
      enforcement: decision.complete ? "mission_complete" : "mission_not_complete",
      reasons: decision.reasons,
      latencyMs: 0,
      missionClosure: payload,
    };
    const appended = ledger.appendDetailed(record, { durable: true });
    return appended.ok
      ? { status: "appended" as const }
      : { status: "unavailable" as const, reason: appended.error.message };
  });
  if (!lock.locked || lock.value === undefined) {
    return { status: "unavailable", correlationId, reason: "could not acquire the mission-closure receipt lock" };
  }
  return { ...lock.value, correlationId };
}
