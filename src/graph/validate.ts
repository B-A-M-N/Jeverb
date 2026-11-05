/**
 * Pure graph operations: validation, loop expansion, descriptors, hashes,
 * and Jev output parsing.
 *
 * No runtime dependencies (no journal, no concurrency, no execution). The
 * scheduler in `executor.ts` imports these from here; `executor.ts` also
 * re-exports them so existing `graph/executor.js` importers keep working.
 */

import { createHash } from "node:crypto";
import type { Answer } from "../decision/types.js";
import type { Graph, GraphCondition, GraphLoopGroup, GraphNode, JevDecision } from "./executor.js";

export function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Parse the structured verdict line jev nodes produce
 * (`verdict=<yes|no|unknown> noul=<p> [provider=<p> qhash=<hex>]`).
 * Returns undefined for anything else: custom run functions that emit
 * free-form text for jev nodes carry no decision, so decision conditions
 * over them are unmet rather than guessed.
 */
export function parseJevVerdict(output: string):
  | { verdict: "yes" | "no" | "unknown"; confidence?: number; provider?: string; questionHash?: string }
  | undefined {
  const verdict = /^verdict=(yes|no|unknown)(?:\s|$)/.exec(output.trim());
  if (verdict === null || verdict[1] === undefined) return undefined;
  const result: { verdict: "yes" | "no" | "unknown"; confidence?: number; provider?: string; questionHash?: string } = {
    verdict: verdict[1] as "yes" | "no" | "unknown",
  };
  const confidence = /(?:^|\s)noul=([0-9]*\.?[0-9]+)(?:\s|$)/.exec(output);
  if (confidence !== null && confidence[1] !== undefined) {
    const p = Number(confidence[1]);
    if (Number.isFinite(p) && p >= 0 && p <= 1) result.confidence = p;
  }
  const provider = /(?:^|\s)provider=([A-Za-z0-9_-]+)(?:\s|$)/.exec(output);
  if (provider !== null && provider[1] !== undefined) result.provider = provider[1];
  const questionHash = /(?:^|\s)qhash=([0-9a-f]{64})(?:\s|$)/.exec(output);
  if (questionHash !== null && questionHash[1] !== undefined) result.questionHash = questionHash[1];
  return result;
}

/** Parse the bounded typed-answer capsule emitted by Jeverb Jev nodes. */
export function parseJevDecision(output: string): JevDecision | undefined {
  const encoded = /(?:^|\s)typed=([A-Za-z0-9_-]{1,65536})(?:\s|$)/.exec(output);
  if (encoded?.[1] === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded[1], "base64url").toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record.provider !== "string" ||
      typeof record.questionHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.questionHash) ||
      typeof record.answers !== "object" || record.answers === null || Array.isArray(record.answers)
    ) return undefined;
    const answers: Record<string, Answer> = {};
    for (const [id, answer] of Object.entries(record.answers as Record<string, unknown>)) {
      if (id.length === 0 || id.length > 64 || typeof answer !== "object" || answer === null) return undefined;
      const typed = answer as Record<string, unknown>;
      if (typed.type === "noul") {
        if (typeof typed.noul !== "number" || !Number.isFinite(typed.noul) || typed.noul < 0 || typed.noul > 1) return undefined;
      } else if (typed.type === "choice") {
        if (typeof typed.choice !== "string" || typeof typed.confidence !== "number" || !Number.isFinite(typed.confidence) || typed.confidence < 0 || typed.confidence > 1) return undefined;
        if (typeof typed.probabilities !== "object" || typed.probabilities === null || Array.isArray(typed.probabilities)) return undefined;
        const probabilities = Object.values(typed.probabilities as Record<string, unknown>);
        if (probabilities.length < 2 || probabilities.some((p) => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)) return undefined;
        if (!Object.hasOwn(typed.probabilities, typed.choice)) return undefined;
        if (Math.abs((probabilities as number[]).reduce((sum, p) => sum + p, 0) - 1) > 0.02) return undefined;
      } else if (typed.type === "score") {
        if (typeof typed.score !== "number" || !Number.isFinite(typed.score) || typeof typed.confidence !== "number" || !Number.isFinite(typed.confidence) || typed.confidence < 0 || typed.confidence > 1) return undefined;
        if (typeof typed.legend !== "object" || typed.legend === null || Array.isArray(typed.legend)) return undefined;
        const indexes = Object.keys(typed.legend).map(Number);
        if (indexes.length < 2 || indexes.some((index) => !Number.isInteger(index) || index < 0) || typed.score < 0 || typed.score > Math.max(...indexes)) return undefined;
      } else return undefined;
      answers[id] = answer as Answer;
    }
    const noul = answers.q?.type === "noul" ? answers.q.noul : undefined;
    if (noul !== undefined && (!Number.isFinite(noul) || noul < 0 || noul > 1)) return undefined;
    return {
      answers,
      provider: record.provider,
      questionHash: record.questionHash,
      calibrated: false,
      ...(noul === undefined ? {} : { noul, verdict: noul >= 0.5 ? "yes" as const : "no" as const }),
    };
  } catch {
    return undefined;
  }
}

/** Stable descriptor of what a node was asked to do (not what happened).
 * Every behavior-affecting field is included: two nodes that would execute
 * differently must never share an input hash. */
export function nodeDescriptor(node: GraphNode): string {
  return JSON.stringify({
    id: node.id,
    kind: node.kind,
    command: node.command ?? null,
    question: node.question ?? null,
    questions: node.questions ?? null,
    diffFrom: node.diffFrom ?? null,
    files: [...(node.files ?? [])].sort(),
    bindings: [...(node.bindings ?? [])]
      .map((binding) => ({ from: binding.from, as: binding.as, pointer: binding.pointer ?? null }))
      .sort((a, b) => a.as.localeCompare(b.as)),
    extractors: [...(node.extractors ?? [])]
      .map((step) => ({ from: step.from, as: step.as, extractor: step.extractor, config: step.config ?? null, pointer: step.pointer ?? null, maxItems: step.maxItems ?? null, moduleHash: step.moduleHash ?? null }))
      .sort((a, b) => a.as.localeCompare(b.as)),
    dependsOn: [...(node.dependsOn ?? [])].sort(),
    when: typeof node.when === "function" ? "[function]" : (node.when ?? null),
    whenAll: [...(node.whenAll ?? [])].sort(),
    whenAny: [...(node.whenAny ?? [])].sort(),
    condition: node.condition ?? null,
    maxAttempts: node.maxAttempts ?? null,
    repeat: node.repeat ?? null,
    parallel: node.parallel ?? false,
    idempotent: node.idempotent ?? false,
    loopIteration: node.loopIteration ?? null,
    captureOutput: node.captureOutput ?? false,
    expansion: node.expansion === undefined ? null : {
      itemsFrom: node.expansion.itemsFrom,
      pointer: node.expansion.pointer ?? null,
      as: node.expansion.as,
      maxItems: node.expansion.maxItems,
      nodes: node.expansion.nodes.map(nodeDescriptor).sort(),
    },
    expansionItem: node.expansionItem === undefined
      ? null
      : { as: node.expansionItem.as, digest: node.expansionItem.digest },
  });
}

/** Content identity for a serializable graph, suitable for journal/resume binding. */
export function graphDescriptor(graph: Graph): string {
  const expanded = expandGraphLoops(graph);
  if (expanded.nodes.some((node) => typeof node.when === "function")) {
    throw new Error("graph has a non-serializable when callback; it cannot be fingerprinted for durable recovery");
  }
  const nodes = expanded.nodes.map(nodeDescriptor).sort();
  return JSON.stringify({ version: graph.version, parallel: graph.parallel ?? false, nodes });
}

/**
 * Expand fixed-count loop bodies into a plain DAG before validation and
 * execution. Iteration-qualified IDs are durable identities; intra-body
 * references stay in the same iteration, while external consumers of a body
 * node observe its final iteration. This is deliberately fixed-count: v1 has
 * no model-controlled loop condition.
 */
export function expandGraphLoops(graph: Graph): Graph {
  const loops = graph.loops ?? [];
  if (loops.length === 0) return { version: graph.version, nodes: graph.nodes, ...(graph.parallel === undefined ? {} : { parallel: graph.parallel }) };
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const owner = new Map<string, GraphLoopGroup>();
  const loopIds = new Set<string>();
  for (const loop of loops) {
    if (!loop.id || loopIds.has(loop.id)) throw new Error(`invalid graph loop id ${JSON.stringify(loop.id)}`);
    loopIds.add(loop.id);
    if (!Number.isSafeInteger(loop.iterations) || loop.iterations < 1 || loop.iterations > 3) {
      throw new Error(`loop ${loop.id} iterations must be between 1 and 3`);
    }
    if (loop.nodes.length === 0 || new Set(loop.nodes).size !== loop.nodes.length) {
      throw new Error(`loop ${loop.id} must contain unique node ids`);
    }
    for (const id of loop.nodes) {
      const bodyNode = byId.get(id);
      if (!bodyNode) throw new Error(`loop ${loop.id} references unknown node ${id}`);
      if (bodyNode.kind === "expand") throw new Error(`expand node ${id} cannot be nested inside a structural loop`);
      if (bodyNode.kind === "shell" && bodyNode.idempotent !== true) {
        throw new Error(`shell node ${id} in loop ${loop.id} must set idempotent:true`);
      }
      if (owner.has(id)) throw new Error(`node ${id} belongs to more than one loop`);
      owner.set(id, loop);
    }
  }
  const expandedId = (id: string, iteration: number): string => {
    const loop = owner.get(id);
    return loop === undefined ? id : `${loop.id}/${iteration + 1}/${id}`;
  };
  const finalId = (id: string): string => {
    const loop = owner.get(id);
    return loop === undefined ? id : expandedId(id, loop.iterations - 1);
  };
  const rewriteNode = (node: GraphNode, iteration?: number): GraphNode => {
    const rewriteRef = (id: string): string => {
      const targetLoop = owner.get(id);
      if (targetLoop === undefined) return id;
      if (iteration !== undefined && targetLoop === owner.get(node.id)) return expandedId(id, iteration);
      return finalId(id);
    };
    if (typeof node.when === "function" && owner.has(node.id)) {
      throw new Error(`loop body node ${node.id} cannot use a non-serializable when callback`);
    }
    return {
      ...node,
      id: iteration === undefined ? node.id : expandedId(node.id, iteration),
      ...(iteration === undefined ? {} : { loopIteration: { group: owner.get(node.id)!.id, index: iteration + 1 } }),
      ...((node.dependsOn === undefined && (iteration === undefined || iteration === 0)) ? {} : {
        dependsOn: [
          ...(node.dependsOn ?? []).map(rewriteRef),
          ...(iteration !== undefined && iteration > 0
            ? (owner.get(node.id)?.nodes ?? []).map((id) => expandedId(id, iteration - 1))
            : []),
        ],
      }),
      ...(node.whenAll === undefined ? {} : { whenAll: node.whenAll.map(rewriteRef) }),
      ...(node.whenAny === undefined ? {} : { whenAny: node.whenAny.map(rewriteRef) }),
      ...(node.condition === undefined ? {} : { condition: { ...node.condition, node: rewriteRef(node.condition.node) } }),
      ...(node.diffFrom === undefined ? {} : { diffFrom: rewriteRef(node.diffFrom) }),
      ...(node.bindings === undefined ? {} : { bindings: node.bindings.map((binding) => ({ ...binding, from: rewriteRef(binding.from) })) }),
    };
  };
  const nodes: GraphNode[] = [];
  for (const node of graph.nodes) {
    const loop = owner.get(node.id);
    if (loop === undefined) nodes.push(rewriteNode(node));
    else for (let iteration = 0; iteration < loop.iterations; iteration += 1) nodes.push(rewriteNode(node, iteration));
  }
  return { version: graph.version, nodes, ...(graph.parallel === undefined ? {} : { parallel: graph.parallel }) };
}

export function graphHash(graph: Graph): string {
  return hashValue(graphDescriptor(graph));
}

/**
 * Runtime evidence bound into a node's effective-input identity. A static
 * descriptor covers what a node was *asked* to do; this covers what it
 * would *decide* on: the current status, digest, and typed judgments of
 * its declared dependencies. Two runs agree on effective inputs only when
 * the evidence the branch predicates read is identical.
 */
export interface EffectiveDepEvidence {
  id: string;
  status: string;
  /** sha256 of the dependency's full output (or its resumed digest). */
  outputDigest: string;
  /** Canonical digest of a Jev dependency's typed judgment, when present. */
  decisionDigest?: string;
  /** Lane of a review dependency, when present. */
  lane?: string;
}

/** Canonical digest of one recorded Jev judgment (provider/model/qualification identity + answers). */
export function digestJevDecision(decision: JevDecision): string {
  return hashValue(JSON.stringify({
    verdict: decision.verdict ?? null,
    noul: decision.noul ?? null,
    provider: decision.provider,
    model: decision.model ?? null,
    questionHash: decision.questionHash,
    calibrated: decision.calibrated,
    answers: decision.answers ?? null,
  }));
}

/**
 * Canonical effective-input digest for resume/replay decisions. Covers the
 * behavior-affecting policy, the static node descriptor, the graph revision,
 * and the sorted runtime dependency evidence (statuses, output digests, and
 * Jev/review judgments that branch predicates read). It replaces the
 * static-only identity for reuse decisions: a matching static hash with
 * changed evidence is a new revision, not a reinterpretable old one.
 */
export function effectiveInputDigest(args: {
  policyTag: string;
  node: GraphNode;
  evidence: EffectiveDepEvidence[];
  revision?: string;
}): string {
  const deps = [...args.evidence]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((dep) => ({
      id: dep.id,
      status: dep.status,
      outputDigest: dep.outputDigest,
      ...(dep.decisionDigest === undefined ? {} : { decisionDigest: dep.decisionDigest }),
      ...(dep.lane === undefined ? {} : { lane: dep.lane }),
    }));
  return hashValue(JSON.stringify({
    policy: args.policyTag,
    node: nodeDescriptor(args.node),
    revision: args.revision ?? null,
    deps,
  }));
}

const SUPPORTED_KINDS = ["shell", "jev", "review", "expand"] as const;

export function validateGraph(graph: Graph): string[] {
  const errors: string[] = [];
  try {
    graph = expandGraphLoops(graph);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (graph.version !== 1) errors.push("unsupported graph version");
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id) {
      errors.push("node missing id");
      continue;
    }
    if (seen.has(node.id)) errors.push(`duplicate node id ${node.id}`);
    seen.add(node.id);
  }
  const ids = seen;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const generatedExpansionIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!(SUPPORTED_KINDS as readonly string[]).includes(node.kind)) {
      errors.push(`node ${node.id} has unsupported kind ${JSON.stringify(node.kind)}`);
    }
    const declared = new Set(node.dependsOn ?? []);
    if (node.kind === "expand") {
      const expansion = node.expansion;
      if (expansion === undefined) {
        errors.push(`expand node ${node.id} is missing its expansion definition`);
      } else {
        if (!(node.dependsOn ?? []).includes(expansion.itemsFrom)) {
          errors.push(`expand node ${node.id} itemsFrom must name a declared dependency`);
        }
        if (!/^[A-Z][A-Z0-9_]{0,60}$/.test(expansion.as)) {
          errors.push(`expand node ${node.id} has an invalid item binding name`);
        }
        if (!Number.isSafeInteger(expansion.maxItems) || expansion.maxItems < 1 || expansion.maxItems > 32) {
          errors.push(`expand node ${node.id} maxItems must be between 1 and 32`);
        }
        if (expansion.nodes.length === 0 || expansion.nodes.length > 32) {
          errors.push(`expand node ${node.id} template must contain between 1 and 32 nodes`);
        }
        const templateIds = new Set<string>();
        for (const template of expansion.nodes) {
          if (!template.id || templateIds.has(template.id)) errors.push(`expand node ${node.id} has a missing or duplicate template node id`);
          if (declared.has(template.id)) errors.push(`expand node ${node.id} template id ${template.id} conflicts with a parent dependency id`);
          templateIds.add(template.id);
          if (!(SUPPORTED_KINDS as readonly string[]).includes(template.kind) || template.kind === "expand") {
            errors.push(`expand node ${node.id} template ${template.id} has an unsupported or nested kind`);
          }
          if (typeof template.when === "function") errors.push(`expand node ${node.id} template ${template.id} cannot use a non-serializable condition callback`);
          if (template.kind === "shell" && (template.command === undefined || template.command.trim() === "")) {
            errors.push(`expand node ${node.id} shell template ${template.id} is missing a command`);
          }
          if (template.kind === "jev" && !template.question) errors.push(`expand node ${node.id} Jev template ${template.id} is missing a question`);
          const templateDeps = new Set(template.dependsOn ?? []);
          for (const dep of templateDeps) {
            if (!templateIds.has(dep) && !expansion.nodes.some((candidate) => candidate.id === dep) && !declared.has(dep)) {
              errors.push(`expand node ${node.id} template ${template.id} references undeclared dependency ${dep}`);
            }
          }
          for (const binding of template.bindings ?? []) {
            if (template.kind !== "shell") errors.push(`expand node ${node.id} template ${template.id} output bindings require a shell node`);
            if (binding.as === expansion.as) errors.push(`expand node ${node.id} template ${template.id} duplicates its dynamic item binding`);
            if (!templateDeps.has(binding.from)) errors.push(`expand node ${node.id} template ${template.id} binding ${binding.as} must name a declared dependency`);
          }
          if (template.condition !== undefined && !templateDeps.has(template.condition.node)) {
            errors.push(`expand node ${node.id} template ${template.id} condition must name a declared dependency`);
          }
          if (template.condition !== undefined) {
            const conditionTarget = expansion.nodes.find((candidate) => candidate.id === template.condition?.node)
              ?? byId.get(template.condition.node);
            if (conditionTarget !== undefined &&
              ((template.condition.field.startsWith("decision.") && conditionTarget.kind !== "jev") ||
               (template.condition.field === "review.lane" && conditionTarget.kind !== "review"))) {
              errors.push(`expand node ${node.id} template ${template.id} condition targets an incompatible node`);
            }
          }
          if (template.kind === "review" && (template.diffFrom === undefined || !templateDeps.has(template.diffFrom))) {
            errors.push(`expand node ${node.id} review template ${template.id} must name a diffFrom dependency`);
          }
        }
        const templateGraphNodes: GraphNode[] = [
          ...[...declared].map((id) => ({ id, kind: "jev" as const, question: "seeded parent dependency" })),
          ...expansion.nodes,
        ];
        try { topoSort({ version: 1, nodes: templateGraphNodes }); }
        catch (error) { errors.push(`expand node ${node.id} template contains a cycle: ${error instanceof Error ? error.message : String(error)}`); }
        for (let index = 1; index <= expansion.maxItems; index += 1) {
          for (const template of expansion.nodes) {
            const runtimeId = `${node.id}/${index}/${template.id}`;
            if (ids.has(runtimeId) || generatedExpansionIds.has(runtimeId)) {
              errors.push(`expand node ${node.id} can generate colliding runtime node id ${runtimeId}`);
            }
            generatedExpansionIds.add(runtimeId);
          }
        }
        if (byId.get(expansion.itemsFrom)?.captureOutput !== true) {
          errors.push(`expand node ${node.id} source ${expansion.itemsFrom} must capture output to support durable expansion recovery`);
        }
        if (expansion.pointer !== undefined && (!expansion.pointer.startsWith("/") || /~(?![01])/.test(expansion.pointer))) {
          errors.push(`expand node ${node.id} has an invalid RFC 6901 JSON pointer`);
        }
      }
    } else if (node.expansion !== undefined) {
      errors.push(`non-expand node ${node.id} cannot contain an expansion definition`);
    }
    if ((node.bindings?.length ?? 0) > 32) errors.push(`node ${node.id} has more than 32 output bindings`);
    const bindingNames = new Set<string>();
    for (const binding of node.bindings ?? []) {
      if (node.kind !== "shell") errors.push(`node ${node.id} output bindings are only supported on shell nodes`);
      if (!/^[A-Z][A-Z0-9_]{0,60}$/.test(binding.as)) errors.push(`node ${node.id} has invalid binding name ${JSON.stringify(binding.as)}`);
      if (bindingNames.has(binding.as)) errors.push(`node ${node.id} has duplicate binding name ${binding.as}`);
      bindingNames.add(binding.as);
      if (!declared.has(binding.from)) errors.push(`node ${node.id} binding ${binding.as} must reference a declared dependency`);
      if (binding.pointer !== undefined && !binding.pointer.startsWith("/")) {
        errors.push(`node ${node.id} binding ${binding.as} JSON pointer must start with /`);
      } else if (binding.pointer !== undefined && /~(?![01])/.test(binding.pointer)) {
        errors.push(`node ${node.id} binding ${binding.as} JSON pointer has an invalid escape`);
      }
    }
    if ((node.extractors?.length ?? 0) > 16) errors.push(`node ${node.id} has more than 16 extractor steps`);
    const extractorNames = new Set<string>();
    for (const step of node.extractors ?? []) {
      if (node.kind !== "jev") errors.push(`node ${node.id} extractors are only supported on Jev nodes`);
      if (!declared.has(step.from)) errors.push(`node ${node.id} extractor ${step.as} must reference a declared dependency`);
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(step.as) || step.as === "__proto__" || step.as === "constructor" || step.as === "prototype") {
        errors.push(`node ${node.id} has invalid extractor output name ${JSON.stringify(step.as)}`);
      }
      if (extractorNames.has(step.as)) errors.push(`node ${node.id} has duplicate extractor output name ${JSON.stringify(step.as)}`);
      extractorNames.add(step.as);
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(step.extractor)) errors.push(`node ${node.id} has invalid extractor name ${JSON.stringify(step.extractor)}`);
      if (step.pointer !== undefined && (!step.pointer.startsWith("/") || /~(?![01])/.test(step.pointer))) {
        errors.push(`node ${node.id} extractor ${step.as} has an invalid RFC 6901 JSON pointer`);
      }
      if (step.extractor === "lines" && step.pointer !== undefined) errors.push(`node ${node.id} lines extractor ${step.as} does not support a JSON pointer`);
      if (step.extractor === "lines" && step.maxItems !== undefined && (!Number.isSafeInteger(step.maxItems) || step.maxItems < 1 || step.maxItems > 256)) {
        errors.push(`node ${node.id} lines extractor ${step.as} maxItems must be between 1 and 256`);
      }
      if (step.extractor !== "lines" && step.maxItems !== undefined) errors.push(`node ${node.id} extractor ${step.as} does not accept maxItems`);
      if (step.extractor !== "json" && step.pointer !== undefined) errors.push(`node ${node.id} extractor ${step.as} does not accept a JSON pointer`);
      if (step.config !== undefined && (typeof step.config !== "object" || step.config === null || Array.isArray(step.config))) {
        errors.push(`node ${node.id} extractor ${step.as} config must be an object`);
      }
    }
    for (const dep of declared) {
      if (dep === node.id) errors.push(`node ${node.id} depends on itself`);
      else if (!ids.has(dep)) errors.push(`node ${node.id} depends on unknown ${dep}`);
    }
    // Serializable conditions may only reference declared dependencies:
    // an unordered or unknown reference can never be a settled result.
    for (const [field, refs] of [["whenAll", node.whenAll], ["whenAny", node.whenAny]] as const) {
      for (const ref of refs ?? []) {
        if (typeof ref !== "string" || ref.length === 0) errors.push(`node ${node.id} ${field} has an empty reference`);
        else if (ref === node.id) errors.push(`node ${node.id} ${field} references itself`);
        else if (!ids.has(ref)) errors.push(`node ${node.id} ${field} references unknown ${ref}`);
        else if (!declared.has(ref)) errors.push(`node ${node.id} ${field} references ${ref} which is not a declared dependency`);
      }
    }
    // Decision conditions reference typed Jev answers, not execution status:
    // the target must be a declared Jev dependency and match the condition's
    // answer type. Anything else is rejected here, never guessed.
    if (node.condition !== undefined) {
      const target = node.condition.node;
      const rawCondition = node.condition as GraphCondition & { field: string; equals?: unknown };
      if (!["decision.verdict", "decision.choice", "decision.score", "review.lane"].includes(rawCondition.field)) {
        errors.push(`node ${node.id} condition has invalid value ${JSON.stringify(rawCondition.equals)} for ${rawCondition.field}`);
      }
      if (typeof target !== "string" || target.length === 0) {
        errors.push(`node ${node.id} condition has an empty reference`);
      } else if (target === node.id) {
        errors.push(`node ${node.id} condition references itself`);
      } else if (!ids.has(target)) {
        errors.push(`node ${node.id} condition references unknown ${target}`);
      } else if (!declared.has(target)) {
        errors.push(`node ${node.id} condition references ${target} which is not a declared dependency`);
      } else if (
        (node.condition.field.startsWith("decision.") && byId.get(target)?.kind !== "jev") ||
        (node.condition.field === "review.lane" && byId.get(target)?.kind !== "review")
      ) {
        errors.push(`node ${node.id} condition references ${target} which does not produce ${node.condition.field}`);
      }
      if (node.condition.field === "decision.choice" || node.condition.field === "decision.score") {
        const targetNode = byId.get(target);
        const question = targetNode?.questions?.[node.condition.question];
        const legacyNoul = targetNode?.question !== undefined && node.condition.question === "q";
        const expectedType = node.condition.field === "decision.choice" ? "choice" : "score";
        const actualType = question?.type ?? (legacyNoul ? "noul" : undefined);
        if (actualType !== expectedType) {
          errors.push(`node ${node.id} condition question ${JSON.stringify(node.condition.question)} does not produce ${expectedType}`);
        }
        if (node.condition.field === "decision.choice" && node.condition.equals.length === 0) {
          errors.push(`node ${node.id} condition has an empty choice value`);
        } else if (node.condition.field === "decision.choice" && question?.type === "choice" && !Object.hasOwn(question.criteria, node.condition.equals)) {
          errors.push(`node ${node.id} condition choice ${JSON.stringify(node.condition.equals)} is not an option in ${node.condition.question}`);
        }
        if (node.condition.field === "decision.score" && (
          !Number.isFinite(node.condition.value) ||
          question?.type !== "score" ||
          node.condition.value < 0 ||
          node.condition.value > question.criteria.length - 1
        )) {
          errors.push(`node ${node.id} condition score value is outside ${node.condition.question}'s score range`);
        }
      } else if (node.condition.field === "decision.verdict") {
        const targetNode = byId.get(target);
        if (targetNode?.kind === "jev" && targetNode.question === undefined && targetNode.questions?.q?.type !== "noul") {
          errors.push(`node ${node.id} condition target ${target} has no Noul question named q`);
        }
        if (!["yes", "no", "unknown"].includes(node.condition.equals)) {
          errors.push(`node ${node.id} condition has invalid value ${JSON.stringify(node.condition.equals)} for ${node.condition.field}`);
        }
      } else if (node.condition.field === "review.lane" && !["BLOCK", "SECURITY REVIEW", "NITS", "MERGE", "UNAVAILABLE"].includes(node.condition.equals)) {
        errors.push(`node ${node.id} condition has invalid value ${JSON.stringify(node.condition.equals)} for ${node.condition.field}`);
      }
      // Unknown-verdict branches route to advisory, diagnostic, or
      // escalation workflows — never to shell execution. An unknown
      // judgment means the evidence was insufficient; running a
      // side-effecting command on that basis inverts the burden of proof.
      // Route unknown to a jev/diagnostic node, not to a shell node.
      // Deterministic authorization still gates every shell node, but the
      // branch itself must not offer one.
      if (node.kind === "shell" && node.condition.field === "decision.verdict" && node.condition.equals === "unknown") {
        errors.push(
          `shell node ${node.id} branches on an unknown verdict: route unknown to a jev/diagnostic node, not to shell execution`,
        );
      }
      if (node.kind === "shell" && node.condition.field === "review.lane" && node.condition.equals !== "MERGE") {
        errors.push(`shell node ${node.id} may execute from a review condition only when the lane is MERGE`);
      }
      if (node.condition.field.startsWith("decision.")) {
        const minConfidence = "minConfidence" in node.condition ? node.condition.minConfidence : undefined;
        if (minConfidence !== undefined && !(minConfidence > 0 && minConfidence < 1)) {
          errors.push(`node ${node.id} condition has invalid minConfidence ${JSON.stringify(minConfidence)}`);
        }
      }
    }
    if (node.kind === "shell" && (node.command === undefined || node.command.trim() === "")) {
      errors.push(`shell node ${node.id} missing command`);
    }
    if (node.kind === "jev" && !node.question && node.questions === undefined) errors.push(`jev node ${node.id} missing question`);
    if (node.kind === "jev" && node.question !== undefined && node.questions !== undefined) {
      errors.push(`jev node ${node.id} cannot set both legacy question and typed questions`);
    }
    if (node.kind !== "jev" && (node.question !== undefined || node.questions !== undefined)) {
      errors.push(`non-jev node ${node.id} cannot contain Jev questions`);
    }
    if (node.kind === "jev" && node.questions !== undefined) {
      if (Object.keys(node.questions).length === 0 || Object.keys(node.questions).length > 16) {
        errors.push(`jev node ${node.id} must contain 1 to 16 typed questions`);
      }
      for (const [questionId, question] of Object.entries(node.questions)) {
        if (!questionId || questionId.length > 64) errors.push(`jev node ${node.id} has an invalid question id`);
        if (question.type === "choice" && Object.keys(question.criteria).length < 2) {
          errors.push(`jev node ${node.id} choice question ${questionId} needs at least two options`);
        }
        if (question.type === "score" && question.criteria.length < 2) {
          errors.push(`jev node ${node.id} score question ${questionId} needs at least two levels`);
        }
      }
    }
    if (node.kind === "review") {
      if (node.diffFrom === undefined || !declared.has(node.diffFrom)) {
        errors.push(`review node ${node.id} must name a diffFrom dependency`);
      } else if (byId.get(node.diffFrom)?.kind !== "shell") {
        errors.push(`review node ${node.id} diffFrom must reference a shell node that produced the diff`);
      }
    }
    if (node.kind === "shell" && (node.dependsOn ?? []).some((id) => byId.get(id)?.kind === "review")) {
      if (node.condition?.field !== "review.lane" || node.condition.equals !== "MERGE") {
        errors.push(`shell node ${node.id} depends on a review and must require condition review.lane=MERGE`);
      }
    }
  }
  return errors;
}

export function topoSort(graph: Graph): GraphNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const out: GraphNode[] = [];
  const visit = (id: string, stack: string[] = []): void => {
    if (visited.has(id)) return;
    if (stack.includes(id)) throw new Error(`cycle: ${[...stack, id].join(" -> ")}`);
    const node = byId.get(id);
    if (!node) return;
    for (const dep of node.dependsOn ?? []) visit(dep, [...stack, id]);
    visited.add(id);
    out.push(node);
  };
  for (const node of graph.nodes) visit(node.id);
  return out;
}
