/**
 * Component-level lifecycle POLICY conformance (deterministic, no live inference).
 *
 * This harness checks the policy composition of the lifecycle — routing,
 * authorization, evidence linkage, and terminal-vocabulary projection — by
 * running the real production gates over SIMULATED node transitions:
 * Intent → propose change → typed routing judgment (stub Jev decisions with
 * recorded qualification) → deterministic authorization → sandbox apply →
 * test+inspection branches → join → permitted repair → evidence linked via
 * explicit criterion→producer associations → independent verifier adapter
 * run → mission closure attempt → terminal verdict.
 *
 * What this harness IS: a policy-composition check. Every boundary that
 * matters calls the real production gate:
 * - routing: `gateConsequentialRouting` / `degradedRoutingFor`
 * - execution: `makeDeterministicAuthorizer` over `defaultExecutionPolicy`
 * - verifiers: `verifyTestExecution` / `verifyBuildArtifact` (memory fs)
 * - lineage: `buildCriterionGraphBindings` → `resolveCriterionGraphBindings`
 * - counting: `validateCriterionVerifications` → `qualifyTrustedCriteria`
 *
 * What this harness IS NOT: execution proof. Graph traversal is simulated
 * deterministically in-harness (the only "execution" is the in-memory
 * `settle()` script below: node DAG with dependency gating, branch join,
 * repair). The harness never executes commands, never touches the network,
 * and never calls a model — so a `verified` terminal here proves the
 * policy aggregation, NOT that side effects ran, sandboxes confined,
 * journals persisted, or receipts survived disk. Adapters run on stub
 * inputs with recorded qualification, per the conformance constraints.
 *
 * Execution proof lives in `./real-lifecycle-e2e.test.js`: the ACTUAL graph
 * tool (`jev_execute_graph`) + the REAL constrained shell runner against a
 * disposable workspace + a REAL `FileJournal` recovered through
 * `reconcileJournal` + actually observed filesystem state + REAL verifier
 * receipts (persisted via `persistVerifierFinding` and read back) + the
 * trusted mission-closure source + Stop integration. Cite that test — never
 * this harness — for execution behavior. In particular, an interrupted
 * (`outcome_unknown`) effect here settles a label; in production it demands
 * reconciliation (inspect, then explicitly authorize a retry or mark
 * superseded) and NEVER auto re-executes.
 */

import { createHash } from "node:crypto";
import {
  CONSEQUENTIAL_ROUTING_FAMILY,
  degradedRoutingFor,
  gateConsequentialRouting,
  type RoutingActiveIdentity,
  type RoutingGateResult,
  type RoutingQualification,
} from "../../src/decision/routing.js";
import { makeDeterministicAuthorizer } from "../../src/graph/authorizer.js";
import type { GraphNode } from "../../src/graph/executor.js";
import { defaultExecutionPolicy } from "../../src/graph/policy.js";
import {
  buildCriterionGraphBindings,
  qualifyTrustedCriteria,
  resolveCriterionGraphBindings,
  validateCriterionVerifications,
  type CriterionVerificationAssessment,
} from "../../src/mission/graph-binding.js";
import type {
  CriterionGraphEvidence,
  MissionCriterionVerification,
  MissionGraphRunEvidence,
} from "../../src/mission/closure.js";
import {
  findingReceiptCorrelationId,
  findingToVerification,
  verifyBuildArtifact,
  verifyTestExecution,
  type VerifierFinding,
} from "../../src/mission/verifiers.js";

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Opaque policy identity the boundary actually runs. */
export const HARNESS_POLICY_HASH = sha256Hex("conformance-decision-policy/v1");
/** Mission revision under test. */
export const HARNESS_MISSION_REVISION = sha256Hex("conformance-mission-revision/7");
/** Current candidate digest. */
export const HARNESS_CANDIDATE = sha256Hex("conformance-candidate/current");
/** Rotated-out candidate digest (stale bindings/verdicts name this). */
export const HARNESS_STALE_CANDIDATE = sha256Hex("conformance-candidate/superseded");
/** Graph definition digest (changed when the graph is edited). */
export const HARNESS_GRAPH_HASH = sha256Hex("conformance-graph-definition/v3");

export const HARNESS_ACTIVE_IDENTITY: RoutingActiveIdentity = {
  backend: "stub",
  model: "stub-jev",
  modelVersion: "v1",
  questionFamily: "repair-routing",
  policyHash: HARNESS_POLICY_HASH,
};

export function qualifiedRoutingRecord(): RoutingQualification {
  return {
    id: "conformance-qualification-1",
    family: CONSEQUENTIAL_ROUTING_FAMILY,
    backend: "stub",
    model: "stub-jev",
    modelVersion: "v1",
    questionFamily: "repair-routing",
    policyHash: HARNESS_POLICY_HASH,
    qualified: true,
  };
}

/** Terminal vocabulary for the whole lifecycle. */
export type TerminalVerdict = "verified" | "incomplete" | "blocked" | "inconclusive";

/** Closure status the terminal verdict projects to. */
export type ClosureStatus = "COMPLETE" | "INCOMPLETE" | "BLOCKED" | "INSUFFICIENT_EVIDENCE";

export const terminalToClosure = (terminal: TerminalVerdict): ClosureStatus =>
  terminal === "verified"
    ? "COMPLETE"
    : terminal === "incomplete"
      ? "INCOMPLETE"
      : terminal === "blocked"
        ? "BLOCKED"
        : "INSUFFICIENT_EVIDENCE";

export type NodeStatus = "succeeded" | "failed" | "skipped" | "blocked" | "cancelled" | "outcome_unknown";

export interface LifecycleKnobs {
  /** Typed routing judgment input. */
  routing: "qualified" | "unavailable" | "degraded-error" | "low-confidence" | "no-confidence" | "unqualified" | "wrong-family" | "identity-mismatch";
  /** Branch selected by the gate evaluation. */
  branch: "valid" | "invalid";
  /** Operator policy: shell execution permitted at all. */
  shellAllowed: boolean;
  /** Apply node uses a privilege-escalation command (authorizer must deny). */
  privilegedCommand: boolean;
  /** Bypass attempt: run the apply node without consulting the authorizer. */
  skipAuthorization: boolean;
  /** Upstream dependency behavior. */
  dep: "ok" | "skipped" | "changed-output";
  /** Sibling branch behavior. */
  sibling: "ok" | "failed";
  /** Journal durability. */
  journal: "ok" | "corrupt" | "missing";
  /** Side effect lands, then the node crashes before reporting (outcome unknown). */
  crashAfterSideEffect: boolean;
  /** Resume attempts to re-enter via a rejected branch. */
  resumeRejectedBranch: boolean;
  /** Graph definition changed under the run (graphHash mismatch). */
  graphChanged: boolean;
  /** Verdicts/bindings name a superseded candidate. */
  candidateStale: boolean;
  /** Durable verifier receipt posture. */
  receipts: "persisted" | "absent" | "conflicting";
  /** Agent outcome claim vs observed node status. */
  claim: "honest" | "false-success";
  /** Process exits zero but produces no outcome artifact (outcome unknown). */
  outcomeAbsent: boolean;
  /** Independent verifier posture. */
  verifier: "pass" | "fail" | "contradictory" | "absent" | "unallowlisted";
  /** Host coverage: full trusted path vs advisory-only host. */
  coverage: "full" | "advisory-only-host";
  /** Whether a repair node may run after a failed join. */
  repairAllowed: boolean;
  /** Whether criteria declare explicit criterion→producer associations. */
  associations: "declared" | "undeclared";
}

export const DEFAULT_KNOBS: LifecycleKnobs = {
  routing: "qualified",
  branch: "valid",
  shellAllowed: true,
  privilegedCommand: false,
  skipAuthorization: false,
  dep: "ok",
  sibling: "ok",
  journal: "ok",
  crashAfterSideEffect: false,
  resumeRejectedBranch: false,
  graphChanged: false,
  candidateStale: false,
  receipts: "persisted",
  claim: "honest",
  outcomeAbsent: false,
  verifier: "pass",
  coverage: "full",
  repairAllowed: true,
  associations: "declared",
};

export interface LifecycleOutcome {
  scenario: string;
  /** Node statuses in traversal order. */
  graphState: Record<string, NodeStatus>;
  /** Order nodes settled (dependency gating proof). */
  traversalOrder: string[];
  routing: RoutingGateResult;
  consequentialTaken: boolean;
  authAllowed: boolean;
  authReason: string | undefined;
  /** Bypass attempts are refused before any effect. */
  bypassRefused: boolean;
  /** Observable side effects (sandbox writes). */
  sideEffects: string[];
  /** True when a cached terminal was reused across an input change. */
  replayReused: boolean;
  /** True when downstream re-executed after an upstream output change. */
  replaySafe: boolean;
  graphEvidence: MissionGraphRunEvidence | undefined;
  lineage: CriterionGraphEvidence[];
  verificationAssessments: CriterionVerificationAssessment[];
  allCriteriaQualified: boolean;
  terminal: TerminalVerdict;
  closure: ClosureStatus;
  notes: string[];
}

const CRITERIA = [{ id: "criterion-apply" }, { id: "criterion-verify" }];

/** Verifier allowlist the host supplies (exact match, default-deny otherwise). */
const HOST_VERIFIER_ALLOWLIST = ["test-execution", "build-artifact"];

function routingInputFor(knobs: LifecycleKnobs): {
  qualification: RoutingQualification | undefined;
  confidence: number | undefined;
  degradedError: unknown;
} {
  switch (knobs.routing) {
    case "qualified":
      return { qualification: qualifiedRoutingRecord(), confidence: 0.9, degradedError: undefined };
    case "unavailable":
      return { qualification: undefined, confidence: 0.9, degradedError: undefined };
    case "degraded-error":
      return { qualification: undefined, confidence: undefined, degradedError: new Error("model timeout after 30s") };
    case "low-confidence":
      return { qualification: qualifiedRoutingRecord(), confidence: 0.2, degradedError: undefined };
    case "no-confidence":
      return { qualification: qualifiedRoutingRecord(), confidence: undefined, degradedError: undefined };
    case "unqualified":
      return { qualification: { ...qualifiedRoutingRecord(), qualified: false }, confidence: 0.9, degradedError: undefined };
    case "wrong-family":
      return {
        qualification: { ...qualifiedRoutingRecord(), family: "mission-closure" },
        confidence: 0.9,
        degradedError: undefined,
      };
    case "identity-mismatch":
      return {
        qualification: { ...qualifiedRoutingRecord(), modelVersion: "v9-evil" },
        confidence: 0.9,
        degradedError: undefined,
      };
  }
}

function shellNode(id: string, command: string): GraphNode {
  return { id, kind: "shell", command } as unknown as GraphNode;
}

/**
 * Run one disposable-repo lifecycle. Deterministic: same knobs always yield
 * the same outcome. Never executes commands, reads the network, or calls a
 * model — the only "execution" is in-memory state plus real gate calls.
 */
export async function runLifecycleScenario(scenario: string, knobs: LifecycleKnobs): Promise<LifecycleOutcome> {
  const notes: string[] = [];
  const sideEffects: string[] = [];
  const graphState: Record<string, NodeStatus> = {};
  const traversalOrder: string[] = [];
  let replayReused = false;
  let replaySafe = true;
  let bypassRefused = false;

  // Step 3 — typed routing judgment (stub Jev decision + recorded qualification).
  const routingInput = routingInputFor(knobs);
  const routing: RoutingGateResult =
    routingInput.degradedError !== undefined
      ? degradedRoutingFor(routingInput.degradedError)
      : gateConsequentialRouting({
          qualification: routingInput.qualification,
          active: HARNESS_ACTIVE_IDENTITY,
          confidence: routingInput.confidence,
          minConfidence: 0.7,
        });
  const consequentialAdmitted = routing.disposition === "allow-consequential";
  notes.push(`routing: ${routing.disposition}/${routing.mode}`);

  // Advisory-only host coverage: the host never admits consequential routes.
  const hostAdmitsConsequential = knobs.coverage === "full";
  const consequentialTaken = consequentialAdmitted && hostAdmitsConsequential && knobs.branch === "valid";
  if (consequentialAdmitted && !hostAdmitsConsequential) {
    notes.push("host supports advisory-only coverage; consequential route deferred");
  }

  // Invalid branch: the gate-admitted branch is not in the graph definition.
  if (knobs.branch === "invalid") {
    notes.push("selected branch is not defined by the graph; refused");
    return {
      scenario,
      graphState: {},
      traversalOrder,
      routing,
      consequentialTaken: false,
      authAllowed: false,
      authReason: "branch refused: not in graph definition",
      bypassRefused,
      sideEffects,
      replayReused,
      replaySafe,
      graphEvidence: undefined,
      lineage: [],
      verificationAssessments: [],
      allCriteriaQualified: false,
      terminal: "blocked",
      closure: terminalToClosure("blocked"),
      notes,
    };
  }

  // Rejected-branch resume: resume may not re-enter through a rejected branch.
  if (knobs.resumeRejectedBranch) {
    notes.push("resume via rejected branch refused; prior terminal stands");
    return {
      scenario,
      graphState: { apply: "blocked" },
      traversalOrder: ["apply"],
      routing,
      consequentialTaken: false,
      authAllowed: false,
      authReason: "resume refused: rejected branch",
      bypassRefused,
      sideEffects,
      replayReused: false,
      replaySafe: true,
      graphEvidence: undefined,
      lineage: [],
      verificationAssessments: [],
      allCriteriaQualified: false,
      terminal: "blocked",
      closure: terminalToClosure("blocked"),
      notes,
    };
  }

  // Step 4 — authorize the consequential apply node via the deterministic authorizer.
  const policy = defaultExecutionPolicy("/sandbox/disposable-repo", { allowShell: knobs.shellAllowed });
  const authorizer = makeDeterministicAuthorizer(policy);
  const applyCommand = knobs.privilegedCommand ? "sudo apply-patch --force" : "apply-patch --candidate current";
  let authAllowed = false;
  let authReason: string | undefined;
  if (knobs.skipAuthorization) {
    // Bypass attempt: the harness refuses to run without the authorization
    // boundary, exactly as the enforcement boundary must.
    bypassRefused = true;
    notes.push("bypass refused: execution without the deterministic authorizer is never permitted");
    return {
      scenario,
      graphState: { apply: "blocked" },
      traversalOrder: ["apply"],
      routing,
      consequentialTaken: false,
      authAllowed: false,
      authReason: "bypass refused: no authorization decision exists",
      bypassRefused,
      sideEffects,
      replayReused,
      replaySafe,
      graphEvidence: undefined,
      lineage: [],
      verificationAssessments: [],
      allCriteriaQualified: false,
      terminal: "blocked",
      closure: terminalToClosure("blocked"),
      notes,
    };
  }
  const decision = await authorizer.authorize(shellNode("apply", applyCommand));
  authAllowed = decision.allowed;
  authReason = decision.allowed ? undefined : decision.reason;
  if (!decision.allowed) notes.push(`authorization denied: ${decision.reason}`);

  // Steps 5–7 — sandbox traversal with dependency gating.
  const settle = (id: string, status: NodeStatus): void => {
    graphState[id] = status;
    traversalOrder.push(id);
  };

  // propose is advisory and always succeeds.
  settle("propose", "succeeded");

  // Skipped dependency gates everything downstream.
  if (knobs.dep === "skipped") {
    settle("apply", "skipped");
    settle("test", "blocked");
    settle("inspect", "blocked");
    settle("join", "blocked");
    notes.push("dependency skipped; dependents blocked, never inferred");
  } else if (!consequentialTaken) {
    // Advisory-only deferral (or a refused route): the consequential change
    // is NOT executed. No side effects, dependents stay blocked.
    settle("apply", "blocked");
    settle("test", "blocked");
    settle("inspect", "blocked");
    settle("join", "blocked");
    notes.push("consequential route not admitted; change deferred, nothing executed");
  } else if (!authAllowed) {
    // Denied authorization: nothing consequential runs, no side effects.
    settle("apply", "blocked");
    settle("test", "blocked");
    settle("inspect", "blocked");
    settle("join", "blocked");
  } else {
    // apply runs in the sandbox.
    sideEffects.push("sandbox-write:apply-patch");
    if (knobs.crashAfterSideEffect) {
      settle("apply", "outcome_unknown");
      notes.push("crash after side effect: outcome unknown; reconcile before any retry, never auto re-execute");
      replaySafe = true;
    } else {
      settle("apply", "succeeded");
    }

    // Changed upstream output changes the effective input downstream: the
    // cached terminal must never be reused. Production does NOT auto
    // re-execute either — shell re-execution needs the same idempotent+retry
    // conjunction as any other retry, so the harness records the safe
    // outcome (no reuse) without performing a run.
    if (knobs.dep === "changed-output") {
      replayReused = false;
      replaySafe = true;
      notes.push("dependency output changed; downstream effective input differs, terminal recomputed");
    }

    const applyOk = graphState["apply"] === "succeeded";
    if (!applyOk) {
      settle("test", "blocked");
      settle("inspect", "blocked");
      settle("join", "blocked");
    } else {
      // test + inspection branches (join requires both).
      const testFailed =
        knobs.sibling === "failed" || knobs.verifier === "fail" || knobs.outcomeAbsent || knobs.claim === "false-success";
      if (knobs.outcomeAbsent) {
        settle("test", "outcome_unknown");
        notes.push("zero exit but outcome absent: outcome unknown, never success");
      } else if (testFailed) {
        settle("test", "failed");
        if (knobs.sibling !== "failed") notes.push("test branch failed on its own record");
      } else {
        settle("test", "succeeded");
      }
      settle("inspect", "succeeded");

      const branchesOk = graphState["test"] === "succeeded" && graphState["inspect"] === "succeeded";
      if (branchesOk) {
        settle("join", "succeeded");
      } else if (graphState["test"] === "outcome_unknown" || knobs.crashAfterSideEffect) {
        settle("join", "blocked");
      } else {
        settle("join", "failed");
        // Repair where permitted: a consequential repair needs an admitted
        // consequential route plus operator repair permission.
        const repairConsequential = consequentialTaken && knobs.repairAllowed;
        if (repairConsequential && knobs.verifier !== "fail" && knobs.sibling !== "failed") {
          sideEffects.push("sandbox-write:repair-patch");
          settle("repair", "succeeded");
          settle("join-retry", "succeeded");
          notes.push("permitted repair applied; join retried");
        } else {
          notes.push("join failed; no permitted repair (advisory-only or repair not allowed)");
        }
      }
    }
  }

  const settledJoinOk = graphState["join"] === "succeeded" || graphState["join-retry"] === "succeeded";

  // Steps 8–9 — evidence linkage via explicit associations + verifier adapters.
  const candidateDigest = knobs.candidateStale ? HARNESS_STALE_CANDIDATE : HARNESS_CANDIDATE;
  const applyOutput = knobs.dep === "changed-output" ? "patched-bytes-v2" : "patched-bytes-v1";
  const inputHash = sha256Hex(`policy:${HARNESS_POLICY_HASH}\nnode:apply`);
  const outputDigest = sha256Hex(applyOutput);
  const testOutputDigest = sha256Hex(graphState["test"] ?? "unknown");

  let graphEvidence: MissionGraphRunEvidence | undefined;
  // A corrupt journal cannot be trusted at all: fail closed with no lineage,
  // exactly as the session source refuses to project from malformed bytes.
  // A missing journal likewise yields no evidence to resolve against.
  if (knobs.journal === "ok") {
    graphEvidence = {
      runId: "run-1",
      graphHash: knobs.graphChanged ? sha256Hex("conformance-graph-definition/v4-CHANGED") : HARNESS_GRAPH_HASH,
      policyHash: HARNESS_POLICY_HASH,
      nodes: [
        { nodeId: "propose", status: "succeeded", inputHash: sha256Hex("node:propose"), outputDigest: sha256Hex("proposal"), declaredDependencies: [] },
        { nodeId: "apply", status: graphState["apply"] ?? "blocked", inputHash, outputDigest, declaredDependencies: ["propose"] },
        { nodeId: "test", status: graphState["test"] ?? "blocked", inputHash: sha256Hex("node:test"), outputDigest: testOutputDigest, declaredDependencies: ["apply"] },
        { nodeId: "inspect", status: graphState["inspect"] ?? "blocked", inputHash: sha256Hex("node:inspect"), outputDigest: sha256Hex("inspect-ok"), declaredDependencies: ["apply"] },
      ],
    };
  }
  const ledgerUnavailable = knobs.journal === "corrupt";
  if (ledgerUnavailable) notes.push("journal corrupt: receipt correlation fails closed");

  const associations =
    knobs.associations === "declared" && graphEvidence !== undefined
      ? [
          { criterionId: "criterion-apply", runId: "run-1", nodeId: "apply" },
          { criterionId: "criterion-verify", runId: "run-1", nodeId: "test" },
        ]
      : [];
  const bindings =
    graphEvidence === undefined
      ? []
      : buildCriterionGraphBindings({
          criteria: CRITERIA,
          graphRuns: [graphEvidence],
          associations,
          missionRevision: HARNESS_MISSION_REVISION,
          candidateDigest: HARNESS_CANDIDATE,
        });
  // A changed graph definition invalidates the binding's graph hash: the
  // resolver compares against persisted evidence, so surface the mismatch by
  // resolving against the ORIGINAL definition hash.
  const lineage = resolveCriterionGraphBindings({
    criteria: CRITERIA,
    graphRuns:
      graphEvidence === undefined
        ? []
        : [
            {
              ...graphEvidence,
              graphHash: knobs.graphChanged ? HARNESS_GRAPH_HASH : (graphEvidence.graphHash ?? HARNESS_GRAPH_HASH),
            },
          ],
    bindings,
    ...(ledgerUnavailable ? { ledgerUnavailable: true as const } : { receipts: [] }),
  });

  // Independent verifier adapter run (stub inputs, real adapters).
  const verifiedAt = 1_700_000_000;
  const graphNodes = [{ runId: "run-1", nodeId: "test", attemptId: "test/1" }];
  const findings: VerifierFinding[] = [];
  if (knobs.verifier === "pass" || knobs.verifier === "contradictory" || knobs.verifier === "fail") {
    const passed = knobs.verifier === "pass" || knobs.verifier === "contradictory";
    const finding = verifyTestExecution({
      criterionId: "criterion-verify",
      missionRevision: HARNESS_MISSION_REVISION,
      candidateDigest,
      graphNodes,
      verifiedAt,
      evidenceRef: "suite:conformance-unit",
      passed,
    });
    findings.push(finding);
    if (knobs.verifier === "contradictory") {
      const against = verifyTestExecution({
        criterionId: "criterion-verify",
        missionRevision: HARNESS_MISSION_REVISION,
        candidateDigest,
        graphNodes,
        verifiedAt: verifiedAt + 1,
        evidenceRef: "suite:conformance-unit-rerun",
        passed: false,
      });
      findings.push(against);
      notes.push("contradictory verifier verdicts: never satisfied");
    }
    // build-artifact covers the apply criterion with a memory filesystem.
    const artifactBytes = Buffer.from(applyOutput, "utf8");
    const artifactDigest = sha256Hex(applyOutput);
    const memoryFs = {
      readFile: (path: string): Buffer => {
        if (path.endsWith("dist/app.bin")) return artifactBytes;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    };
    const artifact = verifyBuildArtifact({
      criterionId: "criterion-apply",
      missionRevision: HARNESS_MISSION_REVISION,
      candidateDigest,
      graphNodes: [{ runId: "run-1", nodeId: "apply", attemptId: "apply/1" }],
      verifiedAt,
      path: "dist/app.bin",
      expectedDigest: artifactDigest,
      root: "/sandbox/disposable-repo",
      fs: memoryFs,
    });
    if (artifact !== undefined) findings.push(artifact);
  }
  if (knobs.verifier === "unallowlisted") {
    // A verdict from a verifier outside the host allowlist must not count.
    const finding = verifyTestExecution({
      criterionId: "criterion-verify",
      missionRevision: HARNESS_MISSION_REVISION,
      candidateDigest,
      graphNodes,
      verifiedAt,
      evidenceRef: "suite:custom",
      passed: true,
    });
    (finding as { verifierId: string }).verifierId = "custom-unallowlisted";
    findings.push(finding);
    notes.push("verdict names a verifier outside the host allowlist");
  }
  if (knobs.verifier === "absent") notes.push("no independent verification observed");

  const verifications: MissionCriterionVerification[] = [];
  const receiptsPresent = new Set<string>();
  for (const finding of findings) {
    const correlationId = findingReceiptCorrelationId(finding);
    if (knobs.receipts === "persisted" || knobs.receipts === "conflicting") {
      receiptsPresent.add(correlationId);
    }
    // Conflicting receipts: a second, divergent verdict under the same
    // criterion forces the counting gate to fail closed.
    if (knobs.receipts === "conflicting" && finding.criterionId === "criterion-verify") {
      const conflict = verifyTestExecution({
        criterionId: "criterion-verify",
        missionRevision: HARNESS_MISSION_REVISION,
        candidateDigest,
        graphNodes,
        verifiedAt: verifiedAt + 2,
        evidenceRef: "suite:conformance-conflict",
        passed: finding.result !== "satisfied",
      });
      const conflictId = findingReceiptCorrelationId(conflict);
      receiptsPresent.add(conflictId);
      verifications.push(findingToVerification(conflict, conflictId));
      notes.push("conflicting receipts for one criterion: fail closed");
    }
    verifications.push(findingToVerification(finding, correlationId));
  }

  const { assessments } = validateCriterionVerifications({
    verifications,
    criteria: CRITERIA,
    missionRevision: HARNESS_MISSION_REVISION,
    candidateDigest: HARNESS_CANDIDATE,
    verifierAllowlist: HOST_VERIFIER_ALLOWLIST,
    receiptsPresent,
  });

  // Step 10 — closure attempt: attestation + bound traceability + satisfied
  // independent verification, all for the exact revision and candidate.
  const attested = new Set(CRITERIA.map((criterion) => criterion.id));
  const qualifications = qualifyTrustedCriteria({
    criteria: CRITERIA,
    attested,
    graphStates: lineage,
    verificationAssessments: assessments,
  });
  const allCriteriaQualified =
    qualifications.length === CRITERIA.length && qualifications.every((entry) => entry.qualified);

  // False success claim: the agent claims success while a node is unhealthy —
  // the claim must never override observed evidence.
  const claimedSuccess = knobs.claim === "false-success" ? true : settledJoinOk;
  if (knobs.claim === "false-success") notes.push("false success claim contradicts observed node status; claim ignored");

  // Step 11–12 — terminal verdict (fail-closed ordering).
  let terminal: TerminalVerdict;
  if (!consequentialTaken && knobs.branch === "valid" && !knobs.skipAuthorization && !knobs.resumeRejectedBranch) {
    // The route never admitted the consequential change: a refused route is
    // blocked, an advisory-only deferral is inconclusive (never verified,
    // never executed).
    terminal = routing.disposition === "blocked" ? "blocked" : "inconclusive";
    if (terminal === "inconclusive") notes.push("advisory-only deferral: consequential branch never taken");
  } else if (!authAllowed && sideEffects.length === 0) {
    terminal = "blocked";
  } else if (knobs.journal !== "ok") {
    terminal = "inconclusive";
  } else if (knobs.crashAfterSideEffect || knobs.outcomeAbsent) {
    terminal = "inconclusive";
  } else if (!settledJoinOk || !claimedSuccess) {
    terminal = "incomplete";
  } else if (knobs.graphChanged || knobs.candidateStale) {
    terminal = "inconclusive";
    notes.push("revision/candidate drift: bindings no longer bind the current run");
  } else if (allCriteriaQualified && knobs.verifier === "pass" && knobs.receipts === "persisted") {
    terminal = "verified";
  } else if (assessments.some((assessment) => assessment.outcome === "failed")) {
    terminal = "incomplete";
  } else {
    terminal = "inconclusive";
  }

  // Advisory-only host coverage can never verify a consequential change.
  if (knobs.coverage === "advisory-only-host" && terminal === "verified") {
    terminal = "inconclusive";
    notes.push("advisory-only host: verification requires the full trusted path");
  }

  return {
    scenario,
    graphState,
    traversalOrder,
    routing,
    consequentialTaken,
    authAllowed,
    authReason,
    bypassRefused,
    sideEffects,
    replayReused,
    replaySafe,
    graphEvidence,
    lineage,
    verificationAssessments: assessments,
    allCriteriaQualified,
    terminal,
    closure: terminalToClosure(terminal),
    notes,
  };
}

/** Release-gate counters aggregated across a batch of scenario outcomes. */
export interface ReleaseGateCounters {
  unauthorizedProtectedExecutions: number;
  unsafeReplays: number;
  falseVerifiedCompletions: number;
  unrelatedEvidenceSatisfactions: number;
  unqualifiedPromotions: number;
}

export function countReleaseGates(outcomes: LifecycleOutcome[]): ReleaseGateCounters {
  let unauthorizedProtectedExecutions = 0;
  let unsafeReplays = 0;
  let falseVerifiedCompletions = 0;
  let unrelatedEvidenceSatisfactions = 0;
  let unqualifiedPromotions = 0;
  for (const outcome of outcomes) {
    if (!outcome.authAllowed && outcome.sideEffects.length > 0) unauthorizedProtectedExecutions += 1;
    if (outcome.replayReused) unsafeReplays += 1;
    if (outcome.terminal === "verified" && !outcome.allCriteriaQualified) falseVerifiedCompletions += 1;
    if (outcome.terminal === "verified" && outcome.lineage.length === 0) unrelatedEvidenceSatisfactions += 1;
    if (outcome.consequentialTaken && outcome.routing.disposition !== "allow-consequential") unqualifiedPromotions += 1;
  }
  return {
    unauthorizedProtectedExecutions,
    unsafeReplays,
    falseVerifiedCompletions,
    unrelatedEvidenceSatisfactions,
    unqualifiedPromotions,
  };
}
