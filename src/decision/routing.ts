/**
 * Consequential-routing qualification: a decision family distinct from
 * mission-closure qualification.
 *
 * A mission-closure manifest proves a backend may judge completion; it says
 * nothing about routing live execution down consequential branches, so it is
 * never accepted here. Advisory routing may use unqualified judgments;
 * selecting a consequential branch additionally requires a qualification
 * record for the exact model + deployed version + question family + decision
 * policy identity. Confidence never grants tool authority: it only clears the
 * per-branch confidence floor once qualification has admitted the route.
 *
 * The deterministic authorizer stays mandatory underneath: this gate admits
 * a *route*, never an execution. Pure: no clock, no model, no network.
 */

import { createHash } from "node:crypto";
import type { DecisionKind } from "./types.js";

/** The only family this gate accepts. Mission-closure families are rejected. */
export const CONSEQUENTIAL_ROUTING_FAMILY = "consequential-routing";

/** Families that qualify mission completion, never consequential routing. */
export const NON_ROUTING_FAMILIES: ReadonlySet<string> = new Set([
  "mission-closure",
  "mission-completion",
  "mission-closure-3stage",
  "corrective-action",
  "stop-intervention",
]);

/**
 * The qualification record as the gate reads it. Existing qualification
 * evidence and thresholds are preserved verbatim: the manifest's own
 * thresholds are recorded and enforced, never weakened or re-derived here.
 */
export interface RoutingQualification {
  /** Qualification record id, for journal attribution. */
  id?: string;
  family: string;
  backend: string;
  model: string;
  modelVersion: string;
  /** Question family (or exact question-set hash) the record was measured on. */
  questionFamily: string;
  /** Opaque hash of the decision policy the thresholds were measured against. */
  policyHash: string;
  /** Whether the record itself reports a qualified release. */
  qualified: boolean;
}

/** The deployment identity the enforcement boundary actually runs. */
export interface RoutingActiveIdentity {
  backend: string;
  model: string;
  modelVersion: string;
  questionFamily: string;
  policyHash: string;
}

export type RoutingDisposition =
  | "allow-consequential"
  | "advisory-only"
  | "blocked"
  | "diagnostic";

export interface RoutingGateResult {
  kind: DecisionKind;
  disposition: RoutingDisposition;
  /** `consequential` only on allow-consequential; advisory-only otherwise. */
  mode: "advisory" | "consequential";
  reasons: string[];
}

export interface RoutingGateInput {
  qualification?: RoutingQualification | undefined;
  active: RoutingActiveIdentity;
  /** Observed confidence for the branch predicate, if any. */
  confidence?: number | undefined;
  /** Per-branch confidence floor (mirrors the executor's default 0.7). */
  minConfidence?: number | undefined;
  /** Thresholds the qualification evidence was measured at (preserved, not weakened). */
  thresholds?: Record<string, number> | undefined;
}

function refuse(disposition: RoutingDisposition, reasons: string[]): RoutingGateResult {
  return {
    kind: "routing",
    disposition,
    mode: "advisory",
    reasons,
  };
}

/**
 * Gate a consequential route. Advisory routing is always permitted (the
 * judgment informs, never decides); a consequential branch is admitted only
 * when every check below passes. Failures are typed: `advisory-only` is a
 * deferral (route without the consequential branch), `blocked` refuses the
 * route, `diagnostic` reports a malformed record that needs operator repair.
 */
export function gateConsequentialRouting(input: RoutingGateInput): RoutingGateResult {
  const threshold = input.minConfidence ?? 0.7;
  const qualification = input.qualification;

  // Unqualified or unavailable: defer to advisory-only. The judgment may
  // still inform; it may not select a consequential branch.
  if (qualification === undefined) {
    return refuse("advisory-only", [
      "no consequential-routing qualification is available; advisory routing only",
    ]);
  }
  if (qualification.qualified !== true) {
    return refuse("advisory-only", [
      "consequential-routing qualification does not report a qualified release; advisory routing only",
    ]);
  }

  // Malformed: missing or blank identity fields cannot be matched, so the
  // route is blocked and the record is flagged for operator repair.
  const fields: Array<[string, string]> = [
    ["family", qualification.family],
    ["backend", qualification.backend],
    ["model", qualification.model],
    ["modelVersion", qualification.modelVersion],
    ["questionFamily", qualification.questionFamily],
    ["policyHash", qualification.policyHash],
  ];
  const malformed = fields.filter(([, value]) => typeof value !== "string" || value.trim() === "");
  if (malformed.length > 0) {
    return {
      kind: "routing",
      disposition: "diagnostic",
      mode: "advisory",
      reasons: [
        `consequential-routing qualification is malformed (blank: ${malformed.map(([name]) => name).join(", ")}); ` +
        "blocked pending operator repair",
      ],
    };
  }

  // Distinct family: mission-closure qualification never qualifies routing.
  if (qualification.family !== CONSEQUENTIAL_ROUTING_FAMILY) {
    const known = NON_ROUTING_FAMILIES.has(qualification.family)
      ? `family ${qualification.family} qualifies mission completion, never consequential routing`
      : `no release policy is defined for family ${qualification.family}`;
    return refuse("blocked", [`${known}; advisory routing only`]);
  }

  // Exact identity: model + deployed version + question family + decision
  // policy must all match what the boundary actually runs.
  const mismatches: string[] = [];
  if (qualification.backend !== input.active.backend) mismatches.push("backend");
  if (qualification.model !== input.active.model) mismatches.push("model");
  if (qualification.modelVersion !== input.active.modelVersion) mismatches.push("modelVersion");
  if (qualification.questionFamily !== input.active.questionFamily) mismatches.push("questionFamily");
  if (qualification.policyHash !== input.active.policyHash) mismatches.push("policyHash");
  if (mismatches.length > 0) {
    return refuse("blocked", [
      `consequential-routing qualification identity mismatch (${mismatches.join(", ")}); advisory routing only`,
    ]);
  }

  // Insufficient confidence defers to advisory-only. Confidence clears the
  // branch floor; it never substitutes for qualification and never grants
  // tool authority (the deterministic authorizer still gates execution).
  if (input.confidence === undefined) {
    return refuse("advisory-only", [
      "no confidence was observed for the branch predicate; advisory routing only",
    ]);
  }
  if (!(input.confidence >= threshold)) {
    return refuse("advisory-only", [
      `observed confidence ${input.confidence} is below the branch floor ${threshold}; advisory routing only`,
    ]);
  }

  return {
    kind: "routing",
    disposition: "allow-consequential",
    mode: "consequential",
    reasons: [
      `consequential-routing qualification ${qualification.id ?? "<unidentified>"} matches ` +
      `backend+model+version+question-family+policy at confidence ${input.confidence} >= ${threshold}; ` +
      "route admitted, execution still requires the deterministic authorizer",
    ],
  };
}

/**
 * Degraded path for model/backend failures (quota exhausted, Stop errors,
 * timeouts, network failures): never an exception and never an admission.
 * A degraded gate degrades to advisory-only with the failure class recorded;
 * consequential branches stay closed until a qualified judgment succeeds.
 */
export function degradedRoutingFor(error: unknown): RoutingGateResult {
  const message = error instanceof Error ? error.message : String(error);
  const failure = /quota|rate.?limit|429/i.test(message)
    ? "quota exhausted"
    : /stop/i.test(message)
      ? "Stop error"
      : /timeout|deadline/i.test(message)
        ? "model timeout"
        : "model unavailable";
  return refuse("advisory-only", [
    `${failure} (${message.slice(0, 200)}); degraded to advisory-only, consequential branches closed`,
  ]);
}

/**
 * Runtime admission of protected (consequential) successors.
 *
 * Classification is explicit, never inferred from confidence: a shell node
 * whose dispatch depends on a Jev decision (`decision.*` condition) is a
 * consequential successor and requires admission. Every other target
 * (jev/review diagnostics, join-only gates, function predicates) stays
 * advisory and keeps the pre-existing predicate behavior.
 *
 * Admission requires a verifier-attested qualification (`verified: true`)
 * bound to the deployment the boundary actually runs (backend + model +
 * deployed version + question family + decision policy) AND to the live
 * judgment being routed on (its provider, model, and question-set hash).
 * A caller-supplied `qualified: true` without the verifier attestation is
 * treated as unavailable, never as sufficient.
 *
 * The deterministic authorizer stays mandatory underneath: this gate admits
 * a *route*, never an execution. Pure apart from the hash: no clock, no
 * model, no network. File reads live in the qualification verifier, never
 * here, so the graph runtime stays lean (the single-set binding below is
 * byte-identical to `questionSetHashFor([hash])` by unit test).
 */

/**
 * A qualification record admitted by authoritative manifest verification.
 * Only the qualification boundary (manifest verifier + branding) mints
 * `verified: true`; the executor treats records without it as unavailable.
 */
export interface VerifiedRoutingQualification extends RoutingQualification {
  /** Verifier attestation: the authoritative manifest verified AND authorized. */
  verified: true;
  /** Stable record id for journal attribution (never caller-chosen at runtime). */
  qualificationId: string;
}

/** Operator admission provisioned for one graph run. Absent = no consequential routes. */
export interface RoutingAdmission {
  /** The deployment identity the enforcement boundary actually runs. */
  active: RoutingActiveIdentity;
  /** Verifier-attested qualification, if any. Unverified records are ignored. */
  qualification?: VerifiedRoutingQualification | undefined;
}

/** Live judgment identity the route is evaluated at. */
export interface RoutingLiveJudgment {
  provider: string;
  model?: string | undefined;
  questionHash: string;
}

/**
 * Explicit advisory-vs-consequential classification. Shell nodes dispatched
 * on a Jev decision are consequential. A Jev-conditioned node is also
 * consequential when its success controls a downstream shell, including
 * through joins; otherwise that branch can indirectly release a shell while
 * avoiding the qualification gate. Diagnostic branches with no shell
 * consequence remain advisory.
 */
export function classifyBranchTarget(
  nodeKind: string,
  conditionField: string | undefined,
  controlsShellDescendant = false,
): "advisory" | "consequential" {
  return (conditionField ?? "").startsWith("decision.") &&
    (nodeKind === "shell" || controlsShellDescendant)
    ? "consequential"
    : "advisory";
}

/**
 * Admit a protected successor branch. The predicate match (verdict/choice/
 * score above its floor) is the caller's input; admission additionally
 * demands the verified qualification, the live-judgment binding, and the
 * gate. Any failure is incapable of admitting protected execution: the
 * returned disposition is advisory-only, blocked, or diagnostic — never
 * allow-consequential.
 */
export function admitProtectedSuccessor(input: {
  admission?: RoutingAdmission | undefined;
  judgment: RoutingLiveJudgment;
  /** Observed confidence for the branch predicate, if any. */
  confidence?: number | undefined;
  minConfidence?: number | undefined;
}): RoutingGateResult {
  const admission = input.admission;
  if (admission === undefined) {
    return refuse("advisory-only", [
      "no consequential-routing admission is provisioned for this run; advisory routing only",
    ]);
  }
  const qualification = admission.qualification;
  if (qualification === undefined || qualification.verified !== true) {
    return refuse("advisory-only", [
      "no verifier-attested consequential-routing qualification is available; " +
      "a caller-supplied qualified flag is never sufficient; advisory routing only",
    ]);
  }
  // Live-judgment binding: the numbers being routed on must come from the
  // pinned deployment. A judgment from another backend, model, or question
  // set cannot ride a qualification measured elsewhere.
  if (input.judgment.provider !== admission.active.backend) {
    return refuse("blocked", [
      `routing judgment backend ${input.judgment.provider} != admitted ${admission.active.backend}; advisory routing only`,
    ]);
  }
  if (input.judgment.model !== admission.active.model) {
    return refuse("blocked", [
      "routing judgment model does not match the admitted model; advisory routing only",
    ]);
  }
  // Single-set binding, byte-identical to questionSetHashFor([hash]): the
  // live question set must be exactly the measured one. Multi-question sets
  // fail closed here by construction.
  const liveSetHash = createHash("sha256")
    .update(JSON.stringify([input.judgment.questionHash].sort()), "utf8")
    .digest("hex");
  if (liveSetHash !== admission.active.questionFamily) {
    return refuse("blocked", [
      "routing judgment question set does not match the admitted question family; advisory routing only",
    ]);
  }
  return gateConsequentialRouting({
    qualification,
    active: admission.active,
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    ...(input.minConfidence === undefined ? {} : { minConfidence: input.minConfidence }),
  });
}
