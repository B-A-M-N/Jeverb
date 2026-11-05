import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { reconcileJournal } from "../graph/journal.js";
import type { Store } from "../hooks/store.js";
import { liveSubagentTasks } from "../hooks/subagent-tasks.js";
import type { MissionClosureEvidence, MissionClosureEvidenceSource, MissionClosureRequestContext, MissionCriterionGraphBinding, MissionCriterionVerification, MissionGraphRunEvidence } from "./closure.js";
import { MISSION_CLOSURE_REQUEST_PROFILE_V2 } from "./closure.js";
import { buildCriterionGraphBindings, qualifyTrustedCriteria, resolveCriterionGraphBindings, validateCriterionVerifications, type CriterionProducerAssociation, type GraphBindingReceiptView } from "./graph-binding.js";
import { readVerifierFileBytes, verificationReceiptIds } from "./verifiers.js";
import type { CriterionCodeStructureEvidence } from "./structural-analysis.js";
import { buildMissionProofObligation, proofObligationId } from "./proof-obligations.js";
import { redactAndClamp } from "../hooks/redact.js";
import { currentCheck } from "../hooks/verification.js";

const MAX_GRAPH_JOURNAL_FILES = 256;
const MAX_GRAPH_DIRECTORY_ENTRIES = 4096;
const MAX_GRAPH_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_GRAPH_JOURNAL_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_CLOSURE_GRAPH_RUNS = 64;
const MAX_CLOSURE_GRAPH_NODES = 512;
const GRAPH_NODE_STATUSES = new Set(["succeeded", "failed", "skipped", "blocked", "cancelled", "outcome_unknown"]);
/** Attempt lineage entries projected per node; latest entries win, bounded. */
const MAX_PROJECTED_ATTEMPT_IDS = 8;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function graphOperationSnapshot(dataDir: string, sessionId: string, candidateProbeRunToExclude?: { runId: string; nodeId: string }): {
  pending: number;
  uncertain: number;
  revision: Array<unknown>;
  graphRuns: MissionGraphRunEvidence[];
  /** Run ids journaled under a different host session (for foreign-binding detection). */
  unscopedRunIds: string[];
} {
  const directory = join(dataDir, "graph-journals");
  let dirStat;
  try {
    dirStat = lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pending: 0, uncertain: 0, revision: [], graphRuns: [], unscopedRunIds: [] };
    throw new Error("graph journal directory could not be inspected");
  }
  if (
    dirStat.isSymbolicLink() || !dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && dirStat.uid !== process.getuid())
  ) throw new Error("graph journal directory failed ownership or mode validation");

  const revision: Array<unknown> = [];
  let uncertain = 0;
  let pending = 0;
  let projectedNodes = 0;
  const graphRuns: MissionGraphRunEvidence[] = [];
  const unscopedRunIds: string[] = [];
  const names: string[] = [];
  const dir = opendirSync(directory);
  try {
    let entries = 0;
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      entries += 1;
      const candidate = /^jeverb-graph-[A-Za-z0-9_-]{1,100}\.jsonl$/.test(entry.name);
      if (candidate) names.push(entry.name);
      if (entries > MAX_GRAPH_DIRECTORY_ENTRIES || names.length > MAX_GRAPH_JOURNAL_FILES) {
        uncertain += 1;
        revision.push({ run: "journal-scan:directory-limit", unknowns: 1, malformed: 0, scoped: false });
        return { pending, uncertain, revision, graphRuns, unscopedRunIds };
      }
    }
  } finally {
    dir.closeSync();
  }
  names.sort();
  let totalBytes = 0;
  for (const name of names) {
    const path = join(directory, name);
    try {
      const stat = lstatSync(path);
      if (
        stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        stat.size > MAX_GRAPH_JOURNAL_BYTES || totalBytes + stat.size > MAX_GRAPH_JOURNAL_TOTAL_BYTES ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      ) {
        // An uninspectable journal may represent a side effect whose outcome
        // is unknown. Fail closed rather than silently ignoring it.
        uncertain += 1;
        revision.push({ run: name, unknowns: 0, malformed: 1, scoped: false });
        continue;
      }
      totalBytes += stat.size;
      const journal = reconcileJournal(path);
      if (journal.hostSessionId !== undefined && journal.hostSessionId !== sessionId && journal.runId !== undefined) {
        unscopedRunIds.push(journal.runId);
      }
      const scoped = journal.hostSessionId === sessionId;
      const unscopedUncertainty = journal.hostSessionId === undefined &&
        (journal.unknowns.length > 0 || journal.pending.length > 0 || journal.malformed > 0);
      if (!scoped && !unscopedUncertainty) continue;
      const unknowns = journal.unknowns.length;
      const malformed = journal.malformed;
      uncertain += unknowns + malformed;
      const interruptedNodes = new Set(journal.unknowns);
      const knownNodes = journal.nodes.map((node) => {
        if (node.status === "pending") return undefined;
        if (!GRAPH_NODE_STATUSES.has(node.status)) {
          uncertain += 1;
          return undefined;
        }
        const inputHashValid = typeof node.inputHash === "string" && /^[0-9a-f]{64}$/.test(node.inputHash);
        const outputDigestValid = typeof node.outputDigest === "string" && /^[0-9a-f]{64}$/.test(node.outputDigest);
        if (node.status === "outcome_unknown") {
          // A journaled terminal outcome_unknown is still an unresolved side
          // effect. Interrupted running attempts are already counted above.
          if (!interruptedNodes.has(node.nodeId)) uncertain += 1;
        } else if (!inputHashValid || !outputDigestValid) {
          uncertain += 1;
        }
        return {
          nodeId: redactAndClamp(node.nodeId, 100),
          status: node.status as MissionGraphRunEvidence["nodes"][number]["status"],
          ...(inputHashValid ? { inputHash: node.inputHash as string } : {}),
          ...(outputDigestValid ? { outputDigest: node.outputDigest as string } : {}),
          ...(Array.isArray(node.declaredDependencies) && node.declaredDependencies.length <= 64 &&
            node.declaredDependencies.every((dependency) => typeof dependency === "string")
            ? { declaredDependencies: [...node.declaredDependencies] }
            : {}),
          // Attempt lineage for bindings that name the settling attempt:
          // retries and repairs stay traceable even though the terminal
          // outcome itself is last-terminal-wins.
          ...(Array.isArray(node.attemptIds) && node.attemptIds.length > 0
            ? { attemptIds: node.attemptIds.filter((id) => typeof id === "string").slice(-MAX_PROJECTED_ATTEMPT_IDS) }
            : {}),
        };
      }).filter((node): node is NonNullable<typeof node> => node !== undefined)
        .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
      const journalPending = scoped ? journal.pending.length : 0;
      pending += journalPending;
      if (scoped && journal.runStarted && journal.nodes.length === 0) uncertain += 1;
      if (scoped && (graphRuns.length >= MAX_CLOSURE_GRAPH_RUNS || projectedNodes + knownNodes.length > MAX_CLOSURE_GRAPH_NODES)) {
        uncertain += 1;
      } else if (scoped && journal.runId !== undefined) {
        projectedNodes += knownNodes.length;
        graphRuns.push({
          runId: journal.runId,
          ...(journal.graphHash !== undefined ? { graphHash: journal.graphHash } : {}),
          ...(journal.policyHash !== undefined ? { policyHash: journal.policyHash } : {}),
          nodes: knownNodes,
        });
      }
      const candidateProbeRun = scoped && candidateProbeRunToExclude !== undefined &&
        journal.runId === candidateProbeRunToExclude.runId && journal.malformed === 0 &&
        journal.unknowns.length === 0 && journal.pending.length === 0 && journal.nodes.length === 1 &&
        journal.nodes[0]?.nodeId === candidateProbeRunToExclude.nodeId &&
        (journal.nodes[0]?.status === "succeeded" || journal.nodes[0]?.status === "failed") &&
        /^[0-9a-f]{64}$/.test(journal.nodes[0]?.inputHash ?? "") &&
        /^[0-9a-f]{64}$/.test(journal.nodes[0]?.outputDigest ?? "");
      if (!candidateProbeRun) revision.push({
        run: journal.runId ?? name,
        unknowns,
        pending: journalPending,
        ...(scoped ? { pendingNodes: journal.pending.map((id) => sha256(id)).sort() } : {}),
        malformed,
        scoped,
        ...(scoped ? { graphHash: journal.graphHash ?? null, policyHash: journal.policyHash ?? null, nodes: knownNodes } : {}),
      });
    } catch {
      uncertain += 1;
      revision.push({ run: name, unknowns: 0, malformed: 1, scoped: false });
    }
  }
  return { pending, uncertain, revision, graphRuns, unscopedRunIds };
}

/**
 * Assemble closure evidence only from the private session Store and durable
 * graph journals. User attestation is accepted solely when it was recorded by
 * UserPromptSubmit against this mission revision. A host exit-code test record
 * is a separate verification source from Jev's semantic vote.
 *
 * Non-authoritative graph bridge. The host may additionally declare
 * `criterionGraphBindings` (operator traceability links, not evidence).
 * They resolve to additive per-criterion `graphEvidence` that NEVER sets
 * `verified` and by default NEVER changes old verdicts: unhealthy bindings
 * only fail closed through `operations.uncertain` (forcing INCOMPLETE),
 * never toward COMPLETE. `allowGraphPromotion` is the explicit opt-in gate
 * for any future authoritative promotion path and defaults to OFF; no
 * promotion path exists today, so both modes behave identically.
 * Receipt correlation needs `ledger`; without it, bindings that name a
 * receipt resolve `unavailable` (fail closed).
 *
 * Trusted-evidence path (`enableTrustedGraphEvidence`, default OFF). When
 * enabled, the source converts the host's explicit
 * `criterionProducerAssociations` into bindings with
 * `buildCriterionGraphBindings` against the in-memory scoped journal
 * projection (no rescan, deterministic ordering) and ignores
 * `criterionGraphBindings` entirely — external bindings are never accepted
 * on the trusted path, and with no associations the path yields no
 * bindings at all (never a heuristic guess). Per-criterion host verdicts
 * (`criterionVerifications`) count only against the host
 * `trustedVerifierIds` allowlist (default empty: all unresolved) and the
 * exact revision and candidate; when a ledger is supplied, a verdict must
 * additionally name a durably persisted `CriterionVerification` receipt —
 * an unreadable ledger fails every verdict closed. A criterion verifies
 * only when attestation, `bound` traceability, and a satisfied
 * revision-and-candidate-bound verification all hold; the snapshot carries
 * request profile v2 so the model-bound request switches to the v2
 * question (old calibration hashes cannot silently match it).
 *
 * Supply path (no MCP/agent input): these args are host-constructed only.
 * No MCP tool schema, agent message, hook payload, or user text reaches
 * `criterionGraphBindings`, `criterionVerifications`, or
 * `trustedVerifierIds` — the only producers are the trusted host calling
 * `createSessionMissionClosureSource` (operator-constructed arrays) and the
 * in-memory producer above, never agent/MCP/user text.
 */
export function createSessionMissionClosureSource(args: {
  store: Store;
  dataDir: string;
  now: () => number;
  criterionGraphBindings?: MissionCriterionGraphBinding[];
  allowGraphPromotion?: boolean;
  ledger?: { read(): { corrupt?: unknown; records: GraphBindingReceiptView[] } };
  /**
   * Explicit host-declared criterion→producer-node associations for the
   * trusted path (host-constructed, never agent/MCP/user text). With none,
   * the trusted path yields no bindings — there is no heuristic fallback.
   */
  criterionProducerAssociations?: CriterionProducerAssociation[];
  /**
   * Trusted graph-to-criterion integration. Default OFF: the disabled
   * snapshot is bit-identical to the historical shape. When ON, the source
   * converts `criterionProducerAssociations` into bindings against the
   * in-memory scoped journal projection (ignoring `criterionGraphBindings`),
   * validates `criterionVerifications` against `trustedVerifierIds` (and
   * against durable receipts when a ledger is supplied), and qualifies
   * criteria deterministically. Only validated receipt-backed verifier
   * observations and their graph attempt references are retained for the
   * development-only DAG-local request builder; production closure remains
   * on its existing global question and gates.
   */
  enableTrustedGraphEvidence?: boolean;
  /** Host-supplied per-criterion verdicts. Never agent/MCP/user text. */
  criterionVerifications?: MissionCriterionVerification[];
  /** Supplemental host verifier rows. They inform semantic review but are
   * deliberately excluded from mandatory criterion qualification. */
  criterionSupplementalVerifications?: MissionCriterionVerification[];
  /** Host-produced TypeScript structure facts, bound to one obligation and candidate. */
  criterionCodeStructure?: CriterionCodeStructureEvidence[];
  /** Host-approved plan's criterion→source mapping; re-read on every snapshot. */
  criterionCodeFiles?: Array<{ criterionId: string; files: string[] }>;
  /** Root path from the host-approved proof plan. */
  structuralAnalysisRoot?: string;
  /** Hash of the control-service-approved proof plan. */
  hostProofPlanDigest?: string;
  /** During crash recovery only, compute the pre-probe candidate identity by
   * omitting this exact, clean terminal one-node probe journal from the graph
   * revision. The journal remains in graphRuns and all closure evidence. */
  candidateProbeRunToExclude?: { runId: string; nodeId: string };
  /** Host-supplied verifier allowlist (exact match). Default empty. */
  trustedVerifierIds?: string[];
}): MissionClosureEvidenceSource {
  const { store, dataDir, now } = args;
  if (args.candidateProbeRunToExclude !== undefined &&
      (!/^[A-Za-z0-9_-]{1,100}$/.test(args.candidateProbeRunToExclude.runId) ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(args.candidateProbeRunToExclude.nodeId))) {
    throw new Error("candidate probe recovery identity is invalid");
  }
  if (args.hostProofPlanDigest !== undefined &&
      (!/^[0-9a-f]{64}$/.test(args.hostProofPlanDigest) || args.structuralAnalysisRoot === undefined || args.structuralAnalysisRoot.trim() === "")) {
    throw new Error("host proof plan requires a valid digest and structural analysis root");
  }

  const loadSnapshot = async (sessionId: string, missionId: string, context: MissionClosureRequestContext = { backgroundTasks: 0, sessionCrons: 0 }): Promise<MissionClosureEvidence> => {
    const session = store.readSession(sessionId);
    const contract = session.mission_contract;
    if (contract === undefined || contract.missionId !== missionId) throw new Error("mission contract is missing or mismatched");
    const attestations = new Map((contract.attestations ?? []).map((item) => [item.criterionId, item]));
    const verification = session.verification;
    const testCheck = currentCheck(verification, "test");
    const testsPassed = testCheck !== undefined && testCheck.record.ok && testCheck.editsSince === 0;
    const verificationDigest = verification === undefined ? undefined : sha256(JSON.stringify({
      last: verification.last ?? null,
      byKind: verification.byKind ?? null,
      editsSince: verification.edits_since,
      editsSinceByKind: verification.editsSinceByKind ?? null,
    }));
    const activeSubagents = liveSubagentTasks(session.subagent_tasks ?? [], now());
    const pending = activeSubagents.length + (session.pending_reissues?.length ?? 0) +
      Math.max(0, Math.floor(context.backgroundTasks)) + Math.max(0, Math.floor(context.sessionCrons));
    const graph = graphOperationSnapshot(dataDir, sessionId, args.candidateProbeRunToExclude);
    const blockers = store.liveTrips(sessionId, now()).map((trip) => ({ id: `trip:${trip.id}`, unresolved: true }));

    // A service-approved host proof plan can add an explicit criterion-bound
    // source set to candidate identity. Its bytes are re-read for every source
    // snapshot so isCurrent detects source changes during semantic review.
    // Without such a plan, preserve the legacy execution-state digest exactly.
    // Verifier receipts bind to this input revision, never to the aggregate
    // evidence revision that incorporates their own receipts.
    const planCodeFileDigests = args.hostProofPlanDigest === undefined ? undefined :
      (args.criterionCodeFiles ?? []).flatMap(({ criterionId, files }) => files.map((path) => ({
        criterionId,
        path,
        sha256: createHash("sha256").update(readVerifierFileBytes(args.structuralAnalysisRoot ?? "", path)).digest("hex"),
      }))).sort((a, b) => a.criterionId.localeCompare(b.criterionId) || a.path.localeCompare(b.path));
    const candidateDigest = sha256(JSON.stringify({
      missionRevision: contract.missionRevision,
      verification: verificationDigest ?? null,
      activeSubagents: activeSubagents.map((task) => ({ agentType: task.agent_type, ts: task.ts })).sort((a, b) => a.ts - b.ts),
      pendingReissues: session.pending_reissues ?? [],
      context,
      blockers: blockers.map(({ id }) => id).sort(),
      graph: graph.revision,
      ...(args.hostProofPlanDigest === undefined ? {} : {
        hostProofPlanDigest: args.hostProofPlanDigest,
        planCodeFileDigests,
      }),
    }));
    const candidateRevision = sha256(JSON.stringify({
      missionRevision: contract.missionRevision,
      candidate: candidateDigest,
    }));

    const independent = (contract.independentVerifications ?? []).filter(
      (v) =>
        v.missionRevision === contract.missionRevision &&
        v.evidenceRevision === candidateRevision &&
        v.candidate === candidateDigest &&
        v.verificationResult === "pass" &&
        v.verifierId.trim() !== "" &&
        v.receiptCorrelationId.trim() !== "" &&
        Number.isFinite(v.verifiedAt),
    );
    const latestIndependent = independent.length > 0 ? independent[independent.length - 1] : undefined;

    // Non-authoritative graph bridge. Bindings are host-declared links, not
    // evidence: resolve them against the scoped journal projection above and
    // (when named) ledger receipts. The receipt read is attempted only when
    // at least one binding names a receipt, so the default path performs no
    // new I/O and stays bit-identical when no bindings are configured.
    //
    // Trusted path (`enableTrustedGraphEvidence`): the source converts the
    // host's explicit `criterionProducerAssociations` into bindings against
    // the in-memory projection above — no rescan, deterministic ordering —
    // and ignores `criterionGraphBindings` entirely. With no associations
    // there are no bindings: the producer never guesses. Producer bindings
    // never name receipts, so the binding half of this path performs no
    // ledger reads; the verification half below reads the ledger once, only
    // when verdicts are supplied and a ledger is available.
    const trusted = args.enableTrustedGraphEvidence === true;
    const bindings = trusted
      ? buildCriterionGraphBindings({
          criteria: contract.criteria,
          associations: args.criterionProducerAssociations ?? [],
          graphRuns: graph.graphRuns,
          missionRevision: contract.missionRevision,
          candidateDigest,
        })
      : (args.criterionGraphBindings ?? []);
    // Explicit opt-in gate for any future authoritative promotion from graph
    // evidence. No promotion path exists: bound rows are annotative only and
    // `verified` below still derives solely from user attestation. Both
    // modes behave identically today; the flag exists so enabling promotion
    // later requires an explicit decision, never a default.
    const allowGraphPromotion = args.allowGraphPromotion === true;
    let graphReceipts: GraphBindingReceiptView[] | undefined;
    let graphLedgerUnavailable = false;
    if (bindings.some((binding) => typeof binding?.receiptCorrelationId === "string")) {
      if (args.ledger === undefined) {
        graphLedgerUnavailable = true;
      } else {
        try {
          const view = args.ledger.read();
          if (view.corrupt !== undefined) graphLedgerUnavailable = true;
          else graphReceipts = view.records;
        } catch {
          graphLedgerUnavailable = true;
        }
      }
    }
    const graphBindingStates = bindings.length === 0 ? [] : resolveCriterionGraphBindings({
      bindings,
      criteria: contract.criteria,
      graphRuns: graph.graphRuns,
      unscopedRunIds: graph.unscopedRunIds,
      candidateDigest,
      missionRevision: contract.missionRevision,
      sessionId,
      ...(graphReceipts === undefined ? {} : { receipts: graphReceipts }),
      ledgerUnavailable: graphLedgerUnavailable,
    });
    // Fail closed: every non-`bound` row — including `unhealthy` (a
    // correctly bound failed/skipped/blocked/cancelled node) and the
    // single overflow `unavailable` row — adds uncertainty (forcing
    // INCOMPLETE in preflight) and can never clear it.
    const graphBindingUncertain = graphBindingStates.filter((state) => state.state !== "bound").length;
    const graphEvidenceByCriterion = new Map<string, typeof graphBindingStates>();
    for (const state of graphBindingStates) {
      const list = graphEvidenceByCriterion.get(state.criterionId) ?? [];
      list.push(state);
      graphEvidenceByCriterion.set(state.criterionId, list);
    }
    if (allowGraphPromotion) {
      // Reserved: authoritative promotion from graph evidence is not
      // implemented. This branch is the explicit opt-in gate a future
      // promotion path must extend; it intentionally leaves `verified`
      // untouched, so the flag can never promote today.
    }

    // Trusted verification: host-supplied per-criterion verdicts counted
    // only against the host allowlist and the exact revision and candidate.
    // When a ledger is supplied and verdicts exist, the ledger is read once
    // and only verdicts naming a durably persisted `CriterionVerification`
    // receipt count — an unreadable ledger, or a verdict without its receipt
    // on disk, fails closed to `unresolved`. Without a ledger the legacy
    // shape/allowlist/binding count applies; production hosts that need
    // durable consistent receipts must supply the ledger (the runtime does).
    // Disabled path: no assessments, no new uncertainty, bit-identical.
    let verificationReceipts: Set<string> | undefined;
    let verificationLedgerDown = false;
    if (trusted && ((args.criterionVerifications ?? []).length > 0 || (args.criterionSupplementalVerifications ?? []).length > 0) && args.ledger !== undefined) {
      try {
        const view = args.ledger.read();
        if (view.corrupt !== undefined) verificationLedgerDown = true;
        else verificationReceipts = verificationReceiptIds(view.records);
      } catch {
        verificationLedgerDown = true;
      }
    }
    const trustedAssessments = trusted
      ? validateCriterionVerifications({
          verifications: args.criterionVerifications ?? [],
          criteria: contract.criteria,
          missionRevision: contract.missionRevision,
          candidateDigest,
          ...(args.trustedVerifierIds === undefined ? {} : { verifierAllowlist: args.trustedVerifierIds }),
          ...(verificationReceipts === undefined
            ? (verificationLedgerDown ? { receiptsPresent: new Set<string>() } : {})
            : { receiptsPresent: verificationReceipts }),
        })
      : { assessments: [], overflow: 0 };
    const supplementalAssessments = trusted
      ? validateCriterionVerifications({
          verifications: args.criterionSupplementalVerifications ?? [],
          criteria: contract.criteria,
          missionRevision: contract.missionRevision,
          candidateDigest,
          ...(args.trustedVerifierIds === undefined ? {} : { verifierAllowlist: args.trustedVerifierIds }),
          ...(verificationReceipts === undefined
            ? (verificationLedgerDown ? { receiptsPresent: new Set<string>() } : {})
            : { receiptsPresent: verificationReceipts }),
        })
      : { assessments: [], overflow: 0 };
    const trustedQualification = trusted
      ? qualifyTrustedCriteria({
          criteria: contract.criteria,
          attested: new Set(
            contract.criteria
              .map((criterion) => criterion.id)
              .filter((id) => {
                const attestation = attestations.get(id);
                return attestation?.missionRevision === contract.missionRevision &&
                  /^[0-9a-f]{64}$/.test(attestation.promptHash) &&
                  typeof attestation.outcome === "string" && attestation.outcome.trim().length > 0;
              }),
          ),
          graphStates: graphBindingStates,
          verificationAssessments: trustedAssessments.assessments,
        })
      : [];
    const trustedQualificationByCriterion = new Map(trustedQualification.map((entry) => [entry.criterionId, entry]));
    const trustedAssessmentByCriterion = new Map(trustedAssessments.assessments.map((entry) => [entry.criterionId, entry]));

    let plannedStructures: CriterionCodeStructureEvidence[] = [];
    if (args.hostProofPlanDigest !== undefined) {
      const { analyzeCriterionTypeScriptStructure } = await import("./structural-analysis.js");
      plannedStructures = (args.criterionCodeFiles ?? []).map(({ criterionId, files }) => {
        const criterion = contract.criteria.find((entry) => entry.id === criterionId);
        if (criterion === undefined) throw new Error("host proof plan references a criterion outside the current contract");
        const structure = analyzeCriterionTypeScriptStructure({
          root: args.structuralAnalysisRoot ?? "",
          files,
          criterionId,
          proofObligationId: proofObligationId(criterionId, criterion.statement),
          missionRevision: contract.missionRevision,
          candidateDigest,
        });
        const plannedDigest = planCodeFileDigests?.filter((row) => row.criterionId === criterionId).sort((a, b) => a.path.localeCompare(b.path));
        if (JSON.stringify(structure.fileDigests) !== JSON.stringify(plannedDigest?.map(({ path, sha256: digest }) => ({ path, sha256: digest })))) {
          throw new Error("workspace source changed while constructing the host proof snapshot");
        }
        return structure;
      });
    }
    const criterionCodeStructure = [...(args.criterionCodeStructure ?? []), ...plannedStructures];
    const evidenceRevision = sha256(JSON.stringify({
      candidateRevision,
      attestations: contract.attestations ?? [],
      independentVerifications: contract.independentVerifications ?? [],
      // Present only when bindings are configured, so the default snapshot
      // (no bindings) hashes exactly as before this bridge existed. The
      // trusted path hashes its own inputs under distinct keys instead.
      ...(!trusted && bindings.length > 0 ? { criterionGraphBindings: bindings, graphBindingStates } : {}),
      ...(trusted
        ? {
            trustedGraphBindings: bindings,
            trustedGraphBindingStates: graphBindingStates,
            trustedCriterionVerifications: args.criterionVerifications ?? [],
            trustedSupplementalVerifications: args.criterionSupplementalVerifications ?? [],
            trustedVerifierIds: args.trustedVerifierIds ?? [],
            trustedProducerAssociations: args.criterionProducerAssociations ?? [],
            trustedCriterionCodeStructure: criterionCodeStructure,
            ...(args.hostProofPlanDigest === undefined ? {} : { trustedHostProofPlanDigest: args.hostProofPlanDigest }),
            // What was actually counted, not just what was supplied: a
            // pruned or never-persisted receipt changes the counted outcomes,
            // so it must change the revision `isCurrent` compares.
            trustedVerificationOutcomes: trustedAssessments.assessments.map((assessment) => ({
              criterionId: assessment.criterionId,
              outcome: assessment.outcome,
            })),
            trustedSupplementalOutcomes: supplementalAssessments.assessments.map((assessment) => ({
              criterionId: assessment.criterionId,
              outcome: assessment.outcome,
              receiptCorrelationId: assessment.receiptCorrelationId ?? null,
            })),
          }
        : {}),
    }));
    const criteria = contract.criteria.map((criterion) => {
      const attestation = attestations.get(criterion.id);
      const valid = attestation?.missionRevision === contract.missionRevision &&
        /^[0-9a-f]{64}$/.test(attestation.promptHash) &&
        typeof attestation.outcome === "string" && attestation.outcome.trim().length > 0;
      const graphEvidence = graphEvidenceByCriterion.get(criterion.id);
      const qualification = trustedQualificationByCriterion.get(criterion.id);
      const assessment = trustedAssessmentByCriterion.get(criterion.id);
      const supplementalAssessment = supplementalAssessments.assessments.find((entry) => entry.criterionId === criterion.id);
      const codeStructureRows = criterionCodeStructure.filter((row) => row.criterionId === criterion.id);
      const codeStructure = codeStructureRows.length === 1 &&
        codeStructureRows[0]?.missionRevision === contract.missionRevision &&
        codeStructureRows[0]?.candidateDigest === candidateDigest &&
        codeStructureRows[0]?.proofObligationId === buildMissionProofObligation({
          criterionId: criterion.id,
          requirement: criterion.statement,
          graphEvidence: graphEvidence ?? [],
        }).id &&
        codeStructureRows[0]?.provenance === "host:typescript-compiler/v1"
        ? codeStructureRows[0]
        : undefined;
      return {
        id: criterion.id,
        statement: criterion.statement,
        proofObligation: buildMissionProofObligation({
          criterionId: criterion.id,
          requirement: criterion.statement,
          graphEvidence: graphEvidence ?? [],
          ...(codeStructure === undefined ? {} : { codeStructure }),
        }),
        // Default path: execution traceability never verifies — `verified`
        // derives solely from user attestation. Trusted path: deterministic
        // qualification — attestation AND bound traceability AND a satisfied
        // revision-and-candidate-bound verification — with no auto-promotion
        // from graph success, verification, or attestation alone.
        verified: trusted ? qualification?.qualified === true : valid,
        ...(valid && attestation !== undefined && attestation.outcome !== undefined ? { outcome: attestation.outcome } : {}),
        ...(valid && attestation !== undefined ? { evidenceRef: `user-prompt:${attestation.promptHash}` } : {}),
        missionRevision: contract.missionRevision,
        evidenceRevision,
        ...(graphEvidence === undefined ? {} : { graphEvidence }),
        ...(trusted && assessment !== undefined
          ? {
              criterionVerification: {
                result: assessment.outcome,
                ...(assessment.verifierId === undefined ? {} : { verifierId: assessment.verifierId }),
                detail: assessment.detail,
                ...(assessment.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: assessment.receiptCorrelationId }),
                ...(assessment.evidenceRef === undefined ? {} : { evidenceRef: assessment.evidenceRef }),
                ...(assessment.observedResult === undefined ? {} : { observedResult: assessment.observedResult }),
                ...(assessment.adapterVersion === undefined ? {} : { adapterVersion: assessment.adapterVersion }),
                ...(assessment.graphNodes === undefined ? {} : { graphNodes: assessment.graphNodes }),
              },
            }
          : {}),
        ...(trusted && supplementalAssessment !== undefined && supplementalAssessment.outcome !== "unresolved"
          ? {
              supplementalVerifications: [{
                result: supplementalAssessment.outcome,
                ...(supplementalAssessment.verifierId === undefined ? {} : { verifierId: supplementalAssessment.verifierId }),
                detail: supplementalAssessment.detail,
                ...(supplementalAssessment.receiptCorrelationId === undefined ? {} : { receiptCorrelationId: supplementalAssessment.receiptCorrelationId }),
                ...(supplementalAssessment.evidenceRef === undefined ? {} : { evidenceRef: supplementalAssessment.evidenceRef }),
                ...(supplementalAssessment.observedResult === undefined ? {} : { observedResult: supplementalAssessment.observedResult }),
                ...(supplementalAssessment.adapterVersion === undefined ? {} : { adapterVersion: supplementalAssessment.adapterVersion }),
                ...(supplementalAssessment.graphNodes === undefined ? {} : { graphNodes: supplementalAssessment.graphNodes }),
              }],
            }
          : {}),
      };
    });

    return {
      missionId: contract.missionId,
      objective: contract.objective,
      ...(contract.objectiveCoverage === undefined
        ? { objectiveCoverage: { status: "missing" as const } }
        : {
            objectiveCoverage: {
              status: contract.objectiveCoverage.missionRevision === contract.missionRevision &&
                contract.objectiveCoverage.promptHash === contract.promptHash
                ? "attested" as const
                : "missing" as const,
              missionRevision: contract.objectiveCoverage.missionRevision,
              promptHash: contract.objectiveCoverage.promptHash,
              source: contract.objectiveCoverage.source,
            },
          }),
      missionRevision: contract.missionRevision,
      evidenceRevision,
      candidateDigest,
      candidateRevision,
      criteria,
      tests: {
        passed: testsPassed,
        // A locally observed passing test is execution success, never
        // independence. Independence requires a trusted, revision-bound
        // verifier attestation (e.g. Veyrict receipt).
        independent: latestIndependent !== undefined,
        ...(latestIndependent !== undefined
          ? { evidenceRef: `verifier:${latestIndependent.verifierId}:${latestIndependent.receiptCorrelationId}` }
          : verificationDigest === undefined ? {} : { evidenceRef: `verification:${verificationDigest}` }),
        revision: evidenceRevision,
      },
      // Fail-close only: unhealthy bindings add uncertainty (forcing
      // INCOMPLETE in preflight) and can never clear it. With no bindings
      // this is exactly `graph.uncertain`, as before. The trusted path
      // additionally fails closed on verification overflow past the bound.
      operations: { pending: pending + graph.pending, uncertain: graph.uncertain + graphBindingUncertain + trustedAssessments.overflow },
      blockers,
      graphRuns: graph.graphRuns,
      ...(trusted ? { requestProfile: MISSION_CLOSURE_REQUEST_PROFILE_V2 } : {}),
    };
  };

  return {
    async load(sessionId, missionId, signal, context) {
      if (signal?.aborted === true) throw new Error("mission evidence load aborted");
      return loadSnapshot(sessionId, missionId, context);
    },
    async isCurrent(sessionId, missionId, missionRevision, evidenceRevision, signal, context) {
      if (signal?.aborted === true) return false;
      try {
        const current = await loadSnapshot(sessionId, missionId, context);
        return current.missionRevision === missionRevision && current.evidenceRevision === evidenceRevision;
      } catch {
        return false;
      }
    },
  };
}
