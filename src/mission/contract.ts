import { createHash } from "node:crypto";
import { redactAndClamp } from "../hooks/redact.js";

export const MAX_MISSION_CONTRACT_PROMPT_CHARS = 8_000;
export const MAX_MISSION_CRITERIA = 32;

export interface MissionCriterionAttestation {
  criterionId: string;
  missionRevision: string;
  promptHash: string;
  /** User-provided outcome summary; a bare checkmark is not closure evidence. */
  outcome?: string;
  attestedAt: number;
  source: "user-prompt-verification";
}

export interface IndependentVerificationAttestation {
  verifierId: string;
  missionRevision: string;
  evidenceRevision: string;
  candidate: string;
  verificationResult: "pass" | "fail" | "unknown";
  receiptCorrelationId: string;
  verifiedAt: number;
}

/** Explicit user attestation that the listed acceptance criteria cover the full objective. */
export interface MissionObjectiveCoverageAttestation {
  missionRevision: string;
  promptHash: string;
  source: "user-prompt-objective-coverage";
}

export interface MissionContract {
  missionId: string;
  missionRevision: string;
  promptHash: string;
  objective: string;
  criteria: Array<{ id: string; statement: string }>;
  /** Missing on legacy contracts; those contracts cannot authorize completion. */
  objectiveCoverage?: MissionObjectiveCoverageAttestation;
  /** Direct user attestations captured only from Muse UserPromptSubmit input. */
  attestations?: MissionCriterionAttestation[];
  /** Trusted independent verifier attestations (e.g. Veyrict); self-reported test success never qualifies. */
  independentVerifications?: IndependentVerificationAttestation[];
  source: "user-prompt-acceptance-section";
  createdAt: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalRevision(objective: string, criteria: readonly { id: string; statement: string }[]): string {
  return sha256(JSON.stringify({ objective, criteria }));
}

function parseCriteria(lines: string[]): Array<{ id: string; statement: string }> | undefined {
  const criteria: Array<{ id: string; statement: string }> = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (criteria.length > 0) break;
      continue;
    }
    const match = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
    const statement = match?.[1]?.trim();
    if (statement === undefined || statement.length === 0) return undefined;
    const safeStatement = redactAndClamp(statement, 1000);
    if (safeStatement.trim() === "") return undefined;
    criteria.push({ id: `criterion-${String(criteria.length + 1).padStart(2, "0")}`, statement: safeStatement });
    if (criteria.length > MAX_MISSION_CRITERIA) return undefined;
  }
  if (criteria.length === 0) return undefined;
  const normalized = criteria.map((criterion) => criterion.statement.toLowerCase().replace(/\s+/g, " "));
  return new Set(normalized).size === normalized.length ? criteria : undefined;
}

/**
 * Capture only an explicit contract provided by the Muse user prompt. The
 * parser is intentionally strict: it does not invent criteria from prose or
 * accept criteria from agent-facing MCP arguments. Coverage is established
 * only by the literal user-authored `Objective coverage: exhaustive` line
 * before the acceptance list; legacy contracts still load but cannot close.
 */
export function parseMissionContract(sessionId: string, prompt: string, createdAt: number): MissionContract | undefined {
  if (sessionId.trim() === "" || sessionId === "unknown" || prompt.length > MAX_MISSION_CONTRACT_PROMPT_CHARS) return undefined;
  const lines = prompt.split(/\r?\n/);
  const headers = lines
    .map((line, index) => ({ index, match: /^\s*(?:#{1,6}\s*)?acceptance\s+criteria\s*:?\s*$/i.test(line) }))
    .filter((entry) => entry.match);
  if (headers.length !== 1) return undefined;
  const section = headers[0];
  if (section === undefined) return undefined;

  const coverageLines = lines
    .map((line, index) => ({ index, matches: /^\s*objective\s+coverage\s*:\s*exhaustive\s*$/i.test(line) }))
    .filter((entry) => entry.matches);
  if (coverageLines.length > 1 || (coverageLines.length === 1 && coverageLines[0]!.index >= section.index)) return undefined;

  const objectiveLines = lines.slice(0, section.index);
  const objectiveText = objectiveLines
    .filter((_line, index) => coverageLines.length === 0 || index !== coverageLines[0]!.index)
    .join("\n")
    .replace(/^\s*(?:#{1,6}\s*)?objective\s*:?\s*\n/i, "")
    .trim();
  const objective = redactAndClamp(objectiveText, 4000).trim();
  if (objective.length === 0) return undefined;

  const criteria = parseCriteria(lines.slice(section.index + 1));
  if (criteria === undefined) return undefined;
  const safePrompt = redactAndClamp(prompt, MAX_MISSION_CONTRACT_PROMPT_CHARS);
  const promptHash = sha256(safePrompt);
  const missionRevision = canonicalRevision(objective, criteria);
  const missionId = sha256(`jeverb-mission-v1\0${sessionId}\0${promptHash}`).slice(0, 32);
  return {
    missionId,
    missionRevision,
    promptHash,
    objective,
    criteria,
    ...(coverageLines.length === 1
      ? { objectiveCoverage: {
          missionRevision,
          promptHash,
          source: "user-prompt-objective-coverage" as const,
        } }
      : {}),
    source: "user-prompt-acceptance-section",
    createdAt: Number.isFinite(createdAt) ? Math.max(0, Math.floor(createdAt)) : 0,
  };
}

/**
 * Parse a direct, user-authored verification block for an existing mission.
 * The caller must supply the session contract loaded from the private Store;
 * no MCP/model argument can create these attestations.
 *
 * Format:
 * Acceptance verification:
 * mission_id: <32 hex>
 * mission_revision: <64 hex>
 * verified:
 * - criterion-01: the interrupted retry remains blocked until reconciliation
 */
export function parseMissionAttestation(
  sessionId: string,
  prompt: string,
  contract: MissionContract | undefined,
  attestedAt: number,
): MissionCriterionAttestation[] | undefined {
  if (
    sessionId.trim() === "" || sessionId === "unknown" || contract === undefined ||
    prompt.length > MAX_MISSION_CONTRACT_PROMPT_CHARS
  ) return undefined;
  const lines = prompt.split(/\r?\n/);
  const headers = lines
    .map((line, index) => ({ index, matches: /^\s*(?:#{1,6}\s*)?acceptance\s+verification\s*:?\s*$/i.test(line) }))
    .filter((entry) => entry.matches);
  if (headers.length !== 1) return undefined;
  const header = headers[0];
  if (header === undefined) return undefined;

  const body = lines.slice(header.index + 1).filter((line) => line.trim() !== "");
  if (body.length < 4) return undefined;
  const missionId = /^\s*mission_id:\s*([0-9a-f]{32})\s*$/i.exec(body[0] ?? "")?.[1]?.toLowerCase();
  const missionRevision = /^\s*mission_revision:\s*([0-9a-f]{64})\s*$/i.exec(body[1] ?? "")?.[1]?.toLowerCase();
  if (missionId !== contract.missionId || missionRevision !== contract.missionRevision || body[2]?.trim().toLowerCase() !== "verified:") {
    return undefined;
  }

  const allowed = new Set(contract.criteria.map(({ id }) => id));
  const ids: string[] = [];
  const outcomes = new Map<string, string>();
  for (const line of body.slice(3)) {
    const match = /^\s*[-*+]\s+(criterion-[0-9]{2})(?:\s*:\s*(.+?))?\s*$/.exec(line);
    const id = match?.[1];
    if (id === undefined || !allowed.has(id) || ids.includes(id)) return undefined;
    ids.push(id);
    const rawOutcome = match?.[2]?.trim();
    if (rawOutcome !== undefined) {
      const outcome = redactAndClamp(rawOutcome, 1000).trim();
      if (outcome === "") return undefined;
      outcomes.set(id, outcome);
    }
  }
  if (ids.length === 0) return undefined;

  const promptHash = sha256(redactAndClamp(prompt, MAX_MISSION_CONTRACT_PROMPT_CHARS));
  const timestamp = Number.isFinite(attestedAt) ? Math.max(0, Math.floor(attestedAt)) : 0;
  return ids.map((criterionId) => {
    const outcome = outcomes.get(criterionId);
    return {
      criterionId,
      missionRevision: contract.missionRevision,
      promptHash,
      ...(outcome === undefined ? {} : { outcome }),
      attestedAt: timestamp,
      source: "user-prompt-verification" as const,
    };
  });
}

export function addMissionAttestations(
  contract: MissionContract,
  incoming: readonly MissionCriterionAttestation[],
): MissionContract {
  const validIds = new Set(contract.criteria.map(({ id }) => id));
  const byId = new Map((contract.attestations ?? []).map((attestation) => [attestation.criterionId, attestation]));
  for (const attestation of incoming) {
    if (attestation.missionRevision === contract.missionRevision && validIds.has(attestation.criterionId)) {
      byId.set(attestation.criterionId, attestation);
    }
  }
  return { ...contract, attestations: [...byId.values()].sort((a, b) => a.criterionId.localeCompare(b.criterionId)) };
}

/** Validate persisted contract structure and its session/prompt/revision bindings. */
export function readMissionContract(value: unknown, sessionId: string): MissionContract | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record["missionId"] !== "string" || !/^[0-9a-f]{32}$/.test(record["missionId"]) ||
    typeof record["missionRevision"] !== "string" || !/^[0-9a-f]{64}$/.test(record["missionRevision"]) ||
    typeof record["promptHash"] !== "string" || !/^[0-9a-f]{64}$/.test(record["promptHash"]) ||
    typeof record["objective"] !== "string" || record["objective"].trim() === "" ||
    record["source"] !== "user-prompt-acceptance-section" ||
    typeof record["createdAt"] !== "number" || !Number.isSafeInteger(record["createdAt"]) ||
    !Array.isArray(record["criteria"]) || record["criteria"].length === 0 || record["criteria"].length > MAX_MISSION_CRITERIA
  ) return undefined;
  const criteria: Array<{ id: string; statement: string }> = [];
  for (const raw of record["criteria"]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const criterion = raw as Record<string, unknown>;
    if (typeof criterion["id"] !== "string" || typeof criterion["statement"] !== "string" || criterion["statement"].trim() === "") {
      return undefined;
    }
    criteria.push({ id: criterion["id"], statement: criterion["statement"] });
  }
  let attestations: MissionCriterionAttestation[] | undefined;
  if (record["attestations"] !== undefined) {
    if (!Array.isArray(record["attestations"]) || record["attestations"].length > MAX_MISSION_CRITERIA) return undefined;
    attestations = [];
    const criterionIds = new Set(criteria.map(({ id }) => id));
    for (const raw of record["attestations"]) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
      const attestation = raw as Record<string, unknown>;
      if (
        typeof attestation["criterionId"] !== "string" || !criterionIds.has(attestation["criterionId"]) ||
        typeof attestation["missionRevision"] !== "string" || attestation["missionRevision"] !== record["missionRevision"] ||
        typeof attestation["promptHash"] !== "string" || !/^[0-9a-f]{64}$/.test(attestation["promptHash"]) ||
        (attestation["outcome"] !== undefined && (typeof attestation["outcome"] !== "string" || attestation["outcome"].trim() === "" || attestation["outcome"].length > 1000)) ||
        typeof attestation["attestedAt"] !== "number" || !Number.isSafeInteger(attestation["attestedAt"]) ||
        attestation["source"] !== "user-prompt-verification"
      ) return undefined;
      attestations.push({
        criterionId: attestation["criterionId"],
        missionRevision: attestation["missionRevision"],
        promptHash: attestation["promptHash"],
        ...(typeof attestation["outcome"] === "string" ? { outcome: attestation["outcome"] } : {}),
        attestedAt: attestation["attestedAt"],
        source: "user-prompt-verification",
      });
    }
    if (new Set(attestations.map(({ criterionId }) => criterionId)).size !== attestations.length) return undefined;
  }
  let objectiveCoverage: MissionObjectiveCoverageAttestation | undefined;
  if (record["objectiveCoverage"] !== undefined) {
    if (typeof record["objectiveCoverage"] !== "object" || record["objectiveCoverage"] === null || Array.isArray(record["objectiveCoverage"])) return undefined;
    const coverage = record["objectiveCoverage"] as Record<string, unknown>;
    if (
      coverage["missionRevision"] !== record["missionRevision"] ||
      coverage["promptHash"] !== record["promptHash"] ||
      coverage["source"] !== "user-prompt-objective-coverage"
    ) return undefined;
    objectiveCoverage = {
      missionRevision: coverage["missionRevision"] as string,
      promptHash: coverage["promptHash"] as string,
      source: "user-prompt-objective-coverage",
    };
  }
  let independentVerifications: IndependentVerificationAttestation[] | undefined;
  if (record["independentVerifications"] !== undefined) {
    if (!Array.isArray(record["independentVerifications"]) || record["independentVerifications"].length > MAX_MISSION_CRITERIA) return undefined;
    independentVerifications = [];
    for (const raw of record["independentVerifications"]) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
      const verification = raw as Record<string, unknown>;
      if (
        typeof verification["verifierId"] !== "string" || verification["verifierId"].trim() === "" ||
        typeof verification["missionRevision"] !== "string" || verification["missionRevision"] !== record["missionRevision"] ||
        typeof verification["evidenceRevision"] !== "string" || verification["evidenceRevision"] === "" ||
        typeof verification["candidate"] !== "string" || verification["candidate"] === "" ||
        (verification["verificationResult"] !== "pass" && verification["verificationResult"] !== "fail" && verification["verificationResult"] !== "unknown") ||
        typeof verification["receiptCorrelationId"] !== "string" || verification["receiptCorrelationId"].trim() === "" ||
        typeof verification["verifiedAt"] !== "number" || !Number.isSafeInteger(verification["verifiedAt"])
      ) return undefined;
      independentVerifications.push({
        verifierId: verification["verifierId"],
        missionRevision: verification["missionRevision"],
        evidenceRevision: verification["evidenceRevision"],
        candidate: verification["candidate"],
        verificationResult: verification["verificationResult"],
        receiptCorrelationId: verification["receiptCorrelationId"],
        verifiedAt: verification["verifiedAt"],
      });
    }
  }
  if (
    new Set(criteria.map(({ id }) => id)).size !== criteria.length ||
    new Set(criteria.map(({ statement }) => statement.toLowerCase().replace(/\s+/g, " "))).size !== criteria.length ||
    record["missionId"] !== sha256(`jeverb-mission-v1\0${sessionId}\0${record["promptHash"]}`).slice(0, 32) ||
    record["missionRevision"] !== canonicalRevision(record["objective"], criteria)
  ) return undefined;
  return {
    missionId: record["missionId"],
    missionRevision: record["missionRevision"],
    promptHash: record["promptHash"],
    objective: record["objective"],
    criteria,
    ...(objectiveCoverage === undefined ? {} : { objectiveCoverage }),
    source: "user-prompt-acceptance-section",
    createdAt: record["createdAt"],
    ...(attestations === undefined ? {} : { attestations }),
    ...(independentVerifications === undefined ? {} : { independentVerifications }),
  };
}

// ---------------------------------------------------------------- routine provisional coverage

/** Output authority for lightweight routine guidance. Never a terminal receipt. */
export const ROUTINE_GUIDANCE_AUTHORITY = "routine-guidance/1";

/** Maximum checklist items derived from one prompt. */
export const MAX_ROUTINE_ITEMS = 8;

export interface ProvisionalChecklistItem {
  id: string;
  statement: string;
}

/**
 * A lightweight, automatically derived task checklist for ordinary work that
 * carries no explicit acceptance section. It is labeled provisional at every
 * layer and must never gain the authority of a user-approved contract:
 * its ids live outside the `criterion-NN` namespace, its source is never
 * `user-prompt-acceptance-section`, and no closure, receipt, or Stop
 * terminal-outcome path accepts it.
 */
export interface ProvisionalChecklist {
  checklistId: string;
  promptHash: string;
  objective: string;
  items: ProvisionalChecklistItem[];
  source: "provisional-derived";
  createdAt: number;
}

/**
 * Derive a bounded provisional checklist from the user's objective text.
 * Pure. Returns undefined for prompts too short to carry task content.
 * Never invents acceptance authority: items are capped, truncated, and
 * namespaced so they cannot be mistaken for user-approved criteria.
 */
export function deriveProvisionalChecklist(
  sessionId: string,
  prompt: string,
  createdAt: number,
): ProvisionalChecklist | undefined {
  if (sessionId.trim() === "" || sessionId === "unknown") return undefined;
  const objective = redactAndClamp(prompt.replace(/^\s*(?:#{1,6}\s*)?objective\s*:?\s*\n/i, "").trim(), 2000).trim();
  if (objective.length < 24) return undefined;
  const seen = new Set<string>();
  const items: ProvisionalChecklistItem[] = [];
  for (const raw of objective.split(/\r?\n|(?<=[.!?;])\s+(?=[A-Z0-9"'(])/)) {
    const statement = redactAndClamp(raw.replace(/^[\s>#"'\-*\d.)\]]+/, "").trim(), 200).trim();
    if (statement.length < 8) continue;
    const normalized = statement.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    items.push({ id: `routine-${String(items.length + 1).padStart(2, "0")}`, statement });
    if (items.length >= MAX_ROUTINE_ITEMS) break;
  }
  if (items.length === 0) return undefined;
  const promptHash = sha256(redactAndClamp(prompt, MAX_MISSION_CONTRACT_PROMPT_CHARS));
  return {
    checklistId: `routine-${sha256(`jeverb-routine-v1\0${sessionId}\0${promptHash}`).slice(0, 12)}`,
    promptHash,
    objective: redactAndClamp(objective, 2000),
    items,
    source: "provisional-derived",
    createdAt: Number.isSafeInteger(createdAt) ? Math.max(0, createdAt) : 0,
  };
}

/** Validate a persisted provisional checklist; anything unrecognized is dropped. */
export function readProvisionalChecklist(value: unknown): ProvisionalChecklist | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record["checklistId"] !== "string" || !/^routine-[0-9a-f]{12}$/.test(record["checklistId"]) ||
    typeof record["promptHash"] !== "string" || !/^[0-9a-f]{64}$/.test(record["promptHash"]) ||
    typeof record["objective"] !== "string" || record["objective"].trim() === "" ||
    record["source"] !== "provisional-derived" ||
    typeof record["createdAt"] !== "number" || !Number.isSafeInteger(record["createdAt"]) ||
    !Array.isArray(record["items"]) || record["items"].length === 0 || record["items"].length > MAX_ROUTINE_ITEMS
  ) return undefined;
  const items: ProvisionalChecklistItem[] = [];
  for (const raw of record["items"]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const item = raw as Record<string, unknown>;
    if (
      typeof item["id"] !== "string" || !/^routine-[0-9]{2}$/.test(item["id"]) ||
      typeof item["statement"] !== "string" || item["statement"].trim() === "" || item["statement"].length > 200
    ) return undefined;
    items.push({ id: item["id"], statement: item["statement"] });
  }
  if (new Set(items.map(({ id }) => id)).size !== items.length) return undefined;
  return {
    checklistId: record["checklistId"] as string,
    promptHash: record["promptHash"] as string,
    objective: record["objective"] as string,
    items,
    source: "provisional-derived",
    createdAt: record["createdAt"] as number,
  };
}

export interface RoutineCoverageItemStatus {
  id: string;
  statement: string;
  /** Provisional items are never verified; this names the evidence state. */
  coverage: "evidence-current" | "evidence-missing" | "evidence-stale";
}

export interface RoutineCoverageSummary {
  authority: typeof ROUTINE_GUIDANCE_AUTHORITY;
  checklistId: string;
  items: RoutineCoverageItemStatus[];
  /** Routine guidance is advisory only: it never authorises completion. */
  terminalReceipt: false;
}

/**
 * Summarise routine coverage against the verification ledger. Pure.
 * A provisional item is never reported verified — the summary only says
 * whether current execution evidence exists — so routine guidance cannot
 * counterfeit an assured terminal receipt.
 */
export function summarizeRoutineCoverage(
  checklist: ProvisionalChecklist,
  verification: { editsSince: number; hasCurrentTest: boolean } | undefined,
): RoutineCoverageSummary {
  const coverage: RoutineCoverageItemStatus["coverage"] =
    verification === undefined || !verification.hasCurrentTest
      ? "evidence-missing"
      : verification.editsSince > 0
        ? "evidence-stale"
        : "evidence-current";
  return {
    authority: ROUTINE_GUIDANCE_AUTHORITY,
    checklistId: checklist.checklistId,
    items: checklist.items.map(({ id, statement }) => ({ id, statement, coverage })),
    terminalReceipt: false,
  };
}
