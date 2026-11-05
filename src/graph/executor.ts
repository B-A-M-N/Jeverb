/**
 * Purpose: validate, traverse, and journal bounded DAG executions.
 * Ownership: graph scheduling, dependency gating, Jev branch admission, dynamic-predicate boundaries, and terminal node evidence.
 * Forbidden: provider calls, policy grants, or bypassing the deterministic authorizer for shell work.
 */
import { createHash } from "node:crypto";
import { mapWithConcurrency } from "../util/concurrency.js";
import { NullJournal, type JournalWriter } from "./journal.js";
import { buildTerminalResult, type TerminalOutcome } from "./terminal.js";
import type { GraphOutputArtifactStore } from "./artifact.js";
import type { ReviewLane, ReviewResult } from "../review/policy.js";
import type { Answer, Question } from "../decision/types.js";
import {
  admitProtectedSuccessor,
  classifyBranchTarget,
  type RoutingAdmission,
} from "../decision/routing.js";
import { expandGraphLoops, hashValue, nodeDescriptor, parseJevDecision, parseJevVerdict, topoSort, validateGraph, digestJevDecision, effectiveInputDigest, type EffectiveDepEvidence } from "./validate.js";
export { expandGraphLoops, graphDescriptor, graphHash, hashValue, nodeDescriptor, parseJevDecision, parseJevVerdict, validateGraph, digestJevDecision, effectiveInputDigest } from "./validate.js";
export type { EffectiveDepEvidence } from "./validate.js";

export type GraphCondition =
  | { node: string; field: "decision.verdict"; equals: "yes" | "no" | "unknown"; minConfidence?: number }
  | { node: string; field: "decision.choice"; question: string; equals: string; minConfidence?: number }
  | { node: string; field: "decision.score"; question: string; operator: "gte" | "lte"; value: number; minConfidence?: number }
  | { node: string; field: "review.lane"; equals: ReviewLane };

export interface GraphOutputBinding {
  /** A succeeded declared dependency whose output becomes a shell input. */
  from: string;
  /** Environment-variable suffix; exposed inside the sandbox as JIVE_REF_<as>. */
  as: string;
  /** Optional RFC 6901 JSON pointer into JSON output. */
  pointer?: string;
}

/** Bounded built-in extraction applied to a succeeded dependency before Jev. */
export interface GraphExtractorStep {
  from: string;
  as: string;
  extractor: string;
  config?: Record<string, import("../decision/types.js").Json>;
  /** Runtime-bound digest of the plugin module tree; caller input cannot set it. */
  moduleHash?: string;
  pointer?: string;
  maxItems?: number;
}

export interface GraphExpansionSpec {
  /** Declared dependency that produces a JSON array, or a JSON value selected by pointer. */
  itemsFrom: string;
  pointer?: string;
  /** Exposed to each template shell as JIVE_REF_<as>. */
  as: string;
  /** Hard item ceiling; never greater than 32. */
  maxItems: number;
  /** A bounded subgraph instantiated once per selected array item. Nested expansion is not supported. */
  nodes: GraphNode[];
}

export interface GraphNode {
  id: string;
  kind: "shell" | "jev" | "review" | "expand";
  command?: string;
  /** Legacy single yes/no question, normalized to a Noul question named `q`. */
  question?: string;
  /** Typed questions sent together against this node's dependency evidence. */
  questions?: Record<string, Question>;
  /** Review the output of this declared dependency as a unified diff. */
  diffFrom?: string;
  /** File paths associated with a review diff (metadata only). */
  files?: string[];
  /** Explicit dependency-output references, passed as bounded data to shell nodes. */
  bindings?: GraphOutputBinding[];
  /** Typed extraction pipeline for constructing Jev state from dependency output. */
  extractors?: GraphExtractorStep[];
  dependsOn?: string[];
  maxAttempts?: number;
  /** Run this node concurrently with other ready nodes in the same level. */
  parallel?: boolean;
  /**
   * Checked before authorization/run. `false` skips the node (not a failure).
   * A function predicate must be pure judgment over its inputs: it runs
   * under graph revocation authority and its late settlement is discarded,
   * so side effects in a predicate may execute without ever authorizing
   * the node — never perform them there.
   */
  when?: boolean | ((node: GraphNode, results: readonly ExecutorResult[]) => boolean | Promise<boolean>);
  /**
   * Serializable conditions over *declared dependency* results — the
   * plannable form of `when`. `whenAll` runs only if every listed
   * dependency succeeded; `whenAny` runs if at least one did. A referenced
   * dependency that did not succeed makes the condition unsatisfiable, so
   * the node is recorded `skipped`, never run on missing inputs. References
   * must name declared `dependsOn` entries: undeclared or unknown ids are
   * rejected at validation, and failed deps never contribute their outputs.
   */
  whenAll?: string[];
  whenAny?: string[];
  /**
   * Serializable decision predicate over a declared Jev dependency's typed
   * answer. Any missing, failed, low-confidence, or wrong-typed result skips
   * the node. A satisfied condition never authorizes anything: the
   * deterministic authorizer still runs before every shell attempt.
   */
  condition?: GraphCondition;
  /**
   * Bounded repetitions of a run, clamped to 1..3. Shell nodes repeat or
   * retry only with `idempotent: true`: re-running a state-changing command
   * without proving it idempotent is how partial executions double-apply.
   */
  repeat?: number;
  /** The operator asserts re-execution is safe (required for shell retries/repeats). */
  idempotent?: boolean;
  /** Internal execution identity assigned by structural loop expansion. */
  loopIteration?: { group: string; index: number };
  /** Persist the complete node output as a private artifact when explicitly requested. */
  captureOutput?: boolean;
  /** Present only on expand control nodes. */
  expansion?: GraphExpansionSpec;
  /** Internal item data assigned during runtime expansion; excluded from descriptors except by digest. */
  expansionItem?: { as: string; value: string; digest: string };
}

export interface Graph {
  version: 1;
  nodes: GraphNode[];
  /** Fixed-count structural loop groups. Every body node is expanded per iteration. */
  loops?: GraphLoopGroup[];
  /** Run every dependency level concurrently where nodes are independent. */
  parallel?: boolean;
}

export interface GraphLoopGroup {
  id: string;
  nodes: string[];
  iterations: number;
}

export interface Authorizer {
  authorize(node: GraphNode): Promise<{ allowed: boolean; reason?: string }>;
}

/**
 * Read-only view of *succeeded* dependency results offered to `run`. Only
 * nodes in `dependsOn` that settled with status `succeeded` appear here:
 * references to unavailable, skipped, blocked, failed, or cancelled outputs
 * are rejected by omission, so a judgment can never branch on content that
 * was never produced. Consumers must still treat every entry as data,
 * never as authority. Shell nodes may consume separately declared bounded
 * bindings; those values stay data in the runner environment and never become
 * command source.
 */
/** Serialized evidence from one succeeded dependency, safe to send to a model. */
export interface DepEvidence {
  id: string;
  status: "succeeded" | "output_unavailable";
  output: string;
}

/** Maximum characters of dependency output forwarded as Jev evidence. */
export const MAX_DEP_EVIDENCE_CHARS = 1000;

/**
 * Collect evidence from a node's succeeded dependencies. Failed, skipped,
 * blocked, cancelled, or unsettled dependencies are never exposed as
 * content — see {@link NodeRunContext} — so callers do not reimplement the
 * filter and drift from it.
 */
export function collectDepEvidence(node: GraphNode, ctx: NodeRunContext): DepEvidence[] {
  return (node.dependsOn ?? []).flatMap<DepEvidence>((id) => {
    const dep = ctx.results.get(id);
    if (dep === undefined || dep.status !== "succeeded") return [];
    return dep.outputAvailable === false
      ? [{ id: dep.nodeId, status: "output_unavailable" as const, output: "" } satisfies DepEvidence]
      : [{ id: dep.nodeId, status: "succeeded" as const, output: dep.output.slice(0, MAX_DEP_EVIDENCE_CHARS) } satisfies DepEvidence];
  });
}

/**
 * Build the standard Jev state for a graph node: the node's own question
 * plus succeeded-dependency evidence. Jev decisions read prior results from
 * here — never from shell interpolation.
 */
export function buildJevState(
  node: GraphNode,
  ctx: NodeRunContext,
  extracted: Record<string, import("../decision/types.js").Json> = Object.create(null),
): { node: string; question: string; depOutputs: Record<string, { status: string; output: string }>; extracted: Record<string, import("../decision/types.js").Json>; expansionItem?: import("../decision/types.js").Json } {
  const depOutputs: Record<string, { status: string; output: string }> = {};
  for (const dep of collectDepEvidence(node, ctx)) {
    depOutputs[dep.id] = { status: dep.status, output: dep.output };
  }
  return {
    node: node.id,
    question: node.question ?? "",
    depOutputs,
    extracted,
    ...(node.expansionItem === undefined ? {} : { expansionItem: JSON.parse(node.expansionItem.value) as import("../decision/types.js").Json }),
  };
}

export interface NodeRunContext {
  results: ReadonlyMap<string, ExecutorResult>;
  /** All completed graph results, used by the trusted dynamic-expansion controller. */
  allResults?: ReadonlyMap<string, ExecutorResult>;
  /** Full successful dependency output, kept inside this run and never returned in result envelopes. */
  fullOutputs: ReadonlyMap<string, string>;
  /**
   * Graph-level signal: the caller's signal combined with the graph deadline.
   * Node runners must honor it so a graph timeout actually stops in-flight
   * work instead of merely preventing the next attempt.
   */
  signal?: AbortSignal;
  /** Milliseconds of graph budget remaining when this node started, if bounded. */
  deadlineMs?: number;
}

export type NodeStatus = "succeeded" | "failed" | "skipped" | "blocked" | "cancelled" | "outcome_unknown";

/**
 * Typed Jev judgment carried by a jev node's result. This — not the
 * presentation text in `output` — is what decision predicates read.
 * `verdict`/`noul` come from the model evaluation; `calibrated` records
 * whether the answering backend+model+questions were calibration-pinned.
 */
export interface JevDecision {
  answers?: Record<string, Answer>;
  /** Backend that produced the numbers (never inferred from model id). */
  provider: string;
  /** Versioned model id that actually answered; absent for legacy/stub decisions. */
  model?: string;
  /** sha256 of the exact question set answered. */
  questionHash: string;
  /** Whether this judgment ran under a calibration-pinned policy. */
  calibrated: boolean;
  /** Compatibility projection for legacy `decision.verdict` conditions. */
  verdict?: "yes" | "no" | "unknown";
  /** P(yes) for the legacy `q` Noul question. */
  noul?: number;
}

export interface ExecutorResult {
  nodeId: string;
  ok: boolean;
  /** Truncated excerpt (first 4000 chars) for display. */
  output: string;
  /** False when a successful node was resumed from digest-only journal data. */
  outputAvailable?: boolean;
  attempts: number;
  status: NodeStatus;
  /** sha256 of the stable node descriptor (id/kind/command/question/deps). */
  inputHash: string;
  /** sha256 of the recorded (possibly truncated) output excerpt. */
  outputHash: string;
  /**
   * sha256 of the FULL node output, not the excerpt. Hashing only the
   * returned excerpt would attest to 4000 characters while claiming the
   * whole command output — the digest covers everything the command
   * produced, the excerpt is presentation.
   */
  outputDigest: string;
  /**
   * Typed judgment for jev nodes. Decision predicates read this field;
   * `output` text is presentation only. Absent for shell nodes and for
   * custom run functions that return plain strings (legacy path: the
   * predicate falls back to parsing the verdict line, if present).
   */
  jev?: JevDecision;
  /** Full typed review result; lane alone never grants execution authority. */
  review?: ReviewResult;
  outputArtifact?: string;
  outputArtifactError?: string;
  /** Set when resume reuses a prior run's outcome instead of executing now. */
  resumed?: boolean;
}

/** Prior run evidence for crash recovery: skip what already succeeded. */
export interface ResumePlan {
  /**
   * Terminal outcomes from `reconcileJournal`, keyed by node id. Reuse is
   * admitted only when every identity agrees: `status` succeeded, the
   * static `inputHash` matches, the graph `revisionHash` matches, the
   * recorded `branch` equals the branch selected by this run's evaluation,
   * and the canonical `effectiveInputHash` (policy + descriptor + revision
   * + runtime dependency evidence/decisions) matches this run's evidence.
   * A static match with changed evidence is a new revision, never a
   * reinterpretable old outcome. Jev nodes additionally require the
   * recorded `jev` decision; without it there is nothing deterministic
   * to replay.
   */
  prior: ReadonlyMap<string, {
    status: string;
    inputHash?: string;
    outputDigest?: string;
    outputArtifact?: string;
    jev?: JevDecision;
    effectiveInputHash?: string;
    revisionHash?: string;
    branch?: string;
  }>;
  /** sha256 of the graph the prior run executed: a different graph refuses, it never resumes. */
  priorGraphHash?: string;
  /** Run id the prior outcomes came from, for resumed-record attribution. */
  priorRunId?: string;
}

export interface ExecuteOptions {
  /** Max nodes in flight within one level. Defaults to 4; never unbounded. */
  maxParallel?: number;
  /** Whole-graph wall-clock budget in ms. Remaining nodes are cancelled. */
  timeoutMs?: number;
  /**
   * Caller abort signal. The executor removes its listener on every exit
   * path, so a shared long-lived signal never accumulates listeners.
   *
   * Shutdown contract (logical deadline vs physical termination): revocation
   * (caller abort or `timeoutMs` expiry) is a *logical* deadline — no new
   * attempt is admitted and late settlements cannot authorize execution.
   * Physical termination depends on the runner. The sandbox shell runner
   * enforces it: the abort signal and per-node timeout reach `execFile`,
   * which kills the `systemd-run` scope leader inside the `bwrap` sandbox,
   * and child exit confirms termination. A generic async runner receives
   * only the abort signal via `NodeRunContext.signal`; the executor cannot
   * force-stop code that ignores it. Such a runaway delays graph completion
   * but gains nothing: its late result is recorded `cancelled` (or
   * `outcome_unknown` when side effects are uncertain), never success.
   * Never claim a process stopped merely because its promise was abandoned.
   */
  signal?: AbortSignal;
  /**
   * Crash-recovery resume: reuse prior succeeded outcomes instead of
   * re-executing them. This is explicit operator action (restart), never a
   * blind retry — and re-authorization still gates every re-executed node.
   */
  resume?: ResumePlan;
  /**
   * Allow bounded retries/repeats of shell nodes the author marked
   * `idempotent: true`. Default `false`: author assertion alone never
   * re-executes a state-changing command — only an explicit operator
   * profile enables it. The tool wires this from `ExecutionPolicy`.
   */
  allowShellRetry?: boolean;
  /**
   * Fingerprint of the execution policy (workspace, timeouts, network,
   * retry regime). Mixed into every node input hash so identical node text
   * under different behavior-affecting configuration never shares a hash.
   */
  policyHash?: string;
  /**
   * Durable per-node journal. Every state transition is persisted; omit it
   * (or pass NullJournal) only when the caller accepts losing crash
   * recovery for this run.
   */
  journal?: JournalWriter;
  /** Stable run identifier stamped on every journal event. */
  runId?: string;
  /** Effective resource ceilings, recorded in run-started as enforcement evidence. */
  resourceLimits?: { maxMemoryMb: number; maxProcesses: number; maxFileBytes: number; maxCpuSeconds: number };
  outputArtifacts?: GraphOutputArtifactStore;
  outputArtifactsAllowed?: boolean;
  /** Existing succeeded dependency results for a bounded dynamic subgraph. */
  initialResults?: readonly ExecutorResult[];
  /** Complete output of those existing dependencies, when available in this run. */
  initialFullOutputs?: ReadonlyMap<string, string>;
  /**
   * Authenticated principal for this run (e.g. `unverified:mcp-stdio`).
   * Never derived from the model-supplied `source`: that string is the
   * *claimed* submitter, recorded separately as such.
   */
  principal?: string;
  /** Candidate/operation correlation supplied out-of-band. */
  candidate?: string;
  /** sha256 of the canonical graph, recorded in run-started. */
  graphHash?: string;
  /** Declared submitter, recorded in run-started for attribution. */
  source?: string;
  /**
   * Consequential-routing admission provisioned by the enforcement boundary
   * (verifier-attested qualification + the deployment identity actually
   * run). Shell nodes dispatched on a Jev decision are protected
   * successors: without admission their branch is refused and they settle
   * `skipped`, however permissive the shell policy. Absent = no
   * consequential routes. Never populated from caller/graph input.
   */
  routing?: RoutingAdmission;
}

const DEFAULT_MAX_PARALLEL = 4;

function clampRepeat(repeat: number | undefined): number {
  if (repeat === undefined || !Number.isFinite(repeat)) return 1;
  return Math.max(1, Math.min(Math.floor(repeat), 3));
}

function levelOf(node: GraphNode, byId: Map<string, GraphNode>, memo: Map<string, number>): number {
  const cached = memo.get(node.id);
  if (cached !== undefined) return cached;
  let level = 0;
  for (const dep of node.dependsOn ?? []) {
    const depNode = byId.get(dep);
    if (depNode) level = Math.max(level, levelOf(depNode, byId, memo) + 1);
  }
  memo.set(node.id, level);
  return level;
}

function cancelled(deadline: number, signal: AbortSignal | undefined): boolean {
  return Date.now() >= deadline || signal?.aborted === true;
}

export async function executeGraph(
  graph: Graph,
  authorizer: Authorizer,
  run: (node: GraphNode, ctx: NodeRunContext) => Promise<string | {
    output: string;
    jev?: JevDecision;
    review?: ReviewResult;
    ok?: boolean;
    childResults?: ExecutorResult[];
  }>,
  opts: ExecuteOptions = {},
): Promise<ExecutorResult[]> {
  graph = expandGraphLoops(graph);
  const errors = validateGraph(graph);
  if (errors.length > 0) throw new Error(`invalid graph: ${errors.join("; ")}`);
  // Resume targets the same graph: a prior hash for a different graph
  // refuses outright. Per-node input hashes are checked at dispatch, so an
  // edited node or changed policy re-executes instead of inheriting stale
  // success.
  if (opts.resume?.priorGraphHash !== undefined && opts.graphHash !== undefined &&
      opts.resume.priorGraphHash !== opts.graphHash) {
    throw new Error("resume refused: prior graph hash does not match this graph");
  }
  const ordered = topoSort(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const dependents = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn ?? []) {
      const children = dependents.get(dependency) ?? [];
      children.push(node);
      dependents.set(dependency, children);
    }
  }
  const expansionContainsShell = (nodes: readonly GraphNode[]): boolean => {
    const templateDependents = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      for (const dependency of node.dependsOn ?? []) {
        const children = templateDependents.get(dependency) ?? [];
        children.push(node);
        templateDependents.set(dependency, children);
      }
    }
    const visit = (nodeId: string, seen = new Set<string>()): boolean => {
      if (seen.has(nodeId)) return false; // graph validation rejects cycles
      const path = new Set(seen).add(nodeId);
      return (templateDependents.get(nodeId) ?? []).some((child) =>
        child.kind === "shell" ||
        (child.kind === "expand" && child.expansion !== undefined && expansionContainsShell(child.expansion.nodes)) ||
        visit(child.id, path),
      );
    };
    return nodes.some((node) => node.kind === "shell" ||
      (node.kind === "expand" && node.expansion !== undefined && expansionContainsShell(node.expansion.nodes)) ||
      visit(node.id));
  };
  const shellDescendantMemo = new Map<string, boolean>();
  const hasShellDescendant = (nodeId: string, visiting = new Set<string>()): boolean => {
    const cached = shellDescendantMemo.get(nodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(nodeId)) return false; // validation already rejects cycles
    const path = new Set(visiting).add(nodeId);
    const result = (dependents.get(nodeId) ?? []).some((child) => {
      if (child.kind === "shell") return true;
      if (child.kind === "expand" && child.expansion !== undefined && expansionContainsShell(child.expansion.nodes)) return true;
      return hasShellDescendant(child.id, path);
    });
    shellDescendantMemo.set(nodeId, result);
    return result;
  };
  const expandedShellIds = new Set(graph.nodes
    .filter((node) => node.kind === "expand" && node.expansion !== undefined && expansionContainsShell(node.expansion.nodes))
    .map((node) => node.id));
  const graphHasJevNode = graph.nodes.some((node) => node.kind === "jev");
  const memo = new Map<string, number>();
  const levels = new Map<number, GraphNode[]>();
  for (const node of ordered) {
    const level = levelOf(node, byId, memo);
    const bucket = levels.get(level) ?? [];
    bucket.push(node);
    levels.set(level, bucket);
  }

  const maxParallel = Math.max(1, Math.min(Math.floor(opts.maxParallel ?? DEFAULT_MAX_PARALLEL), 64));
  const deadline = opts.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + opts.timeoutMs;
  // One graph-level controller: the caller's signal plus the graph deadline.
  // In-flight nodes receive the combined signal through the run context, so
  // cancellation actually stops running work (and reaps the sandboxed process
  // tree via the runner) instead of only gating the next attempt.
  const graphAbort = new AbortController();
  // Abort-cause tracking: only caller abort and deadline expiry revoke the
  // run. Sibling-failure preemption is deliberately level-scoped (see the
  // per-level controller below): it interrupts cooperating in-flight work,
  // but it is NOT a revocation — it never rewrites an already-completed
  // attempt and never halts conditional rescue paths in later levels.
  // Caller abort wins over deadline expiry.
  let abortCause: "caller" | "deadline" | null = null;
  const abortWithCause = (cause: "caller" | "deadline"): void => {
    if (cause === "caller" || abortCause === null) abortCause = cause;
    graphAbort.abort();
  };
  const callerSignal = opts.signal;
  // Named (not inline) so the outer finally can remove it: with `{ once: true }`
  // the listener self-removes only when abort fires, so a normally-completing
  // run would otherwise retain one listener per execution on the caller's
  // long-lived signal.
  const onCallerAbort = (): void => abortWithCause("caller");
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) abortWithCause("caller");
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (Number.isFinite(deadline)) {
    const remaining = Math.max(0, deadline - Date.now());
    deadlineTimer = setTimeout(() => abortWithCause("deadline"), remaining);
  }
  const graphSignal = graphAbort.signal;
  /** True only when the run itself was revoked (caller abort or deadline). */
  const revoked = (): boolean =>
    abortCause === "caller" || abortCause === "deadline" || Date.now() >= deadline;
  // Signal observed by the currently-executing level. The master graph
  // signal carries caller abort and deadline expiry; each level layers a
  // scoped controller so sibling-failure preemption interrupts only that
  // level's in-flight work and never poisons later levels.
  let activeSignal: AbortSignal = graphSignal;
  const shellRetry = opts.allowShellRetry === true;

  const results: ExecutorResult[] = [];
  const byResult = new Map((opts.initialResults ?? []).map((result) => [result.nodeId, result]));
  const fullOutputs = new Map(opts.initialFullOutputs ?? []);
  const nestedResults = new WeakMap<ExecutorResult, ExecutorResult[]>();
  let halted: { status: "blocked" | "cancelled"; reason: string } | null = null;

  const record = (result: ExecutorResult): void => {
    for (const child of nestedResults.get(result) ?? []) record(child);
    results.push(result);
    byResult.set(result.nodeId, result);
  };

  const policyTag = opts.policyHash ?? "no-policy";
  /** Behavior-affecting configuration feeds every input hash, not just node text. */
  const hashInput = (node: GraphNode): string => hashValue(`${policyTag}\n${nodeDescriptor(node)}`);
  /**
   * Runtime evidence snapshot for one node: the statuses, output digests,
   * and typed Jev/review judgments its gates would read right now.
   * Dependencies settle in strictly earlier levels, so this snapshot is
   * stable from dispatch through execution. Resumed dependencies
   * contribute their journaled digests (not availability, which is enforced
   * separately via `output_unavailable`), so a resumed chain replays with
   * the same effective identity it first settled under.
   */
  const evidenceFor = (node: GraphNode): EffectiveDepEvidence[] =>
    (node.dependsOn ?? []).flatMap((id): EffectiveDepEvidence[] => {
      const dep = byResult.get(id);
      if (dep === undefined) return [];
      const entry: EffectiveDepEvidence = { id, status: dep.status, outputDigest: dep.outputDigest };
      const decision = dep.jev ?? parseJevDecision(dep.output);
      if (decision !== undefined) entry.decisionDigest = digestJevDecision(decision);
      if (dep.review?.lane !== undefined) entry.lane = dep.review.lane;
      return [entry];
    });
  /** Canonical effective-input digest for one node under current evidence. */
  const effectiveHashFor = (node: GraphNode): string =>
    effectiveInputDigest({
      policyTag,
      node,
      evidence: evidenceFor(node),
      ...(opts.graphHash === undefined ? {} : { revision: opts.graphHash }),
    });
  /**
   * Branch selected by the gate evaluation that admitted each node this
   * run (join refs satisfied, condition needed vs observed). Reuse of a
   * prior outcome requires the same branch: a changed branch is a
   * different outcome, never a re-execution of the recorded one.
   */
  const selectedBranches = new Map<string, string>();
  /**
   * Decision evidence for the journal: which decision family each admitted
   * or refused branch was evaluated under, and whether the judgment was
   * allowed to select a consequential branch. Read by the terminal wrapper
   * so every settlement persists its routing evidence for replay.
   */
  const selectedDecisions = new Map<string, {
    kind: "routing" | "authorization" | "verification";
    mode: "advisory" | "consequential";
    qualificationId?: string;
    modelVersion?: string;
  }>();
  const journal: JournalWriter = opts.journal ?? new NullJournal();
  /**
   * Authorization bounded by graph revocation: a grant that arrives after
   * caller abort or deadline expiry can neither delay the graph nor start
   * work under an obsolete execution context. A hung authorizer therefore
   * cannot hold the graph past its deadline. Rejections still propagate —
   * a failing authorizer is an executor error, not a denial.
   */
  const authorizeBounded = async (node: GraphNode): Promise<{ allowed: boolean; reason?: string } | "revoked"> => {
    const pending = authorizer.authorize(node);
    pending.catch(() => {});
    if (graphSignal.aborted) return "revoked";
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"revoked">((resolve) => {
      onAbort = () => resolve("revoked");
      graphSignal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      if (onAbort !== undefined) graphSignal.removeEventListener("abort", onAbort);
    }
  };
  /**
   * Condition evaluation bounded by graph revocation: a predicate that
   * resolves after caller abort or deadline expiry cannot admit its node,
   * and a predicate that never settles cannot hold the graph past its
   * deadline. Cancellation takes precedence over a late true/false —
   * a revoked run settles the unevaluated node as cancelled with zero
   * attempts, never as skipped. Predicate errors still propagate to the
   * caller's failed path (a throwing condition is a node failure, not
   * proof its dependencies were unmet).
   */
  const evaluateWhen = async (node: GraphNode, prior: readonly ExecutorResult[]): Promise<boolean | "revoked"> => {
    const predicate = node.when;
    if (typeof predicate !== "function") return predicate ?? true;
    if (revoked()) return "revoked";
    const pending = (async (): Promise<boolean> => predicate(node, prior))();
    pending.catch(() => {});
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"revoked">((resolve) => {
      onAbort = () => resolve("revoked");
      graphSignal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      if (onAbort !== undefined) graphSignal.removeEventListener("abort", onAbort);
    }
  };
  const rid = opts.runId ?? "adhoc";
  journal.record({
    type: "run-started",
    runId: rid,
    ts: new Date().toISOString(),
    ...(opts.graphHash === undefined ? {} : { graphHash: opts.graphHash }),
    policyHash: policyTag,
    ...(opts.source === undefined ? {} : { claimedSource: opts.source }),
    ...(opts.principal === undefined ? {} : { principal: opts.principal }),
    ...(opts.candidate === undefined ? {} : { candidate: opts.candidate }),
    ...(opts.resourceLimits === undefined ? {} : { resourceLimits: opts.resourceLimits }),
  });
  /**
   * Single terminal-result constructor: every settled node passes through
   * here, so excerpt hashes, full-output digests, and journal terminal
   * records are never omitted on any path. Logic lives in `terminal.ts`;
   * this wrapper supplies the run's context.
   */
  const terminal = (node: GraphNode, outcome: TerminalOutcome): ExecutorResult => buildTerminalResult(node, outcome, {
    policyTag,
    runId: rid,
    journal,
    fullOutputs,
    outputArtifactsAllowed: opts.outputArtifactsAllowed,
    outputArtifacts: opts.outputArtifacts,
    cancelled: graphSignal.aborted,
    effectiveInputHash: effectiveHashFor(node),
    ...(opts.graphHash === undefined ? {} : { revisionHash: opts.graphHash }),
    ...(selectedBranches.has(node.id) ? { branch: selectedBranches.get(node.id)! } : {}),
    ...(selectedDecisions.has(node.id) ? { decision: selectedDecisions.get(node.id)! } : {}),
  });
  /** Every settled node passes through here, so hashes are never omitted. */
  const settle = (
    node: GraphNode,
    outcome: { ok: boolean; output: string; attempts: number; status: NodeStatus },
  ): void => {
    record(terminal(node, { ok: outcome.ok, fullOutput: outcome.output, attempts: outcome.attempts, status: outcome.status }));
  };

  const executeNode = async (node: GraphNode): Promise<ExecutorResult> => {
    if (node.kind === "shell" && node.loopIteration !== undefined && !shellRetry) {
      return terminal(node, {
        ok: false,
        fullOutput: "blocked: structural shell loops require operator-enabled shell retry policy",
        attempts: 0,
        status: "blocked",
      });
    }
    // Authorization is revalidated immediately before every attempt, not
    // once per node: a grant observed before attempt 1 says nothing about
    // attempt 2.
    // Shell re-execution needs two independent facts: the author marked the
    // node idempotent AND the operator enabled shell retries. Either alone
    // runs the command at most once — a model asserting idempotency is not
    // authority to repeat a state-changing command.
    const shellRetryable = node.idempotent === true && shellRetry;
    const hasCustomExtractor = node.kind === "jev" && (node.extractors ?? []).some(
      (extractor) => extractor.extractor !== "json" && extractor.extractor !== "lines",
    );
    // A custom extractor can perform authorized helper/network effects. Once
    // its node starts, a generic Jev retry could repeat those effects.
    const retryable = (node.kind !== "shell" && !hasCustomExtractor) || shellRetryable;
    const maxAttempts = retryable ? Math.max(1, Math.min(node.maxAttempts ?? 1, 3)) : 1;
    const repeats = node.kind !== "shell" || shellRetryable ? clampRepeat(node.repeat) : 1;
    let attempts = 0;
    let attemptSeq = 0;
    let childResults: ExecutorResult[] = [];
    const failed = (fullOutput: string): ExecutorResult => {
      const result = terminal(node, {
        ok: false,
        fullOutput: hasCustomExtractor && !/^outcome_unknown:/.test(fullOutput)
          ? `outcome_unknown: custom extractor node may have performed side effects; reconcile before retrying. ${fullOutput}`
          : fullOutput,
        attempts,
        status: hasCustomExtractor || /^outcome_unknown:/.test(fullOutput) ? "outcome_unknown" : "failed",
      });
      if (childResults.length > 0) nestedResults.set(result, childResults);
      return result;
    };
    for (let iteration = 0; iteration < repeats; iteration += 1) {
      let iterationOk = false;
      let output = "";
      let iterationJev: JevDecision | undefined;
      let iterationReview: ReviewResult | undefined;
      let iterationChildren: ExecutorResult[] = [];
      for (let attempt = 0; attempt < maxAttempts && !iterationOk; attempt += 1) {
        // Revocation (caller abort, deadline) stops new attempts. Level
        // preemption alone does not stop later levels: a conditional rescue
        // node admitted after a sibling failure runs under a fresh level
        // signal. But a node authorized after its own level was preempted
        // must not start: the grant arrived under an obsolete context.
        if (revoked()) {
          return terminal(node, {
            ok: false,
            fullOutput: "cancelled: graph deadline or abort",
            attempts,
            status: "cancelled",
          });
        }
        // `attempts` counts executions, not authorization checks: a denial
        // returns before any execution, so 0 attempts proves the command
        // never ran. The counter increments only once execution proceeds.
        const auth = await authorizeBounded(node);
        // A revoked run never starts newly approved work: the late grant
        // arrived under an obsolete execution context.
        if (auth === "revoked" || revoked()) {
          return terminal(node, {
            ok: false,
            fullOutput: "cancelled: graph deadline or abort during authorization",
            attempts,
            status: "cancelled",
          });
        }
        if (!auth.allowed) {
          journal.record({
            type: "node-authorized",
            runId: rid,
            ts: new Date().toISOString(),
            nodeId: node.id,
            allowed: false,
            reason: auth.reason ?? "denied",
            inputHash: hashInput(node),
          });
          return terminal(node, {
            ok: false,
            fullOutput: auth.reason ?? "denied",
            attempts,
            status: "blocked",
          });
        }
        // Level preemption is not revocation, but it ends this level's
        // admission: a sibling already failed, so a grant that arrived after
        // the failure must not start a new side-effecting operation. Nodes
        // in later levels run under a fresh signal and are unaffected.
        // `attempts` is still 0 on the first attempt, proving the command
        // never ran — distinct from an interrupted attempt, whose side
        // effects are uncertain and reconcile as outcome_unknown.
        if (activeSignal.aborted) {
          return terminal(node, {
            ok: false,
            fullOutput: "blocked: level preempted by sibling failure after authorization",
            attempts,
            status: "blocked",
          });
        }
        attempts += 1;
        attemptSeq += 1;
        const attemptId = `${node.id}/${attemptSeq}`;
        journal.record({
          type: "node-authorized",
          runId: rid,
          ts: new Date().toISOString(),
          nodeId: node.id,
          attemptId,
          allowed: true,
          inputHash: hashInput(node),
        });
        // Persisted BEFORE invoking the side-effecting command: a crash
        // after this point leaves a `running` record with no terminal, and
        // reconciliation classifies it outcome_unknown — never success,
        // never a silent retry.
        journal.record({
          type: "node-running",
          runId: rid,
          ts: new Date().toISOString(),
          nodeId: node.id,
          attemptId,
          inputHash: hashInput(node),
        });
        try {
          // Dependency results are data for the judgment, never authority:
          // the authorizer above already decided this attempt may run. Only
          // succeeded dependencies are visible; anything else is omitted.
          const succeeded = new Map<string, ExecutorResult>();
          for (const dep of node.dependsOn ?? []) {
            const depResult = byResult.get(dep);
            if (depResult !== undefined && depResult.status === "succeeded") succeeded.set(dep, depResult);
          }
          // Remaining graph budget travels with the run: the runner clamps
          // its own timeout to it and aborts on the combined signal, so a
          // per-node budget cannot overrun a nearly-spent graph budget.
          const remainingMs =
            Number.isFinite(deadline) && !activeSignal.aborted ? Math.max(0, deadline - Date.now()) : undefined;
          const ctx: NodeRunContext = {
            results: succeeded,
            allResults: byResult,
            fullOutputs,
            signal: activeSignal,
            ...(remainingMs === undefined ? {} : { deadlineMs: remainingMs }),
          };
          const produced = await run(node, ctx);
          if (typeof produced === "string") {
            output = produced;
            iterationJev = undefined;
            iterationReview = undefined;
            iterationChildren = [];
          } else {
            output = produced.output;
            iterationJev = produced.jev;
            iterationReview = produced.review;
            iterationChildren = produced.childResults ?? [];
            iterationOk = produced.ok !== false;
          }
          // A revoked run (caller abort, deadline) can race with a provider
          // or custom runner that ignores its signal and resolves normally.
          // Never turn that late result into a success. Shell/custom
          // extractor outcomes may have side effects; retain an uncertainty
          // classification for reconciliation. Sibling-failure preemption is
          // not revocation: an attempt that ran to completion keeps its real
          // outcome — the graph continues, and downstream conditions must
          // read what actually happened, not the interruption.
          if (revoked()) {
            const uncertain = node.kind === "shell" || hasCustomExtractor;
            return terminal(node, {
              ok: false,
              fullOutput: uncertain
                ? "outcome_unknown: graph cancelled while node was running; reconcile possible side effects"
                : "cancelled: graph deadline or abort during execution",
              attempts,
              status: uncertain ? "outcome_unknown" : "cancelled",
            });
          }
          if (typeof produced === "string" || produced.ok !== false) iterationOk = true;
        } catch (error) {
          // An abort that lands mid-attempt is cancellation, not failure:
          // the run was stopped, not disproven. Anything else fails.
          if (cancelled(deadline, activeSignal)) {
            return terminal(node, {
              ok: false,
              fullOutput: node.kind === "shell" || hasCustomExtractor
                ? "outcome_unknown: node was aborted while running; side effects require reconciliation"
                : "cancelled: graph deadline or abort during execution",
              attempts,
              status: node.kind === "shell" || hasCustomExtractor ? "outcome_unknown" : "cancelled",
            });
          }
          output = error instanceof Error ? error.message : String(error);
          // Once any node reports uncertain side effects, do not consume a
          // retry budget. Plugins may invoke authorized helpers too.
          if (/^outcome_unknown:/.test(output)) break;
        }
      }
      if (!iterationOk) {
        childResults = iterationChildren;
        return failed(output);
      }
      if (iteration === repeats - 1) {
        const result = terminal(node, {
          ok: true,
          fullOutput: output,
          attempts,
          status: "succeeded",
          ...(iterationJev === undefined ? {} : { jev: iterationJev }),
          ...(iterationReview === undefined ? {} : { review: iterationReview }),
        });
        if (iterationChildren.length > 0) nestedResults.set(result, iterationChildren);
        return result;
      }
    }
    // Unreachable: repeats >= 1 always returns inside the loop.
    return failed("internal error");
  };

  // try/finally: an escaping executor error (e.g. a throwing authorizer)
  // must still clear the deadline timer, so a failed run never holds the
  // event loop past its budget.
  try {
    for (const level of [...levels.keys()].sort((a, b) => a - b)) {
      // Level-scoped preemption: a sibling failure aborts this level's
      // controller only, so in-flight siblings observe cancellation while
      // later levels start from a clean signal and conditional rescue paths
      // still evaluate. Caller abort and deadline expiry propagate from the
      // master controller into every level.
      const levelAbort = new AbortController();
      const propagateMaster = (): void => levelAbort.abort();
      if (graphAbort.signal.aborted) propagateMaster();
      else graphAbort.signal.addEventListener("abort", propagateMaster, { once: true });
      activeSignal = levelAbort.signal;
      // Level-scoped finally: the master→level propagation listener is removed
      // on every exit path, including an escaping executor error. (The body
      // keeps its indentation; only the boundaries changed.)
      try {
      const candidates: GraphNode[] = [];
      for (const node of levels.get(level) ?? []) {
        if (byResult.has(node.id)) continue; // idempotent de-duplication within one run
        const priorHit = opts.resume?.prior.get(node.id);
        if (priorHit?.status === "outcome_unknown") {
          settle(node, {
            ok: false,
            output: "blocked: prior node outcome is unknown; inspect its side effects before authorizing a new run",
            attempts: 0,
            status: "blocked",
          });
          continue;
        }
        // Only a revoked run halts everything here. Sibling-failure
        // preemption falls through: the failed level already recorded a
        // `blocked` halt, which stops ordinary nodes but still admits
        // conditional nodes that opted into running despite failures
        // (rescue paths) and records unsatisfiable ones `skipped`.
        if (revoked()) {
          halted = { status: "cancelled", reason: "cancelled: graph deadline or abort" };
          settle(node, { ok: false, output: halted.reason, attempts: 0, status: "cancelled" });
          continue;
        }
        const missing = (node.dependsOn ?? []).find((dep) => byResult.get(dep) === undefined);
        if (missing !== undefined) {
          settle(node, { ok: false, output: `blocked: dependency ${missing} unsettled`, attempts: 0, status: "blocked" });
          continue;
        }
        // (Resume of prior success happens after gate evaluation below: no
        // outcome is inherited before the current run's branches decide.)
        if (
          node.kind === "shell" &&
          priorHit?.status === "succeeded" &&
          priorHit.inputHash !== hashInput(node) &&
          !(node.idempotent === true && shellRetry)
        ) {
          settle(node, {
            ok: false,
            output: "blocked: a changed command cannot reuse prior success or rerun without idempotency and retry policy authorization",
            attempts: 0,
            status: "blocked",
          });
          continue;
        }
        if (node.kind === "shell" && priorHit?.status === "failed" && !(node.idempotent === true && shellRetry)) {
          settle(node, {
            ok: false,
            output: "blocked: prior shell failure is not safe to retry without both idempotent:true and retry policy authorization",
            attempts: 0,
            status: "blocked",
          });
          continue;
        }
        // Traversal semantics (explicit — every gate form behaves the same):
        // - Branch activation: a node runs only when its gates admit it.
        //   `whenAll` is an AND join over succeeded refs, `whenAny` an OR
        //   join (at least one succeeded ref); both present means both joins
        //   must hold. `condition` is an additional AND over the typed
        //   judgment of one declared Jev/review dependency. A bare
        //   `when` predicate is the same admission choice in function form.
        // - Skip vs blocked propagation: an admitted-but-unsatisfied gate
        //   settles `skipped` (ok, branch not taken); a missing, failed, or
        //   unmet dependency with no gate to excuse it settles `blocked`
        //   (not ok). Terminal-state determination is therefore structural:
        //   skipped = a gate declined, blocked = an input was unavailable,
        //   failed/outcome_unknown = an attempt ran and did not succeed.
        // - A failure halts the graph for ordinary nodes — but a node with
        //   ANY gate form (joins, typed condition, or function predicate)
        //   explicitly opted into running despite failures, so it still
        //   gets evaluated: a satisfied gate runs (rescue paths), an
        //   unsatisfied one records `skipped`. Cancellation halts everything.
        const conditional =
          (node.whenAll?.length ?? 0) > 0 || (node.whenAny?.length ?? 0) > 0 ||
          typeof node.when === "function" || node.condition !== undefined;
        if (halted !== null && halted.status === "cancelled") {
          settle(node, { ok: false, output: halted.reason, attempts: 0, status: "cancelled" });
          continue;
        }
        if (halted !== null && !conditional) {
          settle(node, { ok: false, output: halted.reason, attempts: 0, status: halted.status });
          continue;
        }
        // Dependency-aware skip semantics. Without a serializable condition a
        // node runs only when every dependency succeeded: a skipped, denied,
        // failed, or missing prerequisite blocks its dependents instead of
        // leaving them unsettled — or worse, running them without inputs.
        // With whenAll/whenAny the condition decides, but only over succeeded
        // references: a referenced dependency that did not succeed makes the
        // condition unsatisfiable, so the node is recorded `skipped`, never
        // run on missing or failed inputs.
        const hasCondition =
          (node.whenAll?.length ?? 0) > 0 || (node.whenAny?.length ?? 0) > 0 || node.condition !== undefined;
        // Branch this run selects for the node. Set only when a gate admits
        // the node; resume reuses a prior outcome only on the same branch.
        let admittedBranch: string | undefined;
        if (hasCondition) {
          const succeeded = (id: string): boolean => byResult.get(id)?.status === "succeeded";
          const allOk = (node.whenAll ?? []).every(succeeded);
          const anyOk = (node.whenAny ?? []).length === 0 || (node.whenAny ?? []).some(succeeded);
          if (!allOk || !anyOk) {
            const unmet = [...(node.whenAll ?? []), ...(node.whenAny ?? [])].filter((id) => !succeeded(id));
            settle(node, {
              ok: true,
              output: `skipped: condition not met (unsatisfied: ${unmet.join(", ") || "none succeeded"})`,
              attempts: 0,
              status: "skipped",
            });
            continue;
          }
          const satisfiedRefs = [...(node.whenAll ?? []), ...(node.whenAny ?? [])]
            .filter((id) => byResult.get(id)?.status === "succeeded").sort();
          const joinPart = (node.whenAll?.length ?? 0) > 0 || (node.whenAny?.length ?? 0) > 0
            ? `join:ok(${satisfiedRefs.join("+")})`
            : undefined;
          if (node.condition === undefined) admittedBranch = joinPart;
          // Selected-branch encoding shared by the resume gate: the needed
          // value, the observed value, and the confidence it was observed at.
          // Admission records it; a different branch in another run is a
          // different outcome.
          const describeSelection = (needed: string, observed: string, confidence: number | undefined): string => {
            const condPart = `cond:${needed}/${observed}@${confidence === undefined ? "na" : confidence.toFixed(3)}`;
            return joinPart === undefined ? condPart : `${joinPart}+${condPart}`;
          };
          // Decision predicates read typed answers, not execution status: the
          // target must have settled `succeeded` with a matching answer type.
          // A failed, skipped, blocked, or free-text dependency carries no
          // decision, so the predicate is unmet — never guessed.
          if (node.condition !== undefined) {
            const target = byResult.get(node.condition.node);
            if (node.condition.field === "review.lane") {
              const lane = target?.status === "succeeded" ? target.review?.lane : undefined;
              if (lane !== node.condition.equals) {
                settle(node, {
                  ok: true,
                  output: `skipped: review condition not met (${node.condition.node} lane was ${lane ?? "unavailable"}, needed ${node.condition.equals})`,
                  attempts: 0,
                  status: "skipped",
                });
                continue;
              }
              admittedBranch = describeSelection(`review.lane:${node.condition.equals}`, lane, undefined);
            } else {
              const typed =
                target !== undefined && target.status === "succeeded"
                  ? target.jev ?? parseJevDecision(target.output)
                  : undefined;
              let qualified = false;
              let observed = "unavailable";
              let confidence: number | undefined;
              const threshold = node.condition.minConfidence ?? 0.7;
              if (node.condition.field === "decision.verdict") {
                const parsed = typed?.verdict !== undefined
                  ? { verdict: typed.verdict, confidence: typed.noul }
                  : target !== undefined && target.status === "succeeded"
                    ? parseJevVerdict(target.output)
                    : undefined;
                observed = parsed?.verdict ?? "unavailable";
                confidence = parsed?.confidence === undefined || node.condition.equals === "unknown"
                  ? undefined
                  : node.condition.equals === "yes" ? parsed.confidence : 1 - parsed.confidence;
                qualified = parsed?.verdict === node.condition.equals &&
                  (node.condition.equals === "unknown" || (confidence !== undefined && confidence >= threshold));
              } else if (node.condition.field === "decision.choice") {
                const answer = typed?.answers?.[node.condition.question];
                observed = answer?.type === "choice" ? answer.choice : "unavailable";
                confidence = answer?.type === "choice" ? answer.confidence : undefined;
                qualified = answer?.type === "choice" && answer.choice === node.condition.equals && confidence !== undefined && confidence >= threshold;
              } else {
                const answer = typed?.answers?.[node.condition.question];
                observed = answer?.type === "score" ? String(answer.score) : "unavailable";
                confidence = answer?.type === "score" ? answer.confidence : undefined;
                const scoreMatches = answer?.type === "score" &&
                  (node.condition.operator === "gte" ? answer.score >= node.condition.value : answer.score <= node.condition.value);
                qualified = scoreMatches && confidence !== undefined && confidence >= threshold;
              }
              if (!qualified) {
                const reason = node.condition.field === "decision.verdict"
                  ? `skipped: decision condition not met (${node.condition.node} verdict was ${observed}${confidence === undefined ? "" : ` @ ${confidence.toFixed(3)}`}, needed ${node.condition.equals} @ >=${threshold})`
                  : `skipped: decision condition not met (${node.condition.node} ${node.condition.field} was ${observed}${confidence === undefined ? "" : ` @ ${confidence.toFixed(3)}`}, threshold >=${threshold})`;
                settle(node, {
                  ok: true,
                  output: reason,
                  attempts: 0,
                  status: "skipped",
                });
                continue;
              }
              // Protected successors: a satisfied predicate is necessary but
              // never sufficient for a shell dispatched on a Jev decision.
              // The consequential-routing admission (verified qualification
              // bound to the actual deployment and live judgment) must also
              // allow the route. Refusal settles `skipped` — a gate declined
              // the branch — with zero attempts, so the command never ran.
              // The deterministic authorizer still gates any admitted run.
              const controlsShell = hasShellDescendant(node.id) || expandedShellIds.has(node.id);
              if (classifyBranchTarget(node.kind, node.condition.field, controlsShell) === "consequential") {
                const judgment = {
                  provider: typed?.provider ?? "",
                  ...(typed?.model === undefined ? {} : { model: typed.model }),
                  questionHash: typed?.questionHash ?? "",
                };
                const admission = admitProtectedSuccessor({
                  admission: opts.routing,
                  judgment,
                  confidence,
                  minConfidence: threshold,
                });
                if (admission.disposition !== "allow-consequential" || admission.mode !== "consequential") {
                  selectedDecisions.set(node.id, { kind: "routing", mode: "advisory" });
                  settle(node, {
                    ok: true,
                    output: `skipped: consequential route refused (${admission.disposition}: ${admission.reasons.join("; ")})`,
                    attempts: 0,
                    status: "skipped",
                  });
                  continue;
                }
                const qualId = opts.routing?.qualification?.qualificationId ?? "";
                selectedDecisions.set(node.id, {
                  kind: "routing",
                  mode: "consequential",
                  ...(qualId === "" ? {} : { qualificationId: qualId }),
                  ...(opts.routing?.active.modelVersion === undefined
                    ? {}
                    : { modelVersion: opts.routing.active.modelVersion }),
                });
                const cond = node.condition;
                const needed = cond === undefined
                  ? `decision.verdict:${observed}`
                  : cond.field === "decision.score"
                    ? `${cond.field}:${cond.question}${cond.operator}${cond.value}`
                    : cond.field === "decision.choice"
                      ? `${cond.field}:${cond.question}=${cond.equals}`
                      : `${cond.field}:${cond.equals}`;
                // The admitted qualification identity joins the branch: a
                // prior outcome replays only under the same qualification.
                admittedBranch = qualId === ""
                  ? describeSelection(needed, observed, confidence)
                  : `${describeSelection(needed, observed, confidence)}+qual:${qualId}`;
              } else {
                const cond = node.condition;
                const needed = cond === undefined
                  ? `decision.verdict:${observed}`
                  : cond.field === "decision.score"
                    ? `${cond.field}:${cond.question}${cond.operator}${cond.value}`
                    : cond.field === "decision.choice"
                      ? `${cond.field}:${cond.question}=${cond.equals}`
                      : `${cond.field}:${cond.equals}`;
                admittedBranch = describeSelection(needed, observed, confidence);
              }
            }
          }
        } else {
          const unsettled = (node.dependsOn ?? []).find((dep) => byResult.get(dep)?.status !== "succeeded");
          if (unsettled !== undefined) {
            const depResult = byResult.get(unsettled);
            settle(node, {
              ok: false,
              output: `blocked: dependency ${unsettled} ${depResult?.status ?? "unsettled"}`,
              attempts: 0,
              status: "blocked",
            });
            continue;
          }
        }
        // Admission records the selected branch for the resume gate (and the
        // journal): a prior outcome is reusable only on the same branch.
        if (admittedBranch !== undefined) selectedBranches.set(node.id, admittedBranch);
        // Function predicates can inspect every prior result, so their Jev
        // influence cannot be bound to a qualified typed branch. Keep them
        // available for non-Jev graphs, but refuse them as shell gates when
        // this DAG contains model judgments. Serializable `condition` gates
        // carry the source, answer field, and threshold needed for admission.
        if (node.kind === "shell" && typeof node.when === "function" && graphHasJevNode) {
          settle(node, {
            ok: true,
            output: "skipped: consequential routing refused (dynamic shell predicates cannot bind a Jev judgment; use a declarative decision condition)",
            attempts: 0,
            status: "skipped",
          });
          continue;
        }
        let allowed = true;
        try {
          const decided = await evaluateWhen(node, [...results]);
          if (decided === "revoked") {
            settle(node, {
              ok: false,
              output: "cancelled: graph deadline or abort during condition evaluation",
              attempts: 0,
              status: "cancelled",
            });
            continue;
          }
          allowed = decided;
        } catch (error) {
          settle(node, {
            ok: false,
            output: error instanceof Error ? error.message : String(error),
            attempts: 0,
            status: "failed",
          });
          halted = { status: "blocked", reason: `blocked: condition for ${node.id} threw` };
          continue;
        }
        if (!allowed) {
          settle(node, { ok: true, output: "skipped", attempts: 0, status: "skipped" });
          continue;
        }
        // Crash-recovery resume AFTER gate evaluation — never before it. A
        // prior `succeeded` is reused only when every identity agrees: the
        // static input hash (node text + policy), the graph revision, the
        // branch this run selected, and the canonical effective-input digest
        // (policy + descriptor + revision + runtime dependency
        // evidence/decisions). Anything else falls through: shell nodes with
        // changed identity re-execute only under the idempotent+retry
        // conjunction (or block), Jev nodes evaluate fresh as a new
        // revision. Resumed nodes keep their input hash so downstream
        // condition checks see a genuine succeeded record, and replayed Jev
        // nodes keep their recorded decision so predicates read history
        // without re-invoking the backend. Side-effecting commands are never
        // re-executed on a branch change: an unmet gate above already
        // settled the node `skipped`, so reaching here with a different
        // branch means the branch encoding itself drifted — block, don't run.
        if ((node.kind === "shell" || node.kind === "jev") &&
            priorHit?.status === "succeeded" && priorHit.inputHash === hashInput(node)) {
          const effectiveHash = effectiveHashFor(node);
          const recordBranch = (status: "succeeded", extra: { outputDigest: string; jev?: JevDecision; outputArtifact?: string }): void => {
            journal.record({
              type: "node-terminal",
              runId: rid,
              ts: new Date().toISOString(),
              nodeId: node.id,
              declaredDependencies: [...(node.dependsOn ?? [])],
              status,
              inputHash: hashInput(node),
              outputDigest: extra.outputDigest,
              ...(extra.outputArtifact === undefined ? {} : { outputArtifact: extra.outputArtifact }),
              ...(extra.jev === undefined ? {} : { jev: extra.jev }),
              effectiveInputHash: effectiveHash,
              ...(opts.graphHash === undefined ? {} : { revisionHash: opts.graphHash }),
              ...(admittedBranch === undefined ? {} : { branch: admittedBranch }),
              // Replay carries this run's gate evaluation: the selected
              // route and the qualification identity that admitted it.
              ...(selectedDecisions.get(node.id) === undefined ? {} : {
                decisionKind: selectedDecisions.get(node.id)!.kind,
                decisionMode: selectedDecisions.get(node.id)!.mode,
                ...(selectedDecisions.get(node.id)!.qualificationId === undefined
                  ? {}
                  : { qualificationId: selectedDecisions.get(node.id)!.qualificationId! }),
                ...(selectedDecisions.get(node.id)!.modelVersion === undefined
                  ? {}
                  : { modelVersion: selectedDecisions.get(node.id)!.modelVersion! }),
              }),
            });
          };
          if (priorHit.outputDigest === undefined) {
            settle(node, {
              ok: false,
              output: "blocked: prior success has no output digest; refusing to inherit an unverifiable outcome",
              attempts: 0,
              status: "blocked",
            });
            continue;
          }
          if (priorHit.effectiveInputHash === undefined) {
            // Legacy journal entry: the evidence identity cannot be proven.
            // Shell effects must not be inherited blindly; Jev judgments
            // simply evaluate fresh (no side effects either way).
            if (node.kind === "shell") {
              settle(node, {
                ok: false,
                output: "blocked: prior success predates effective-input journaling; refusing to inherit an unverifiable outcome",
                attempts: 0,
                status: "blocked",
              });
              continue;
            }
          } else {
            const revisionMismatch = priorHit.revisionHash !== undefined &&
              opts.graphHash !== undefined && priorHit.revisionHash !== opts.graphHash;
            const branchMismatch = (priorHit.branch ?? null) !== (admittedBranch ?? null);
            const effectiveMismatch = priorHit.effectiveInputHash !== effectiveHash;
            if (revisionMismatch) {
              // Stale revisions never inherit: history stays history. Shell
              // effects stay untouched (no re-execution); Jev evaluates the
              // new revision fresh below.
              if (node.kind === "shell") {
                settle(node, {
                  ok: false,
                  output: "blocked: prior success is from a stale graph revision; refusing to inherit it",
                  attempts: 0,
                  status: "blocked",
                });
                continue;
              }
            } else if (branchMismatch) {
              // The branch changed since the prior outcome: never re-execute
              // a side-effecting command into a branch that did not select
              // it; Jev re-evaluates the new branch fresh below.
              if (node.kind === "shell") {
                settle(node, {
                  ok: false,
                  output: "blocked: branch changed since prior success; refusing to re-execute a side-effecting command on a new branch",
                  attempts: 0,
                  status: "blocked",
                });
                continue;
              }
            } else if (effectiveMismatch) {
              // Changed evidence is a new revision, not a reinterpretation.
              // Shell re-execution needs the same idempotent+retry
              // conjunction as a changed command; Jev evaluates fresh below.
              if (node.kind === "shell" && !(node.idempotent === true && shellRetry)) {
                settle(node, {
                  ok: false,
                  output: "blocked: effective dependency inputs changed since prior success; refusing to reuse or rerun without idempotency and retry policy authorization",
                  attempts: 0,
                  status: "blocked",
                });
                continue;
              }
            } else if (node.kind === "shell") {
              const resumedOutput = `resumed: prior succeeded outcome reused${opts.resume?.priorRunId === undefined ? "" : ` from run ${opts.resume.priorRunId}`}; command not re-executed`;
              const resumed: ExecutorResult = {
                nodeId: node.id,
                ok: true,
                output: resumedOutput,
                outputAvailable: false,
                attempts: 0,
                status: "succeeded",
                inputHash: hashInput(node),
                outputHash: hashValue(resumedOutput),
                outputDigest: priorHit.outputDigest,
                ...(priorHit.outputArtifact === undefined ? {} : { outputArtifact: priorHit.outputArtifact }),
                resumed: true,
              };
              recordBranch("succeeded", {
                outputDigest: resumed.outputDigest,
                ...(priorHit.outputArtifact === undefined ? {} : { outputArtifact: priorHit.outputArtifact }),
              });
              record(resumed);
              continue;
            } else if (priorHit.jev !== undefined) {
              // Deterministic replay: restore the recorded decision verbatim
              // instead of re-invoking the backend. The replayed result
              // carries the original provider/model/qualification identity,
              // so history is never misattributed — and the backend is never
              // billed for a judgment it already made on identical inputs.
              const replayedOutput = `replayed: prior Jev decision reused${opts.resume?.priorRunId === undefined ? "" : ` from run ${opts.resume.priorRunId}`}; model not re-invoked`;
              const replayed: ExecutorResult = {
                nodeId: node.id,
                ok: true,
                output: replayedOutput,
                outputAvailable: false,
                attempts: 0,
                status: "succeeded",
                inputHash: hashInput(node),
                outputHash: hashValue(replayedOutput),
                outputDigest: priorHit.outputDigest,
                jev: priorHit.jev,
                ...(priorHit.outputArtifact === undefined ? {} : { outputArtifact: priorHit.outputArtifact }),
                resumed: true,
              };
              recordBranch("succeeded", {
                outputDigest: replayed.outputDigest,
                jev: priorHit.jev,
                ...(priorHit.outputArtifact === undefined ? {} : { outputArtifact: priorHit.outputArtifact }),
              });
              record(replayed);
              continue;
            }
            // Jev nodes that reach here (legacy entry, stale revision,
            // changed branch/evidence, or recorded success without a typed
            // decision) evaluate fresh below: a new evaluation on changed
            // inputs is a new revision, and re-invoking the backend is
            // side-effect free for the graph.
          }
        }
        candidates.push(node);
      }

      if (candidates.length > 0) {
        const isParallel = graph.parallel === true || candidates.some((n) => n.parallel === true);
        const levelResults =
          isParallel && candidates.length > 1
            ? await (async () => {
                // Parallel preemption with the NO-ROLLBACK invariant: the first
                // node failure aborts this level's scoped controller, so
                // running siblings that honor it stop instead of running to
                // completion. Nodes not yet admitted are never started: they
                // settle `blocked` with zero attempts, which proves they never
                // executed. Nodes aborted mid-attempt keep the existing
                // uncertain-side-effect path (`outcome_unknown` + forced
                // reconciliation in executeNode) — an abort is never read as
                // proof a sibling did not execute. Later levels start from a
                // clean signal, so conditional rescue still evaluates.
                let preempted: { reason: string } | null = null;
                const guarded = async (node: GraphNode): Promise<ExecutorResult> => {
                  if (preempted !== null) {
                    return terminal(node, {
                      ok: false,
                      fullOutput: preempted.reason,
                      attempts: 0,
                      status: "blocked",
                    });
                  }
                  const result = await executeNode(node);
                  if (!result.ok && preempted === null) {
                    preempted = {
                      reason:
                        result.status === "cancelled"
                          ? "cancelled: graph deadline or abort"
                          : `blocked: ${node.id} ${result.status}`,
                    };
                    // Fail the level through the level-scoped controller so
                    // in-flight siblings observe cancellation via the run
                    // context they already receive. Scoped, not master: the
                    // interruption stops this level's cooperating work but
                    // does not revoke completed attempts or poison later
                    // levels' signals and conditional rescue paths.
                    levelAbort.abort();
                  }
                  return result;
                };
                return mapWithConcurrency(candidates, maxParallel, guarded);
              })()
            : await (async () => {
                const out: ExecutorResult[] = [];
                for (let i = 0; i < candidates.length; i += 1) {
                  const node = candidates[i]!;
                  const result = await executeNode(node);
                  out.push(result);
                  if (!result.ok && halted === null) {
                    halted = {
                      status: result.status === "cancelled" ? "cancelled" : "blocked",
                      reason:
                        result.status === "cancelled"
                          ? "cancelled: graph deadline or abort"
                          : `blocked: ${node.id} ${result.status}`,
                    };
                  }
                  // Stop sequential siblings when this node failed or the run
                  // was cancelled — but a halt inherited from an earlier level
                  // does not stop candidates this level already admitted (they
                  // are conditional nodes that opted into running anyway).
                  if (!result.ok || result.status === "cancelled") {
                    // The halt preempts the rest of this level's admitted
                    // candidates: they never ran, so settle them explicitly
                    // with the halt's terminal state instead of leaving them
                    // without any record.
                    const halt = halted ?? {
                      status: "blocked" as const,
                      reason: `blocked: ${node.id} ${result.status}`,
                    };
                    for (const rest of candidates.slice(i + 1)) {
                      out.push(
                        terminal(rest, {
                          ok: false,
                          fullOutput: halt.reason,
                          attempts: 0,
                          status: halt.status,
                        }),
                      );
                    }
                    break;
                  }
                }
                return out;
              })();
        for (const result of levelResults) record(result);
        if (halted === null && levelResults.some((r) => !r.ok)) {
          const first = levelResults.find((r) => !r.ok)!;
          halted = {
            status: first.status === "cancelled" ? "cancelled" : "blocked",
            reason:
              first.status === "cancelled"
                ? "cancelled: graph deadline or abort"
                : `blocked: ${first.nodeId} ${first.status}`,
          };
        }
      }
      } finally {
        graphAbort.signal.removeEventListener("abort", propagateMaster);
      }
    }
    // Terminal-record backstop: after normal settlement every declared node
    // must have exactly one record. Anything missing is an executor bug, and
    // it must surface as an explicit blocked record — never as a silent
    // omission that inflates the success count.
    for (const node of graph.nodes) {
      if (!byResult.has(node.id)) {
        const reason = `blocked: ${node.id} settled without a terminal record (executor bug)`;
        settle(node, { ok: false, output: reason, attempts: 0, status: "blocked" });
      }
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    // No-op when abort already fired (`{ once: true }` self-removed); required
    // on success, failure, and thrown errors so a shared caller signal does
    // not accumulate one listener per completed execution.
    if (callerSignal !== undefined) callerSignal.removeEventListener("abort", onCallerAbort);
  }
  return results;
}
