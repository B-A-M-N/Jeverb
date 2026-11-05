/**
 * Non-authoritative graph-to-criterion evidence bridge (resolver).
 *
 * Purpose: validate operator-declared criterion bindings ONLY against
 * persisted host-owned evidence — the session-scoped journal projection
 * (`MissionGraphRunEvidence`, built in session-source.ts from
 * `reconcileJournal`) and, when a binding names one, a correlated
 * `GraphNodeTerminal` receipt (`outcome: execution-observed`, checked with
 * `isValidReceipt` from evidence/receipt-validation.js).
 *
 * Execution-vs-satisfaction boundary: a `bound` result means the binding
 * is traceable to a persisted terminal node, never that the criterion is
 * satisfied. Stub-model judgments, user outcome strings, generic
 * succeeded nodes, review lanes, observations, and ledger
 * execution-observed rows must not count as verification — this module
 * never produces verification, only traceability states, and its caller
 * (session-source.ts) never derives `verified` from its output.
 *
 * State mapping:
 * - bound: every present binding field matches the scoped journal node
 *   (and the correlated receipt, when named).
 * - missing: the criterion, run, node, or named receipt does not exist in
 *   scoped evidence.
 * - mismatched: present evidence disagrees (revision, candidate, hash, or
 *   kind), or the binding itself is malformed. Malformed input is rejected
 *   as mismatched — never bound.
 * - stale: the binding names a candidate older than the current one
 *   (evidence moved on; e.g. attestations rotated the candidate digest).
 * - foreign: the run belongs to another session's journal.
 * - conflict: two bindings claim divergent terminal evidence for one
 *   criterion, or the correlated receipt contradicts the journal.
 *   Divergence compares canonical length-delimited identity tuples, so
 *   distinct terminal rows cannot forge the same identity and evade the
 *   conflict.
 * - unavailable: correlation needs a receipt but the ledger cannot be read,
 *   or receipt correlation was requested without a trusted host session
 *   id (fail closed: never correlate receipts anonymously).
 * - unknown: the referenced node is interrupted (pending/outcome_unknown)
 *   or otherwise indeterminate; never inferred as success.
 * - unhealthy: the journaled node terminated without success (failed,
 *   skipped, blocked, cancelled). A binding that matches such a node on
 *   every hash and status field still resolves unhealthy, never bound:
 *   execution failure is traceable, never healthy.
 *
 * Overflow: at most MAX_CRITERION_GRAPH_BINDINGS bindings are evaluated.
 * Any excess collapses to ONE bounded `unavailable` overflow row (still
 * fail closed through `operations.uncertain`), never one row per excess
 * binding, so adversarial input size cannot inflate the evidence bundle.
 *
 * Session identity: receipt correlation requires a trusted host session
 * id. A binding that names `receiptCorrelationId` while no session id is
 * supplied resolves `unavailable` — the `mcp-run:<runId>` receipt scope
 * is honored only when the host explicitly supplies its session id.
 *
 * Supply path (wiring): bindings are accepted ONLY as host-constructed
 * `criterionGraphBindings` loadSnapshot args to
 * `createSessionMissionClosureSource` (src/mission/session-source.ts).
 * No MCP tool schema, agent input, hook payload, or user text can supply
 * them. A future trusted host would pass operator-constructed binding
 * arrays through those same args — never through agent/MCP channels —
 * and `allowGraphPromotion` (default OFF, no promotion path exists) would
 * still need an explicit opt-in before any promotion behavior activates.
 *
 * Trusted producer path (opt-in, default OFF): `buildCriterionGraphBindings`
 * below converts explicit host-declared criterion→producer-node associations
 * into proposed bindings, resolved ONLY against persisted host-owned
 * evidence already in memory — the contract criteria, the scoped journal
 * projection, and the current candidate digest. It never reads agent JSON,
 * MCP input, or user text: there is no input channel for those here at all.
 * Each association names one criterion and one producer node
 * (runId+nodeId, optionally the settling attemptId); only associations that
 * match a journaled terminal node carrying both hashes produce a binding.
 * Undeclared nodes never bind — an unrelated succeeded node cannot satisfy
 * a criterion — missing or contradictory declarations yield no counted
 * traceability, and one node contributes to several criteria only when each
 * contribution is explicitly declared. Retries and repairs preserve lineage
 * through the journaled attempt list: a binding that names a superseded
 * attempt never resolves bound. Every produced binding carries
 * `provenance: "host:journal-projection/v2"` marking host authority, binds
 * the mission revision and the current candidate digest (rotation renders it
 * `stale`/`mismatched`), and resolved evidence retains its declared
 * attempt/provenance plus the journaled predecessor ids and terminal states.
 * A successful node with absent predecessor metadata resolves `unknown`;
 * an empty captured list is distinct evidence for a root node. Every
 * predecessor must itself be journaled as `succeeded` before the binding
 * resolves `bound`.
 * It never names a receipt correlation id (no
 * ledger reads on the producer path, bounded or otherwise).
 *
 * Independent criterion verification: `validateCriterionVerifications`
 * checks host-supplied per-criterion verdicts against a host-supplied
 * verifier allowlist (default empty: every verdict is `unresolved`, fail
 * closed). A verdict counts only when it binds the exact criterion,
 * mission revision, and candidate digest; contradictory verdicts
 * (satisfied vs failed, or ambiguous satisfied duplicates with divergent
 * identity) are never satisfied. Verification alone never verifies: see
 * `qualifyTrustedCriteria`, which additionally requires a `bound`
 * traceability row — unhealthy/unknown execution never satisfies — and,
 * in the session source, a valid user attestation.
 */

import { isValidReceipt } from "../evidence/receipt-validation.js";
import type {
  CriterionGraphEvidence,
  CriterionGraphEvidenceState,
  MissionCriterionGraphBinding,
  MissionCriterionVerification,
  MissionGraphRunEvidence,
} from "./closure.js";

const HEX64 = /^[0-9a-f]{64}$/;
const GRAPH_STATUSES = new Set([
  "succeeded",
  "failed",
  "skipped",
  "blocked",
  "cancelled",
  "outcome_unknown",
] as const);
type GraphTerminalStatus = NonNullable<MissionGraphRunEvidence["nodes"][number]["status"]>;

function graphTerminalStatus(value: string | undefined): NonNullable<CriterionGraphEvidence["dependencies"]>[number]["state"] {
  switch (value as GraphTerminalStatus | undefined) {
    case "succeeded": return "succeeded";
    case "failed": return "failed";
    case "skipped": return "skipped";
    case "blocked": return "blocked";
    case "cancelled": return "cancelled";
    case "outcome_unknown": return "outcome_unknown";
    default:
      return "missing";
  }
}
const INTERRUPTED = new Set(["pending", "outcome_unknown"]);
/** Journaled terminal statuses that are never healthy, even when fully matched. */
const UNHEALTHY_NODE_STATUSES = new Set(["failed", "skipped", "blocked", "cancelled"]);

/** Bound on bindings resolved per snapshot; extras fail closed, never bound. */
export const MAX_CRITERION_GRAPH_BINDINGS = 64;
const MAX_ID_CHARS = 200;
const MAX_DETAIL_CHARS = 200;

/**
 * Minimal receipt view the resolver correlates. `EvidenceRecord` satisfies
 * this structurally, so callers pass ledger rows through without mapping.
 */
export interface GraphBindingReceiptView {
  correlationId?: string;
  event: string;
  outcome?: string;
  sessionId: string;
  outputDigest?: string;
  executionStatus?: string;
}

export interface ResolveCriterionGraphBindingsArgs {
  bindings: MissionCriterionGraphBinding[];
  /** Criterion ids in the current mission contract. */
  criteria: Array<{ id: string }>;
  /** Scoped journal projection for this session (host-owned). */
  graphRuns: MissionGraphRunEvidence[];
  /** Run ids journaled under a different host session. */
  unscopedRunIds?: string[];
  /** Current candidate digest of the snapshot being annotated. */
  candidateDigest?: string;
  /**
   * Current mission revision the bindings are resolved against. A binding
   * that names a different mission revision resolves `mismatched`: an
   * association declared against one contract revision never traces a
   * criterion of another.
   */
  missionRevision?: string;
  /** Current host session id, for receipt scoping. */
  sessionId?: string;
  /** Ledger rows for receipt correlation; undefined means unreadable. */
  receipts?: GraphBindingReceiptView[];
  /** Explicit ledger failure (corrupt/unreadable): receipt bindings fail closed. */
  ledgerUnavailable?: boolean;
}

function detail(text: string): string {
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

/**
 * Canonical tuple encoding for compound identity keys. Each field is
 * length-prefixed (`<length>:<bytes>`), so distinct field tuples always
 * encode to distinct strings — naive joins on fixed separators (spaces,
 * NUL bytes) let distinct tuples forge the same key and either hide a
 * divergence or split an identity. Local twin of `encodeTupleFields` in
 * mission/verifiers.ts (kept module-private so neither leaf imports the
 * other at runtime).
 */
function encodeTuple(fields: string[]): string {
  return fields.map((field) => `${field.length}:${field}`).join(",");
}

function identity(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedBinding(binding: MissionCriterionGraphBinding): string | undefined {
  if (!identity(binding)) return "binding is not an object";
  const { criterionId, runId, nodeId, inputHash, outputDigest } = binding;
  if (typeof criterionId !== "string" || criterionId.trim() === "" || criterionId.length > MAX_ID_CHARS) {
    return "criterionId is missing or unbounded";
  }
  if (typeof runId !== "string" || runId.trim() === "" || runId.length > MAX_ID_CHARS) return "runId is missing or unbounded";
  if (typeof nodeId !== "string" || nodeId.trim() === "" || nodeId.length > MAX_ID_CHARS) return "nodeId is missing or unbounded";
  if (typeof inputHash !== "string" || !HEX64.test(inputHash)) return "inputHash is not a 64-hex digest";
  if (typeof outputDigest !== "string" || !HEX64.test(outputDigest)) return "outputDigest is not a 64-hex digest";
  for (const field of ["graphHash", "policyHash", "candidateDigest"] as const) {
    const value = binding[field];
    if (value !== undefined && (typeof value !== "string" || !HEX64.test(value))) return `${field} is not a 64-hex digest`;
  }
  if (
    binding.executionStatus !== undefined &&
    binding.executionStatus !== "pending" &&
    !GRAPH_STATUSES.has(binding.executionStatus)
  ) {
    return "executionStatus is outside the terminal vocabulary";
  }
  if (binding.receiptCorrelationId !== undefined && (typeof binding.receiptCorrelationId !== "string" || !HEX64.test(binding.receiptCorrelationId))) {
    return "receiptCorrelationId is not a 64-hex correlation id";
  }
  if (binding.attemptId !== undefined && (typeof binding.attemptId !== "string" || binding.attemptId.trim() === "" || binding.attemptId.length > MAX_ID_CHARS)) {
    return "attemptId is missing or unbounded";
  }
  if (binding.missionRevision !== undefined && (typeof binding.missionRevision !== "string" || !HEX64.test(binding.missionRevision))) {
    return "missionRevision is not a 64-hex digest";
  }
  return undefined;
}

/**
 * Validate each binding against persisted host-owned evidence only.
 * Pure and deterministic: same inputs always yield the same states in the
 * same order. Never consults model judgments, user outcome strings,
 * review lanes, or observations — those are not arguments here.
 */
export function resolveCriterionGraphBindings(args: ResolveCriterionGraphBindingsArgs): CriterionGraphEvidence[] {
  const criteria = new Set(args.criteria.map((criterion) => criterion.id));
  const runs = new Map(args.graphRuns.map((run) => [run.runId, run]));
  const unscoped = new Set(args.unscopedRunIds ?? []);
  const receipts = args.receipts;
  const ledgerDown = args.ledgerUnavailable === true || receipts === undefined;
  const out: CriterionGraphEvidence[] = [];
  const boundIdentities = new Map<string, Set<string>>();

  const bindings = args.bindings.slice(0, MAX_CRITERION_GRAPH_BINDINGS);
  const overflow = args.bindings.length > bindings.length;

  const push = (
    binding: MissionCriterionGraphBinding,
    state: CriterionGraphEvidenceState,
    reason: string,
    dependencies?: CriterionGraphEvidence["dependencies"],
  ): void => {
    out.push({
      criterionId: typeof binding?.criterionId === "string" ? binding.criterionId : "",
      runId: typeof binding?.runId === "string" ? binding.runId : "",
      nodeId: typeof binding?.nodeId === "string" ? binding.nodeId : "",
      state,
      detail: detail(reason),
      ...(typeof binding?.attemptId === "string" ? { attemptId: binding.attemptId } : {}),
      ...(typeof binding?.provenance === "string" ? { provenance: binding.provenance } : {}),
      ...(dependencies === undefined ? {} : { dependencies }),
    });
  };

  for (const binding of bindings) {
    const malformed = malformedBinding(binding);
    if (malformed !== undefined) {
      push(binding, "mismatched", `malformed binding: ${malformed}`);
      continue;
    }
    if (!criteria.has(binding.criterionId)) {
      push(binding, "missing", "criterion is not in the current mission contract");
      continue;
    }
    const run = runs.get(binding.runId);
    if (run === undefined) {
      if (unscoped.has(binding.runId)) {
        push(binding, "foreign", "run is journaled under a different host session");
      } else {
        push(binding, "missing", "run has no journal in this session");
      }
      continue;
    }
    const node = run.nodes.find((entry) => entry.nodeId === binding.nodeId);
    if (node === undefined) {
      push(binding, "missing", "node has no terminal record in this run");
      continue;
    }
    if (INTERRUPTED.has(node.status)) {
      push(binding, "unknown", `node is interrupted (${node.status}); success is never inferred`);
      continue;
    }
    if (UNHEALTHY_NODE_STATUSES.has(node.status)) {
      push(binding, "unhealthy", `node terminated as ${node.status}; non-success is never healthy`);
      continue;
    }
    if (
      binding.missionRevision !== undefined &&
      args.missionRevision !== undefined &&
      binding.missionRevision !== args.missionRevision
    ) {
      push(binding, "mismatched", "mission revision disagrees with the current contract; the association is superseded");
      continue;
    }
    if (binding.attemptId !== undefined) {
      const lineage = Array.isArray(node.attemptIds) ? node.attemptIds : [];
      if (!lineage.includes(binding.attemptId)) {
        push(binding, "mismatched", "attempt has no record in the journaled node lineage; retries or repairs superseded it");
        continue;
      }
    }
    if (binding.executionStatus !== undefined) {
      if (INTERRUPTED.has(binding.executionStatus)) {
        push(binding, "unknown", "binding references an interrupted outcome");
        continue;
      }
      if (binding.executionStatus !== node.status) {
        push(binding, "mismatched", `execution status ${binding.executionStatus} disagrees with journaled ${node.status}`);
        continue;
      }
    }
    if (
      binding.candidateDigest !== undefined &&
      args.candidateDigest !== undefined &&
      binding.candidateDigest !== args.candidateDigest
    ) {
      push(binding, "stale", "binding names a superseded candidate; evidence moved on");
      continue;
    }
    if (binding.graphHash !== undefined && run.graphHash !== binding.graphHash) {
      push(binding, "mismatched", "graph hash disagrees with the journaled run");
      continue;
    }
    if (binding.policyHash !== undefined && run.policyHash !== binding.policyHash) {
      push(binding, "mismatched", "policy hash disagrees with the journaled run");
      continue;
    }
    if (node.inputHash !== binding.inputHash) {
      push(binding, "mismatched", "input hash disagrees with the journaled node; the graph was edited or repaired since");
      continue;
    }
    if (node.outputDigest !== binding.outputDigest) {
      push(binding, "mismatched", "output digest disagrees with the journaled node");
      continue;
    }
    if (binding.receiptCorrelationId !== undefined) {
      if (args.sessionId === undefined) {
        push(binding, "unavailable", "receipt correlation needs a trusted host session id");
        continue;
      }
      if (ledgerDown) {
        push(binding, "unavailable", "receipt correlation needs the ledger, which cannot be read");
        continue;
      }
      const receipt = (receipts ?? []).find((entry) => entry.correlationId === binding.receiptCorrelationId);
      if (receipt === undefined) {
        push(binding, "missing", "named receipt is absent from the ledger");
        continue;
      }
      if (!isValidReceipt(receipt) || receipt.event !== "GraphNodeTerminal" || receipt.outcome !== "execution-observed") {
        push(binding, "mismatched", "named receipt is not a valid execution-observed graph terminal");
        continue;
      }
      if (args.sessionId !== undefined) {
        const allowed = new Set([args.sessionId, `mcp-run:${binding.runId}`]);
        if (!allowed.has(receipt.sessionId)) {
          push(binding, "foreign", "receipt is scoped to a different session");
          continue;
        }
      }
      if (receipt.outputDigest !== undefined && receipt.outputDigest !== binding.outputDigest) {
        push(binding, "conflict", "receipt output digest contradicts the journaled node");
        continue;
      }
      if (receipt.executionStatus !== undefined && receipt.executionStatus !== node.status) {
        push(binding, "conflict", "receipt execution status contradicts the journaled node");
        continue;
      }
    }
    if (!Array.isArray(node.declaredDependencies)) {
      push(binding, "unknown", "journal does not preserve the producer node's declared dependencies");
      continue;
    }
    const dependencyEvidence = node.declaredDependencies.map((nodeId) => {
      const dependency = run.nodes.find((entry) => entry.nodeId === nodeId);
      return { nodeId, state: graphTerminalStatus(dependency?.status) };
    });
    const failedDependency = dependencyEvidence.find((dependency) => dependency.state !== "succeeded");
    if (failedDependency !== undefined) {
      push(binding, failedDependency.state === "outcome_unknown" ? "unknown" : "unhealthy",
        `declared dependency ${failedDependency.nodeId} is ${failedDependency.state}`,
        dependencyEvidence);
      continue;
    }
    push(binding, "bound", "binding matches the persisted terminal node and every declared dependency succeeded", dependencyEvidence);
    const identityKey = encodeTuple([binding.runId, binding.nodeId, binding.outputDigest]);
    let seen = boundIdentities.get(binding.criterionId);
    if (seen === undefined) {
      seen = new Set();
      boundIdentities.set(binding.criterionId, seen);
    }
    seen.add(identityKey);
  }

  if (overflow) {
    // One bounded overflow row, never one row per excess binding: the
    // excess count is folded into the detail so adversarial input size
    // cannot inflate the evidence bundle. Still fail closed — the row is
    // never `bound`, so the caller counts it toward uncertainty.
    const excess = args.bindings.length - bindings.length;
    out.push({
      criterionId: "",
      runId: "",
      nodeId: "",
      state: "unavailable",
      detail: detail(
        `${excess} binding${excess === 1 ? "" : "s"} beyond the bound of ${MAX_CRITERION_GRAPH_BINDINGS} were not evaluated`,
      ),
    });
  }

  // Divergent bound evidence for one criterion conflicts: two different
  // terminal rows cannot both trace one acceptance criterion.
  const conflicted = new Set<string>();
  for (const [criterionId, identities] of boundIdentities) {
    if (identities.size > 1) conflicted.add(criterionId);
  }
  if (conflicted.size > 0) {
    for (const entry of out) {
      if (entry.state === "bound" && conflicted.has(entry.criterionId)) {
        entry.state = "conflict";
        entry.detail = detail("divergent bound evidence for one criterion");
      }
    }
  }
  return out;
}

/** Authority marker stamped on every producer-built binding. Host only. */
export const TRUSTED_GRAPH_BINDING_PROVENANCE = "host:journal-projection/v2";

/** Bound on host-supplied criterion verifications evaluated per snapshot. */
export const MAX_CRITERION_VERIFICATIONS = 64;

/**
 * Explicit host-declared criterion→producer-node association: the claim
 * that one producer node contributes evidence for one acceptance criterion.
 * The producer validates each association against the journaled projection
 * and emits a binding only for matches; undeclared nodes never bind, and a
 * node contributes to several criteria only when each contribution carries
 * its own association row.
 */
export interface CriterionProducerAssociation {
  criterionId: string;
  runId: string;
  nodeId: string;
  /**
   * The settling attempt the association traces. When named, the emitted
   * binding carries it and the resolver requires it in the journaled node
   * lineage. When absent, the binding traces the terminal outcome without
   * naming the attempt.
   */
  attemptId?: string;
}

export interface BuildCriterionGraphBindingsArgs {
  /** Criterion ids in the current mission contract. */
  criteria: Array<{ id: string }>;
  /**
   * Explicit host-declared associations (host-constructed, never agent
   * JSON, MCP input, or user text). Associations naming criteria outside
   * the current contract, runs outside the scoped projection, nodes
   * without journaled terminal hashes, or attempts outside the journaled
   * lineage produce no binding — missing stays unresolved, never bound.
   */
  associations: CriterionProducerAssociation[];
  /**
   * Scoped journal projection for this session (host-owned, already in
   * memory — the producer never rescans journals and never consults agent
   * JSON, MCP input, or user text; there is no such parameter here).
   */
  graphRuns: MissionGraphRunEvidence[];
  /** Current mission revision the bindings are declared against. */
  missionRevision: string;
  /** Current candidate digest the bindings attach to. */
  candidateDigest?: string;
}

/**
 * Host-owned trusted producer: convert explicit associations into proposed
 * bindings against persisted evidence only. Deterministic: output sorted by
 * (criterionId, runId, nodeId, attemptId); duplicate association rows
 * collapse to one binding. Zero matching associations yield zero bindings
 * (never a placeholder). Produced bindings never name receipts, so
 * resolving them performs no ledger reads. A criterion with two
 * divergent matched associations yields two bindings, which the resolver
 * below marks `conflict` — the producer never picks a winner.
 */
export function buildCriterionGraphBindings(args: BuildCriterionGraphBindingsArgs): MissionCriterionGraphBinding[] {
  const valid = new Set(
    args.criteria
      .filter((criterion) => typeof criterion?.id === "string" && criterion.id.trim() !== "")
      .map((criterion) => criterion.id),
  );
  if (valid.size === 0) return [];
  const runs = new Map(
    (Array.isArray(args.graphRuns) ? args.graphRuns : [])
      .filter((run) => typeof run?.runId === "string" && run.runId.trim() !== "" && Array.isArray(run.nodes))
      .map((run) => [run.runId, run] as const),
  );
  const seen = new Set<string>();
  const out: MissionCriterionGraphBinding[] = [];
  const sorted = [...(Array.isArray(args.associations) ? args.associations : [])]
    .filter(
      (association) =>
        association !== null &&
        typeof association === "object" &&
        typeof association.criterionId === "string" &&
        typeof association.runId === "string" &&
        typeof association.nodeId === "string",
    )
    .sort((a, b) =>
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
  for (const association of sorted) {
    if (!valid.has(association.criterionId)) continue;
    const key = encodeTuple([association.criterionId, association.runId, association.nodeId, association.attemptId ?? ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    const run = runs.get(association.runId);
    if (run === undefined) continue;
    const node = run.nodes.find((entry) => entry?.nodeId === association.nodeId);
    if (node === undefined) continue;
    if (typeof node.inputHash !== "string" || !HEX64.test(node.inputHash)) continue;
    if (typeof node.outputDigest !== "string" || !HEX64.test(node.outputDigest)) continue;
    const lineage = Array.isArray(node.attemptIds) ? node.attemptIds : [];
    if (association.attemptId !== undefined && !lineage.includes(association.attemptId)) continue;
    out.push({
      criterionId: association.criterionId,
      runId: association.runId,
      nodeId: association.nodeId,
      ...(run.graphHash === undefined ? {} : { graphHash: run.graphHash }),
      ...(run.policyHash === undefined ? {} : { policyHash: run.policyHash }),
      inputHash: node.inputHash as string,
      outputDigest: node.outputDigest as string,
      executionStatus: node.status,
      ...(association.attemptId === undefined ? {} : { attemptId: association.attemptId }),
      missionRevision: args.missionRevision,
      ...(args.candidateDigest === undefined ? {} : { candidateDigest: args.candidateDigest }),
      provenance: TRUSTED_GRAPH_BINDING_PROVENANCE,
    });
  }
  return out;
}

export type CriterionVerificationOutcome = "satisfied" | "failed" | "unresolved";

export interface CriterionVerificationAssessment {
  criterionId: string;
  outcome: CriterionVerificationOutcome;
  /**
   * The counted verifier, present only when every counted verdict for this
   * criterion shares one verifier id. Never verifier or model text beyond
   * the host-allowlisted id.
   */
  verifierId?: string;
  /** Bounded, sanitized reason; never verifier or model text. */
  detail: string;
  /** The exact durable receipt whose allowlisted verdict was counted. */
  receiptCorrelationId?: string;
  evidenceRef?: string;
  /** Host verifier output retained only after all binding checks succeed. */
  observedResult?: string;
  adapterVersion?: string;
  graphNodes?: Array<{ runId: string; nodeId: string; attemptId?: string }>;
}

export interface ValidateCriterionVerificationsArgs {
  /** Host-supplied per-criterion verdicts. Never agent/MCP/user text. */
  verifications: MissionCriterionVerification[];
  /** Criterion ids in the current mission contract. */
  criteria: Array<{ id: string }>;
  /** Current mission revision the verdicts must bind to. */
  missionRevision: string;
  /** Current candidate digest the verdicts must bind to. */
  candidateDigest?: string;
  /**
   * Host-supplied verifier allowlist (exact match). Default empty: every
   * verdict is `unresolved`, fail closed.
   */
  verifierAllowlist?: string[];
  /**
   * Durable receipt presence, by receipt correlation id. When provided, a
   * counted verdict must name a correlation id present in this set — a
   * verdict whose receipt was never durably persisted (or was pruned) is
   * skipped as `unresolved`, fail closed. When omitted, counting falls back
   * to shape, allowlist, and revision/candidate binding only; hosts that
   * need durable consistent receipts must pass the ledger-derived set.
   */
  receiptsPresent?: Set<string>;
}

export interface ValidatedCriterionVerifications {
  assessments: CriterionVerificationAssessment[];
  /** Verdicts beyond the bound are unevaluated and fail closed upstream. */
  overflow: number;
}

function verificationDetail(text: string): string {
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

function malformedVerification(verification: MissionCriterionVerification): string | undefined {
  if (typeof verification !== "object" || verification === null || Array.isArray(verification)) return "verification is not an object";
  if (typeof verification.criterionId !== "string" || verification.criterionId.trim() === "" || verification.criterionId.length > MAX_ID_CHARS) {
    return "criterionId is missing or unbounded";
  }
  if (typeof verification.verifierId !== "string" || verification.verifierId.trim() === "" || verification.verifierId.length > MAX_ID_CHARS) {
    return "verifierId is missing or unbounded";
  }
  if (typeof verification.missionRevision !== "string" || !HEX64.test(verification.missionRevision)) {
    return "missionRevision is not a 64-hex digest";
  }
  if (typeof verification.candidateDigest !== "string" || !HEX64.test(verification.candidateDigest)) {
    return "candidateDigest is not a 64-hex digest";
  }
  if (verification.result !== "satisfied" && verification.result !== "failed") {
    return "result is outside the satisfied/failed vocabulary";
  }
  if (
    typeof verification.receiptCorrelationId !== "string" || verification.receiptCorrelationId.trim() === "" ||
    verification.receiptCorrelationId.length > MAX_ID_CHARS
  ) {
    return "receiptCorrelationId is missing or unbounded";
  }
  if (typeof verification.verifiedAt !== "number" || !Number.isFinite(verification.verifiedAt)) {
    return "verifiedAt is not finite";
  }
  return undefined;
}

/**
 * Validate host-supplied per-criterion verdicts. Pure and deterministic.
 * A verdict counts only when it is well-formed, names an allowlisted
 * verifier (exact match), names a current contract criterion, and binds
 * the exact mission revision and candidate digest. When the host supplies
 * `receiptsPresent`, the verdict must additionally name a durably persisted
 * receipt correlation id. Per criterion: any counted `failed` verdict fails; divergent counted `satisfied` verdicts
 * (different verifier or receipt identity) are ambiguous and unresolved;
 * repeated identical verdicts collapse to satisfied. Anything else —
 * including every verdict under the default empty allowlist — is
 * `unresolved`, fail closed. Never consults graph success, model
 * judgments, or user outcome strings.
 */
export function validateCriterionVerifications(args: ValidateCriterionVerificationsArgs): ValidatedCriterionVerifications {
  const valid = new Set(args.criteria.map((criterion) => criterion.id));
  const allowlist = new Set((args.verifierAllowlist ?? []).filter((id) => typeof id === "string" && id !== ""));
  const verifications = args.verifications.slice(0, MAX_CRITERION_VERIFICATIONS);
  const overflow = Math.max(0, args.verifications.length - verifications.length);
  const counted = new Map<string, MissionCriterionVerification[]>();
  for (const verification of verifications) {
    if (malformedVerification(verification) !== undefined) continue;
    if (!valid.has(verification.criterionId)) continue;
    if (!allowlist.has(verification.verifierId)) continue;
    if (verification.missionRevision !== args.missionRevision) continue;
    if (args.candidateDigest === undefined || verification.candidateDigest !== args.candidateDigest) continue;
    if (args.receiptsPresent !== undefined && !args.receiptsPresent.has(verification.receiptCorrelationId)) continue;
    const list = counted.get(verification.criterionId) ?? [];
    list.push(verification);
    counted.set(verification.criterionId, list);
  }
  const assessments: CriterionVerificationAssessment[] = [...valid]
    .sort()
    .map((criterionId) => {
      const rows = counted.get(criterionId) ?? [];
      const singleVerifier = ((): string | undefined => {
        const ids = new Set(rows.map((row) => row.verifierId));
        return ids.size === 1 ? [...ids][0] : undefined;
      })();
      const verifierField = singleVerifier === undefined ? {} : { verifierId: singleVerifier };
      if (rows.length === 0) {
        return {
          criterionId,
          outcome: "unresolved" as const,
          detail: verificationDetail("no counted independent verification binds this criterion, revision, and candidate"),
        };
      }
      if (rows.some((row) => row.result === "failed")) {
        const failed = rows.find((row) => row.result === "failed")!;
        return {
          criterionId,
          outcome: "failed" as const,
          ...verifierField,
          detail: verificationDetail("an allowlisted verifier reports this criterion failed on this candidate"),
          receiptCorrelationId: failed.receiptCorrelationId,
          ...(typeof failed.evidenceRef === "string" ? { evidenceRef: verificationDetail(failed.evidenceRef) } : {}),
          ...(typeof failed.observedResult === "string" ? { observedResult: verificationDetail(failed.observedResult) } : {}),
          ...(typeof failed.adapterVersion === "string" ? { adapterVersion: verificationDetail(failed.adapterVersion) } : {}),
          ...(Array.isArray(failed.graphNodes) ? { graphNodes: failed.graphNodes.slice(0, 16).map((node) => ({ ...node })) } : {}),
        };
      }
      const identities = new Set(rows.map((row) => encodeTuple([row.verifierId, row.receiptCorrelationId])));
      if (identities.size > 1) {
        return {
          criterionId,
          outcome: "unresolved" as const,
          detail: verificationDetail("ambiguous duplicate satisfied verdicts with divergent verifier or receipt identity"),
        };
      }
      return {
        criterionId,
        outcome: "satisfied" as const,
        ...verifierField,
        detail: verificationDetail("an allowlisted verifier reports this criterion satisfied on this candidate"),
        receiptCorrelationId: rows[0]!.receiptCorrelationId,
        ...(typeof rows[0]!.evidenceRef === "string" ? { evidenceRef: verificationDetail(rows[0]!.evidenceRef) } : {}),
        ...(typeof rows[0]!.observedResult === "string" ? { observedResult: verificationDetail(rows[0]!.observedResult) } : {}),
        ...(typeof rows[0]!.adapterVersion === "string" ? { adapterVersion: verificationDetail(rows[0]!.adapterVersion) } : {}),
        ...(Array.isArray(rows[0]!.graphNodes) ? { graphNodes: rows[0]!.graphNodes.slice(0, 16).map((node) => ({ ...node })) } : {}),
      };
    });
  return { assessments, overflow };
}

export interface QualifyTrustedCriteriaArgs {
  /** Criterion ids in the current mission contract. */
  criteria: Array<{ id: string }>;
  /** Criteria with a valid user attestation on this mission revision. */
  attested: Set<string>;
  /** Resolver output for the producer-built bindings. */
  graphStates: CriterionGraphEvidence[];
  /** Verification assessments for this revision and candidate. */
  verificationAssessments: CriterionVerificationAssessment[];
}

export interface TrustedCriterionQualification {
  criterionId: string;
  /** True only when attested, bound, and independently satisfied. */
  qualified: boolean;
  traceable: boolean;
  verification: CriterionVerificationOutcome;
}

/**
 * Deterministic qualification: a criterion qualifies only when a valid
 * user attestation, a `bound` graph traceability row (every row bound —
 * unhealthy, unknown, stale, conflicting, or absent traceability never
 * qualifies), and a `satisfied` independent verification all hold for the
 * exact criterion, revision, and candidate. Graph success alone,
 * verification alone, and attestation alone never qualify.
 */
export function qualifyTrustedCriteria(args: QualifyTrustedCriteriaArgs): TrustedCriterionQualification[] {
  const statesByCriterion = new Map<string, CriterionGraphEvidence[]>();
  for (const state of args.graphStates) {
    const list = statesByCriterion.get(state.criterionId) ?? [];
    list.push(state);
    statesByCriterion.set(state.criterionId, list);
  }
  const verificationByCriterion = new Map(args.verificationAssessments.map((assessment) => [assessment.criterionId, assessment.outcome]));
  return [...new Set(args.criteria.map((criterion) => criterion.id))]
    .sort()
    .map((criterionId) => {
      const rows = statesByCriterion.get(criterionId) ?? [];
      const traceable = rows.length > 0 && rows.every((row) => row.state === "bound");
      const verification = verificationByCriterion.get(criterionId) ?? "unresolved";
      const qualified = args.attested.has(criterionId) && traceable && verification === "satisfied";
      return { criterionId, qualified, traceable, verification };
    });
}
