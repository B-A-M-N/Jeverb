import type { Json } from "../decision/types.js";
import type { GraphNode, NodeRunContext } from "./executor.js";
import { discoverExtractorPlugins } from "./extractor-registry.js";
import { runExtractorPluginConstrained } from "./runner.js";
import { isExtractorJsonSchema, validateExtractorSchema } from "./json-schema.js";

const MAX_EXTRACTOR_INPUT_BYTES = 64 * 1024;
const MAX_EXTRACTOR_OUTPUT_BYTES = 64 * 1024;
const MAX_LINE_ITEMS = 256;

function selectPointer(value: unknown, pointer: string | undefined, label: string): unknown {
  if (pointer === undefined) return value;
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(token)) {
      current = current[Number(token)];
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      throw new Error(`extractor ${label} JSON pointer does not resolve`);
    }
  }
  return current;
}

/** Run bounded built-ins or a content-bound plugin in the isolated runner. */
export async function runGraphExtractors(
  node: GraphNode,
  ctx: NodeRunContext,
  options: { workspaceRoot: string; timeoutMs: number; allowNetwork: boolean; onExec?: (command: string) => Promise<string>; onArtifact?: (content: string) => Promise<string> },
): Promise<Record<string, Json>> {
  const extracted = Object.create(null) as Record<string, Json>;
  const plugins = discoverExtractorPlugins(options.workspaceRoot);
  for (const step of node.extractors ?? []) {
    const dependency = ctx.results.get(step.from);
    if (dependency?.status !== "succeeded" || dependency.outputAvailable === false) {
      throw new Error(`extractor ${step.as} requires available output from succeeded dependency ${step.from}`);
    }
    const raw = ctx.fullOutputs.get(step.from);
    if (raw === undefined) throw new Error(`extractor ${step.as} cannot access complete output from ${step.from}`);
    if (Buffer.byteLength(raw, "utf8") > MAX_EXTRACTOR_INPUT_BYTES) {
      throw new Error(`extractor ${step.as} input exceeds ${MAX_EXTRACTOR_INPUT_BYTES} bytes`);
    }

    let result: unknown;
    if (step.extractor === "json") {
      let parsed: unknown;
      try { parsed = JSON.parse(raw) as unknown; }
      catch { throw new Error(`extractor ${step.as} expected valid JSON output from ${step.from}`); }
      result = selectPointer(parsed, step.pointer, step.as);
    } else if (step.extractor === "lines") {
      if (step.pointer !== undefined) throw new Error(`lines extractor ${step.as} does not support a JSON pointer`);
      const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
      const limit = step.maxItems ?? MAX_LINE_ITEMS;
      if (lines.length > limit) throw new Error(`lines extractor ${step.as} found ${lines.length} items; limit is ${limit}`);
      result = lines;
    } else {
      const plugin = plugins.get(step.extractor);
      if (plugin === undefined) throw new Error(`extractor plugin ${JSON.stringify(step.extractor)} is not installed or its path is unsafe`);
      if (step.moduleHash === undefined || step.moduleHash !== plugin.contentHash) {
        throw new Error(`extractor plugin ${JSON.stringify(step.extractor)} changed after the graph was fingerprinted`);
      }
      let helperUncertain = false;
      const invokePlugin = async (phase: "metadata" | "run", allowNetwork: boolean): Promise<Record<string, unknown>> => {
        const serialized = await runExtractorPluginConstrained({
          workspaceRoot: options.workspaceRoot,
          pluginRoot: plugin.root,
          modulePath: plugin.modulePath,
          pluginName: plugin.name,
          expectedHash: plugin.contentHash,
          phase,
          input: raw,
          config: step.config ?? {},
          timeoutMs: options.timeoutMs,
          allowNetwork,
          ...(phase === "run" && options.onExec !== undefined ? {
            onExec: async (command: string) => {
              try { return await options.onExec!(command); }
              catch (error) {
                if (error instanceof Error && error.message.startsWith("outcome_unknown:")) helperUncertain = true;
                throw error;
              }
            },
          } : {}),
          ...(phase === "run" && options.onArtifact !== undefined ? { onArtifact: options.onArtifact } : {}),
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        });
        let envelope: unknown;
        try { envelope = JSON.parse(serialized) as unknown; }
        catch { throw new Error(`extractor plugin ${JSON.stringify(step.extractor)} returned invalid JSON output`); }
        if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
          throw new Error(`extractor plugin ${JSON.stringify(step.extractor)} returned an invalid result envelope`);
        }
        return envelope as Record<string, unknown>;
      };
      // Discover schemas with network disabled, then validate input/config
      // before invoking the plugin's run method or granting opted-in fetch.
      const metadataEnvelope = await invokePlugin("metadata", false);
      const metadata = metadataEnvelope.metadata;
      if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
        throw new Error(`extractor plugin ${JSON.stringify(step.extractor)} returned invalid metadata`);
      }
      const pluginMetadata = metadata as Record<string, unknown>;
      if (pluginMetadata.name !== plugin.name || typeof pluginMetadata.description !== "string" || !isExtractorJsonSchema(pluginMetadata.inputSchema) || !isExtractorJsonSchema(pluginMetadata.outputSchema)) {
        throw new Error(`extractor plugin ${JSON.stringify(step.extractor)} has invalid metadata or schemas`);
      }
      const inputErrors = validateExtractorSchema(raw, pluginMetadata.inputSchema, `extractor ${step.extractor} input`);
      if (inputErrors.length > 0) throw new Error(inputErrors.join("; "));
      if (pluginMetadata.configSchema !== undefined) {
        if (!isExtractorJsonSchema(pluginMetadata.configSchema)) throw new Error(`extractor plugin ${JSON.stringify(step.extractor)} has an invalid configSchema`);
        const configErrors = validateExtractorSchema(step.config ?? {}, pluginMetadata.configSchema, `extractor ${step.extractor} config`);
        if (configErrors.length > 0) throw new Error(configErrors.join("; "));
      }

      let resultEnvelope: Record<string, unknown>;
      try { resultEnvelope = await invokePlugin("run", options.allowNetwork); }
      catch (error) {
        if (helperUncertain) throw new Error("outcome_unknown: plugin exec helper may have caused an uncertain side effect; reconcile the graph before retrying");
        throw error;
      }
      if (helperUncertain) throw new Error("outcome_unknown: plugin exec helper may have caused an uncertain side effect; reconcile the graph before retrying");
      if (JSON.stringify(resultEnvelope.metadata) !== JSON.stringify(pluginMetadata) || !Object.hasOwn(resultEnvelope, "output")) {
        throw new Error(`extractor plugin ${JSON.stringify(step.extractor)} metadata changed between preparation and execution`);
      }
      const outputErrors = validateExtractorSchema(resultEnvelope.output, pluginMetadata.outputSchema, `extractor ${step.extractor} output`);
      if (outputErrors.length > 0) throw new Error(outputErrors.join("; "));
      result = resultEnvelope.output;
    }

    let serialized: string | undefined;
    try { serialized = JSON.stringify(result); }
    catch { throw new Error(`extractor ${step.as} produced a non-serializable value`); }
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_EXTRACTOR_OUTPUT_BYTES) {
      throw new Error(`extractor ${step.as} output exceeds ${MAX_EXTRACTOR_OUTPUT_BYTES} bytes`);
    }
    extracted[step.as] = JSON.parse(serialized) as Json;
  }
  return extracted;
}
