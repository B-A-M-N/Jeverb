import { createHash } from "node:crypto";
import type { CriterionGraphEvidence } from "./closure.js";
import type { CriterionCodeStructureEvidence } from "./structural-analysis.js";

/** Current evidence classes that must exist before a mandatory obligation can pass. */
export const REQUIRED_PROOF_EVIDENCE = [
  "graph-execution-lineage",
  "independent-verifier-receipt",
  "qualified-global-semantic-review",
] as const;

export interface ProofObligationDependency {
  runId: string;
  nodeId: string;
  state: "succeeded" | "failed" | "skipped" | "blocked" | "cancelled" | "outcome_unknown" | "missing";
}

/** One mandatory acceptance criterion, expressed as an auditable proof obligation. */
export interface MissionProofObligation {
  id: string;
  criterionId: string;
  requirement: string;
  mandatory: true;
  dependencies: ProofObligationDependency[];
  requiredEvidence: typeof REQUIRED_PROOF_EVIDENCE;
  /** Advisory AST evidence; deterministic verifier receipts remain authoritative. */
  codeStructure?: CriterionCodeStructureEvidence;
}

function normalizedRequirement(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Stable across criterion ordering and unrelated mission edits. */
export function proofObligationId(criterionId: string, requirement: string): string {
  const normalized = normalizedRequirement(requirement);
  return `po-${createHash("sha256").update(`${criterionId.length}:${criterionId}${normalized.length}:${normalized}`, "utf8").digest("hex")}`;
}

/** Project criterion graph evidence into explicit predecessor obligations. */
export function buildMissionProofObligation(args: {
  criterionId: string;
  requirement: string;
  graphEvidence: readonly CriterionGraphEvidence[];
  codeStructure?: CriterionCodeStructureEvidence;
}): MissionProofObligation {
  const dependencies = args.graphEvidence.flatMap((row) =>
    (row.dependencies ?? []).map((dependency) => ({
      runId: row.runId,
      nodeId: dependency.nodeId,
      state: dependency.state,
    })),
  ).sort((a, b) => a.runId.localeCompare(b.runId) || a.nodeId.localeCompare(b.nodeId));
  return {
    id: proofObligationId(args.criterionId, args.requirement),
    criterionId: args.criterionId,
    requirement: args.requirement,
    mandatory: true,
    dependencies,
    requiredEvidence: REQUIRED_PROOF_EVIDENCE,
    ...(args.codeStructure === undefined ? {} : { codeStructure: args.codeStructure }),
  };
}

/** Fail closed on incomplete, duplicated, or stale obligation projections. */
export function validMissionProofObligation(
  obligation: MissionProofObligation | undefined,
  criterionId: string,
  requirement: string,
  scope?: { missionRevision: string; candidateDigest?: string },
): boolean {
  const structure = obligation?.codeStructure;
  const structuralBinding = structure === undefined ? undefined : (() => {
    const { evidenceDigest, ...binding } = structure;
    return createHash("sha256").update(JSON.stringify(binding), "utf8").digest("hex") === evidenceDigest;
  })();
  return obligation !== undefined &&
    obligation.id === proofObligationId(criterionId, requirement) &&
    obligation.criterionId === criterionId &&
    obligation.requirement === requirement &&
    obligation.mandatory === true &&
    obligation.requiredEvidence.length === REQUIRED_PROOF_EVIDENCE.length &&
    obligation.requiredEvidence.every((value, index) => value === REQUIRED_PROOF_EVIDENCE[index]) &&
    (obligation.codeStructure === undefined ||
      obligation.codeStructure.criterionId === criterionId &&
      obligation.codeStructure.proofObligationId === obligation.id &&
      obligation.codeStructure.provenance === "host:typescript-compiler/v1" &&
      structuralBinding === true &&
      (scope === undefined || obligation.codeStructure.missionRevision === scope.missionRevision &&
        obligation.codeStructure.candidateDigest === scope.candidateDigest)) &&
    obligation.dependencies.every((dependency) => dependency.state === "succeeded");
}
