import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { readMasterSwitch, type MasterSwitchStatus } from "./master-switch.js";
import { CONTROL_SOCKET_PATH, PROTECTED_MASTER_SWITCH_PATH } from "./constants.js";

interface ServiceReply {
  ok: boolean;
  error?: string;
  message?: string;
  desired?: "ON" | "OFF";
  effective?: "ON" | "OFF";
  generation?: string;
  updated_at?: number;
  attestations?: unknown;
  plan?: unknown;
  result?: string;
  receipt_correlation_id?: string;
}

function request(payload: Record<string, unknown>, timeoutMs = 185_000): Promise<ServiceReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(CONTROL_SOCKET_PATH);
  let response = "";
    const timeout = setTimeout(() => socket.destroy(new Error("control service request timed out")), timeoutMs);
    socket.once("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      response += String(chunk);
      if (response.length > 16_384) socket.destroy(new Error("control service response exceeded limit"));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(response) as ServiceReply;
        if (parsed.ok !== true) reject(new Error(`${parsed.error ?? "control_error"}: ${parsed.message ?? "request failed"}`));
        else resolve(parsed);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("invalid control service response"));
      }
    });
  });
}

/** CLI observation uses the service's STATUS operation and has no mutation authority. */
export async function controlStatus(): Promise<ServiceReply> {
  return request({ op: "STATUS" });
}

/** A transition is a separate, action-specific Polkit authorization every time. */
export async function setControlState(action: "on" | "off"): Promise<ServiceReply> {
  const current = await controlStatus();
  if (typeof current.generation !== "string") throw new Error("service status omitted generation");
  return request({
    op: action === "on" ? "SET_ON" : "SET_OFF",
    generation: current.generation,
    request_id: randomUUID().replaceAll("-", ""),
  });
}

/** One operator-signed independent verification, as stored by the service. */
export interface ServiceAttestation {
  missionId: string;
  missionRevision: string;
  evidenceRevision: string;
  candidate: string;
  result: "pass" | "fail";
  receiptCorrelationId: string;
  verifiedAt: number;
  verifierUid: number;
}

export interface AttestationStatusReply {
  ok: boolean;
  generation: string;
  attestations: ServiceAttestation[];
}

export interface HostProofPlanPayload {
  schema: "jeverb-host-proof-plan/1" | "jeverb-host-proof-plan/2" | "jeverb-host-proof-plan/3" | "jeverb-host-proof-plan/4";
  missionId: string;
  missionRevision: string;
  objectiveSha256: string;
  workspaceRoot: string;
  criteria: Array<{
    criterionId: string;
    requirementSha256: string;
    /** SHA-256 of the exact host verification command authorized for this criterion. */
    testCommandSha256: string;
    /** Present only in v4: approved command to rerun after graph repair. */
    testCommand?: string;
    producers: Array<{ runId: string; nodeId: string; attemptId?: string }>;
    codeFiles: string[];
    /** Exact supplemental commands approved for criterion-local semantic investigation (v2 only). */
    probeActions?: Array<{
      id: string;
      description: string;
      command: string;
      commandSha256: string;
      producers?: Array<{ runId: string; nodeId: string; attemptId: string }>;
      nodeId: string;
      maxExecutions: number;
    }>;
    /** V4: exactly one pre-authorized graph repair command, when automation is allowed. */
    repairActions?: Array<{
      id: string; description: string; command: string;
      commandSha256: string;
      producers: Array<{ runId: string; nodeId: string; attemptId: string }>;
      nodeId: string; maxExecutions: 1;
    }>;
  }>;
}

export interface ServiceHostProofPlan extends HostProofPlanPayload {
  planDigest: string;
  receiptCorrelationId: string;
  approvedAt: number;
  approvedByUid: number;
}

export interface ProofPlanStatusReply {
  ok: true;
  generation: string;
  plan?: ServiceHostProofPlan;
}

interface WireAttestation {
  mission_id: string;
  mission_revision: string;
  evidence_revision: string;
  candidate: string;
  result: "pass" | "fail";
  receipt_correlation_id: string;
  verified_at: number;
  verifier_uid: number;
}

function isWireAttestation(value: unknown): value is WireAttestation {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["mission_id"] === "string" &&
    typeof entry["mission_revision"] === "string" &&
    typeof entry["evidence_revision"] === "string" &&
    typeof entry["candidate"] === "string" &&
    (entry["result"] === "pass" || entry["result"] === "fail") &&
    typeof entry["receipt_correlation_id"] === "string" &&
    typeof entry["verified_at"] === "number" &&
    typeof entry["verifier_uid"] === "number"
  );
}

/** Read-only: which operator attestations exist for one mission. */
export async function attestationStatus(missionId: string, timeoutMs = 750): Promise<AttestationStatusReply> {
  const reply = await request({ op: "ATTEST_STATUS", mission_id: missionId }, timeoutMs);
  if (reply.ok !== true || typeof reply.generation !== "string" || !Array.isArray(reply.attestations)) {
    throw new Error("service attestation status was invalid");
  }
  const raw = reply.attestations as unknown[];
  if (!raw.every(isWireAttestation)) throw new Error("service attestation status was invalid");
  return {
    ok: true,
    generation: reply.generation as string,
    attestations: raw.map((entry) => ({
      missionId: entry.mission_id,
      missionRevision: entry.mission_revision,
      evidenceRevision: entry.evidence_revision,
      candidate: entry.candidate,
      result: entry.result,
      receiptCorrelationId: entry.receipt_correlation_id,
      verifiedAt: entry.verified_at,
      verifierUid: entry.verifier_uid,
    })),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function proofPlanFromWire(value: unknown): ServiceHostProofPlan | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const plan = row["plan"] as Record<string, unknown> | undefined;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan) ||
      typeof row["plan_digest"] !== "string" || !/^[0-9a-f]{64}$/.test(row["plan_digest"]) ||
      typeof row["receipt_correlation_id"] !== "string" || !/^[0-9a-f]{32}$/.test(row["receipt_correlation_id"]) ||
      typeof row["approved_at"] !== "number" || typeof row["approved_by_uid"] !== "number") return undefined;
  const criteria = plan["criteria"];
  if (!Array.isArray(criteria)) return undefined;
  const v4 = plan["schema"] === "jeverb-host-proof-plan/4";
  const v3 = plan["schema"] === "jeverb-host-proof-plan/3" || v4;
  const v2 = plan["schema"] === "jeverb-host-proof-plan/2" || v3;
  if (!v2 && plan["schema"] !== "jeverb-host-proof-plan/1") return undefined;
  if (v2 && criteria.some((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return true;
    const probes = (entry as Record<string, unknown>)["probe_actions"];
    return !Array.isArray(probes) || probes.length > 8 || probes.some((probe) => {
      if (typeof probe !== "object" || probe === null || Array.isArray(probe)) return true;
      const action = probe as Record<string, unknown>;
      return typeof action["id"] !== "string" || typeof action["description"] !== "string" ||
        typeof action["command"] !== "string" || typeof action["command_sha256"] !== "string" ||
        typeof action["node_id"] !== "string" || !Number.isSafeInteger(action["max_executions"]) ||
        (v3 && (!Array.isArray(action["producers"]) || action["producers"].length === 0 || action["producers"].length > 8 ||
          action["producers"].some((producer) => typeof producer !== "object" || producer === null || Array.isArray(producer) ||
            typeof producer["run_id"] !== "string" || typeof producer["node_id"] !== "string" ||
            typeof producer["attempt_id"] !== "string")));
    });
  })) return undefined;
  if (v4 && criteria.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry) ||
      typeof (entry as Record<string, unknown>)["test_command"] !== "string" ||
      !Array.isArray((entry as Record<string, unknown>)["repair_actions"]) ||
      ((entry as Record<string, unknown>)["repair_actions"] as unknown[]).length > 1)) return undefined;
  const camel: HostProofPlanPayload = {
    schema: plan["schema"] as HostProofPlanPayload["schema"],
    missionId: plan["mission_id"] as string,
    missionRevision: plan["mission_revision"] as string,
    objectiveSha256: plan["objective_sha256"] as string,
    workspaceRoot: plan["workspace_root"] as string,
    criteria: criteria.map((item) => {
      const criterion = item as Record<string, unknown>;
      return {
        criterionId: criterion["criterion_id"] as string,
        requirementSha256: criterion["requirement_sha256"] as string,
        testCommandSha256: criterion["test_command_sha256"] as string,
        ...(v4 ? { testCommand: criterion["test_command"] as string } : {}),
        producers: (criterion["producers"] as Array<Record<string, unknown>>).map((producer) => ({
          runId: producer["run_id"] as string,
          nodeId: producer["node_id"] as string,
          ...(producer["attempt_id"] === undefined ? {} : { attemptId: producer["attempt_id"] as string }),
        })),
        codeFiles: criterion["code_files"] as string[],
        ...(v2 ? {
          probeActions: (criterion["probe_actions"] as Array<Record<string, unknown>>).map((action) => ({
            id: action["id"] as string,
            description: action["description"] as string,
            command: action["command"] as string,
            commandSha256: action["command_sha256"] as string,
            ...(v3 ? { producers: (action["producers"] as Array<Record<string, unknown>>).map((producer) => ({
              runId: producer["run_id"] as string,
              nodeId: producer["node_id"] as string,
              attemptId: producer["attempt_id"] as string,
            })) } : {}),
            nodeId: action["node_id"] as string,
            maxExecutions: action["max_executions"] as number,
          })),
        } : {}),
        ...(v4 ? { repairActions: (criterion["repair_actions"] as Array<Record<string, unknown>>).map((action) => ({
          id: action["id"] as string,
          description: action["description"] as string,
          command: action["command"] as string,
          commandSha256: action["command_sha256"] as string,
          producers: (action["producers"] as Array<Record<string, unknown>>).map((producer) => ({
            runId: producer["run_id"] as string, nodeId: producer["node_id"] as string,
            attemptId: producer["attempt_id"] as string,
          })),
          nodeId: action["node_id"] as string,
          maxExecutions: action["max_executions"] as 1,
        })) } : {}),
      };
    }),
  };
  const body = {
    schema: camel.schema,
    mission_id: camel.missionId,
    mission_revision: camel.missionRevision,
    objective_sha256: camel.objectiveSha256,
    workspace_root: camel.workspaceRoot,
    criteria: camel.criteria.map((criterion) => ({
      criterion_id: criterion.criterionId,
      requirement_sha256: criterion.requirementSha256,
      test_command_sha256: criterion.testCommandSha256,
      ...(camel.schema === "jeverb-host-proof-plan/4" ? { test_command: criterion.testCommand } : {}),
      producers: criterion.producers.map((producer) => ({
        run_id: producer.runId,
        node_id: producer.nodeId,
        ...(producer.attemptId === undefined ? {} : { attempt_id: producer.attemptId }),
      })),
      code_files: criterion.codeFiles,
            ...(camel.schema !== "jeverb-host-proof-plan/1"
        ? { probe_actions: (criterion.probeActions ?? []).map((action) => ({
            id: action.id,
            description: action.description,
            command: action.command,
            command_sha256: action.commandSha256,
            ...((camel.schema === "jeverb-host-proof-plan/3" || camel.schema === "jeverb-host-proof-plan/4") ? { producers: (action.producers ?? []).map((producer) => ({
              run_id: producer.runId,
              node_id: producer.nodeId,
              attempt_id: producer.attemptId,
            })) } : {}),
            node_id: action.nodeId,
            max_executions: action.maxExecutions,
          })) }
        : {}),
      ...(camel.schema === "jeverb-host-proof-plan/4" ? { repair_actions: (criterion.repairActions ?? []).map((action) => ({
        id: action.id, description: action.description, command: action.command, command_sha256: action.commandSha256,
        producers: action.producers.map((producer) => ({ run_id: producer.runId, node_id: producer.nodeId, attempt_id: producer.attemptId })),
        node_id: action.nodeId, max_executions: action.maxExecutions,
      })) } : {}),
    })),
  };
  // Server hashes sorted-key UTF-8 JSON. Verify it again at this trust boundary.
  const digest = createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
  if (digest !== row["plan_digest"]) return undefined;
  return {
    ...camel,
    planDigest: row["plan_digest"],
    receiptCorrelationId: row["receipt_correlation_id"],
    approvedAt: row["approved_at"],
    approvedByUid: row["approved_by_uid"],
  };
}

function isWirePlan(value: unknown): value is HostProofPlanPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const v4 = row["schema"] === "jeverb-host-proof-plan/4";
  const v3 = row["schema"] === "jeverb-host-proof-plan/3" || v4;
  const v2 = row["schema"] === "jeverb-host-proof-plan/2" || v3;
  return (row["schema"] === "jeverb-host-proof-plan/1" || v2) &&
    typeof row["missionId"] === "string" && typeof row["missionRevision"] === "string" &&
    typeof row["objectiveSha256"] === "string" && typeof row["workspaceRoot"] === "string" &&
    Array.isArray(row["criteria"]) && (!v2 || (row["criteria"] as unknown[]).every((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
      const criterion = item as Record<string, unknown>;
      if (!Array.isArray(criterion["producers"]) || criterion["producers"].length === 0 || criterion["producers"].length > 8 ||
          !criterion["producers"].every((producer) => typeof producer === "object" && producer !== null &&
            typeof producer["runId"] === "string" && typeof producer["nodeId"] === "string" &&
            (producer["attemptId"] === undefined || typeof producer["attemptId"] === "string"))) return false;
      if (!Array.isArray(criterion["probeActions"]) || criterion["probeActions"].length > 8) return false;
      if (v4 && (typeof criterion["testCommand"] !== "string" || !Array.isArray(criterion["repairActions"]) || criterion["repairActions"].length > 1)) return false;
      if (v4 && !(criterion["repairActions"] as unknown[]).every((raw) => {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
        const repair = raw as Record<string, unknown>;
        return typeof repair["id"] === "string" && typeof repair["description"] === "string" &&
          typeof repair["command"] === "string" && typeof repair["commandSha256"] === "string" &&
          typeof repair["nodeId"] === "string" && repair["maxExecutions"] === 1 &&
          Array.isArray(repair["producers"]) && repair["producers"].length >= 1 && repair["producers"].length <= 8;
      })) return false;
      return criterion["probeActions"].every((raw) => {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
        const action = raw as Record<string, unknown>;
        if (!(typeof action["id"] === "string" && typeof action["description"] === "string" &&
          typeof action["command"] === "string" && typeof action["commandSha256"] === "string" &&
          typeof action["nodeId"] === "string" && Number.isSafeInteger(action["maxExecutions"]) &&
          (!v3 || (Array.isArray(action["producers"]) && action["producers"].length >= 1 && action["producers"].length <= 8 &&
            action["producers"].every((producer) => typeof producer === "object" && producer !== null &&
              typeof producer["runId"] === "string" && typeof producer["nodeId"] === "string" &&
              typeof producer["attemptId"] === "string"))))) return false;
        if (!v3) return true;
        const actionProducers = action["producers"] as Array<Record<string, unknown>>;
        const criterionProducers = criterion["producers"] as Array<Record<string, unknown>>;
        return actionProducers.every((probeProducer) => criterionProducers.some((producer) =>
          producer["runId"] === probeProducer["runId"] && producer["nodeId"] === probeProducer["nodeId"] &&
          producer["attemptId"] === probeProducer["attemptId"]));
      });
    }));
}

/** Read the root-owned, PolicyKit-approved proof plan for one mission. */
export async function proofPlanStatus(missionId: string, timeoutMs = 750): Promise<ProofPlanStatusReply> {
  const reply = await request({ op: "PROOF_PLAN_STATUS", mission_id: missionId }, timeoutMs);
  if (reply.ok !== true || typeof reply.generation !== "string") throw new Error("service proof-plan status was invalid");
  if (reply.plan === null || reply.plan === undefined) return { ok: true, generation: reply.generation };
  const plan = proofPlanFromWire(reply.plan);
  if (plan === undefined || plan.missionId !== missionId) throw new Error("service proof plan failed provenance validation");
  return { ok: true, generation: reply.generation, plan };
}

/** Submit one host-built plan for a fresh PolicyKit authorization. */
export async function setProofPlan(plan: HostProofPlanPayload, timeoutMs = 10_000): Promise<ServiceHostProofPlan> {
  if (!isWirePlan(plan)) throw new Error("proof plan shape is invalid");
  const status = await proofPlanStatus(plan.missionId, timeoutMs);
  const reply = await request({
    op: "PROOF_PLAN_SET",
    generation: status.generation,
    request_id: randomUUID().replaceAll("-", ""),
    plan: {
      schema: plan.schema,
      mission_id: plan.missionId,
      mission_revision: plan.missionRevision,
      objective_sha256: plan.objectiveSha256,
      workspace_root: plan.workspaceRoot,
      criteria: plan.criteria.map((criterion) => ({
        criterion_id: criterion.criterionId,
        requirement_sha256: criterion.requirementSha256,
        test_command_sha256: criterion.testCommandSha256,
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
        ...(plan.schema === "jeverb-host-proof-plan/4" ? { test_command: criterion.testCommand } : {}),
        ...(plan.schema === "jeverb-host-proof-plan/4" ? { repair_actions: (criterion.repairActions ?? []).map((action) => ({
          id: action.id, description: action.description, command: action.command, command_sha256: action.commandSha256,
          producers: action.producers.map((producer) => ({ run_id: producer.runId, node_id: producer.nodeId, attempt_id: producer.attemptId })),
          node_id: action.nodeId, max_executions: action.maxExecutions,
        })) } : {}),
      })),
    },
  }, timeoutMs);
  if (reply.ok !== true) throw new Error("service rejected the proof plan");
  const stored = proofPlanFromWire(reply.plan);
  if (stored === undefined || stored.missionId !== plan.missionId) throw new Error("service proof-plan receipt was invalid");
  return stored;
}

/** Operator-signed verdict; each call is a separate action-specific Polkit authorization. */
export async function attestIndependentVerification(args: {
  result: "pass" | "fail";
  missionId: string;
  missionRevision: string;
  evidenceRevision: string;
  candidate: string;
}, timeoutMs = 10000): Promise<ServiceReply> {
  const status = await attestationStatus(args.missionId, timeoutMs);
  return request({
    op: args.result === "pass" ? "ATTEST_PASS" : "ATTEST_FAIL",
    generation: status.generation,
    request_id: randomUUID().replaceAll("-", ""),
    mission_id: args.missionId,
    mission_revision: args.missionRevision,
    evidence_revision: args.evidenceRevision,
    candidate: args.candidate,
  }, timeoutMs);
}

/** Read-only hook view. An absent or untrusted service state suppresses hooks. */
export function protectedSwitchStatus(envDisabled = false): MasterSwitchStatus {
  return readMasterSwitch("", envDisabled, PROTECTED_MASTER_SWITCH_PATH, true);
}
