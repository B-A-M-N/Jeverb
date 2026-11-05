/**
 * Host-side execution implementation for jev_execute_graph.
 *
 * Kept free of MCP/Zod schema imports so the Stop hook can call the exact
 * same journaled, authorized graph path without bundling tool validation
 * dependencies into the hook executable.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionModel } from "../decision/types.js";
import type { RoutingAdmission } from "../decision/routing.js";
import {
  admitRoutingQualification,
  verifyQualificationManifest,
  type QualificationActiveIdentity,
  type QualificationEvidenceFiles,
  type QualificationManifest,
} from "../jev/qualification.js";
import { PROTECTED_MASTER_SWITCH_PATH, REQUIRE_ROOT_OWNED_SWITCH } from "../control/constants.js";
import { buildJevState, executeGraph, expandGraphLoops, graphHash as fingerprintGraph, hashValue, validateGraph, type Graph, type GraphNode, type NodeRunContext } from "../graph/executor.js";
import { makeDeterministicAuthorizer } from "../graph/authorizer.js";
import type { ExecutionPolicy } from "../graph/policy.js";
import { runShellConstrained } from "../graph/runner.js";
import { FileJournal, journalExists, newRunId, reconcileJournal } from "../graph/journal.js";
import { limitsFor } from "../graph/policy.js";
import { EvidenceLedger } from "../evidence/ledger.js";
import { persistGraphNodeReceipt } from "../graph/receipt.js";
import { GraphOutputArtifactStore } from "../graph/artifact.js";
import { runGraphExtractors } from "../graph/extractors.js";
import { hasGraphDefinition, loadGraphDefinition, saveGraphDefinition } from "../graph/store.js";
import { withFileLockAsync } from "../hooks/store-lock.js";
import { toQuestion, type ToolConfig } from "./runtime-shared.js";
import { bindExtractorIdentities, expandPointer, MAX_BINDING_VALUE_CHARS, policyHash, resolveBindings, selectOutput } from "./graph-bindings.js";
import type { ReviewResult } from "../review/policy.js";

import type { ExecuteGraphToolInput, ExecuteGraphToolOutput } from "./execute-graph-schema.js";
/**
 * Authenticated principal for MCP-invoked runs. The stdio MCP transport
 * performs no caller authentication, so every MCP run is explicitly
 * `unverified:mcp-stdio` — an honest statement that no verified identity
 * exists, and proof that a model-supplied source string can never mint
 * operator authority.
 */
export const GRAPH_PRINCIPAL_UNVERIFIED = "unverified:mcp-stdio";

function candidateFromEnv(): string | undefined {
  const raw = (process.env["JEVERB_CANDIDATE"] ?? "").trim();
  return raw === "" ? undefined : raw.slice(0, 80);
}

/** Upper bound on nodes per call: parallel levels fan out bounded by policy. */
export const MAX_GRAPH_NODES = 64;

function configuredDataDir(config: ToolConfig): string {
  const dataDir = config.dataDir?.trim();
  if (dataDir === undefined || dataDir === "") {
    throw new Error("graph execution requires an explicit dataDir");
  }
  return dataDir;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Operator-provisioned consequential-routing admission for one run.
 *
 * The operator places `<dataDir>/routing-qualification.json` naming the
 * pinned deployment identity plus the authoritative manifest and its
 * evidence files (paths resolved under the dataDir, never trusted from
 * the manifest itself). The manifest is re-verified from file bytes
 * against the pinned identity and the live decision policy; only a
 * verification that authorizes brands a runtime admission.
 *
 * Nothing here reads the tool input: a model-supplied graph carries no
 * qualification material, and a caller-supplied `qualified: true` has no
 * path to the executor. Any absence or failure returns `undefined` — the
 * executor then fails protected branches closed.
 */
export interface OperatorRoutingProvision {
  backend: string;
  model: string;
  modelVersion: string;
  adapterVersion: string;
  /** Pinned question-set hash (hex) the manifest was measured on. */
  questionFamily: string;
  manifest: QualificationManifest;
  evidence: {
    datasetPath: string;
    developmentDatasetPath?: string;
    validationDatasetPath?: string;
    receiptsPath: string;
  };
}

export function resolveRoutingAdmission(dataDir: string, policyHash: string): RoutingAdmission | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, "routing-qualification.json"), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const provision = parsed as Partial<OperatorRoutingProvision>;
  for (const field of ["backend", "model", "modelVersion", "adapterVersion"] as const) {
    if (typeof provision[field] !== "string" || (provision[field] as string).trim() === "") return undefined;
  }
  if (typeof provision.questionFamily !== "string" || !HEX64.test(provision.questionFamily)) return undefined;
  if (typeof provision.manifest !== "object" || provision.manifest === null) return undefined;
  const evidencePaths = provision.evidence as OperatorRoutingProvision["evidence"] | undefined;
  if (typeof evidencePaths !== "object" || evidencePaths === null) return undefined;
  if (typeof evidencePaths.datasetPath !== "string" || typeof evidencePaths.receiptsPath !== "string") return undefined;
  const evidence: QualificationEvidenceFiles = {
    datasetPath: join(dataDir, evidencePaths.datasetPath),
    ...(evidencePaths.developmentDatasetPath === undefined ? {} : { developmentDatasetPath: join(dataDir, evidencePaths.developmentDatasetPath) }),
    ...(evidencePaths.validationDatasetPath === undefined ? {} : { validationDatasetPath: join(dataDir, evidencePaths.validationDatasetPath) }),
    receiptsPath: join(dataDir, evidencePaths.receiptsPath),
  };
  const backend = provision.backend as string;
  const model = provision.model as string;
  const modelVersion = provision.modelVersion as string;
  const adapterVersion = provision.adapterVersion as string;
  const questionFamily = provision.questionFamily as string;
  const active: QualificationActiveIdentity = {
    backend,
    model,
    modelVersion,
    adapterVersion,
    questionSetHash: questionFamily,
    policyHash,
  };
  const verification = verifyQualificationManifest(provision.manifest as QualificationManifest, evidence, active);
  const qualification = admitRoutingQualification(provision.manifest as QualificationManifest, verification);
  if (qualification === undefined) return undefined;
  return {
    active: { backend, model, modelVersion, questionFamily, policyHash },
    qualification,
  };
}

export async function run(
  model: DecisionModel | null,
  input: ExecuteGraphToolInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<ExecuteGraphToolOutput> {
  if (config.initialRunId !== undefined && input.runId !== undefined) {
    throw new Error("a host initialRunId cannot be combined with a caller resume runId");
  }
  const requestedRunId = input.runId ?? config.initialRunId;
  const runId = typeof requestedRunId === "string" && requestedRunId.length > 0 ? requestedRunId : newRunId();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) {
    throw new Error("runId must contain only letters, numbers, hyphens, or underscores");
  }
  const dataDir = configuredDataDir(config);
  const journalDir = join(dataDir, "graph-journals");
  mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  const locked = await withFileLockAsync(journalDir, `graph-run-${runId}`, () =>
    runLocked(model, input, config, signal, runId, dataDir));
  if (!locked.locked || locked.value === undefined) {
    throw new Error("could not acquire exclusive graph-run lock; another invocation may be executing this run id");
  }
  return locked.value;
}

async function runLocked(
  model: DecisionModel | null,
  input: ExecuteGraphToolInput,
  config: ToolConfig,
  signal: AbortSignal | undefined,
  runId: string,
  dataDir: string,
): Promise<ExecuteGraphToolOutput> {
  // Source identity is attribution, not decoration: every run records who
  // submitted it, and sourceless graphs are rejected before validation.
  // (The MCP boundary validates the same constraint via the schema.)
  if (typeof input.source !== "string" || input.source.trim() === "" || input.source.length > 200) {
    throw new Error("graph execution requires a declared source identity (submitter, host, or candidate id).");
  }
  let graph = input.graph as Graph;
  if (graph.nodes.length > MAX_GRAPH_NODES) {
    throw new Error(`graph too large: ${graph.nodes.length} nodes exceeds limit of ${MAX_GRAPH_NODES}`);
  }
  const expandedCount = expandGraphLoops(graph).nodes.length;
  if (expandedCount > MAX_GRAPH_NODES) {
    throw new Error(`expanded graph too large: ${expandedCount} nodes exceeds limit of ${MAX_GRAPH_NODES}`);
  }
  const structurallyExpanded = expandGraphLoops(graph);
  const dynamicMaximum = expandedCount + structurallyExpanded.nodes.reduce((total, node) =>
    total + (node.expansion === undefined ? 0 : node.expansion.maxItems * node.expansion.nodes.length), 0);
  if (dynamicMaximum > MAX_GRAPH_NODES) {
    throw new Error(`maximum expanded graph too large: ${dynamicMaximum} nodes exceeds limit of ${MAX_GRAPH_NODES}`);
  }
  const errors = validateGraph(graph);
  if (errors.length > 0) {
    throw new Error(`invalid graph: ${errors.join("; ")}`);
  }
  // The explicit execution permission boundary: no policy, no shell. There
  // is deliberately no default-permit fallback — the caller (server wiring
  // or an explicitly opted-in test) must supply the policy.
  const policy = config.execution;
  if (policy === undefined) {
    throw new Error(
      "graph execution requires an explicit ExecutionPolicy (JEV_GRAPH_SHELL=allow to opt in); refusing to run shell nodes without one.",
    );
  }
  if (graph.nodes.some((node) => node.kind === "expand") && !policy.allowOutputArtifacts) {
    throw new Error("dynamic expansion requires operator-enabled full-output artifacts for durable recovery");
  }
  graph = bindExtractorIdentities(graph, policy.workspaceRoot);
  const runtimeGraph = expandGraphLoops(graph);
  const hash = policyHash(policy);
  const source = input.source;
  // Journal identity: a fresh runId per invocation, or a prior id whose
  // journal Jeverb loads and validates itself. The model cannot supply status,
  // input hashes, or output digests to manufacture a resumed success.
  const resuming = typeof input.runId === "string" && input.runId.length > 0;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) {
    throw new Error("runId must contain only letters, numbers, hyphens, or underscores");
  }
  const graphHash = fingerprintGraph(graph);
  const journalDir = join(dataDir, "graph-journals");
  mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  const museSessionId = (config.museSessionId ?? process.env.MUSE_SESSION_ID)?.trim();
  const journal = new FileJournal(
    runId,
    journalDir,
    museSessionId !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(museSessionId) ? museSessionId : undefined,
  );
  let resumePlan:
    | {
        prior: Map<string, { status: string; inputHash?: string; outputDigest?: string; outputArtifact?: string }>;
        priorGraphHash: string;
        priorRunId: string;
      }
    | undefined;
  if (resuming) {
    if (!journalExists(journal.path)) throw new Error("resume refused: no Jeverb journal exists for that runId");
    const priorRun = reconcileJournal(journal.path);
    if (
      !priorRun.runStarted ||
      priorRun.runId !== runId ||
      priorRun.malformed !== 0 ||
      priorRun.graphHash !== graphHash ||
      priorRun.policyHash !== hash
    ) {
      throw new Error("resume refused: journal identity, graph, policy, or framing did not validate");
    }
    resumePlan = {
      priorRunId: runId,
      priorGraphHash: graphHash,
      prior: new Map(priorRun.nodes.map((node) => [
        node.nodeId,
        {
          status: node.status,
          ...(node.inputHash === undefined ? {} : { inputHash: node.inputHash }),
          ...(node.outputDigest === undefined ? {} : { outputDigest: node.outputDigest }),
          ...(node.outputArtifact === undefined ? {} : { outputArtifact: node.outputArtifact }),
          ...(node.jev === undefined ? {} : { jev: node.jev }),
          ...(node.effectiveInputHash === undefined ? {} : { effectiveInputHash: node.effectiveInputHash }),
          ...(node.revisionHash === undefined ? {} : { revisionHash: node.revisionHash }),
          ...(node.branch === undefined ? {} : { branch: node.branch }),
        },
      ])),
    };
  } else if (journalExists(journal.path)) {
    throw new Error(config.initialRunId === undefined
      ? "new graph run refused: generated runId already has a journal"
      : "host initialRunId already has a journal; refusing to replay a reserved action");
  }
  if (resuming) {
    if (hasGraphDefinition(dataDir, runId)) {
      if (fingerprintGraph(loadGraphDefinition(dataDir, runId)) !== graphHash) {
        throw new Error("resume refused: supplied graph differs from the saved definition");
      }
    } else {
      // Upgrade path for journals created before graph-definition persistence.
      saveGraphDefinition(dataDir, runId, graph);
    }
  } else {
    saveGraphDefinition(dataDir, runId, graph);
  }
  const candidate = candidateFromEnv();
  const artifactStore = policy.allowOutputArtifacts ? new GraphOutputArtifactStore(join(dataDir, "graph-artifacts")) : undefined;
  const authorizer = makeDeterministicAuthorizer(policy);
  // Operator-provisioned routing admission, resolved once per run from the
  // dataDir (never from the model-supplied graph): absent unless an
  // authoritative consequential-routing manifest verifies. The expand
  // controller below inherits the same admission for its child graphs.
  const routingAdmission = resolveRoutingAdmission(dataDir, hash);
  const runNode = async (node: GraphNode, ctx: NodeRunContext): Promise<string | { output: string; jev?: import("../graph/executor.js").JevDecision; review?: ReviewResult; ok?: boolean; childResults?: import("../graph/executor.js").ExecutorResult[] }> => {
      const nodeStartedAt = Date.now();
      if (node.kind === "expand") {
        const spec = node.expansion;
        if (spec === undefined) throw new Error(`expand node ${node.id} is missing its expansion definition`);
        if (!policy.allowOutputArtifacts || artifactStore === undefined) {
          throw new Error("dynamic expansion requires operator-enabled full-output artifacts for durable recovery");
        }
        const source = ctx.allResults?.get(spec.itemsFrom);
        if (source?.status !== "succeeded") throw new Error(`expand node ${node.id} requires succeeded source ${spec.itemsFrom}`);
        if (source.outputArtifact === undefined) {
          throw new Error(`expand node ${node.id} source ${spec.itemsFrom} has no durable full-output artifact`);
        }
        const artifact = artifactStore.read(runId, source.outputArtifact);
        if (artifact.nodeId !== spec.itemsFrom || artifact.digest !== source.outputDigest) {
          throw new Error(`expand node ${node.id} source artifact does not match its journaled output`);
        }
        const sourceOutput = artifact.content;
        const selected = expandPointer(sourceOutput, spec.pointer);
        if (!Array.isArray(selected)) throw new Error(`expand node ${node.id} source must select a JSON array`);
        if (selected.length > spec.maxItems) throw new Error(`expand node ${node.id} source has ${selected.length} items; limit is ${spec.maxItems}`);
        const childResults: import("../graph/executor.js").ExecutorResult[] = [];
        const runtimeIds = new Set<string>();
        for (let index = 0; index < selected.length; index += 1) {
          const item = selected[index];
          const itemValue = JSON.stringify(item);
          if (itemValue === undefined || Buffer.byteLength(itemValue, "utf8") > MAX_BINDING_VALUE_CHARS) {
            throw new Error(`expand node ${node.id} item ${index} exceeds the 64 KiB limit`);
          }
          const digest = hashValue(itemValue);
          const idFor = (templateId: string): string => `${node.id}/${index + 1}/${templateId}`;
          const runtimeNodes: GraphNode[] = spec.nodes.map((template) => {
            const id = idFor(template.id);
            if (runtimeIds.has(id)) throw new Error(`expand node ${node.id} generated a duplicate runtime id ${id}`);
            runtimeIds.add(id);
            const rewrite = (dep: string): string => spec.nodes.some((candidate) => candidate.id === dep) ? idFor(dep) : dep;
            return {
              ...template,
              id,
              ...(template.dependsOn === undefined ? {} : { dependsOn: template.dependsOn.map(rewrite) }),
              ...(template.whenAll === undefined ? {} : { whenAll: template.whenAll.map(rewrite) }),
              ...(template.whenAny === undefined ? {} : { whenAny: template.whenAny.map(rewrite) }),
              ...(template.condition === undefined ? {} : { condition: { ...template.condition, node: rewrite(template.condition.node) } }),
              ...(template.diffFrom === undefined ? {} : { diffFrom: rewrite(template.diffFrom) }),
              ...(template.bindings === undefined ? {} : { bindings: template.bindings.map((binding) => ({ ...binding, from: rewrite(binding.from) })) }),
              expansionItem: { as: spec.as, value: itemValue, digest },
            };
          });
          // External template inputs are already settled parent dependencies.
          // Seed them as inert descriptors so the child DAG validates without
          // re-running parent work, then execute only the per-item templates.
          const externalIds = new Set(spec.nodes.flatMap((template) => template.dependsOn ?? []).filter((dep) => !spec.nodes.some((candidate) => candidate.id === dep)));
          const externalKinds = new Map<string, GraphNode["kind"]>();
          for (const template of spec.nodes) {
            if (template.diffFrom !== undefined && externalIds.has(template.diffFrom)) externalKinds.set(template.diffFrom, "shell");
            if (template.condition !== undefined && externalIds.has(template.condition.node)) {
              externalKinds.set(template.condition.node, template.condition.field === "review.lane" ? "review" : "jev");
            }
          }
          for (const id of [...externalIds]) {
            const parentNode = runtimeGraph.nodes.find((candidate) => candidate.id === id);
            if (parentNode !== undefined) externalKinds.set(id, parentNode.kind);
            if (parentNode?.kind === "review" && parentNode.diffFrom !== undefined) {
              externalIds.add(parentNode.diffFrom);
              externalKinds.set(parentNode.diffFrom, "shell");
            }
          }
          const stubs: GraphNode[] = [...externalIds].map((id) => {
            const kind = externalKinds.get(id) ?? "jev";
            if (kind === "shell") return { id, kind, command: "true" };
            if (kind === "review") {
              const parentReview = runtimeGraph.nodes.find((candidate) => candidate.id === id);
              const diffFrom = parentReview?.diffFrom ?? [...externalIds].find((candidate) => externalKinds.get(candidate) === "shell");
              if (diffFrom === undefined) throw new Error(`cannot create a settled review dependency stub for ${id}`);
              return { id, kind, diffFrom, dependsOn: [diffFrom] };
            }
            return { id, kind: "jev", question: "seeded parent dependency" };
          });
          const allNodes = [...stubs, ...runtimeNodes];
          if (allNodes.length > MAX_GRAPH_NODES) throw new Error(`expand node ${node.id} child graph exceeds ${MAX_GRAPH_NODES} nodes`);
          const child = await executeGraph(
            { version: 1, nodes: allNodes, ...(runtimeGraph.parallel === undefined ? {} : { parallel: runtimeGraph.parallel }) },
            authorizer,
            runNode,
            {
              maxParallel: policy.maxParallelShells,
              ...(ctx.deadlineMs === undefined ? {} : { timeoutMs: ctx.deadlineMs }),
              ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
              allowShellRetry: policy.allowShellRetry,
              policyHash: hash,
              journal,
              runId,
              graphHash,
              source: input.source,
              principal: GRAPH_PRINCIPAL_UNVERIFIED,
              ...(resumePlan === undefined ? {} : { resume: resumePlan }),
              ...(candidate === undefined ? {} : { candidate }),
              resourceLimits: limitsFor({ profile: policy.profile, ...(policy.resourceLimits === undefined ? {} : { resourceLimits: policy.resourceLimits }) }),
              outputArtifactsAllowed: policy.allowOutputArtifacts,
              outputArtifacts: artifactStore,
              initialResults: [...(ctx.allResults?.values() ?? [])],
              initialFullOutputs: ctx.fullOutputs,
              ...(routingAdmission === undefined ? {} : { routing: routingAdmission }),
            },
          );
          childResults.push(...child.filter((result) => !externalIds.has(result.nodeId)));
        }
        const ok = childResults.every((result) => result.status === "succeeded");
        return {
          output: JSON.stringify({ items: selected.length, nodes: childResults.map(({ nodeId, status, outputDigest }) => ({ nodeId, status, outputDigest })) }),
          ok,
          childResults,
        };
      }
      if (node.kind === "shell") {
        // Dependency outputs enter only as explicitly named, bounded
        // environment values; they are never substituted into command text.
        // Cross-node data remains evidence, never authorization.
        // Execution goes through the constrained runner (sandbox + filtered
        // env + no network by default), never a bare `bash -c`.
        // The graph owns cancellation: prefer its combined signal and
        // remaining budget over the tool-level inputs.
        const runSignal = ctx.signal ?? signal;
        const ran = await runShellConstrained(node.command ?? "", {
          workspaceRoot: policy.workspaceRoot,
          timeoutMs: policy.nodeTimeoutMs,
          ...(runSignal === undefined ? {} : { signal: runSignal }),
          ...(ctx.deadlineMs === undefined ? {} : { deadlineMs: ctx.deadlineMs }),
          allowNetwork: policy.allowNetwork,
          profile: policy.profile,
          ...(policy.resourceLimits === undefined ? {} : { resourceLimits: policy.resourceLimits }),
          readOnlyWorkspace: policy.readOnlyWorkspace,
          bindings: resolveBindings(node, ctx),
        });
        return ran.output;
      }
      if (node.kind === "review") {
        if (config.review === undefined) throw new Error(`review node ${node.id} needs the configured review authority`);
        const dependency = node.diffFrom === undefined ? undefined : ctx.results.get(node.diffFrom);
        if (dependency?.status !== "succeeded" || dependency.outputAvailable === false) {
          throw new Error(`review node ${node.id} requires available output from succeeded diff dependency ${node.diffFrom ?? "missing diffFrom"}`);
        }
        const diff = node.diffFrom === undefined ? undefined : ctx.fullOutputs.get(node.diffFrom);
        if (diff === undefined) throw new Error(`review node ${node.id} cannot read complete diff output from ${node.diffFrom ?? "missing diffFrom"}`);
        const reviewed = await config.review.review({
          diff,
          files: node.files ?? [],
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        });
        return {
          output: JSON.stringify({
            lane: reviewed.lane,
            source: reviewed.source,
            findings: reviewed.findings,
            policyVersion: reviewed.policyVersion,
            calibration: reviewed.calibration,
          }),
          review: reviewed as ReviewResult,
        };
      }
      if (node.kind === "jev") {
        const assertActive = (): void => {
          if (ctx.signal?.aborted) throw new Error("graph cancelled: execution stopped before helper or Jev request");
        };
        assertActive();
        if (model === null) throw new Error(`jev node ${node.id} needs an API key`);
        if (!node.question && node.questions === undefined) throw new Error(`jev node ${node.id} missing question`);
        const questions = node.questions === undefined
          ? { q: { type: "noul" as const, instructions: node.question ?? "" } }
          : Object.fromEntries(Object.entries(node.questions).map(([id, question]) => [id, toQuestion(question)]));
        // Dependency evidence comes from the shared executor helper so the
        // succeeded-only filter cannot drift from the run-context contract.
        const extracted = await runGraphExtractors(node, ctx, {
          workspaceRoot: policy.workspaceRoot,
          timeoutMs: policy.nodeTimeoutMs,
          allowNetwork: policy.allowNetwork,
          onExec: async (command) => {
            assertActive();
            const helperNode: GraphNode = { id: `${node.id}/extractor-exec`, kind: "shell", command };
            const authorization = await authorizer.authorize(helperNode);
            assertActive();
            if (!authorization.allowed) throw new Error("plugin exec denied by deterministic graph authorization");
            const remainingMs = ctx.deadlineMs === undefined ? undefined : Math.max(1, ctx.deadlineMs - (Date.now() - nodeStartedAt));
            try {
              const result = await runShellConstrained(command, {
                workspaceRoot: policy.workspaceRoot,
                timeoutMs: policy.nodeTimeoutMs,
                ...(remainingMs === undefined ? {} : { deadlineMs: remainingMs }),
                ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
                allowNetwork: policy.allowNetwork,
                profile: policy.profile,
                ...(policy.resourceLimits === undefined ? {} : { resourceLimits: policy.resourceLimits }),
                readOnlyWorkspace: policy.readOnlyWorkspace,
                maxOutputBytes: 16 * 1024,
              });
              return `${result.output}${result.truncated ? "\n[output truncated]" : ""}`;
            } catch (error) {
              if (error instanceof Error && error.message.startsWith("outcome_unknown:")) {
                throw new Error("outcome_unknown: plugin exec shell outcome requires graph reconciliation");
              }
              throw new Error("plugin exec command failed inside the constrained runner");
            }
          },
          onArtifact: async (content) => {
            assertActive();
            if (artifactStore === undefined) {
              throw new Error("plugin artifacts require operator-enabled graph output artifacts");
            }
            const artifact = artifactStore.write(runId, `${node.id}/extractor`, content);
            return `jeverb-artifact://${runId}/${artifact.artifactId}`;
          },
        });
        assertActive();
        const evaluation = await model.evaluate({
          state: buildJevState(node, ctx, extracted),
          questions,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        });
        assertActive();
        const answers = evaluation.answers as Record<string, import("../decision/types.js").Answer>;
        const noul = answers.q?.type === "noul" ? answers.q.noul : undefined;
        const verdict = noul === undefined ? undefined : noul >= 0.5 ? "yes" : "no";
        const typedPayload = Buffer.from(JSON.stringify({ answers, provider: evaluation.provider, questionHash: evaluation.questionHash }), "utf8").toString("base64url");
        const prefix = verdict === undefined ? "" : `verdict=${verdict} noul=${noul} `;
        const line = `${prefix}provider=${evaluation.provider} qhash=${evaluation.questionHash}${typedPayload.length <= 65536 ? ` typed=${typedPayload}` : ""}`;
        // Typed judgments remain advisory branch evidence, never authority.
        // A shell node still passes the deterministic authorizer on every
        // attempt, and a decision-gated shell additionally requires a
        // verifier-attested consequential-routing admission (see
        // resolveRoutingAdmission). The per-judgment `calibrated` flag stays
        // false here: qualification is bound at the admission boundary to
        // the actual deployment and live judgment, never self-attested by
        // the answering path.
        return {
          output: line,
          jev: {
            answers,
            ...(verdict === undefined || noul === undefined ? {} : { verdict, noul }),
            provider: evaluation.provider,
            model: evaluation.model,
            questionHash: evaluation.questionHash,
            calibrated: false,
          },
        };
      }
      throw new Error(`node ${node.id} has unsupported kind ${JSON.stringify(node.kind)}`);
    };
  const results = await executeGraph(
    runtimeGraph,
    authorizer,
    runNode,
    {
      maxParallel: policy.maxParallelShells,
      timeoutMs: policy.graphTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
      // Shell re-execution needs the operator profile, not just the author's
      // idempotent flag: the executor enforces the conjunction.
      allowShellRetry: policy.allowShellRetry,
      policyHash: hash,
      journal,
      runId,
      graphHash,
      source: input.source,
      principal: GRAPH_PRINCIPAL_UNVERIFIED,
      ...(resumePlan === undefined ? {} : { resume: resumePlan }),
      ...(candidate === undefined ? {} : { candidate }),
      resourceLimits: limitsFor({
        profile: policy.profile,
        ...(policy.resourceLimits === undefined ? {} : { resourceLimits: policy.resourceLimits }),
      }),
      outputArtifactsAllowed: policy.allowOutputArtifacts,
      ...(artifactStore === undefined ? {} : { outputArtifacts: artifactStore }),
      ...(routingAdmission === undefined ? {} : { routing: routingAdmission }),
    },
  );
  const evidenceLedger = new EvidenceLedger(join(dataDir, "evidence.log"), {
    ...(config.masterSwitchPath === undefined ? {} : { switchPath: config.masterSwitchPath }),
    // The MCP graph path has no root-ownership gate of its own; only treat
    // the protected install-wide path as root-gated, like the MCP server does.
    ...(config.masterSwitchPath === undefined || config.masterSwitchPath === PROTECTED_MASTER_SWITCH_PATH
      ? { requireRootOwnedSwitch: REQUIRE_ROOT_OWNED_SWITCH }
      : { requireRootOwnedSwitch: false }),
  });
  const graphReceipts = results.map((result) => persistGraphNodeReceipt({
    ledger: evidenceLedger,
    runId,
    graphHash,
    policyHash: hash,
    result,
    ...(config.museSessionId === undefined ? {} : { museSessionId: config.museSessionId }),
    ...(candidate === undefined ? {} : { candidate }),
  }));
  const evidenceReceipts = {
    status: graphReceipts.every((receipt) => receipt.status === "appended" || receipt.status === "duplicate")
      ? "persisted" as const
      : graphReceipts.some((receipt) => receipt.status === "appended" || receipt.status === "duplicate")
        ? "partial" as const
        : "unavailable" as const,
    appended: graphReceipts.filter((receipt) => receipt.status === "appended").length,
    duplicate: graphReceipts.filter((receipt) => receipt.status === "duplicate").length,
    unavailable: graphReceipts.filter((receipt) => receipt.status === "unavailable").length,
    conflict: graphReceipts.filter((receipt) => receipt.status === "conflict").length,
    correlationIds: graphReceipts.map((receipt) => receipt.correlationId).filter((id) => id !== ""),
  };
  return {
    results,
    succeeded: results.filter((r) => r.status === "succeeded").length,
    failed: results.filter((r) => r.status === "failed" || r.status === "blocked" || r.status === "cancelled" || r.status === "outcome_unknown")
      .length,
    skipped: results.filter((r) => r.status === "skipped").length,
    source,
    policyHash: hash,
    runId,
    graphHash,
    journalPath: journal.path,
    evidenceReceipts,
    principal: GRAPH_PRINCIPAL_UNVERIFIED,
    ...(candidate === undefined ? {} : { candidate }),
  };
}

/**
 * Reconciliation interface: classify a journal after a crash or before a
 * restart. Nodes with persisted `running` but no terminal are
 * `outcome_unknown` — inspect the side effect, then explicitly authorize a
 * retry (new run, same graph) or mark it superseded. Never rerun on an
 * unknown and call it a retry: that is how partial executions double-apply.
 */
export function reconcileRun(journalPath: string) {
  return reconcileJournal(journalPath);
}
