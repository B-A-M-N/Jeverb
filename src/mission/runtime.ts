import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { redactAndClamp } from "../hooks/redact.js";
import { mergeServiceAttestations, readServiceAttestations } from "../control/attestations.js";
import { proofPlanStatus, type ServiceHostProofPlan } from "../control/client.js";
import type { DecisionModel } from "../decision/types.js";
import { hashSubject, type EvidenceLedger, type EvidenceRecord } from "../evidence/ledger.js";
import type { HookConfig } from "../hooks/config.js";
import type { Store } from "../hooks/store.js";
import { AdversarialClosureGate, MissionClosureGate, type MissionClosureRunnerResult } from "./closure.js";
import type { CriterionProducerAssociation } from "./graph-binding.js";
import type { MissionClosureEvidence, MissionCriterionVerification } from "./closure.js";
import type { CriterionCodeStructureEvidence } from "./structural-analysis.js";
import type { MissionContract } from "./contract.js";
import { hostProofPlanContentDigest } from "./proof-plan.js";
import { persistMissionClosureReceipt } from "./receipt.js";
import { createSessionMissionClosureSource } from "./session-source.js";
import {
  dagLocalProbeRunId,
  evaluateDagLocalCriterion,
  preflightMissionClosure,
  selectDagLocalProbe,
  type DagLocalCriterionJudgment,
  type RegisteredDagLocalProbeAction,
} from "./closure.js";
import { resolveExecutionPolicy } from "../graph/policy.js";
import { graphHash } from "../graph/validate.js";
import { reconcileJournal, journalExists } from "../graph/journal.js";
import { withFileLockAsync } from "../hooks/store-lock.js";
import {
  findingToVerification,
  persistVerifierFinding,
  readVerifierFileBytes,
  verificationReceiptIds,
  verifyBuildArtifact,
  verifyFileState,
  verifyTestExecution,
  verifyTreeBinding,
  type VerifierFinding,
  type VerifierFs,
} from "./verifiers.js";

/**
 * Build the production Stop adapter from host-owned session, journal, and ledger state.
 * Only explicit user-authored mission contracts reach the closure runner:
 * provisional routine checklists are guidance, never closure evidence, and
 * can never produce a terminal receipt.
 *
 * Trusted graph-to-criterion integration stays default-OFF. Enabling it is
 * an explicit host decision, never a default, and enabling alone authorizes
 * nothing: verified completion additionally requires every qualification
 * gate below, and the gate's `terminalComplete` (a complete decision plus a
 * durable appended/duplicate closure receipt) stays the only terminal
 * authorization signal. Execution-observed rows — succeeded nodes, terminal
 * receipts, review lanes, observations — never count as verified outcomes.
 *
 * Qualification gates for verified completion on the trusted path:
 * 1. Current contract: the snapshot's mission/evidence revisions must still
 *    be current after the semantic vote (`isCurrent`; the gate rechecks).
 * 2. Valid graph states: every traceability row for every criterion is
 *    `bound` (unhealthy, unknown, stale, conflicting, or absent rows fail
 *    closed through `operations.uncertain`, never toward COMPLETE).
 * 3. Traceable evidence: producer bindings derive ONLY from explicit
 *    host-declared `criterionProducerAssociations` matched against persisted
 *    journals; undeclared nodes never bind, and one node serves several
 *    criteria only when each contribution is explicitly declared.
 * 4. Per-criterion independent outcomes: every criterion carries a
 *    `satisfied` verification bound to the exact mission revision and
 *    candidate, from an allowlisted verifier with a durably persisted
 *    receipt (enforced when the ledger is supplied).
 * 5. Zero unresolved uncertainty: no pending or uncertain operations.
 * 6. Semantic qualification: a calibrated judge agrees under the v2
 *    question (a v1 calibration can never validate a v2 request).
 * 7. Durable consistent receipts: the verdict persists as an
 *    appended/duplicate closure receipt, else the COMPLETE is downgraded.
 *
 * Supplemental lifecycle (host proof-plan v3/v4): after deterministic
 * readiness passes, criterion-local Jev may select only a registered action
 * id scoped to exact approved producer attempts. The runner reserves it
 * durably, dispatches the exact approved command as a single non-idempotent,
 * read-only-workspace graph node, persists a separate host verifier receipt,
 * and never counts that receipt as a second producer binding. After a passing
 * probe, the primary verifier and operator attestation are rebound to the
 * settled graph candidate before closure; stale pre-probe evidence cannot
 * complete it. A behavioral failure returns one durable repair obligation
 * per criterion/revision. V4 may carry one separately PolicyKit-approved
 * repair command; the existing graph runner executes it once, reruns all
 * current criterion tests and the selected probe, and records host receipts.
 * Plans without that action retain the authorized agent handoff. Unknown
 * side effects are reconciled, never replayed. Recovery accepts a terminal
 * observation only when its journal belongs to the exact Muse session and
 * its graph fingerprint matches the command graph rebuilt from the approved
 * plan; one-shot proof receipts also require one explicit durable attempt id.
 * Existing global closure remains the final semantic gate.
 */

/**
 * Explicit trusted-path configuration, resolved from operator-controlled
 * input (never agent/MCP/user text). Everything defaults to OFF/absent:
 * constructing this from defaults leaves the snapshot bit-identical.
 */
export interface TrustedRunnerOptions {
  /** Master switch for the trusted-evidence snapshot profile. Default false. */
  enableTrustedGraphEvidence?: boolean;
  /** Explicit criterion→producer-node associations (host-constructed). */
  criterionProducerAssociations?: CriterionProducerAssociation[];
  /** Host-supplied per-criterion verdicts. Never agent/MCP/user text. */
  criterionVerifications?: MissionCriterionVerification[];
  /** Host-owned supplemental probe receipts; not used for criterion qualification. */
  criterionSupplementalVerifications?: MissionCriterionVerification[];
  /** Host-produced AST relationships, bound to the current obligation/revision/candidate. */
  criterionCodeStructure?: CriterionCodeStructureEvidence[];
  /** Current code paths covered by an operator-approved control-service plan. */
  criterionCodeFiles?: Array<{ criterionId: string; files: string[] }>;
  structuralAnalysisRoot?: string;
  hostProofPlanDigest?: string;
  /** Host-supplied verifier allowlist (exact match). Default empty. */
  trustedVerifierIds?: string[];
}

/**
 * Resolve trusted-path options from an explicit operator-controlled env
 * mapping (default: everything OFF). Only the boolean profile switch and
 * the verifier allowlist travel this way — associations and verdicts are
 * structured host state and must be injected by the host via
 * `createSessionMissionClosureRunner` args, never derived from strings.
 *
 * Recognized keys:
 * - `JEVERB_TRUSTED_GRAPH_EVIDENCE=1`: enable the trusted-evidence
 *   snapshot profile. Any other value (including unset) disables it.
 * - `JEVERB_TRUSTED_VERIFIER_IDS`: comma-separated verifier allowlist.
 *   Empty entries are dropped; an empty result means the default empty
 *   allowlist (every verdict `unresolved`, fail closed).
 *
 * Note: hook transports may sanitize the process environment. A supervised
 * install or qualification harness passes these explicitly; when they cannot
 * be observed the path stays OFF, never half-enabled.
 */
export function resolveTrustedRunnerOptions(env: NodeJS.ProcessEnv = process.env): TrustedRunnerOptions {
  const enabled = env.JEVERB_TRUSTED_GRAPH_EVIDENCE === "1";
  if (!enabled) return {};
  const ids = (env.JEVERB_TRUSTED_VERIFIER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  return {
    enableTrustedGraphEvidence: true as const,
    ...(ids.length === 0 ? {} : { trustedVerifierIds: ids }),
  };
}

interface ProbeReservation {
  runId: string;
  correlationId: string;
  created: boolean;
}

function probeReservationCorrelation(args: {
  missionId: string; missionRevision: string; probeInputDigest: string;
  criterionId: string; probeId: string; runId: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "jeverb-verification-probe/1", args.missionId, args.missionRevision,
    args.probeInputDigest, args.criterionId, args.probeId, args.runId,
  ]), "utf8").digest("hex");
}

/** Stable semantic input identity for a probe. It binds the relevant source,
 * graph predecessors, requirement, and primary verifier, while excluding the
 * probe's own journal/receipt so recovery cannot turn one action into a loop. */
function criterionProbeInputDigest(evidence: MissionClosureEvidence, criterionId: string, planDigest: string): string | undefined {
  const criterion = evidence.criteria.find((row) => row.id === criterionId);
  if (criterion === undefined || !/^[0-9a-f]{64}$/.test(planDigest)) return undefined;
  const structure = criterion.proofObligation?.codeStructure;
  return createHash("sha256").update(JSON.stringify({
    planDigest,
    missionRevision: evidence.missionRevision,
    criterionId,
    requirement: criterion.statement,
    sourceFiles: (structure?.fileDigests ?? []).map(({ path, sha256 }) => ({ path, sha256 })),
    predecessorStates: (criterion.graphEvidence ?? []).map((row) => ({
      runId: row.runId, nodeId: row.nodeId, attemptId: row.attemptId ?? null,
      state: row.state, dependencies: row.dependencies ?? [],
    })),
    verifier: criterion.criterionVerification === undefined ? null : {
      result: criterion.criterionVerification.result,
      verifierId: criterion.criterionVerification.verifierId ?? null,
      evidenceRef: criterion.criterionVerification.evidenceRef ?? null,
      observedResult: criterion.criterionVerification.observedResult ?? null,
    },
  }), "utf8").digest("hex");
}

/** Reserve a bounded action durably before dispatch. A pre-existing reservation
 * is never interpreted as permission to start a fresh side effect. */
async function reserveApprovedProbe(args: {
  ledger: EvidenceLedger; sessionId: string; missionId: string; missionRevision: string;
  evidenceRevision: string; candidateDigest: string; criterionId: string;
  probeId: string; runId: string; probeInputDigest: string; maxExecutions: number;
}): Promise<ProbeReservation | undefined> {
  const correlationId = probeReservationCorrelation(args);
  const budgetKey = createHash("sha256").update(JSON.stringify([
    "mission-probe-budget/1", args.missionId, args.missionRevision, args.evidenceRevision,
  ]), "utf8").digest("hex").slice(0, 32);
  const lock = await withFileLockAsync(dirname(args.ledger.path), `mission-probe-${budgetKey}`, () => {
    const current = args.ledger.read();
    if (current.corrupt !== undefined) return undefined;
    const prior = current.records.find((row) => row.event === "ControlAction" && row.correlationId === correlationId);
    if (prior !== undefined) return { runId: args.runId, correlationId, created: false };
    const sameEvidenceUses = current.records.filter((row) => row.event === "ControlAction" &&
      row.controlAction?.action === "verification-probe-reserved" &&
      row.controlAction.missionId === args.missionId &&
      row.controlAction.missionRevision === args.missionRevision &&
      row.controlAction.evidenceRevision === args.evidenceRevision).length;
    if (sameEvidenceUses >= 1) return undefined;
    const uses = current.records.filter((row) => row.event === "ControlAction" &&
      row.controlAction?.action === "verification-probe-reserved" &&
      row.controlAction.missionId === args.missionId &&
      row.controlAction.missionRevision === args.missionRevision &&
      row.controlAction.criterionId === args.criterionId &&
      row.controlAction.requiredOutcome?.startsWith(`${args.probeId}:`) === true).length;
    if (uses >= args.maxExecutions) return undefined;
    const record: EvidenceRecord = {
      schema: 1, id: "", ts: new Date().toISOString(), sessionId: args.sessionId,
      decisionId: correlationId.slice(0, 32), correlationId, event: "ControlAction",
      subjectHash: hashSubject(`${args.missionId}\n${args.missionRevision}\n${args.criterionId}\n${args.probeId}`),
      policyVersion: "mission-probe/1", deterministicFindings: [], enforcement: "mission_not_complete",
      reasons: ["reserved a host-approved bounded verification probe"], latencyMs: 0,
      controlAction: {
        missionId: args.missionId, missionRevision: args.missionRevision,
        evidenceRevision: args.evidenceRevision, candidateDigest: args.candidateDigest,
        action: "verification-probe-reserved", criterionId: args.criterionId,
        requiredOutcome: `${args.probeId}:${args.runId}`, maxAttempts: args.maxExecutions, attempt: uses + 1,
      },
    };
    const appended = args.ledger.appendDetailed(record, { durable: true });
    if (!appended.ok) return undefined;
    const verify = args.ledger.read();
    if (verify.corrupt !== undefined || !verify.records.some((row) => row.event === "ControlAction" && row.correlationId === correlationId)) return undefined;
    return { runId: args.runId, correlationId, created: true };
  });
  return lock.locked ? lock.value : undefined;
}

function persistProbeResult(args: {
  ledger: EvidenceLedger; sessionId: string; missionId: string; missionRevision: string;
  evidenceRevision: string; candidateDigest: string; criterionId: string; probeId: string;
  runId: string; status: string; resultClass: "passed" | "behavioral-failure" | "execution-unresolved"; verifierReceipt?: string;
}): boolean {
  const correlationId = createHash("sha256").update(JSON.stringify([
    "jeverb-verification-probe-result/1", args.missionId, args.missionRevision,
    args.evidenceRevision, args.criterionId, args.probeId, args.runId,
  ]), "utf8").digest("hex");
  const record: EvidenceRecord = {
    schema: 1, id: "", ts: new Date().toISOString(), sessionId: args.sessionId,
    decisionId: correlationId.slice(0, 32), correlationId, event: "ControlAction",
    subjectHash: hashSubject(`${args.missionId}\n${args.missionRevision}\n${args.criterionId}\n${args.probeId}`),
    policyVersion: "mission-probe/1", deterministicFindings: [], enforcement: "mission_not_complete",
    reasons: ["recorded host graph-probe disposition"], latencyMs: 0,
    controlAction: {
      missionId: args.missionId, missionRevision: args.missionRevision,
      evidenceRevision: args.evidenceRevision, candidateDigest: args.candidateDigest,
      action: "verification-probe-result", criterionId: args.criterionId,
      requiredOutcome: `${args.probeId}:${args.runId}:${args.status}:${args.resultClass}${args.verifierReceipt === undefined ? "" : `:${args.verifierReceipt}`}`,
    },
  };
  const appended = args.ledger.appendDetailed(record, { durable: true });
  if (!appended.ok) return false;
  const read = args.ledger.read();
  return read.corrupt === undefined && read.records.some((row) => row.event === "ControlAction" && row.correlationId === correlationId);
}

/** Persist at most one repair handoff per mandatory criterion and mission
 * revision. Candidate edits cannot reset the repair budget. */
async function persistProbeRepairObligation(args: {
  ledger: EvidenceLedger; sessionId: string; missionId: string; missionRevision: string;
  evidenceRevision: string; candidateDigest: string; criterionId: string; probeId: string;
  runId: string; requirement: string; verifierReceipt: string; evidenceRefs: string[];
}): Promise<{ receipt?: string; budgetExhausted: boolean }> {
  if (!/^[0-9a-f]{64}$/.test(args.verifierReceipt) || args.evidenceRefs.length === 0 || args.evidenceRefs.length > 16) {
    return { budgetExhausted: false };
  }
  const correlationId = createHash("sha256").update(JSON.stringify([
    "jeverb-verification-repair-obligation/1", args.missionId, args.missionRevision,
    args.criterionId, args.probeId, args.runId,
  ]), "utf8").digest("hex");
  const budgetKey = createHash("sha256").update(JSON.stringify([
    "mission-repair-budget/1", args.missionId, args.missionRevision, args.criterionId,
  ]), "utf8").digest("hex").slice(0, 32);
  const locked = await withFileLockAsync(dirname(args.ledger.path), `mission-repair-${budgetKey}`, () => {
    const prior = args.ledger.read();
    if (prior.corrupt !== undefined) return { budgetExhausted: false };
    const previous = prior.records.find((row) => row.event === "ControlAction" && row.correlationId === correlationId);
    if (previous !== undefined) {
      const action = previous.controlAction;
      const valid = action?.action === "verification-repair-obligation" && action.missionId === args.missionId &&
        action.missionRevision === args.missionRevision && action.criterionId === args.criterionId &&
        action.candidateDigest !== undefined && /^[0-9a-f]{64}$/.test(action.candidateDigest) &&
        previous.subjectHash === hashSubject(`${args.missionId}\n${args.missionRevision}\n${args.criterionId}\n${args.requirement}`) &&
        typeof action.terminalReceipt === "string" && /^[0-9a-f]{64}$/.test(action.terminalReceipt) &&
        action.evidenceRefs?.includes(`graph-run:${args.runId}`) === true &&
        action.evidenceRefs.includes(`approved-probe:${args.probeId}`) &&
        action.evidenceRefs.includes(`verifier-receipt:${action.terminalReceipt}`) &&
        prior.records.some((row) => row.event === "CriterionVerification" && row.correlationId === action.terminalReceipt);
      return valid ? { receipt: correlationId, budgetExhausted: false } : { budgetExhausted: false };
    }
    const repairAttempts = prior.records.filter((row) => row.event === "ControlAction" &&
      row.controlAction?.action === "verification-repair-obligation" &&
      row.controlAction.missionId === args.missionId &&
      row.controlAction.missionRevision === args.missionRevision &&
      row.controlAction.criterionId === args.criterionId).length;
    if (repairAttempts >= 1) return { budgetExhausted: true };
    const record: EvidenceRecord = {
      schema: 1, id: "", ts: new Date().toISOString(), sessionId: args.sessionId,
      decisionId: correlationId.slice(0, 32), correlationId, event: "ControlAction",
      subjectHash: hashSubject(`${args.missionId}\n${args.missionRevision}\n${args.criterionId}\n${args.requirement}`),
      policyVersion: "mission-repair-obligation/1", deterministicFindings: [], enforcement: "mission_not_complete",
      reasons: [`bounded repair obligation for original requirement: ${redactAndClamp(args.requirement, 500)}`], latencyMs: 0,
      controlAction: {
        missionId: args.missionId, missionRevision: args.missionRevision,
        evidenceRevision: args.evidenceRevision, candidateDigest: args.candidateDigest,
        action: "verification-repair-obligation", criterionId: args.criterionId,
        defectKind: "contradiction", requiredOutcome: `repair criterion ${args.criterionId} and rerun its authorized verification`,
        maxAttempts: 1, attempt: 1, terminalReceipt: args.verifierReceipt,
        evidenceRefs: args.evidenceRefs,
      },
    };
    const appended = args.ledger.appendDetailed(record, { durable: true });
    if (!appended.ok) return { budgetExhausted: false };
    const read = args.ledger.read();
    return read.corrupt === undefined && read.records.some((row) => row.event === "ControlAction" && row.correlationId === correlationId)
      ? { receipt: correlationId, budgetExhausted: false }
      : { budgetExhausted: false };
  });
  return locked.locked && locked.value !== undefined ? locked.value : { budgetExhausted: false };
}

/** Reserve the single plan-approved repair graph run before dispatch. A
 * reservation without a journal is ambiguous after a crash and must never be
 * replayed automatically. */
async function reserveApprovedRepair(args: {
  ledger: EvidenceLedger; sessionId: string; missionId: string; missionRevision: string;
  evidenceRevision: string; candidateDigest: string; criterionId: string;
  repairId: string; runId: string; inputDigest: string;
}): Promise<ProbeReservation | undefined> {
  const correlationId = createHash("sha256").update(JSON.stringify([
    "jeverb-approved-repair/1", args.missionId, args.missionRevision,
    args.criterionId, args.repairId, args.runId, args.inputDigest,
  ]), "utf8").digest("hex");
  const budgetKey = createHash("sha256").update(JSON.stringify([
    "mission-approved-repair/1", args.missionId, args.missionRevision, args.criterionId,
  ]), "utf8").digest("hex").slice(0, 32);
  const locked = await withFileLockAsync(dirname(args.ledger.path), `mission-approved-repair-${budgetKey}`, () => {
    const current = args.ledger.read();
    if (current.corrupt !== undefined) return undefined;
    if (current.records.some((row) => row.event === "ControlAction" && row.correlationId === correlationId)) {
      return { runId: args.runId, correlationId, created: false };
    }
    const used = current.records.filter((row) => row.event === "ControlAction" &&
      row.controlAction?.action === "verification-repair-reserved" &&
      row.controlAction.missionId === args.missionId && row.controlAction.missionRevision === args.missionRevision &&
      row.controlAction.criterionId === args.criterionId).length;
    if (used >= 1) return undefined;
    const record: EvidenceRecord = {
      schema: 1, id: "", ts: new Date().toISOString(), sessionId: args.sessionId,
      decisionId: correlationId.slice(0, 32), correlationId, event: "ControlAction",
      subjectHash: hashSubject(`${args.missionId}\n${args.missionRevision}\n${args.criterionId}\n${args.repairId}`),
      policyVersion: "mission-repair/1", deterministicFindings: [], enforcement: "mission_not_complete",
      reasons: ["reserved one host-approved bounded repair graph action"], latencyMs: 0,
      controlAction: {
        missionId: args.missionId, missionRevision: args.missionRevision,
        evidenceRevision: args.evidenceRevision, candidateDigest: args.candidateDigest,
        action: "verification-repair-reserved", criterionId: args.criterionId,
        requiredOutcome: `${args.repairId}:${args.runId}`, maxAttempts: 1, attempt: 1,
      },
    };
    if (!args.ledger.appendDetailed(record, { durable: true }).ok) return undefined;
    const verify = args.ledger.read();
    return verify.corrupt === undefined && verify.records.some((row) => row.event === "ControlAction" && row.correlationId === correlationId)
      ? { runId: args.runId, correlationId, created: true } : undefined;
  });
  return locked.locked ? locked.value : undefined;
}

/** A non-zero command is not by itself proof of a code defect: sandbox,
 * timeout, dependency, and harness failures also return non-zero. Only
 * recognizable assertion/test-failure output is routed as a repair. */
function probeOutputDemonstratesBehavioralFailure(output: string): boolean {
  return /\b(?:AssertionError|AssertionError\s*\[|Test Failed|Tests? failed|Test Suites?:.*failed|FAIL\s+.*\.(?:test|spec)\.|not ok\s+\d+|expected .{1,120}(?:received|got|to be|to equal))\b/i.test(output);
}

export function createSessionMissionClosureRunner(args: {
  model: DecisionModel;
  config: Pick<HookConfig, "dataDir" | "missionClosurePolicy" | "timeoutMs">;
  store: Store;
  ledger: EvidenceLedger;
  now: () => number;
  /**
   * Enable the adversarial closure pair (Jev A + Jev B). Off by default:
   * the second live judgment should only be introduced once the provider
   * path is reliable, and pair mode doubles inference at each checkpoint.
   */
  adversarial?: boolean;
  /**
   * Trusted graph-to-criterion integration (default OFF). When enabled, the
   * session source converts `criterionProducerAssociations` into bindings
   * against the in-memory journal projection and qualifies criteria against
   * `criterionVerifications` gated by `trustedVerifierIds` (default empty:
   * all unresolved). Production passes none of these today, so the default
   * snapshot is unchanged.
   */
  enableTrustedGraphEvidence?: boolean;
  /**
   * Explicit host-declared criterion→producer-node associations for the
   * trusted path (host-constructed, never agent/MCP/user text). With none,
   * the trusted path yields no bindings — there is no heuristic fallback.
   */
  criterionProducerAssociations?: CriterionProducerAssociation[];
  /** Host-supplied per-criterion verdicts. Never agent/MCP/user text. */
  criterionVerifications?: MissionCriterionVerification[];
  /** Supplemental receipts inform semantics but never mandatory qualification. */
  criterionSupplementalVerifications?: MissionCriterionVerification[];
  /** Host-produced AST relationships, bound to current obligation/revision/candidate. */
  criterionCodeStructure?: CriterionCodeStructureEvidence[];
  /** Source paths explicitly approved in a root-owned host proof plan. */
  criterionCodeFiles?: Array<{ criterionId: string; files: string[] }>;
  structuralAnalysisRoot?: string;
  hostProofPlanDigest?: string;
  /** Host-supplied verifier allowlist (exact match). Default empty. */
  trustedVerifierIds?: string[];
}): (sessionId: string, signal?: AbortSignal, context?: { backgroundTasks: number; sessionCrons: number }) => Promise<MissionClosureRunnerResult> {
  const trusted = args.enableTrustedGraphEvidence === true;
  const source = createSessionMissionClosureSource({
    store: args.store,
    dataDir: args.config.dataDir,
    now: args.now,
    // The ledger reaches the source only on the trusted path: the disabled
    // path must stay bit-identical (receipt-naming bindings keep resolving
    // `unavailable` there, exactly as before this wiring existed).
    ...(trusted ? { ledger: args.ledger } : {}),
    ...(trusted ? { enableTrustedGraphEvidence: true as const } : {}),
    ...(args.criterionProducerAssociations === undefined ? {} : { criterionProducerAssociations: args.criterionProducerAssociations }),
    ...(args.criterionVerifications === undefined ? {} : { criterionVerifications: args.criterionVerifications }),
    ...(args.criterionSupplementalVerifications === undefined ? {} : { criterionSupplementalVerifications: args.criterionSupplementalVerifications }),
    ...(args.criterionCodeStructure === undefined ? {} : { criterionCodeStructure: args.criterionCodeStructure }),
    ...(args.criterionCodeFiles === undefined ? {} : { criterionCodeFiles: args.criterionCodeFiles }),
    ...(args.structuralAnalysisRoot === undefined ? {} : { structuralAnalysisRoot: args.structuralAnalysisRoot }),
    ...(args.hostProofPlanDigest === undefined ? {} : { hostProofPlanDigest: args.hostProofPlanDigest }),
    ...(args.trustedVerifierIds === undefined ? {} : { trustedVerifierIds: args.trustedVerifierIds }),
  });
  const timeoutMs = Math.min(args.config.timeoutMs, 1500);
  if (args.adversarial === true) {
    const gate = new AdversarialClosureGate(
      args.model,
      args.config.missionClosurePolicy,
      source,
      args.ledger,
      timeoutMs,
    );
    return async (sessionId: string, signal?: AbortSignal, context?: Parameters<typeof gate.close>[3]) => {
      const missionId = args.store.readSession(sessionId).mission_contract?.missionId;
      if (missionId === undefined) return { outcome: "NOT_APPLICABLE", reason: "mission_contract_missing" };
      return gate.close(sessionId, missionId, signal, context);
    };
  }
  const gate = new MissionClosureGate(
    args.model,
    args.config.missionClosurePolicy,
    source,
    args.ledger,
    timeoutMs,
  );
  return async (sessionId: string, signal?: AbortSignal, context?: Parameters<typeof gate.close>[3]) => {
    const missionId = args.store.readSession(sessionId).mission_contract?.missionId;
    if (missionId === undefined) return { outcome: "NOT_APPLICABLE", reason: "mission_contract_missing" };
    return gate.close(sessionId, missionId, signal, context);
  };
}

function validServiceProofPlan(plan: ServiceHostProofPlan, contract: MissionContract): boolean {
  const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
  if ((plan.schema !== "jeverb-host-proof-plan/1" && plan.schema !== "jeverb-host-proof-plan/2" && plan.schema !== "jeverb-host-proof-plan/3" && plan.schema !== "jeverb-host-proof-plan/4") || plan.missionId !== contract.missionId ||
      plan.missionRevision !== contract.missionRevision || plan.objectiveSha256 !== sha(contract.objective) ||
      !/^[0-9a-f]{64}$/.test(plan.planDigest) || !/^[0-9a-f]{32}$/.test(plan.receiptCorrelationId) ||
      !Number.isSafeInteger(plan.approvedAt) || !Number.isSafeInteger(plan.approvedByUid) ||
      !isAbsolute(plan.workspaceRoot) || !Array.isArray(plan.criteria) || plan.criteria.length !== contract.criteria.length ||
      hostProofPlanContentDigest(plan) !== plan.planDigest) return false;
  try {
    if (realpathSync(plan.workspaceRoot) !== resolve(plan.workspaceRoot) || !statSync(plan.workspaceRoot).isDirectory()) return false;
  } catch {
    return false;
  }
  const byId = new Map(plan.criteria.map((criterion) => [criterion.criterionId, criterion]));
  if (byId.size !== contract.criteria.length) return false;
  return contract.criteria.every((criterion) => {
    const entry = byId.get(criterion.id);
    const repairActionsValid = plan.schema !== "jeverb-host-proof-plan/4" || (entry !== undefined &&
      typeof entry.testCommand === "string" && entry.testCommand.trim() !== "" && entry.testCommand.length <= 512 && !/[\r\n\0]/.test(entry.testCommand) &&
      createHash("sha256").update(entry.testCommand, "utf8").digest("hex") === entry.testCommandSha256 &&
      Array.isArray(entry.repairActions) && entry.repairActions.length <= 1 && entry.repairActions.every((action) => {
        if (typeof action.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(action.id) ||
            typeof action.description !== "string" || action.description.trim() === "" || action.description.length > 300 ||
            typeof action.command !== "string" || action.command.trim() === "" || action.command.length > 512 || /[\r\n\0]/.test(action.command) ||
            !/^[0-9a-f]{64}$/.test(action.commandSha256) || sha(action.command) !== action.commandSha256 ||
            typeof action.nodeId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(action.nodeId) || action.maxExecutions !== 1 ||
            !Array.isArray(action.producers) || action.producers.length === 0 || action.producers.length > 8) return false;
        const ids = new Set<string>();
        return action.producers.every((producer) => {
          const id = `${producer.runId}\0${producer.nodeId}\0${producer.attemptId}`;
          if (!/^[A-Za-z0-9_.-]{1,128}$/.test(producer.runId) || !/^[A-Za-z0-9_.-]{1,128}$/.test(producer.nodeId) ||
              !/^[A-Za-z0-9_.-]{1,128}\/[1-9][0-9]{0,8}$/.test(producer.attemptId) || ids.has(id)) return false;
          ids.add(id);
          return entry.producers.some((candidate) => candidate.runId === producer.runId &&
            candidate.nodeId === producer.nodeId && candidate.attemptId === producer.attemptId);
        });
      }));
    return entry !== undefined && entry.requirementSha256 === sha(criterion.statement) &&
      /^[0-9a-f]{64}$/.test(entry.testCommandSha256) &&
      Array.isArray(entry.producers) && entry.producers.length > 0 && entry.producers.length <= 8 &&
      Array.isArray(entry.codeFiles) && entry.codeFiles.length > 0 && entry.codeFiles.length <= 16 &&
      (plan.schema === "jeverb-host-proof-plan/1" || (Array.isArray(entry.probeActions) && entry.probeActions.length <= 8 && entry.probeActions.every((action) =>
        /^[a-z][a-z0-9-]{0,47}$/.test(action.id) && action.description.trim() !== "" && action.description.length <= 300 &&
        action.command.trim() !== "" && action.command.length <= 512 && !/[\r\n\0]/.test(action.command) &&
        createHash("sha256").update(action.command, "utf8").digest("hex") === action.commandSha256 &&
        /^[A-Za-z0-9_.-]{1,128}$/.test(action.nodeId) && Number.isSafeInteger(action.maxExecutions) &&
        action.maxExecutions >= 1 && action.maxExecutions <= 3 &&
        (plan.schema === "jeverb-host-proof-plan/2" ? action.producers === undefined :
          Array.isArray(action.producers) && action.producers.length >= 1 && action.producers.length <= 8 &&
          action.producers.every((probeProducer) => /^[A-Za-z0-9_.-]{1,128}$/.test(probeProducer.runId) &&
            /^[A-Za-z0-9_.-]{1,128}$/.test(probeProducer.nodeId) &&
            /^[A-Za-z0-9_.-]{1,128}\/[1-9][0-9]{0,8}$/.test(probeProducer.attemptId) &&
            entry.producers.some((producer) => producer.runId === probeProducer.runId &&
              producer.nodeId === probeProducer.nodeId && producer.attemptId === probeProducer.attemptId))) &&
        !entry.producers.some((producer) => producer.nodeId === action.nodeId)))) &&
      repairActionsValid &&
      entry.producers.every((producer) => typeof producer.runId === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(producer.runId) &&
        typeof producer.nodeId === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(producer.nodeId) &&
        (producer.attemptId === undefined || /^[A-Za-z0-9_.-]{1,128}\/[1-9][0-9]{0,8}$/.test(producer.attemptId))) &&
      entry.codeFiles.every((path) => /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\-/]{1,512}\.(?:ts|tsx|mts|cts)$/.test(path));
  });
}

function approvedProbeGraph(action: { nodeId: string; command: string }) {
  return { version: 1 as const, parallel: false, nodes: [{
    id: action.nodeId, kind: "shell" as const, command: action.command,
    maxAttempts: 1, idempotent: false, captureOutput: false,
  }] };
}

function approvedRepairGraph(args: {
  plan: ServiceHostProofPlan;
  criterionId: string;
  repairId: string;
  probeId: string;
}) {
  const criterion = args.plan.criteria.find((entry) => entry.criterionId === args.criterionId);
  const repair = criterion?.repairActions?.find((entry) => entry.id === args.repairId);
  const probe = criterion?.probeActions?.find((entry) => entry.id === args.probeId);
  if (repair === undefined || probe === undefined || args.plan.criteria.some((entry) => entry.testCommand === undefined)) return undefined;
  const verificationNodes = new Map(args.plan.criteria.map((entry) => [entry.criterionId,
    `verify-${createHash("sha256").update(entry.criterionId, "utf8").digest("hex").slice(0, 16)}`]));
  const probeNodeId = `probe-${createHash("sha256").update(repair.id, "utf8").digest("hex").slice(0, 16)}`;
  return { version: 1 as const, parallel: false, nodes: [
    { id: repair.nodeId, kind: "shell" as const, command: repair.command, maxAttempts: 1, idempotent: false, captureOutput: false },
    ...args.plan.criteria.map((entry) => ({
      id: verificationNodes.get(entry.criterionId)!, kind: "shell" as const, command: entry.testCommand!,
      dependsOn: [repair.nodeId], maxAttempts: 1, idempotent: false, captureOutput: false,
    })),
    { id: probeNodeId, kind: "shell" as const, command: probe.command, dependsOn: [...verificationNodes.values()],
      maxAttempts: 1, idempotent: false, captureOutput: false },
  ] };
}

/** A terminal journal entry for these one-shot actions must identify the one
 * actual attempt. Journal authorization and running events may repeat that
 * id, so compare unique identities rather than trusting array length. */
function exactSingleAttempt(attemptIds: readonly string[], nodeId: string): string | undefined {
  const unique = [...new Set(attemptIds)];
  return unique.length === 1 && unique[0] === `${nodeId}/1` ? unique[0] : undefined;
}

function journalMatchesApprovedGraph(journal: ReturnType<typeof reconcileJournal>, runId: string, sessionId: string,
  graph: ReturnType<typeof approvedProbeGraph> | NonNullable<ReturnType<typeof approvedRepairGraph>>): boolean {
  return journal.runStarted && journal.runId === runId && journal.hostSessionId === sessionId &&
    journal.malformed === 0 && journal.graphHash === graphHash(graph);
}

interface RecoveredRepairVerification {
  producer: HostProducerResult;
  supplementalVerifications: MissionCriterionVerification[];
  associations: CriterionProducerAssociation[];
}

/** Rebuild current host verifier receipts from a completed, durable v4 repair
 * graph when a later Stop sees the same candidate. This avoids reusing the
 * pre-repair Muse test record after a graph command changed the workspace.
 * Recovery reads terminal journal evidence only; it never dispatches a node. */
async function recoverApprovedRepairVerification(args: {
  store: Store; dataDir: string; sessionId: string; contract: MissionContract;
  plan: ServiceHostProofPlan; ledger: EvidenceLedger; now: () => number;
  associations: CriterionProducerAssociation[];
  criterionCodeFiles: Array<{ criterionId: string; files: string[] }>;
}): Promise<RecoveredRepairVerification | undefined> {
  if (args.plan.schema !== "jeverb-host-proof-plan/4") return undefined;
  const view = args.ledger.read();
  if (view.corrupt !== undefined) return undefined;
  const current = await createSessionMissionClosureSource({
    store: args.store, dataDir: args.dataDir, now: args.now, ledger: args.ledger,
    enableTrustedGraphEvidence: true, criterionProducerAssociations: args.associations,
    criterionCodeFiles: args.criterionCodeFiles, structuralAnalysisRoot: args.plan.workspaceRoot,
    hostProofPlanDigest: args.plan.planDigest,
  }).load(args.sessionId, args.contract.missionId);
  if (current.candidateDigest === undefined) return undefined;

  const records = view.records.filter((record) => record.event === "ControlAction" &&
    record.controlAction?.action === "verification-repair-result" &&
    record.controlAction.missionId === args.contract.missionId &&
    record.controlAction.missionRevision === args.contract.missionRevision &&
    record.controlAction.candidateDigest === current.candidateDigest &&
    typeof record.controlAction.requiredOutcome === "string").reverse();
  for (const record of records) {
    const action = record.controlAction!;
    const outcome = action.requiredOutcome!;
    const repair = args.plan.criteria.flatMap((criterion) => (criterion.repairActions ?? []).map((repairAction) => ({ criterion, repairAction })))
      .find(({ criterion, repairAction }) => criterion.criterionId === action.criterionId && outcome.startsWith(`${repairAction.id}:`));
    if (repair === undefined) continue;
    const outcomeParts = outcome.split(":");
    if (outcomeParts.length !== 3) continue;
    const [, runId, probeDigest] = outcomeParts;
    if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(runId) || !/^[0-9a-f]{64}$/.test(probeDigest ?? "")) continue;
    const evidenceRefs = action.evidenceRefs ?? [];
    const selectedProbeId = evidenceRefs.find((reference) => reference.startsWith("approved-probe:"))?.slice("approved-probe:".length);
    const obligationRef = evidenceRefs.find((reference) => reference.startsWith("repair-obligation:"));
    const obligationId = obligationRef?.slice("repair-obligation:".length);
    const obligation = obligationId === undefined ? undefined : view.records.find((candidate) =>
      candidate.event === "ControlAction" && candidate.correlationId === obligationId &&
      candidate.controlAction?.action === "verification-repair-obligation" &&
      candidate.controlAction.missionId === args.contract.missionId &&
      candidate.controlAction.missionRevision === args.contract.missionRevision &&
      candidate.controlAction.criterionId === action.criterionId);
    const obligationAction = obligation?.controlAction;
    const probeRunRef = obligationAction?.evidenceRefs?.find((reference) => reference.startsWith("graph-run:"));
    const probeRunId = probeRunRef?.slice("graph-run:".length);
    const probeReceipt = obligationAction?.terminalReceipt;
    const requirement = args.contract.criteria.find((criterion) => criterion.id === action.criterionId)?.statement;
    if (selectedProbeId === undefined || probeRunId === undefined || requirement === undefined ||
        probeReceipt === undefined || !/^[0-9a-f]{64}$/.test(probeReceipt) ||
        obligationAction?.evidenceRevision === undefined || !/^[0-9a-f]{64}$/.test(obligationAction.evidenceRevision) ||
        obligationAction.candidateDigest === undefined || !/^[0-9a-f]{64}$/.test(obligationAction.candidateDigest) ||
        !obligationAction.evidenceRefs?.includes(`approved-probe:${selectedProbeId}`) ||
        !obligationAction.evidenceRefs.includes(`verifier-receipt:${probeReceipt}`) ||
        !evidenceRefs.includes(`graph-run:${runId}`) || !evidenceRefs.includes(`repair-obligation:${obligationId}`)) continue;
    const repairInputDigest = createHash("sha256").update(JSON.stringify({
      planDigest: args.plan.planDigest, missionRevision: args.contract.missionRevision,
      criterionId: action.criterionId, requirement, probeRunId, probeReceipt,
      repairId: repair.repairAction.id, repairCommandSha256: repair.repairAction.commandSha256,
      testCommandSha256: repair.criterion.testCommandSha256,
    }), "utf8").digest("hex");
    if (dagLocalProbeRunId(action.criterionId!, repairInputDigest) !== runId) continue;
    const reservationCorrelation = createHash("sha256").update(JSON.stringify([
      "jeverb-approved-repair/1", args.contract.missionId, args.contract.missionRevision,
      action.criterionId, repair.repairAction.id, runId, repairInputDigest,
    ]), "utf8").digest("hex");
    const reservation = view.records.find((candidate) => candidate.event === "ControlAction" &&
      candidate.correlationId === reservationCorrelation && candidate.controlAction?.action === "verification-repair-reserved" &&
      candidate.controlAction.missionId === args.contract.missionId &&
      candidate.controlAction.missionRevision === args.contract.missionRevision &&
      candidate.controlAction.criterionId === action.criterionId &&
      candidate.controlAction.evidenceRevision === obligationAction.evidenceRevision &&
      candidate.controlAction.candidateDigest === obligationAction.candidateDigest &&
      candidate.controlAction.requiredOutcome === `${repair.repairAction.id}:${runId}`);
    if (reservation === undefined) continue;
    const graph = approvedRepairGraph({ plan: args.plan, criterionId: action.criterionId!,
      repairId: repair.repairAction.id, probeId: selectedProbeId });
    if (graph === undefined) continue;
    const journalPath = join(args.dataDir, "graph-journals", `jeverb-graph-${runId}.jsonl`);
    if (!journalExists(journalPath)) continue;
    const journal = reconcileJournal(journalPath);
    if (!journalMatchesApprovedGraph(journal, runId, args.sessionId, graph)) continue;
    const repairNode = journal.nodes.find((node) => node.nodeId === repair.repairAction.nodeId);
    if (repairNode?.status !== "succeeded" || exactSingleAttempt(repairNode.attemptIds, repair.repairAction.nodeId) === undefined || repairNode.outputDigest === undefined) continue;
    const verificationNodeIds = args.plan.criteria.map((criterion) =>
      `verify-${createHash("sha256").update(criterion.criterionId, "utf8").digest("hex").slice(0, 16)}`);
    const targetProbeNode = `probe-${createHash("sha256").update(repair.repairAction.id, "utf8").digest("hex").slice(0, 16)}`;
    const targetProbeEvidence = journal.nodes.find((node) => node.nodeId === targetProbeNode);
    const requiredGraphRefs = [repair.repairAction.nodeId, ...verificationNodeIds, targetProbeNode].map((nodeId) => `graph-node:${nodeId}`);
    if (!requiredGraphRefs.every((reference) => evidenceRefs.includes(reference)) ||
        targetProbeEvidence?.status !== "succeeded" || targetProbeEvidence.outputDigest !== probeDigest ||
      verificationNodeIds.some((nodeId) => {
        const node = journal.nodes.find((candidate) => candidate.nodeId === nodeId);
        return node?.status !== "succeeded" || node.outputDigest === undefined || exactSingleAttempt(node.attemptIds, nodeId) === undefined;
      })) continue;
    const nodeSpecs = args.plan.criteria.map((criterion) => {
      const nodeId = `verify-${createHash("sha256").update(criterion.criterionId, "utf8").digest("hex").slice(0, 16)}`;
      const node = journal.nodes.find((candidate) => candidate.nodeId === nodeId);
      const command = criterion.testCommand;
      if (node?.status !== "succeeded" || node.outputDigest === undefined || command === undefined) return undefined;
      const attemptId = exactSingleAttempt(node.attemptIds, nodeId);
      if (attemptId === undefined) return undefined;
      return { criterionId: criterion.criterionId, producers: [{ runId, nodeId, attemptId }],
        test: { kind: "host-command" as const, command, exitCode: 0, outputDigest: node.outputDigest,
          observedBehavior: "approved criterion test command exited successfully after repair" } };
    });
    if (nodeSpecs.some((spec) => spec === undefined)) continue;
    try {
      const producer = await produceHostVerificationInputs({
        store: args.store, dataDir: args.dataDir, sessionId: args.sessionId,
        missionId: args.contract.missionId, ledger: args.ledger, evidenceRoot: args.plan.workspaceRoot,
        now: args.now, hostProofPlanDigest: args.plan.planDigest,
        criterionCodeFiles: args.criterionCodeFiles, structuralAnalysisRoot: args.plan.workspaceRoot,
        specs: nodeSpecs as HostProducerCriterionSpec[],
      });
      const probe = repair.criterion.probeActions?.find((candidate) => candidate.id === selectedProbeId);
      const probeNode = journal.nodes.find((node) => node.nodeId === targetProbeNode);
      if (probe === undefined || probeNode?.status !== "succeeded" || probeNode.outputDigest === undefined) continue;
      const probeAttempt = exactSingleAttempt(probeNode.attemptIds, targetProbeNode);
      if (probeAttempt === undefined) continue;
      const supplemental = await produceHostVerificationInputs({
        store: args.store, dataDir: args.dataDir, sessionId: args.sessionId,
        missionId: args.contract.missionId, ledger: args.ledger, evidenceRoot: args.plan.workspaceRoot,
        now: args.now, hostProofPlanDigest: args.plan.planDigest,
        criterionCodeFiles: args.criterionCodeFiles, structuralAnalysisRoot: args.plan.workspaceRoot,
        specs: [{ criterionId: repair.criterion.criterionId, producers: [{ runId, nodeId: targetProbeNode, attemptId: probeAttempt }],
          test: { kind: "host-command", command: probe.command, exitCode: 0, outputDigest: probeNode.outputDigest,
            observedBehavior: "approved targeted supplemental probe exited successfully after repair" } }],
      });
      if (producer.reports.length !== args.contract.criteria.length || producer.reports.some((report) => report.status !== "satisfied") ||
          producer.verifications.length !== args.contract.criteria.length || producer.verifications.some((verification) => verification.result !== "satisfied") ||
          supplemental.reports.length !== 1 || supplemental.reports[0]?.status !== "satisfied" ||
          supplemental.verifications.length !== 1 || supplemental.verifications[0]?.result !== "satisfied") {
        throw new Error(`recovered verifier reconstruction incomplete: ${JSON.stringify({ reports: producer.reports, verifications: producer.verifications, supplementalReports: supplemental.reports })}`);
      }
      if (producer.reports.length !== args.contract.criteria.length || producer.reports.some((report) => report.status !== "satisfied") ||
          producer.verifications.length !== args.contract.criteria.length || producer.verifications.some((verification) => verification.result !== "satisfied") ||
          supplemental.reports.length !== 1 || supplemental.reports[0]?.status !== "satisfied" ||
          supplemental.verifications.length !== 1 || supplemental.verifications[0]?.result !== "satisfied") continue;
      const receiptRefs = [
        ...producer.verifications.map((verification) => `verifier-receipt:${verification.receiptCorrelationId}`),
        ...supplemental.verifications.map((verification) => `verifier-receipt:${verification.receiptCorrelationId}`),
      ];
      if (!receiptRefs.every((reference) => evidenceRefs.includes(reference))) continue;
      return { producer, supplementalVerifications: supplemental.verifications, associations: producer.associations };
    } catch {
      // Corrupt, stale, or incomplete evidence is never recovered as success.
    }
  }
  return undefined;
}

/**
 * Build the production Stop path from a PolicyKit-approved plan in the
 * root-owned control-service store. The service receipt is the trust source;
 * no association or file mapping is inferred from model/agent text.
 */
export function createControlServiceProofPlanClosureRunner(args: {
  model: DecisionModel;
  config: Pick<HookConfig, "dataDir" | "missionClosurePolicy" | "timeoutMs">;
  store: Store;
  ledger: EvidenceLedger;
  now: () => number;
  adversarial?: boolean;
  fallback?: (sessionId: string, signal?: AbortSignal, context?: { backgroundTasks: number; sessionCrons: number }) => Promise<MissionClosureRunnerResult>;
  readPlan?: typeof proofPlanStatus;
  readAttestations?: typeof readServiceAttestations;
  /** Test seam for exercising orchestration without executing a command. The
   * production default is always the existing confined graph tool. */
  executeGraph?: typeof import("../tools/execute-graph-runner.js").run;
}): (sessionId: string, signal?: AbortSignal, context?: { backgroundTasks: number; sessionCrons: number }) => Promise<MissionClosureRunnerResult> {
  const fallback = args.fallback ?? createSessionMissionClosureRunner({
    model: args.model,
    config: args.config,
    store: args.store,
    ledger: args.ledger,
    now: args.now,
    ...(args.adversarial === undefined ? {} : { adversarial: args.adversarial }),
    enableTrustedGraphEvidence: true,
    trustedVerifierIds: ["test-execution"],
  });
  const readPlan = args.readPlan ?? proofPlanStatus;
  const readAttestations = args.readAttestations ?? readServiceAttestations;
  return async (sessionId, signal, context) => {
    const contract = args.store.readSession(sessionId).mission_contract;
    if (contract === undefined) return fallback(sessionId, signal, context);
    let plan: ServiceHostProofPlan | undefined;
    try {
      plan = (await readPlan(contract.missionId, 250)).plan;
    } catch {
      return fallback(sessionId, signal, context);
    }
    let valid = false;
    try {
      valid = plan !== undefined && validServiceProofPlan(plan, contract);
    } catch {
      valid = false;
    }
    if (plan === undefined || !valid) return fallback(sessionId, signal, context);

    let associations: CriterionProducerAssociation[] = plan.criteria.flatMap((criterion) =>
      criterion.producers.map((producer) => ({
        criterionId: criterion.criterionId,
        runId: producer.runId,
        nodeId: producer.nodeId,
        ...(producer.attemptId === undefined ? {} : { attemptId: producer.attemptId }),
      })),
    );
    const criterionCodeFiles = plan.criteria.map(({ criterionId, codeFiles }) => ({ criterionId, files: codeFiles }));
    let producer: HostProducerResult;
    const recoveredRepair = await recoverApprovedRepairVerification({
      store: args.store, dataDir: args.config.dataDir, sessionId, contract, plan, ledger: args.ledger,
      now: args.now, associations, criterionCodeFiles,
    });
    const recoveredRepairProducer = recoveredRepair?.producer;
    if (recoveredRepair !== undefined) associations = recoveredRepair.associations;
    const recoveryLedger = args.ledger.read();
    const hasPriorRepairResult = recoveryLedger.corrupt === undefined && recoveryLedger.records.some((record) =>
      record.event === "ControlAction" && record.controlAction?.action === "verification-repair-result" &&
      record.controlAction.missionId === contract.missionId && record.controlAction.missionRevision === contract.missionRevision);
    const staleRepairEvidence = hasPriorRepairResult && recoveredRepairProducer === undefined;
    try {
      producer = recoveredRepairProducer ?? await produceHostVerificationInputs({
        store: args.store,
        dataDir: args.config.dataDir,
        sessionId,
        missionId: contract.missionId,
        ledger: args.ledger,
        evidenceRoot: plan.workspaceRoot,
        specs: plan.criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          producers: criterion.producers,
          ...(staleRepairEvidence ? {} : { test: {
            kind: "validated-runner-record" as const,
            expectedCommandSha256: criterion.testCommandSha256,
            expectedCwd: plan.workspaceRoot,
          } }),
        })),
        now: args.now,
        hostProofPlanDigest: plan.planDigest,
        criterionCodeFiles,
        structuralAnalysisRoot: plan.workspaceRoot,
      });
    } catch {
      return fallback(sessionId, signal, context);
    }
    const expected = new Set(contract.criteria.map(({ id }) => id));
    if (producer.reports.length !== expected.size || producer.reports.some((report) => !expected.has(report.criterionId))) {
      return fallback(sessionId, signal, context);
    }

    // Refresh the external operator verdict for this candidate immediately
    // before deterministic closure. A service outage leaves it absent.
    try {
      const entries = await readAttestations(contract.missionId, 250);
      if (entries.length > 0) {
        args.store.updateSession(sessionId, (state) => {
          const current = state.mission_contract as MissionContract | undefined;
          if (current === undefined || current.missionId !== contract.missionId) return state;
          const merged = mergeServiceAttestations(current, entries);
          return merged === undefined ? state : { ...state, mission_contract: merged };
        }, args.now());
      }
    } catch {
      // Missing operator evidence remains a deterministic preflight blocker.
    }

    const supplementalVerifications: MissionCriterionVerification[] = recoveredRepair?.supplementalVerifications ?? [];
    let repairedProducer: HostProducerResult | undefined = recoveredRepairProducer;
  let probeFailure: { criterionId: string; probeId: string; runId: string; receipt?: string; reason: string; candidateDigest: string; evidenceRevision: string; defectObserved: boolean } | undefined;
    const probeSource = createSessionMissionClosureSource({
      store: args.store, dataDir: args.config.dataDir, now: args.now, ledger: args.ledger,
      enableTrustedGraphEvidence: true, criterionProducerAssociations: associations,
      criterionVerifications: producer.verifications, trustedVerifierIds: ["test-execution"],
      criterionCodeFiles, structuralAnalysisRoot: plan.workspaceRoot, hostProofPlanDigest: plan.planDigest,
    });
    let probeEvidence;
    try {
      probeEvidence = await probeSource.load(sessionId, contract.missionId, undefined, {
        backgroundTasks: context?.backgroundTasks ?? 0, sessionCrons: context?.sessionCrons ?? 0,
      });
    } catch {
      probeEvidence = undefined;
    }
    // Deterministic verification and all structural readiness checks run
    // before the advisory model. If any are unresolved, the ordinary closure
    // gate will explain the blocker without spending a semantic request.
    const readiness = probeEvidence === undefined
      ? undefined
      : preflightMissionClosure(probeEvidence, args.config.missionClosurePolicy);
    const mechanicallyReady = readiness !== undefined && readiness.checks.objectivePresent &&
      readiness.checks.objectiveCoverageEstablished && readiness.checks.revisionsMatch &&
      readiness.checks.criteriaPresent && readiness.checks.allCriteriaVerified && readiness.checks.testsPassed &&
      readiness.checks.independentVerificationPassed && readiness.checks.noPendingOperations &&
      readiness.checks.noUncertainOperations && readiness.checks.noUnresolvedBlockers;
    let priorProbeConsumed = recoveredRepairProducer !== undefined;
    if (probeEvidence !== undefined && repairedProducer === undefined &&
        (plan.schema === "jeverb-host-proof-plan/3" || plan.schema === "jeverb-host-proof-plan/4")) {
      // Recover a previously reserved probe before asking Jev again. This
      // prevents repeated uncertainty from spending requests or restarting
      // a command after a crash. The journal, not the old model answer,
      // supplies its terminal status.
      const ledgerView = args.ledger.read();
      if (ledgerView.corrupt !== undefined) {
        probeFailure = {
          criterionId: contract.criteria[0]?.id ?? "", probeId: "", runId: "",
          reason: "evidence ledger is unreadable while recovering a probe reservation",
          candidateDigest: probeEvidence.candidateDigest ?? "", evidenceRevision: probeEvidence.evidenceRevision,
          defectObserved: false,
        };
        priorProbeConsumed = true;
      } else {
        for (const criterion of contract.criteria) {
          const planned = plan.criteria.find((row) => row.criterionId === criterion.id);
          for (const action of planned?.probeActions ?? []) {
            const contextDigest = criterionProbeInputDigest(probeEvidence, criterion.id, plan.planDigest);
            if (contextDigest === undefined) continue;
            const exactEvidenceDigest = createHash("sha256").update(`${contextDigest}\0${action.id}\0${action.commandSha256}`, "utf8").digest("hex");
            const stableRunId = dagLocalProbeRunId(criterion.id, exactEvidenceDigest);
            if (stableRunId === undefined || probeEvidence.candidateDigest === undefined) continue;
            const correlationId = probeReservationCorrelation({
              missionId: contract.missionId, missionRevision: contract.missionRevision,
              probeInputDigest: exactEvidenceDigest, criterionId: criterion.id,
              probeId: action.id, runId: stableRunId,
            });
            const reservationRecord = ledgerView.records.find((row) => row.event === "ControlAction" &&
              row.correlationId === correlationId && row.controlAction?.action === "verification-probe-reserved");
            if (reservationRecord === undefined) continue;
            priorProbeConsumed = true;
            const reservation = reservationRecord.controlAction;
            let preProbeSnapshot: Awaited<ReturnType<ReturnType<typeof createSessionMissionClosureSource>["load"]>> | undefined;
            try {
              preProbeSnapshot = await createSessionMissionClosureSource({
                store: args.store, dataDir: args.config.dataDir, now: args.now, ledger: args.ledger,
                enableTrustedGraphEvidence: true, criterionProducerAssociations: associations,
                criterionVerifications: producer.verifications, trustedVerifierIds: ["test-execution"],
                criterionCodeFiles, structuralAnalysisRoot: plan.workspaceRoot, hostProofPlanDigest: plan.planDigest,
                candidateProbeRunToExclude: { runId: stableRunId, nodeId: action.nodeId },
              }).load(sessionId, contract.missionId);
            } catch {
              preProbeSnapshot = undefined;
            }
            if (reservation?.missionId !== contract.missionId ||
                reservation.missionRevision !== contract.missionRevision ||
                preProbeSnapshot === undefined ||
                !/^[0-9a-f]{64}$/.test(reservation.evidenceRevision ?? "") ||
                reservation.candidateDigest !== preProbeSnapshot.candidateDigest ||
                reservation.criterionId !== criterion.id ||
                reservation.requiredOutcome !== `${action.id}:${stableRunId}`) {
              probeFailure = { criterionId: criterion.id, probeId: action.id, runId: stableRunId,
                reason: "probe reservation is stale or does not bind the pre-probe candidate; operator review is required",
                candidateDigest: probeEvidence.candidateDigest, evidenceRevision: probeEvidence.evidenceRevision,
                defectObserved: false };
              break;
            }
            const path = join(args.config.dataDir, "graph-journals", `jeverb-graph-${stableRunId}.jsonl`);
            const prior = journalExists(path) ? reconcileJournal(path) : undefined;
            const probeGraph = approvedProbeGraph(action);
            const node = prior !== undefined && journalMatchesApprovedGraph(prior, stableRunId, sessionId, probeGraph)
              ? prior.nodes.find((row) => row.nodeId === action.nodeId)
              : undefined;
            if (node === undefined || node.status === "pending" || node.status === "outcome_unknown" || node.outputDigest === undefined) {
              probeFailure = { criterionId: criterion.id, probeId: action.id, runId: stableRunId,
                reason: `reserved probe has no safely recoverable terminal observation (${node?.status ?? "missing"})`,
                candidateDigest: probeEvidence.candidateDigest, evidenceRevision: probeEvidence.evidenceRevision, defectObserved: false };
              break;
            }
            if (node.status !== "succeeded" && node.status !== "failed") {
              persistProbeResult({
                ledger: args.ledger, sessionId, missionId: contract.missionId,
                missionRevision: contract.missionRevision, evidenceRevision: probeEvidence.evidenceRevision,
                candidateDigest: probeEvidence.candidateDigest, criterionId: criterion.id, probeId: action.id,
                runId: stableRunId, status: node.status, resultClass: "execution-unresolved",
              });
              probeFailure = { criterionId: criterion.id, probeId: action.id, runId: stableRunId,
                reason: `probe action was ${node.status}; no behavioral result can be inferred`,
                candidateDigest: probeEvidence.candidateDigest, evidenceRevision: probeEvidence.evidenceRevision,
                defectObserved: false };
              break;
            }
            const attemptId = exactSingleAttempt(node.attemptIds, action.nodeId);
            if (attemptId === undefined) {
              probeFailure = { criterionId: criterion.id, probeId: action.id, runId: stableRunId,
                reason: "reserved probe journal does not identify exactly one authorized execution attempt",
                candidateDigest: probeEvidence.candidateDigest, evidenceRevision: probeEvidence.evidenceRevision, defectObserved: false };
              break;
            }
            const recovered = await produceHostVerificationInputs({
              store: args.store, dataDir: args.config.dataDir, sessionId, missionId: contract.missionId,
              ledger: args.ledger, evidenceRoot: plan.workspaceRoot, now: args.now,
              hostProofPlanDigest: plan.planDigest, criterionCodeFiles, structuralAnalysisRoot: plan.workspaceRoot,
              specs: [{ criterionId: criterion.id,
                producers: [{ runId: stableRunId, nodeId: action.nodeId, attemptId }],
                test: { kind: "host-command", command: action.command,
                  exitCode: node.status === "succeeded" ? 0 : 1,
                  outputDigest: node.outputDigest,
                  observedBehavior: `recovered terminal graph observation: ${node.status}; output digest ${node.outputDigest}` },
              }],
            });
            const verification = recovered.verifications[0];
            const resultCorrelation = createHash("sha256").update(JSON.stringify([
              "jeverb-verification-probe-result/1", contract.missionId, contract.missionRevision,
              reservation.evidenceRevision, criterion.id, action.id, stableRunId,
            ]), "utf8").digest("hex");
            const recoveredResult = ledgerView.records.find((row) => row.event === "ControlAction" &&
              row.correlationId === resultCorrelation && row.controlAction?.action === "verification-probe-result" &&
              row.controlAction.missionId === contract.missionId &&
              row.controlAction.missionRevision === contract.missionRevision &&
              row.controlAction.evidenceRevision === reservation.evidenceRevision &&
              row.controlAction.candidateDigest === reservation.candidateDigest &&
              row.controlAction.criterionId === criterion.id);
            const failurePrefix = `${action.id}:${stableRunId}:failed:behavioral-failure:`;
            const failureReceiptId = recoveredResult?.controlAction?.requiredOutcome?.startsWith(failurePrefix) === true
              ? recoveredResult.controlAction.requiredOutcome.slice(failurePrefix.length) : undefined;
            const failureReceipt = failureReceiptId === undefined ? undefined : ledgerView.records.find((row) =>
              row.event === "CriterionVerification" && row.sessionId === sessionId && row.correlationId === failureReceiptId);
            const failureReceiptDurable = failureReceipt !== undefined &&
              failureReceipt.enforcement === "criterion_failed" &&
              failureReceipt.deterministicFindings.includes("verifier=test-execution") &&
              failureReceipt.deterministicFindings.includes("result=failed") &&
              failureReceipt.deterministicFindings.includes(`criterion_hash=${hashSubject(criterion.id)}`) &&
              failureReceipt.deterministicFindings.includes(`candidate=${probeEvidence.candidateDigest!.slice(0, 16)}`) &&
              failureReceipt.deterministicFindings.includes(`evidence_ref=host-command:${action.command}`);
            const resultClass = node.status === "succeeded" && verification?.result === "satisfied" ? "passed" as const
              : failureReceiptDurable
                ? "behavioral-failure" as const : "execution-unresolved" as const;
            const expectedResult = verification === undefined ? undefined
              : `${action.id}:${stableRunId}:${node.status}:${resultClass}:${verification.receiptCorrelationId}`;
            const resultPersisted = recoveredResult === undefined
              ? verification !== undefined && persistProbeResult({
                ledger: args.ledger, sessionId, missionId: contract.missionId,
                missionRevision: contract.missionRevision, evidenceRevision: reservation.evidenceRevision,
                candidateDigest: reservation.candidateDigest!, criterionId: criterion.id, probeId: action.id,
                runId: stableRunId, status: node.status, resultClass,
                verifierReceipt: verification.receiptCorrelationId,
              })
              : recoveredResult.controlAction?.requiredOutcome === expectedResult;
            if (verification === undefined || !resultPersisted) {
              probeFailure = { criterionId: criterion.id, probeId: action.id, runId: stableRunId,
                reason: "recovered probe lacks a durable host-verifier receipt",
                candidateDigest: reservation.candidateDigest!, evidenceRevision: reservation.evidenceRevision, defectObserved: false };
              break;
            }
            supplementalVerifications.push(verification);
            if (node.status !== "succeeded" || verification.result !== "satisfied") {
              probeFailure = { criterionId: criterion.id, probeId: action.id, runId: stableRunId,
                receipt: verification.receiptCorrelationId, reason: `recovered probe status ${node.status}`,
                candidateDigest: reservation.candidateDigest!, evidenceRevision: reservation.evidenceRevision,
                defectObserved: node.status === "failed" && resultClass === "behavioral-failure" };
            }
            break;
          }
          if (priorProbeConsumed) break;
        }
      }
    }
    if (mechanicallyReady && probeEvidence !== undefined && (plan.schema === "jeverb-host-proof-plan/3" || plan.schema === "jeverb-host-proof-plan/4")) {
      if (priorProbeConsumed) {
        // A reserved action is handled above and never selected or replayed.
      } else {
      for (const criterion of contract.criteria) {
        const planned = plan.criteria.find((row) => row.criterionId === criterion.id);
        const criterionEvidence = probeEvidence.criteria.find((row) => row.id === criterion.id);
        const actions = (planned?.probeActions ?? []).filter((action) => action.producers !== undefined && action.producers.length > 0 && action.producers.every((producer) =>
          criterionEvidence?.graphEvidence?.some((row) => row.state === "bound" &&
            row.runId === producer.runId && row.nodeId === producer.nodeId && row.attemptId === producer.attemptId) === true));
        if (actions.length === 0) continue;
        const registry: RegisteredDagLocalProbeAction[] = actions.flatMap((action) => action.producers === undefined ? [] : [{
          id: action.id, description: action.description,
          producerRefs: action.producers.map((producer) => ({ ...producer })),
          command: action.command, sourceReadOnly: true,
        }]);
        let judgment: DagLocalCriterionJudgment | undefined;
        try {
          judgment = await evaluateDagLocalCriterion(args.model, probeEvidence, criterion.id, signal, registry);
        } catch {
          judgment = undefined;
        }
        // A failed/invalid semantic response does not authorize a probe. It
        // is escalated by the existing global closure gate below.
        if (judgment === undefined || judgment.disposition === "SATISFIED") continue;
        const selected = selectDagLocalProbe(judgment, registry);
        if (selected.status !== "selected") continue;
        const action = actions.find((row) => row.id === selected.probe.id);
        if (action === undefined || probeEvidence.candidateDigest === undefined) continue;
        const contextDigest = criterionProbeInputDigest(probeEvidence, criterion.id, plan.planDigest);
        if (contextDigest === undefined) continue;
        const exactEvidenceDigest = createHash("sha256").update(`${contextDigest}\0${action.id}\0${action.commandSha256}`, "utf8").digest("hex");
        const stableRunId = dagLocalProbeRunId(criterion.id, exactEvidenceDigest);
        if (stableRunId === undefined) continue;
        const reservation = await reserveApprovedProbe({
          ledger: args.ledger, sessionId, missionId: contract.missionId,
          missionRevision: contract.missionRevision, evidenceRevision: probeEvidence.evidenceRevision,
          candidateDigest: probeEvidence.candidateDigest, criterionId: criterion.id,
          probeId: action.id, runId: stableRunId, probeInputDigest: exactEvidenceDigest,
          maxExecutions: action.maxExecutions,
        });
        if (reservation === undefined) {
          probeFailure = { criterionId: criterion.id, probeId: action.id, runId: stableRunId,
            reason: "probe execution budget or durable reservation is unavailable", candidateDigest: probeEvidence.candidateDigest,
            evidenceRevision: probeEvidence.evidenceRevision, defectObserved: false };
          break;
        }
        const journalPath = join(args.config.dataDir, "graph-journals", `jeverb-graph-${stableRunId}.jsonl`);
        // A reservation with no journal means the process may have crashed
        // between reservation and dispatch. Do not guess whether side effects
        // happened and do not automatically launch a second copy.
        if (!reservation.created && !journalExists(journalPath)) {
          probeFailure = { criterionId: criterion.id, probeId: action.id, runId: stableRunId,
            reason: "prior probe reservation has no journal; side-effect status is unknown and requires review",
            candidateDigest: probeEvidence.candidateDigest, evidenceRevision: probeEvidence.evidenceRevision, defectObserved: false };
          break;
        }
        let graphOutput: Awaited<ReturnType<(typeof import("../tools/execute-graph-runner.js"))["run"]>> | undefined;
        let dispatchError: string | undefined;
        try {
          const graphTool = args.executeGraph === undefined ? await import("../tools/execute-graph-runner.js") : undefined;
          const executeGraph = args.executeGraph ?? graphTool!.run;
          graphOutput = await executeGraph(null, {
            source: "jeverb-control-service-approved-probe",
            graph: approvedProbeGraph(action),
          }, {
            model: "", thresholds: { auto: 0.9, review: 0.6 }, maxConcurrency: 1,
            dataDir: args.config.dataDir,
            initialRunId: stableRunId,
            museSessionId: sessionId,
            execution: { ...resolveExecutionPolicy(process.env, plan.workspaceRoot, args.config.dataDir), readOnlyWorkspace: true },
          }, signal);
        } catch (error) {
          // The journal remains the only source for recovery. If a node is
          // outcome_unknown, this path never replays it automatically.
          const detail = error instanceof Error ? error.message : String(error);
          dispatchError = redactAndClamp(detail, 240);
        }
        const nodeResult = graphOutput?.results.find((row) => row.nodeId === action.nodeId);
        if (nodeResult === undefined || graphOutput === undefined) {
          const prior = journalExists(journalPath) ? reconcileJournal(journalPath) : undefined;
          const priorNode = prior?.nodes.find((row) => row.nodeId === action.nodeId);
          probeFailure = { criterionId: criterion.id, probeId: action.id, runId: stableRunId,
            reason: `probe did not produce a trusted terminal result (${priorNode?.status ?? "outcome_unknown"})${dispatchError === undefined ? "" : `: ${dispatchError}`}`,
            candidateDigest: probeEvidence.candidateDigest, evidenceRevision: probeEvidence.evidenceRevision, defectObserved: false };
          break;
        }
        if (nodeResult.status !== "succeeded" && nodeResult.status !== "failed") {
          persistProbeResult({
            ledger: args.ledger, sessionId, missionId: contract.missionId,
            missionRevision: contract.missionRevision, evidenceRevision: probeEvidence.evidenceRevision,
            candidateDigest: probeEvidence.candidateDigest, criterionId: criterion.id, probeId: action.id,
            runId: graphOutput.runId, status: nodeResult.status, resultClass: "execution-unresolved",
          });
          probeFailure = { criterionId: criterion.id, probeId: action.id, runId: graphOutput.runId,
            reason: `probe action was ${nodeResult.status}; no behavioral result can be inferred${nodeResult.output.trim() === "" ? "" : `: ${redactAndClamp(nodeResult.output, 240)}`}`,
            candidateDigest: probeEvidence.candidateDigest, evidenceRevision: probeEvidence.evidenceRevision,
            defectObserved: false };
          break;
        }
        const attemptId = nodeResult.attempts === 1 ? `${action.nodeId}/1` : undefined;
        if (attemptId === undefined) {
          probeFailure = { criterionId: criterion.id, probeId: action.id, runId: stableRunId,
            reason: "probe result did not report exactly one authorized execution attempt",
            candidateDigest: probeEvidence.candidateDigest, evidenceRevision: probeEvidence.evidenceRevision, defectObserved: false };
          break;
        }
        const supplemental = await produceHostVerificationInputs({
          store: args.store, dataDir: args.config.dataDir, sessionId, missionId: contract.missionId,
          ledger: args.ledger, evidenceRoot: plan.workspaceRoot, now: args.now,
          hostProofPlanDigest: plan.planDigest, criterionCodeFiles, structuralAnalysisRoot: plan.workspaceRoot,
          specs: [{
            criterionId: criterion.id,
            producers: [{ runId: graphOutput.runId, nodeId: action.nodeId, attemptId }],
            test: {
              kind: "host-command", command: action.command,
              exitCode: nodeResult.status === "succeeded" ? 0 : 1,
              outputDigest: nodeResult.outputDigest,
              observedBehavior: redactAndClamp(nodeResult.output, 200),
            },
          }],
        });
        const verification = supplemental.verifications[0];
        const report = supplemental.reports[0];
        const behavioralFailure = nodeResult.status === "failed" && probeOutputDemonstratesBehavioralFailure(nodeResult.output);
        const resultClass = nodeResult.status === "succeeded" ? "passed" as const
          : behavioralFailure ? "behavioral-failure" as const : "execution-unresolved" as const;
        const durable = verification !== undefined && report?.status === (nodeResult.status === "succeeded" ? "satisfied" : "failed");
        if (!durable || verification === undefined || !persistProbeResult({
          ledger: args.ledger, sessionId, missionId: contract.missionId,
          missionRevision: contract.missionRevision, evidenceRevision: probeEvidence.evidenceRevision,
          candidateDigest: probeEvidence.candidateDigest, criterionId: criterion.id, probeId: action.id,
          runId: graphOutput.runId, status: nodeResult.status, resultClass, verifierReceipt: verification?.receiptCorrelationId,
        })) {
          probeFailure = { criterionId: criterion.id, probeId: action.id, runId: stableRunId,
            reason: "probe outcome lacks a durable host-verifier receipt", candidateDigest: probeEvidence.candidateDigest,
            evidenceRevision: probeEvidence.evidenceRevision, defectObserved: false };
          break;
        }
        supplementalVerifications.push(verification);
        if (nodeResult.status !== "succeeded" || verification.result !== "satisfied") {
          probeFailure = { criterionId: criterion.id, probeId: action.id, runId: graphOutput.runId,
            receipt: verification.receiptCorrelationId,
            reason: redactAndClamp(nodeResult.output, 240) || `probe status ${nodeResult.status}`,
            candidateDigest: probeEvidence.candidateDigest, evidenceRevision: probeEvidence.evidenceRevision,
            defectObserved: behavioralFailure };
        }
        // One probe per evidence revision. The next invocation sees the
        // durable receipt and any remaining obligations after reconciliation.
        break;
      }
      }
    }
    if (probeFailure !== undefined) {
      const failedCriterion = contract.criteria.find((criterion) => criterion.id === probeFailure!.criterionId);
      const failedNodeId = plan.criteria.find((criterion) => criterion.criterionId === probeFailure!.criterionId)
        ?.probeActions?.find((action) => action.id === probeFailure!.probeId)?.nodeId;
      const taskEvidenceRefs = [
        `approved-probe:${probeFailure.probeId}`,
        ...(probeFailure.runId === "" || !journalExists(join(args.config.dataDir, "graph-journals", `jeverb-graph-${probeFailure.runId}.jsonl`))
          ? [] : [`graph-run:${probeFailure.runId}`]),
        ...(failedNodeId === undefined || probeFailure.runId === "" ||
            !journalExists(join(args.config.dataDir, "graph-journals", `jeverb-graph-${probeFailure.runId}.jsonl`))
          ? [] : [`graph-node:${failedNodeId}`]),
        ...(probeFailure.receipt === undefined ? [] : [`verifier-receipt:${probeFailure.receipt}`]),
      ];
      let repairObligationReceipt: string | undefined;
      if (probeFailure.defectObserved && failedCriterion !== undefined && probeFailure.receipt !== undefined) {
        const repairObligation = await persistProbeRepairObligation({
          ledger: args.ledger, sessionId, missionId: contract.missionId,
          missionRevision: contract.missionRevision, evidenceRevision: probeFailure.evidenceRevision,
          candidateDigest: probeFailure.candidateDigest, criterionId: probeFailure.criterionId,
          probeId: probeFailure.probeId, runId: probeFailure.runId,
          requirement: failedCriterion.statement, verifierReceipt: probeFailure.receipt,
          evidenceRefs: taskEvidenceRefs,
        });
        repairObligationReceipt = repairObligation.receipt;
        if (repairObligationReceipt === undefined) {
          probeFailure = { ...probeFailure, defectObserved: false,
            reason: repairObligation.budgetExhausted
              ? "behavioral failure was observed, but the one-repair-per-criterion budget is exhausted; operator review is required"
              : "behavioral failure was observed but the durable repair obligation could not be recorded; operator review is required" };
        }
      }
      // Schema v4 may carry one exact repair command approved with this host
      // proof plan. It is the only path that dispatches a repair automatically;
      // otherwise the existing Stop handoff remains advisory and bounded.
      if (probeFailure.defectObserved && repairObligationReceipt !== undefined && plan.schema === "jeverb-host-proof-plan/4") {
        const planned = plan.criteria.find((row) => row.criterionId === probeFailure!.criterionId);
        const repair = planned?.repairActions?.[0];
        const currentCriterion = probeEvidence?.criteria.find((row) => row.id === probeFailure!.criterionId);
        const exactRepairProducers = repair?.producers.every((producerRef) => currentCriterion?.graphEvidence?.some((row) =>
          row.state === "bound" && row.runId === producerRef.runId && row.nodeId === producerRef.nodeId &&
          row.attemptId === producerRef.attemptId) === true) === true;
        if (repair !== undefined && exactRepairProducers && probeEvidence?.candidateDigest !== undefined) {
          const repairInputDigest = createHash("sha256").update(JSON.stringify({
            planDigest: plan.planDigest, missionRevision: contract.missionRevision,
            criterionId: probeFailure.criterionId, requirement: failedCriterion?.statement,
            probeRunId: probeFailure.runId, probeReceipt: probeFailure.receipt,
            repairId: repair.id, repairCommandSha256: repair.commandSha256,
            testCommandSha256: planned?.testCommandSha256,
          }), "utf8").digest("hex");
          const repairRunId = dagLocalProbeRunId(probeFailure.criterionId, repairInputDigest);
          if (repairRunId !== undefined) {
            const reservation = await reserveApprovedRepair({
              ledger: args.ledger, sessionId, missionId: contract.missionId,
              missionRevision: contract.missionRevision, evidenceRevision: probeFailure.evidenceRevision,
              candidateDigest: probeEvidence.candidateDigest, criterionId: probeFailure.criterionId,
              repairId: repair.id, runId: repairRunId, inputDigest: repairInputDigest,
            });
            const journalPath = join(args.config.dataDir, "graph-journals", `jeverb-graph-${repairRunId}.jsonl`);
            if (reservation !== undefined && (reservation.created || journalExists(journalPath))) {
              let repairGraph: Awaited<ReturnType<(typeof import("../tools/execute-graph-runner.js"))["run"]>> | undefined;
              let repairError: string | undefined;
              const postRepairProbe = planned?.probeActions?.find((action) => action.id === probeFailure!.probeId);
              const postRepairProbeCommand = postRepairProbe?.command;
              const repairGraphDefinition = postRepairProbe === undefined ? undefined : approvedRepairGraph({
                plan, criterionId: probeFailure.criterionId, repairId: repair.id, probeId: postRepairProbe.id,
              });
              const verificationNodes = new Map(plan.criteria.map((entry) => [entry.criterionId,
                `verify-${createHash("sha256").update(entry.criterionId, "utf8").digest("hex").slice(0, 16)}`]));
              const postRepairProbeNode = `probe-${createHash("sha256").update(repair.id, "utf8").digest("hex").slice(0, 16)}`;
              const generatedNodeIds = [repair.nodeId, ...verificationNodes.values(), postRepairProbeNode];
              const declaredNodeIds = new Set(plan.criteria.flatMap((entry) => [
                ...entry.producers.map((producerRef) => producerRef.nodeId),
                ...(entry.probeActions ?? []).map((action) => action.nodeId),
                ...(entry.repairActions ?? []).map((action) => action.nodeId),
              ]));
              try {
                if (postRepairProbeCommand === undefined || repairGraphDefinition === undefined ||
                    new Set(generatedNodeIds).size !== generatedNodeIds.length ||
                    generatedNodeIds.some((nodeId) => !/^[A-Za-z0-9_.-]{1,128}$/.test(nodeId)) ||
                    generatedNodeIds.slice(1).some((nodeId) => declaredNodeIds.has(nodeId))) {
                  throw new Error("approved repair lacks a unique, bounded post-repair verification plan");
                }
                const graphTool = args.executeGraph === undefined ? await import("../tools/execute-graph-runner.js") : undefined;
                const executeGraph = args.executeGraph ?? graphTool!.run;
                repairGraph = await executeGraph(null, {
                  source: "jeverb-control-service-approved-repair",
                  graph: repairGraphDefinition,
                }, {
                  model: "", thresholds: { auto: 0.9, review: 0.6 }, maxConcurrency: 1,
                  dataDir: args.config.dataDir, initialRunId: repairRunId, museSessionId: sessionId,
                  execution: { ...resolveExecutionPolicy(process.env, plan.workspaceRoot, args.config.dataDir), readOnlyWorkspace: false },
                }, signal);
              } catch (error) {
                repairError = redactAndClamp(error instanceof Error ? error.message : String(error), 240);
              }
              const journal = journalExists(journalPath) ? reconcileJournal(journalPath) : undefined;
              const liveGraphMatches = repairGraph !== undefined && repairGraph.runId === repairRunId &&
                repairGraphDefinition !== undefined && repairGraph.graphHash === graphHash(repairGraphDefinition);
              const journalGraphMatches = repairGraph === undefined && journal !== undefined &&
                repairGraphDefinition !== undefined && journalMatchesApprovedGraph(journal, repairRunId, sessionId, repairGraphDefinition);
              const repairNode = liveGraphMatches
                ? repairGraph?.results.find((row) => row.nodeId === repair.nodeId)
                : journalGraphMatches ? journal?.nodes.find((row) => row.nodeId === repair.nodeId) : undefined;
              const terminalNodes = [...verificationNodes.values(), postRepairProbeNode].map((nodeId) =>
                liveGraphMatches ? repairGraph?.results.find((row) => row.nodeId === nodeId)
                  : journalGraphMatches ? journal?.nodes.find((row) => row.nodeId === nodeId) : undefined);
              const terminal = repairNode?.status === "succeeded" && terminalNodes.length === plan.criteria.length + 1 &&
                terminalNodes.every((node) => node?.status === "succeeded" && node.outputDigest !== undefined &&
                  ("attemptIds" in node ? exactSingleAttempt(node.attemptIds, node.nodeId) !== undefined : node.attempts === 1)) &&
                (repairNode !== undefined && ("attemptIds" in repairNode
                  ? exactSingleAttempt(repairNode.attemptIds, repair.nodeId) !== undefined : repairNode.attempts === 1));
              const probeVerificationNode = liveGraphMatches
                ? repairGraph?.results.find((row) => row.nodeId === postRepairProbeNode)
                : journalGraphMatches ? journal?.nodes.find((row) => row.nodeId === postRepairProbeNode) : undefined;
              if (terminal && probeVerificationNode !== undefined) {
                try {
                  repairedProducer = await produceHostVerificationInputs({
                    store: args.store, dataDir: args.config.dataDir, sessionId, missionId: contract.missionId,
                    ledger: args.ledger, evidenceRoot: plan.workspaceRoot, now: args.now,
                    hostProofPlanDigest: plan.planDigest, criterionCodeFiles, structuralAnalysisRoot: plan.workspaceRoot,
                    specs: plan.criteria.map((entry) => {
                      const nodeId = verificationNodes.get(entry.criterionId)!;
                      const node = repairGraph?.results.find((row) => row.nodeId === nodeId) ?? journal?.nodes.find((row) => row.nodeId === nodeId);
                      if (node === undefined || node.outputDigest === undefined) throw new Error(`post-repair verifier evidence missing for ${entry.criterionId}`);
                      const attemptId = "attemptIds" in node
                        ? exactSingleAttempt(node.attemptIds, nodeId)
                        : node.attempts === 1 ? `${nodeId}/1` : undefined;
                      if (attemptId === undefined) throw new Error(`post-repair verifier attempt identity is invalid for ${entry.criterionId}`);
                      return { criterionId: entry.criterionId,
                        producers: [{ runId: repairRunId, nodeId, attemptId }],
                        test: { kind: "host-command" as const,
                          command: entry.testCommand!, exitCode: 0,
                          outputDigest: node.outputDigest,
                          observedBehavior: "approved criterion test command exited successfully after repair" } };
                    }),
                  });
                  associations = repairedProducer.associations;
                  producer = repairedProducer;
                  const repairedCheck = repairedProducer.reports.find((row) => row.criterionId === probeFailure!.criterionId);
                  const repairedVerifier = repairedProducer.verifications.find((row) =>
                    row.criterionId === probeFailure!.criterionId && row.result === "satisfied" && /^[0-9a-f]{64}$/.test(row.receiptCorrelationId));
                  const probeAttempt = "attemptIds" in probeVerificationNode
                    ? exactSingleAttempt(probeVerificationNode.attemptIds, postRepairProbeNode)
                    : probeVerificationNode.attempts === 1 ? `${postRepairProbeNode}/1` : undefined;
                  if (probeAttempt === undefined) throw new Error("post-repair probe attempt identity is invalid");
                  const repairedProbe = await produceHostVerificationInputs({
                    store: args.store, dataDir: args.config.dataDir, sessionId, missionId: contract.missionId,
                    ledger: args.ledger, evidenceRoot: plan.workspaceRoot, now: args.now,
                    hostProofPlanDigest: plan.planDigest, criterionCodeFiles, structuralAnalysisRoot: plan.workspaceRoot,
                    specs: [{ criterionId: probeFailure.criterionId,
                      producers: [{ runId: repairRunId, nodeId: postRepairProbeNode, attemptId: probeAttempt }],
                      test: { kind: "host-command", command: postRepairProbeCommand!, exitCode: 0,
                        outputDigest: probeVerificationNode.outputDigest!,
                        observedBehavior: "approved targeted supplemental probe exited successfully after repair" } }],
                  });
                  const repairedProbeVerifier = repairedProbe.verifications[0];
                  if (repairedCheck?.status === "satisfied" && repairedProducer.reports.every((row) => row.status === "satisfied") &&
                      repairedProducer.verifications.length === plan.criteria.length && repairedProducer.verifications.every((row) => row.result === "satisfied") &&
                      repairedVerifier !== undefined && repairedProbe.reports[0]?.status === "satisfied" &&
                      repairedProbeVerifier?.result === "satisfied" && /^[0-9a-f]{64}$/.test(repairedProbeVerifier.receiptCorrelationId)) {
                    supplementalVerifications.push(repairedProbeVerifier);
                    const repairedSnapshot = await createSessionMissionClosureSource({
                      store: args.store, dataDir: args.config.dataDir, now: args.now, ledger: args.ledger,
                      enableTrustedGraphEvidence: true, criterionProducerAssociations: associations,
                      criterionVerifications: repairedProducer.verifications, trustedVerifierIds: ["test-execution"],
                      criterionSupplementalVerifications: supplementalVerifications,
                      criterionCodeFiles, structuralAnalysisRoot: plan.workspaceRoot, hostProofPlanDigest: plan.planDigest,
                    }).load(sessionId, contract.missionId);
                    const repairedCriterion = repairedSnapshot.criteria.find((row) => row.id === probeFailure!.criterionId);
                    if (repairedSnapshot.candidateDigest === undefined || repairedCriterion?.criterionVerification?.result !== "satisfied") {
                      throw new Error("the repaired candidate does not have a current trusted verifier binding");
                    }
                    const resultCorrelation = createHash("sha256").update(JSON.stringify([
                      "jeverb-approved-repair-result/1", contract.missionId, contract.missionRevision,
                      probeFailure.criterionId, repair.id, repairRunId, probeVerificationNode.outputDigest,
                      repairedSnapshot.candidateDigest,
                    ]), "utf8").digest("hex");
                    const resultRecord: EvidenceRecord = {
                      schema: 1, id: "", ts: new Date().toISOString(), sessionId,
                      decisionId: resultCorrelation.slice(0, 32), correlationId: resultCorrelation, event: "ControlAction",
                      subjectHash: hashSubject(`${contract.missionId}\n${contract.missionRevision}\n${probeFailure.criterionId}\n${repair.id}`),
                      policyVersion: "mission-repair/1", deterministicFindings: [], enforcement: "mission_not_complete",
                      reasons: ["approved repair graph action and dependent host verification completed"], latencyMs: 0,
                      controlAction: { missionId: contract.missionId, missionRevision: contract.missionRevision,
                        evidenceRevision: repairedSnapshot.evidenceRevision, candidateDigest: repairedSnapshot.candidateDigest,
                        action: "verification-repair-result", criterionId: probeFailure.criterionId,
                        requiredOutcome: `${repair.id}:${repairRunId}:${probeVerificationNode.outputDigest}`,
                        maxAttempts: 1, attempt: 1, evidenceRefs: [...taskEvidenceRefs,
                          `repair-obligation:${repairObligationReceipt}`, `graph-run:${repairRunId}`,
                          `graph-node:${repair.nodeId}`, ...[...verificationNodes.values()].map((nodeId) => `graph-node:${nodeId}`),
                          `graph-node:${postRepairProbeNode}`,
                          ...repairedProducer.verifications.map((verification) => `verifier-receipt:${verification.receiptCorrelationId}`),
                          `verifier-receipt:${repairedProbeVerifier.receiptCorrelationId}`] },
                    };
                    const appended = args.ledger.appendDetailed(resultRecord, { durable: true });
                    const resultReadback = args.ledger.read();
                    if (appended.ok && resultReadback.corrupt === undefined &&
                        resultReadback.records.some((record) => record.event === "ControlAction" && record.correlationId === resultCorrelation)) {
                      probeFailure = undefined;
                    } else {
                      probeFailure = { ...probeFailure!, defectObserved: false,
                        reason: "repair and verification passed, but the durable repair result could not be read back; operator review is required" };
                    }
                  } else {
                    probeFailure = { ...probeFailure!, defectObserved: false,
                      reason: `the approved repair ran, but its primary tests or supplemental probe did not pass or persist${repairedCheck === undefined ? "" : ` (${repairedCheck.status})`}` };
                  }
                } catch (error) {
                  probeFailure = { ...probeFailure!, defectObserved: false,
                    reason: `the repair graph ran but host verification could not be durably recorded${error instanceof Error ? `: ${redactAndClamp(error.message, 160)}` : ""}` };
                }
              } else {
                const missingJournal = !journalExists(journalPath);
                const repairObservation = repairNode !== undefined && "output" in repairNode ? repairNode.output : undefined;
                probeFailure = { ...probeFailure!, defectObserved: false,
                  reason: missingJournal && !reservation.created
                    ? "repair reservation has no journal; side-effect status is unknown and requires operator review"
                    : `approved repair or its dependent verification is not safely complete (${repairNode?.status ?? "missing"}/${terminalNodes.map((node) => node?.status ?? "missing").join(",")})${repairError === undefined ? "" : `: ${repairError}`}${repairObservation === undefined || repairObservation.trim() === "" ? "" : `; repair observation: ${redactAndClamp(repairObservation, 120)}`}` };
              }
            } else {
              probeFailure = { ...probeFailure!, defectObserved: false,
                reason: "approved repair budget or durable reservation is unavailable; operator review is required" };
            }
          }
        }
      }
      if (probeFailure === undefined) {
        // The bounded repair and its exact verifier succeeded. Continue the
        // ordinary deterministic closure path with the new host receipt.
      } else {
      const task = {
        criterionId: probeFailure.criterionId,
        finding: probeFailure.defectObserved
          ? `host probe ${probeFailure.probeId} failed while checking the original requirement "${failedCriterion?.statement ?? probeFailure.criterionId}": ${probeFailure.reason}`
          : `probe ${probeFailure.probeId} requires escalation for original requirement "${failedCriterion?.statement ?? probeFailure.criterionId}": ${probeFailure.reason}`,
        requiredEvidence: probeFailure.defectObserved
          ? `repair only criterion ${probeFailure.criterionId}; rerun its approved verification and probe${failedNodeId === undefined ? "" : ` graph node ${failedNodeId}`} after changing the candidate`
          : `resolve the probe evidence, recovery, or durable-provenance state for criterion ${probeFailure.criterionId}; do not assume the implementation is defective`,
        evidenceRevision: probeFailure.evidenceRevision,
        defectKind: probeFailure.defectObserved ? "contradiction" as const : "unresolved-requirement" as const,
        evidenceRefs: [...taskEvidenceRefs, ...(repairObligationReceipt === undefined ? [] : [`repair-obligation:${repairObligationReceipt}`])],
        baseCandidateDigest: probeFailure.candidateDigest,
        maxAttempts: 1,
      };
      const basis = probeEvidence ?? await probeSource.load(sessionId, contract.missionId);
      const decision = {
        ...preflightMissionClosure(basis, args.config.missionClosurePolicy),
        status: probeFailure.defectObserved ? "INCOMPLETE" as const : "INSUFFICIENT_EVIDENCE" as const,
        complete: false,
        repairTask: task,
        reasons: [`approved probe ${probeFailure.probeId} did not establish the required behavior: ${probeFailure.reason}`, `repair task bound to ${probeFailure.criterionId} and ${probeFailure.runId}`],
      };
      const receipt = persistMissionClosureReceipt(args.ledger, sessionId, decision);
      return { decision, receipt, terminalComplete: false };
      }
    }
    if (repairedProducer !== undefined) {
      // The approved verification node already ran after the repair and its
      // host receipt is bound to the updated candidate.
      producer = repairedProducer;
      associations = repairedProducer.associations;
      // The source candidate changed during the repair graph, so the earlier
      // operator attestation cannot cover it. Refresh against the settled
      // candidate before the final closure gate.
      try {
        const entries = await readAttestations(contract.missionId, 250);
        if (entries.length > 0) {
          args.store.updateSession(sessionId, (state) => {
            const current = state.mission_contract as MissionContract | undefined;
            if (current === undefined || current.missionId !== contract.missionId) return state;
            const merged = mergeServiceAttestations(current, entries);
            return merged === undefined ? state : { ...state, mission_contract: merged };
          }, args.now());
        }
      } catch {
        // An unavailable or stale service attestation remains a hard blocker.
      }
    } else if (supplementalVerifications.length > 0) {
      // A graph probe changes the execution evidence and therefore the
      // candidate identity. Rebind the ordinary host test observations to
      // that settled graph revision before deterministic closure; otherwise
      // the pre-probe receipts are correctly stale and completion stays
      // blocked forever after a successful investigation.
      try {
        producer = await produceHostVerificationInputs({
          store: args.store, dataDir: args.config.dataDir, sessionId,
          missionId: contract.missionId, ledger: args.ledger, evidenceRoot: plan.workspaceRoot,
          now: args.now, hostProofPlanDigest: plan.planDigest, criterionCodeFiles,
          structuralAnalysisRoot: plan.workspaceRoot,
          specs: plan.criteria.map((criterion) => ({
            criterionId: criterion.criterionId,
            producers: criterion.producers,
            test: { kind: "validated-runner-record" as const,
              expectedCommandSha256: criterion.testCommandSha256, expectedCwd: plan.workspaceRoot },
          })),
        });
        associations = producer.associations;
      } catch {
        // The new snapshot has no current verification. The normal
        // deterministic closure path will expose the missing evidence.
      }
      // Probe journaling also advances the candidate revision. Refresh the
      // service-owned attestation for that exact final graph/candidate; a
      // previously issued receipt remains stale and cannot authorize it.
      try {
        const entries = await readAttestations(contract.missionId, 250);
        if (entries.length > 0) {
          args.store.updateSession(sessionId, (state) => {
            const current = state.mission_contract as MissionContract | undefined;
            if (current === undefined || current.missionId !== contract.missionId) return state;
            const merged = mergeServiceAttestations(current, entries);
            return merged === undefined ? state : { ...state, mission_contract: merged };
          }, args.now());
        }
      } catch {
        // Missing or stale operator evidence remains a deterministic blocker.
      }
    }
    const plannedRunner = createSessionMissionClosureRunner({
      model: args.model,
      config: args.config,
      store: args.store,
      ledger: args.ledger,
      now: args.now,
      ...(args.adversarial === undefined ? {} : { adversarial: args.adversarial }),
      enableTrustedGraphEvidence: true,
      criterionProducerAssociations: associations,
      criterionVerifications: producer.verifications,
      criterionSupplementalVerifications: supplementalVerifications,
      trustedVerifierIds: ["test-execution"],
      criterionCodeFiles,
      structuralAnalysisRoot: plan.workspaceRoot,
      hostProofPlanDigest: plan.planDigest,
    });
    const plannedResult = await plannedRunner(sessionId, signal, context);
    return plannedResult;
  };
}

const HEX64_DIGEST = /^[0-9a-f]{64}$/;

/**
 * Host-observed test outcome for one criterion.
 *
 * There is deliberately no `passed: boolean` field: the verdict derives
 * inside the producer from host-observed evidence, so an agent cannot
 * supply `passed: true` through this channel.
 *
 * - `host-command`: the host invoked the suite itself against real state
 *   and observed the process exit. `passed` is `exitCode === 0`; the
 *   output digest binds the actually captured run.
 * - `validated-runner-record`: the host reads its own validated runner
 *   record — the session verification entry its hooks wrote after running
 *   the suite (`last.kind === "test"` with `edits_since === 0`, so the
 *   record covers the current state). A stale record (edits since the run)
 *   or a missing record abstains: the producer emits no verdict and the
 *   criterion stays `unresolved`, never satisfied.
 */
export type HostTestEvidence =
  | {
      kind: "host-command";
      /** Host-invoked command identity (evidence, never executed here). */
      command: string;
      /** Host-observed process exit code. */
      exitCode: number;
      /** 64-hex digest of the captured output the host actually observed. */
      outputDigest: string;
      /** Optional bounded behavior summary parsed by the host from the command output/artifact; never a proof claim. */
      observedBehavior?: string;
    }
  | {
      kind: "validated-runner-record";
      /** Approved plans bind the persisted host result to this exact command and workspace. */
      expectedCommandSha256?: string;
      expectedCwd?: string;
    };

/**
 * Host-declared verification spec for one acceptance criterion.
 *
 * Exactly one of `test`, `artifact`, `files`, or `tree` must be present, so
 * one criterion yields one verdict from one allowlisted verifier — never an
 * ambiguous duplicate pair. `producers` names the explicit
 * criterion→producer-node associations; they pass through to the trusted
 * path unchanged (traceability lineage, independent of the verdict).
 * `evidenceRoot` overrides the file/tree observation root for this
 * criterion; it defaults to the producer-level `evidenceRoot`.
 */
export interface HostProducerCriterionSpec {
  criterionId: string;
  producers: Array<{ runId: string; nodeId: string; attemptId?: string }>;
  test?: HostTestEvidence;
  artifact?: { path: string; expectedDigest: string };
  files?: Array<{ path: string; expectedDigest: string }>;
  tree?: { expected: Record<string, string> };
  evidenceRoot?: string;
}

export interface ProduceHostVerificationInputsArgs {
  store: Store;
  dataDir: string;
  sessionId: string;
  missionId: string;
  ledger: EvidenceLedger;
  /** Explicit host-declared per-criterion specs (host-constructed, never agent/MCP/user text). */
  specs: HostProducerCriterionSpec[];
  /** Host-controlled observation root (a real temp dir in tests, the supervised workspace in production). */
  evidenceRoot: string;
  now?: () => number;
  /** Filesystem seam for observation reads; defaults to real disk reads. */
  fs?: VerifierFs;
  /** Plan identity is included in candidate identity and source provenance. */
  hostProofPlanDigest?: string;
  criterionCodeFiles?: Array<{ criterionId: string; files: string[] }>;
  structuralAnalysisRoot?: string;
}

export interface HostProducerCriterionReport {
  criterionId: string;
  status: "satisfied" | "failed" | "unobserved" | "rejected";
  verifierId?: string;
  correlationId?: string;
  detail: string;
}

export interface HostProducerResult {
  /** Explicit associations to supply as `criterionProducerAssociations` (deterministic order, deduplicated). */
  associations: CriterionProducerAssociation[];
  /** Durably persisted verdicts to supply as `criterionVerifications`. */
  verifications: MissionCriterionVerification[];
  /** Per-criterion outcome of the producer run. */
  reports: HostProducerCriterionReport[];
}

/** Minimal structural view of the host-written session verification ledger. */
interface HostVerificationRecordView {
  kind?: unknown;
  ok?: unknown;
  ts?: unknown;
  command?: unknown;
  cwd?: unknown;
}

interface HostVerificationLedgerView {
  last?: HostVerificationRecordView;
  byKind?: Record<string, HostVerificationRecordView | undefined>;
  edits_since?: unknown;
  editsSinceByKind?: Record<string, unknown>;
}

function readHostTestRecord(
  session: { verification?: HostVerificationLedgerView },
  expected?: { commandSha256: string; cwd: string },
):
  | { ok: boolean; evidenceRef: string }
  | { stale: true }
  | undefined {
  const ledger = session.verification;
  if (ledger === undefined) return undefined;
  const perKind = ledger.byKind?.["test"];
  let record: HostVerificationRecordView | undefined;
  let editsSince: unknown;
  if (perKind !== undefined) {
    record = perKind;
    const byKind = ledger.editsSinceByKind?.["test"];
    editsSince = typeof byKind === "number" ? byKind : ledger.edits_since;
  } else if (ledger.last?.kind === "test") {
    record = ledger.last;
    editsSince = ledger.edits_since;
  } else {
    return undefined;
  }
  if (typeof editsSince !== "number" || editsSince !== 0) return { stale: true };
  if (typeof record?.ok !== "boolean") return undefined;
  const command = typeof record.command === "string" && record.command !== "" ? record.command : "host-suite";
  if (expected !== undefined && (
    createHash("sha256").update(command, "utf8").digest("hex") !== expected.commandSha256 || record.cwd !== expected.cwd
  )) return { stale: true };
  return { ok: record.ok, evidenceRef: `host-record:test:${String(record.ts ?? "unknown")}:${command}` };
}

/**
 * Host-owned verification producer for the trusted-evidence path.
 *
 * Reads the authoritative mission contract plus a disabled-profile probe
 * snapshot (contract revision, current candidate digest — never agent
 * text), establishes the explicit criterion→producer-node associations,
 * collects observations by invoking the real verifier adapters host-side
 * against real state, binds every verdict to the current mission revision
 * and candidate, persists each verifier receipt and reads it back, and
 * returns associations+verdicts ready for
 * `createSessionMissionClosureRunner({ enableTrustedGraphEvidence: true,
 * ...produced, trustedVerifierIds })`.
 *
 * Fail-closed behavior, per criterion:
 * - unknown criterion (not in the current contract): `rejected`, no
 *   association, no verdict. A rotated contract never inherits verdicts.
 * - adapter abstains (unreadable input, no authorized reader, stale or
 *   missing host test record): `unobserved`, no verdict — the criterion
 *   stays `unresolved` downstream, never satisfied.
 * - observed negative (failing tests, absent/mismatched artifact, diverged
 *   tree): a `failed` finding is persisted and returned, never silence.
 * - receipt that will not persist, or is absent on read-back: `rejected`,
 *   verdict withheld — phantom receipts never reach the runner.
 *
 * Stale, foreign, conflicting, and untrusted inputs are rejected
 * downstream by `validateCriterionVerifications` /
 * `resolveCriterionGraphBindings` (revision/candidate binding, session
 * scoping, single-identity counting, allowlist gating); this producer
 * never guesses lineage or verdicts to work around them. In particular an
 * execution-observed row (succeeded node, terminal receipt) is never
 * converted into a verified outcome here: only adapter findings become
 * verdicts, and findings carry no `outcome` field at all.
 */
export async function produceHostVerificationInputs(args: ProduceHostVerificationInputsArgs): Promise<HostProducerResult> {
  if (args.sessionId.trim() === "" || args.missionId.trim() === "") {
    throw new Error("host producer requires session and mission identity");
  }
  if (!Array.isArray(args.specs)) throw new Error("host producer specs must be an array");
  if (typeof args.evidenceRoot !== "string" || args.evidenceRoot === "") {
    throw new Error("host producer requires an evidence root");
  }
  const now = args.now ?? (() => Date.now());
  const nowMs = now();
  if (!Number.isFinite(nowMs)) throw new Error("host producer now is not finite");

  const session = args.store.readSession(args.sessionId);
  const contract = session.mission_contract;
  if (contract === undefined || contract.missionId !== args.missionId) {
    throw new Error("host producer: mission contract is missing or mismatched");
  }
  // Disabled-profile probe: contract revision + current candidate digest +
  // graph history, bit-identical to the historical snapshot (no trusted keys,
  // no ledger, no new I/O beyond journal reads).
  const probe = await createSessionMissionClosureSource({
    store: args.store,
    dataDir: args.dataDir,
    now: () => nowMs,
    ...(args.hostProofPlanDigest === undefined ? {} : { hostProofPlanDigest: args.hostProofPlanDigest }),
    ...(args.criterionCodeFiles === undefined ? {} : { criterionCodeFiles: args.criterionCodeFiles }),
    ...(args.structuralAnalysisRoot === undefined ? {} : { structuralAnalysisRoot: args.structuralAnalysisRoot }),
  }).load(args.sessionId, args.missionId);
  const missionRevision = contract.missionRevision;
  const candidateDigest = probe.candidateDigest;
  if (candidateDigest === undefined || !HEX64_DIGEST.test(candidateDigest)) {
    throw new Error("host producer: probe snapshot has no candidate digest");
  }

  const validCriteria = new Set(contract.criteria.map((criterion) => criterion.id));

  const associations: CriterionProducerAssociation[] = [];
  const seenAssociations = new Set<string>();
  const verifications: MissionCriterionVerification[] = [];
  const reports: HostProducerCriterionReport[] = [];

  for (const spec of args.specs) {
    const criterionId = spec?.criterionId;
    if (typeof criterionId !== "string" || !validCriteria.has(criterionId)) {
      reports.push({
        criterionId: typeof criterionId === "string" ? criterionId : "",
        status: "rejected",
        detail: "criterion is not in the current mission contract; no association, no verdict",
      });
      continue;
    }
    for (const producer of Array.isArray(spec.producers) ? spec.producers : []) {
      if (
        typeof producer?.runId !== "string" || producer.runId.trim() === "" ||
        typeof producer?.nodeId !== "string" || producer.nodeId.trim() === ""
      ) {
        continue;
      }
      if (producer.attemptId !== undefined && (typeof producer.attemptId !== "string" || producer.attemptId.trim() === "")) {
        continue;
      }
      const key = [criterionId, producer.runId, producer.nodeId, producer.attemptId ?? ""].join("\0");
      if (seenAssociations.has(key)) continue;
      seenAssociations.add(key);
      associations.push({
        criterionId,
        runId: producer.runId,
        nodeId: producer.nodeId,
        ...(producer.attemptId === undefined ? {} : { attemptId: producer.attemptId }),
      });
    }

    const observationKinds = [
      spec.test !== undefined,
      spec.artifact !== undefined,
      spec.files !== undefined,
      spec.tree !== undefined,
    ].filter(Boolean).length;
    if (observationKinds > 1) {
      throw new Error(
        `host producer spec for ${criterionId} declares ${observationKinds} observation kinds; exactly one is allowed so one criterion yields one verdict`,
      );
    }
    if (observationKinds === 0) {
      reports.push({
        criterionId,
        status: "unobserved",
        detail: "no host observation declared for this criterion; no verdict",
      });
      continue;
    }

    const graphNodes = associations
      .filter((association) => association.criterionId === criterionId)
      .map((association) => ({
        runId: association.runId,
        nodeId: association.nodeId,
        ...(association.attemptId === undefined ? {} : { attemptId: association.attemptId }),
      }));
    const root = spec.evidenceRoot ?? args.evidenceRoot;
    let finding: VerifierFinding | undefined;
    let verifierId = "";
    if (spec.test !== undefined) {
      verifierId = "test-execution";
      if (spec.test.kind === "host-command") {
        if (typeof spec.test.command !== "string" || spec.test.command.trim() === "") {
          throw new Error(`host producer spec for ${criterionId} names no host command`);
        }
        if (!Number.isSafeInteger(spec.test.exitCode)) {
          throw new Error(`host producer spec for ${criterionId} has a non-integer host exit code`);
        }
        if (typeof spec.test.outputDigest !== "string" || !HEX64_DIGEST.test(spec.test.outputDigest)) {
          throw new Error(`host producer spec for ${criterionId} has no 64-hex host output digest`);
        }
        finding = verifyTestExecution({
          criterionId,
          missionRevision,
          candidateDigest,
          graphNodes,
          evidenceRef: `host-command:${spec.test.command}`,
          passed: spec.test.exitCode === 0,
          verifiedAt: nowMs,
        });
        if (spec.test.observedBehavior !== undefined) {
          finding.observedResult = redactAndClamp(`host-observed behavior (untrusted observation): ${spec.test.observedBehavior}`, 200);
        }
      } else if (spec.test.kind === "validated-runner-record") {
        const record = readHostTestRecord(session, spec.test.expectedCommandSha256 === undefined && spec.test.expectedCwd === undefined
          ? undefined
          : {
              commandSha256: spec.test.expectedCommandSha256 ?? "",
              cwd: spec.test.expectedCwd ?? "",
            });
        if (record === undefined || "stale" in record) {
          reports.push({
            criterionId,
            status: "unobserved",
            verifierId,
            detail: record === undefined
              ? "no host test record covers this state; no verdict"
              : "host test record is stale for the current state; no verdict",
          });
          continue;
        }
        finding = verifyTestExecution({
          criterionId,
          missionRevision,
          candidateDigest,
          graphNodes,
          evidenceRef: record.evidenceRef,
          passed: record.ok,
          verifiedAt: nowMs,
        });
      } else {
        throw new Error(`host producer spec for ${criterionId} names an unknown test evidence kind`);
      }
    } else if (spec.artifact !== undefined) {
      verifierId = "build-artifact";
      finding = verifyBuildArtifact({
        criterionId,
        missionRevision,
        candidateDigest,
        graphNodes,
        path: spec.artifact.path,
        expectedDigest: spec.artifact.expectedDigest,
        root,
        ...(args.fs === undefined ? {} : { fs: args.fs }),
        verifiedAt: nowMs,
      });
    } else if (spec.files !== undefined) {
      verifierId = "file-state";
      finding = verifyFileState({
        criterionId,
        missionRevision,
        candidateDigest,
        graphNodes,
        files: spec.files,
        root,
        ...(args.fs === undefined ? {} : { fs: args.fs }),
        verifiedAt: nowMs,
      });
    } else if (spec.tree !== undefined) {
      verifierId = "tree-binding";
      const expected = spec.tree.expected;
      if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
        throw new Error(`host producer spec for ${criterionId} has no expected tree map`);
      }
      const actualTree: Record<string, string> = {};
      let unscanned: string | undefined;
      for (const [path, digest] of Object.entries(expected)) {
        if (typeof digest !== "string" || !HEX64_DIGEST.test(digest)) {
          throw new Error(`host producer spec for ${criterionId} has a malformed expected digest`);
        }
        try {
          // Hardened observation read: symlink/ancestor escapes, TOCTOU
          // swaps, and non-regular files refuse through the shared
          // verifier seam, and any refusal abstains below (`unobserved`),
          // never a verdict over outside bytes.
          const observed = createHashDigest(readVerifierFileBytes(root, path, args.fs));
          actualTree[path] = observed;
        } catch {
          unscanned = path;
          break;
        }
      }
      if (unscanned !== undefined) {
        reports.push({
          criterionId,
          status: "unobserved",
          verifierId,
          detail: `host could not observe the tree under its evidence root (${unscanned}); no verdict`,
        });
        continue;
      }
      finding = verifyTreeBinding({
        criterionId,
        missionRevision,
        candidateDigest,
        graphNodes,
        expectedTree: expected,
        actualTree,
        verifiedAt: nowMs,
      });
    }

    if (finding === undefined) {
      const report: HostProducerCriterionReport = {
        criterionId,
        status: "unobserved",
        detail: "the verifier adapter abstained (unreadable input, no authorized reader); no verdict",
      };
      if (verifierId !== "") report.verifierId = verifierId;
      reports.push(report);
      continue;
    }
    const persisted = persistVerifierFinding(args.ledger, args.sessionId, finding);
    switch (persisted.status) {
      case "appended":
      case "duplicate": {
        let durable = false;
        try {
          const view = args.ledger.read();
          if (view.corrupt === undefined) durable = verificationReceiptIds(view.records).has(persisted.correlationId);
        } catch {
          durable = false;
        }
        if (!durable) {
          reports.push({
            criterionId,
            status: "rejected",
            verifierId,
            detail: "verifier receipt is not durably present on read-back; verdict withheld",
          });
          continue;
        }
        verifications.push(findingToVerification(finding, persisted.correlationId));
        reports.push({
          criterionId,
          status: finding.result === "satisfied" ? "satisfied" : "failed",
          verifierId,
          correlationId: persisted.correlationId,
          detail: finding.result === "satisfied"
            ? "host observation satisfied; verdict persisted and read back"
            : "host observed a negative; failed verdict persisted and read back",
        });
        continue;
      }
      case "conflict":
      case "unavailable": {
        reports.push({
          criterionId,
          status: "rejected",
          verifierId,
          detail: `verifier receipt did not persist (${persisted.status}: ${persisted.reason}); verdict withheld`,
        });
        continue;
      }
    }
  }

  associations.sort((a, b) =>
    a.criterionId < b.criterionId ? -1
    : a.criterionId > b.criterionId ? 1
    : a.runId < b.runId ? -1
    : a.runId > b.runId ? 1
    : a.nodeId < b.nodeId ? -1
    : a.nodeId > b.nodeId ? 1
    : (a.attemptId ?? "") < (b.attemptId ?? "") ? -1
    : (a.attemptId ?? "") > (b.attemptId ?? "") ? 1
    : 0,
  );
  return { associations, verifications, reports };
}

function createHashDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
