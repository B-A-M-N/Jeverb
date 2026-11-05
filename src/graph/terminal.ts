/**
 * Terminal-result construction for settled graph nodes.
 *
 * Single choke point: every settled node passes through here, so excerpt
 * hashes, full-output digests, and journal terminal records are never
 * omitted on any path. Depends on graph runtime services (journal,
 * artifact store) via an explicit context — never on the scheduler — so
 * the logic is unit-testable and the scheduling core stays lean. The
 * terminal journal event also snapshots the graph node's declared
 * predecessors for later receipt-backed criterion lineage.
 */

import { digestFullOutput, type JournalWriter } from "./journal.js";
import type { GraphOutputArtifactStore } from "./artifact.js";
import type { ExecutorResult, GraphNode, JevDecision, NodeStatus } from "./executor.js";
import type { ReviewResult } from "../review/policy.js";
import { hashValue, nodeDescriptor } from "./validate.js";

/** Settled node outcome: presentation text plus typed judgments. */
export interface TerminalOutcome {
  ok: boolean;
  fullOutput: string;
  attempts: number;
  status: NodeStatus;
  jev?: JevDecision;
  review?: ReviewResult;
}

/** Runtime services the constructor needs, supplied by the scheduler. */
export interface TerminalContext {
  /** Behavior-affecting configuration fingerprint mixed into every input hash. */
  policyTag: string;
  /** Stable run identifier stamped on journal events. */
  runId: string;
  journal: JournalWriter;
  /** Full successful dependency output, kept inside the run. */
  fullOutputs: Map<string, string>;
  outputArtifactsAllowed?: boolean | undefined;
  outputArtifacts?: GraphOutputArtifactStore | undefined;
  /** Whether graph execution was cancelled when the node settled. */
  cancelled: boolean;
  /**
   * Canonical effective-input digest for this settlement (policy +
   * descriptor + revision + runtime dependency evidence). Recorded so a
   * later resume matches on evidence, never on the static hash alone.
   */
  effectiveInputHash?: string | undefined;
  /** Graph revision this node settled under. */
  revisionHash?: string | undefined;
  /** Branch selected by the gate evaluation that admitted this node. */
  branch?: string | undefined;
  /**
   * Decision evidence for replay: which decision family this settlement was
   * evaluated under and whether the judgment was allowed to select a
   * consequential branch, with the admitted qualification identity when a
   * consequential route was taken. Persisted to the journal node-terminal
   * event so a restart replays the recorded route instead of re-deriving it.
   */
  decision?: {
    kind: "routing" | "authorization" | "verification";
    mode: "advisory" | "consequential";
    qualificationId?: string;
    modelVersion?: string;
  } | undefined;
}

/** Maximum excerpt characters kept on the result envelope for display. */
export const TERMINAL_EXCERPT_CHARS = 4000;

/** Build the terminal result for one settled node and journal it. */
export function buildTerminalResult(node: GraphNode, outcome: TerminalOutcome, ctx: TerminalContext): ExecutorResult {
  const excerpt = outcome.fullOutput.slice(0, TERMINAL_EXCERPT_CHARS);
  let artifactId: string | undefined;
  let artifactError: string | undefined;
  if (node.captureOutput && ctx.cancelled) {
    artifactError = "output artifact omitted because graph execution was cancelled";
  } else if (node.captureOutput) {
    if (ctx.outputArtifactsAllowed !== true) artifactError = "operator policy does not allow full-output artifacts";
    else if (ctx.outputArtifacts === undefined) artifactError = "full-output artifact store is not configured";
    else {
      try {
        artifactId = ctx.outputArtifacts.write(ctx.runId, node.id, outcome.fullOutput).artifactId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        artifactError = message.includes("artifact limit") ? "requested output exceeds the 4 MiB artifact limit" : "requested output artifact could not be persisted";
      }
    }
  }
  const result: ExecutorResult = {
    nodeId: node.id,
    ok: outcome.ok,
    output: excerpt,
    attempts: outcome.attempts,
    status: outcome.status,
    inputHash: hashValue(`${ctx.policyTag}\n${nodeDescriptor(node)}`),
    outputHash: hashValue(excerpt),
    outputDigest: digestFullOutput(outcome.fullOutput),
    ...(artifactId === undefined ? {} : { outputArtifact: artifactId }),
    ...(artifactError === undefined ? {} : { outputArtifactError: artifactError }),
    ...(outcome.jev === undefined ? {} : { jev: outcome.jev }),
    ...(outcome.review === undefined ? {} : { review: outcome.review }),
  };
  ctx.fullOutputs.set(node.id, outcome.fullOutput);
  ctx.journal.record({
    type: "node-terminal",
    runId: ctx.runId,
    ts: new Date().toISOString(),
    nodeId: node.id,
    declaredDependencies: [...(node.dependsOn ?? [])],
    status: outcome.status,
    inputHash: result.inputHash,
    outputDigest: result.outputDigest,
    ...(artifactId === undefined ? {} : { outputArtifact: artifactId }),
    ...(outcome.jev === undefined ? {} : { jev: outcome.jev }),
    ...(ctx.effectiveInputHash === undefined ? {} : { effectiveInputHash: ctx.effectiveInputHash }),
    ...(ctx.revisionHash === undefined ? {} : { revisionHash: ctx.revisionHash }),
    ...(ctx.branch === undefined ? {} : { branch: ctx.branch }),
    ...(ctx.decision === undefined ? {} : {
      decisionKind: ctx.decision.kind,
      decisionMode: ctx.decision.mode,
      ...(ctx.decision.qualificationId === undefined ? {} : { qualificationId: ctx.decision.qualificationId }),
      ...(ctx.decision.modelVersion === undefined ? {} : { modelVersion: ctx.decision.modelVersion }),
    }),
  });
  return result;
}
