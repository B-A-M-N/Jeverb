/** Build a bounded plan proposal from the user-authored mission contract and explicit host mapping. */
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { MissionContract } from "./contract.js";
import type { HostProofPlanPayload } from "../control/client.js";

const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_.-]{1,128}$/;
// Graph executor attempt identities are `<node-id>/<sequence>`.
const ATTEMPT = /^[A-Za-z0-9_.-]{1,128}\/[1-9][0-9]{0,8}$/;
const PLAN_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\-/]{1,512}\.(?:ts|tsx|mts|cts)$/;

export interface HostProofPlanInput {
  schema: "jeverb-host-proof-plan-input/1" | "jeverb-host-proof-plan-input/2" | "jeverb-host-proof-plan-input/3" | "jeverb-host-proof-plan-input/4";
  workspaceRoot: string;
  criteria: Array<{
    criterionId: string;
    /** Plain command appears only in the host's pre-approval summary. */
    testCommand: string;
    producers: Array<{ runId: string; nodeId: string; attemptId?: string }>;
    codeFiles: string[];
    /** Host-reviewed supplemental probes. Commands are included only in the PolicyKit approval summary. */
    probeActions?: Array<{
      id: string;
      description: string;
      command: string;
      /** Exact approved graph attempts whose evidence makes this probe relevant. */
      producers?: Array<{ runId: string; nodeId: string; attemptId: string }>;
      nodeId: string;
      maxExecutions: number;
    }>;
    repairActions?: Array<{
      id: string; description: string; command: string;
      producers: Array<{ runId: string; nodeId: string; attemptId: string }>;
      nodeId: string; maxExecutions: 1;
    }>;
  }>;
}

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("proof plan contains a non-JSON value");
  return encoded;
}

/** Digest function shared with the control-service canonical JSON receipt. */
export function hostProofPlanContentDigest(plan: HostProofPlanPayload): string {
  const wire = {
    schema: plan.schema,
    mission_id: plan.missionId,
    mission_revision: plan.missionRevision,
    objective_sha256: plan.objectiveSha256,
    workspace_root: plan.workspaceRoot,
    criteria: plan.criteria.map((criterion) => ({
      criterion_id: criterion.criterionId,
      requirement_sha256: criterion.requirementSha256,
      test_command_sha256: criterion.testCommandSha256,
      ...(plan.schema === "jeverb-host-proof-plan/4" ? { test_command: criterion.testCommand } : {}),
      producers: criterion.producers.map((producer) => ({
        run_id: producer.runId,
        node_id: producer.nodeId,
        ...(producer.attemptId === undefined ? {} : { attempt_id: producer.attemptId }),
      })),
      code_files: criterion.codeFiles,
      ...(plan.schema !== "jeverb-host-proof-plan/1"
        ? { probe_actions: (criterion.probeActions ?? []).map((action) => ({
            id: action.id,
            description: action.description,
            command: action.command,
            command_sha256: action.commandSha256,
            ...((plan.schema === "jeverb-host-proof-plan/3" || plan.schema === "jeverb-host-proof-plan/4") ? { producers: (action.producers ?? []).map((producer) => ({
              run_id: producer.runId,
              node_id: producer.nodeId,
              attempt_id: producer.attemptId,
            })) } : {}),
            node_id: action.nodeId,
            max_executions: action.maxExecutions,
          })) }
        : {}),
      ...(plan.schema === "jeverb-host-proof-plan/4" ? { repair_actions: (criterion.repairActions ?? []).map((action) => ({
        id: action.id, description: action.description, command: action.command, command_sha256: action.commandSha256,
        producers: action.producers.map((producer) => ({ run_id: producer.runId, node_id: producer.nodeId, attempt_id: producer.attemptId })),
        node_id: action.nodeId, max_executions: action.maxExecutions,
      })) } : {}),
    })),
  };
  return hash(canonicalJson(wire));
}

/** Validate every obligation and explicit graph/source mapping; never invent an association. */
export function buildHostProofPlanPayload(
  contract: MissionContract,
  rawInput: unknown,
): HostProofPlanPayload {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    throw new Error("host proof-plan mapping must be an object");
  }
  const input = rawInput as HostProofPlanInput;
  const keys = Object.keys(rawInput as Record<string, unknown>).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["criteria", "schema", "workspaceRoot"])) {
    throw new Error("host proof-plan mapping contains unknown or missing fields");
  }
  const isV4 = input.schema === "jeverb-host-proof-plan-input/4";
  const isV3 = input.schema === "jeverb-host-proof-plan-input/3" || isV4;
  const isV2 = input.schema === "jeverb-host-proof-plan-input/2" || isV3;
  if ((input.schema !== "jeverb-host-proof-plan-input/1" && !isV2) || typeof input.workspaceRoot !== "string" || !isAbsolute(input.workspaceRoot) ||
      !Array.isArray(input.criteria) || input.criteria.length !== contract.criteria.length || input.criteria.length === 0) {
    throw new Error("host proof-plan input does not cover the complete mission contract");
  }
  const root = realpathSync(input.workspaceRoot);
  if (root !== resolve(input.workspaceRoot) || !statSync(root).isDirectory()) {
    throw new Error("host proof-plan workspace root must be a canonical real directory");
  }
  if (input.criteria.some((criterion) => typeof criterion !== "object" || criterion === null || Array.isArray(criterion))) {
    throw new Error("host proof-plan criterion entries must be objects");
  }
  const byId = new Map(input.criteria.map((criterion) => [criterion.criterionId, criterion]));
  if (byId.size !== input.criteria.length) throw new Error("host proof-plan contains duplicate criteria");
  const expectedIds = new Set(contract.criteria.map(({ id }) => id));
  if (byId.size !== expectedIds.size || [...byId.keys()].some((id) => !expectedIds.has(id))) {
    throw new Error("host proof-plan criteria must exactly match the user-authored mission contract");
  }
  const criteria = contract.criteria.map((criterion) => {
    const assignment = byId.get(criterion.id);
    const expectedAssignmentKeys = isV4
      ? ["codeFiles", "criterionId", "probeActions", "producers", "repairActions", "testCommand"]
      : isV2
        ? ["codeFiles", "criterionId", "probeActions", "producers", "testCommand"]
      : ["codeFiles", "criterionId", "producers", "testCommand"];
    if (assignment !== undefined && JSON.stringify(Object.keys(assignment).sort()) !== JSON.stringify(expectedAssignmentKeys)) {
      throw new Error(`host proof-plan assignment contains unknown or missing fields for ${criterion.id}`);
    }
    if (assignment === undefined || !Array.isArray(assignment.producers) || assignment.producers.length === 0 ||
        assignment.producers.length > 8 || !Array.isArray(assignment.codeFiles) ||
        assignment.codeFiles.length === 0 || assignment.codeFiles.length > 16 ||
        typeof assignment.testCommand !== "string" || assignment.testCommand.trim() === "" ||
        assignment.testCommand.length > 512 || /[\r\n\0]/.test(assignment.testCommand)) {
      throw new Error(`host proof-plan assignment is missing or unbounded for ${criterion.id}`);
    }
    const producerKeys = new Set<string>();
    const producers = assignment.producers.map((producer) => {
      if (typeof producer !== "object" || producer === null || Array.isArray(producer) ||
          JSON.stringify(Object.keys(producer).sort()) !== JSON.stringify(
            (producer.attemptId === undefined ? ["nodeId", "runId"] : ["attemptId", "nodeId", "runId"]).sort(),
          ) ||
          typeof producer.runId !== "string" || !TOKEN.test(producer.runId) ||
          typeof producer.nodeId !== "string" || !TOKEN.test(producer.nodeId) ||
          (producer.attemptId !== undefined &&
            (typeof producer.attemptId !== "string" || !ATTEMPT.test(producer.attemptId)))) {
        throw new Error(`host proof-plan producer identity is invalid for ${criterion.id}`);
      }
      const key = `${producer.runId.length}:${producer.runId}${producer.nodeId.length}:${producer.nodeId}${producer.attemptId?.length ?? 0}:${producer.attemptId ?? ""}`;
      if (producerKeys.has(key)) throw new Error(`host proof-plan repeats a producer for ${criterion.id}`);
      producerKeys.add(key);
      return {
        runId: producer.runId,
        nodeId: producer.nodeId,
        ...(producer.attemptId === undefined ? {} : { attemptId: producer.attemptId }),
      };
    });
    if (assignment.codeFiles.some((path) => typeof path !== "string") ||
        new Set(assignment.codeFiles).size !== assignment.codeFiles.length ||
        assignment.codeFiles.some((path) => !PLAN_PATH.test(path))) {
      throw new Error(`host proof-plan source paths are invalid for ${criterion.id}`);
    }
    let probeActions: NonNullable<HostProofPlanPayload["criteria"][number]["probeActions"]> | undefined;
    const probeIds = new Set<string>();
    if (isV2) {
      if (!Array.isArray(assignment.probeActions) || assignment.probeActions.length > 8) {
        throw new Error(`host proof-plan probe actions are missing or exceed policy bounds for ${criterion.id}`);
      }
      const probeNodes = new Set<string>();
      const producerNodes = new Set(producers.map((producer) => producer.nodeId));
      probeActions = assignment.probeActions.map((probe) => {
        if (typeof probe !== "object" || probe === null || Array.isArray(probe) ||
            JSON.stringify(Object.keys(probe).sort()) !== JSON.stringify(isV3
              ? ["command", "description", "id", "maxExecutions", "nodeId", "producers"]
              : ["command", "description", "id", "maxExecutions", "nodeId"]) ||
            typeof probe.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(probe.id) || probeIds.has(probe.id) ||
            typeof probe.description !== "string" || probe.description.trim() === "" || probe.description.length > 300 ||
            typeof probe.command !== "string" || probe.command.trim() === "" || probe.command.length > 512 || /[\r\n\0]/.test(probe.command) ||
            (isV3 && (!Array.isArray(probe.producers) || probe.producers.length === 0 || probe.producers.length > 8)) ||
            typeof probe.nodeId !== "string" || !TOKEN.test(probe.nodeId) || probeNodes.has(probe.nodeId) || producerNodes.has(probe.nodeId) ||
            !Number.isSafeInteger(probe.maxExecutions) || probe.maxExecutions < 1 || probe.maxExecutions > 3) {
          throw new Error(`host proof-plan probe action is malformed or unbounded for ${criterion.id}`);
        }
        const actionProducerKeys = new Set<string>();
        const actionProducers = (probe.producers ?? []).map((producer) => {
          if (typeof producer !== "object" || producer === null || Array.isArray(producer) ||
              JSON.stringify(Object.keys(producer).sort()) !== JSON.stringify(["attemptId", "nodeId", "runId"]) ||
              typeof producer.runId !== "string" || !TOKEN.test(producer.runId) ||
              typeof producer.nodeId !== "string" || !TOKEN.test(producer.nodeId) ||
              typeof producer.attemptId !== "string" || !ATTEMPT.test(producer.attemptId)) {
            throw new Error(`host proof-plan probe producer identity is invalid for ${criterion.id}`);
          }
          const key = `${producer.runId.length}:${producer.runId}${producer.nodeId.length}:${producer.nodeId}${producer.attemptId}`;
          const isCriterionProducer = producers.some((candidate) => candidate.runId === producer.runId &&
            candidate.nodeId === producer.nodeId && candidate.attemptId === producer.attemptId);
          if (actionProducerKeys.has(key) || !isCriterionProducer) {
            throw new Error(`host proof-plan probe producer is not an exact criterion producer for ${criterion.id}`);
          }
          actionProducerKeys.add(key);
          return { runId: producer.runId, nodeId: producer.nodeId, attemptId: producer.attemptId };
        });
        if (isV3 && actionProducers.length !== probe.producers?.length) {
          throw new Error(`host proof-plan probe producer mapping is incomplete for ${criterion.id}`);
        }
        probeIds.add(probe.id);
        probeNodes.add(probe.nodeId);
        return {
          id: probe.id,
          description: probe.description.trim(),
          command: probe.command,
          ...(isV3 ? { producers: actionProducers } : {}),
          commandSha256: hash(probe.command),
          nodeId: probe.nodeId,
          maxExecutions: probe.maxExecutions,
        };
      });
    }
    let repairActions: NonNullable<HostProofPlanPayload["criteria"][number]["repairActions"]> | undefined;
    if (isV4) {
      if (!Array.isArray(assignment.repairActions) || assignment.repairActions.length > 1) {
        throw new Error(`host proof-plan repair actions are missing or exceed policy bounds for ${criterion.id}`);
      }
      const usedNodeIds = new Set([...(probeActions ?? []).map((action) => action.nodeId), ...producers.map((producer) => producer.nodeId)]);
      repairActions = assignment.repairActions.map((repair) => {
        if (typeof repair !== "object" || repair === null || Array.isArray(repair) ||
            JSON.stringify(Object.keys(repair).sort()) !== JSON.stringify(["command", "description", "id", "maxExecutions", "nodeId", "producers"]) ||
            typeof repair.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(repair.id) ||
            probeIds.has(repair.id) ||
            typeof repair.description !== "string" || repair.description.trim() === "" || repair.description.length > 300 ||
            typeof repair.command !== "string" || repair.command.trim() === "" || repair.command.length > 512 || /[\r\n\0]/.test(repair.command) ||
            typeof repair.nodeId !== "string" || !TOKEN.test(repair.nodeId) || usedNodeIds.has(repair.nodeId) ||
            repair.maxExecutions !== 1 || !Array.isArray(repair.producers) || repair.producers.length === 0 || repair.producers.length > 8) {
          throw new Error(`host proof-plan repair action is malformed or unbounded for ${criterion.id}`);
        }
        const repairProducerKeys = new Set<string>();
        const actionProducers = repair.producers.map((producer) => {
          const matches = producers.some((candidate) => candidate.runId === producer.runId &&
            candidate.nodeId === producer.nodeId && candidate.attemptId === producer.attemptId);
          const producerKey = `${producer.runId.length}:${producer.runId}${producer.nodeId.length}:${producer.nodeId}${producer.attemptId}`;
          if (!matches || !ATTEMPT.test(producer.attemptId) || repairProducerKeys.has(producerKey)) {
            throw new Error(`host proof-plan repair producer is not a unique exact criterion producer for ${criterion.id}`);
          }
          repairProducerKeys.add(producerKey);
          return { runId: producer.runId, nodeId: producer.nodeId, attemptId: producer.attemptId };
        });
        usedNodeIds.add(repair.nodeId);
        return { id: repair.id, description: repair.description.trim(), command: repair.command,
          commandSha256: hash(repair.command), producers: actionProducers, nodeId: repair.nodeId, maxExecutions: 1 as const };
      });
    }
    return {
      criterionId: criterion.id,
      requirementSha256: hash(criterion.statement),
      testCommandSha256: hash(assignment.testCommand),
      ...(isV4 ? { testCommand: assignment.testCommand } : {}),
      producers,
      codeFiles: [...assignment.codeFiles].sort(),
      ...(probeActions === undefined ? {} : { probeActions }),
      ...(repairActions === undefined ? {} : { repairActions }),
    };
  });
  const objectiveSha256 = hash(contract.objective);
  if (!HEX64.test(objectiveSha256)) throw new Error("host proof-plan objective identity is invalid");
  return {
    schema: isV4 ? "jeverb-host-proof-plan/4" : isV3 ? "jeverb-host-proof-plan/3" : isV2 ? "jeverb-host-proof-plan/2" : "jeverb-host-proof-plan/1",
    missionId: contract.missionId,
    missionRevision: contract.missionRevision,
    objectiveSha256,
    workspaceRoot: root,
    criteria,
  };
}
