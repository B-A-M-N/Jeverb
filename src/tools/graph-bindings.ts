/**
 * Graph input/output binding helpers for the `jev_execute_graph` tool.
 *
 * Pure data plumbing: extractor identity binding, JSON-pointer selection
 * over dependency output, and execution-policy fingerprinting. The tool
 * adapter (`execute-graph.ts`) applies these; nothing here touches the
 * filesystem, the network, or the journal.
 */

import { discoverExtractorPlugins } from "../graph/extractor-registry.js";
import type { Graph, GraphNode, NodeRunContext } from "../graph/executor.js";
import type { ExecutionPolicy } from "../graph/policy.js";
import { hashValue } from "../graph/validate.js";

export const MAX_BINDING_VALUE_CHARS = 64 * 1024;

export function bindExtractorIdentities(graph: Graph, workspaceRoot: string): Graph {
  const plugins = discoverExtractorPlugins(workspaceRoot);
  const bindNode = (node: GraphNode): GraphNode => ({
    ...node,
    ...(node.extractors === undefined ? {} : {
      extractors: node.extractors.map((step) => {
        if (step.extractor === "json" || step.extractor === "lines") return { ...step };
        const plugin = plugins.get(step.extractor);
        if (plugin === undefined) throw new Error(`extractor plugin ${JSON.stringify(step.extractor)} is not installed or its path is unsafe`);
        return { ...step, moduleHash: plugin.contentHash };
      }),
    }),
    ...(node.expansion === undefined ? {} : {
      expansion: { ...node.expansion, nodes: node.expansion.nodes.map(bindNode) },
    }),
  });
  return { ...graph, nodes: graph.nodes.map(bindNode) };
}

export function selectOutput(output: string, pointer?: string): string {
  if (pointer === undefined) return output;
  let current: unknown;
  try {
    current = JSON.parse(output) as unknown;
  } catch {
    throw new Error("output reference requested a JSON pointer, but dependency output is not valid JSON");
  }
  for (const token of pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(token)) {
      current = current[Number(token)];
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      throw new Error(`output reference JSON pointer does not exist: ${pointer}`);
    }
  }
  if (current === undefined) throw new Error(`output reference JSON pointer does not exist: ${pointer}`);
  return typeof current === "string" ? current : JSON.stringify(current);
}

export function expandPointer(output: string, pointer?: string): unknown {
  let value: unknown;
  try { value = JSON.parse(output) as unknown; }
  catch { throw new Error("expand source output is not valid JSON"); }
  if (pointer === undefined) return value;
  for (const token of pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (Array.isArray(value) && /^(0|[1-9][0-9]*)$/.test(token)) value = value[Number(token)];
    else if (typeof value === "object" && value !== null && Object.hasOwn(value, token)) value = (value as Record<string, unknown>)[token];
    else throw new Error(`expand JSON pointer does not exist: ${pointer}`);
  }
  if (value === undefined) throw new Error(`expand JSON pointer does not exist: ${pointer}`);
  return value;
}

export function resolveBindings(node: GraphNode, ctx: NodeRunContext): Record<string, string> {
  const bindings: Record<string, string> = {};
  if (node.expansionItem !== undefined) {
    const item = JSON.parse(node.expansionItem.value) as unknown;
    bindings[`JIVE_REF_${node.expansionItem.as}`] = typeof item === "string" ? item : JSON.stringify(item);
  }
  for (const binding of node.bindings ?? []) {
    const dependency = ctx.results.get(binding.from);
    if (dependency?.status !== "succeeded") {
      throw new Error(`binding ${binding.as} requires a succeeded dependency ${binding.from}`);
    }
    if (dependency.outputAvailable === false) {
      throw new Error(`binding ${binding.as} cannot read unavailable resumed output from ${binding.from}`);
    }
    const output = ctx.fullOutputs.get(binding.from);
    if (output === undefined) throw new Error(`binding ${binding.as} cannot read unavailable dependency ${binding.from}`);
    const value = selectOutput(output, binding.pointer);
    if (value.length > MAX_BINDING_VALUE_CHARS) {
      throw new Error(`binding ${binding.as} exceeds the ${MAX_BINDING_VALUE_CHARS}-character limit`);
    }
    bindings[`JIVE_REF_${binding.as}`] = value;
  }
  return bindings;
}
/**
 * Canonical execution-policy fingerprint. Behavior-affecting configuration
 * — not only node text — feeds every node input hash, so the same command
 * under a different workspace, timeout, network, retry, or parallelism
 * regime never shares a hash with this run.
 */
export function policyHash(policy: ExecutionPolicy): string {
  return hashValue(
    JSON.stringify({
      allowShell: policy.allowShell,
      workspaceRoot: policy.workspaceRoot,
      maxParallelShells: policy.maxParallelShells,
      nodeTimeoutMs: policy.nodeTimeoutMs,
      graphTimeoutMs: policy.graphTimeoutMs,
      denyPrivileged: policy.denyPrivileged,
      allowShellRetry: policy.allowShellRetry,
      allowOutputArtifacts: policy.allowOutputArtifacts,
      allowNetwork: policy.allowNetwork,
      profile: policy.profile,
      resourceLimits: policy.resourceLimits ?? null,
      readOnlyWorkspace: policy.readOnlyWorkspace,
    }),
  );
}

