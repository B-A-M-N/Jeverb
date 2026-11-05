import { z } from "zod";
import type { DecisionModel } from "../decision/types.js";
import { loadSessionGraphForResume } from "../graph/history.js";
import * as executeGraphTool from "./execute-graph.js";
import type { ToolConfig } from "./shared.js";

export const name = "jev_resume_graph";
export const description = [
  "Resume a saved Jive graph from the current host-injected Muse session without resending its graph definition.",
  "Jeverb loads the private saved definition and journal, checks their hashes and session identity, then delegates to the ordinary graph executor.",
  "Every re-executed shell node still passes deterministic authorization and the constrained runner; prior successes remain digest-only reuse.",
].join("\n");

export const inputShape = {
  runId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  source: z.string().min(1).max(200).describe("Claimed submitter attribution; it grants no execution authority."),
} as const;
export const inputSchema = z.object(inputShape).strict();
export type ResumeGraphInput = z.infer<typeof inputSchema>;
export const outputShape = executeGraphTool.outputShape;
export const outputSchema = executeGraphTool.outputSchema;

export async function run(
  model: DecisionModel | null,
  input: ResumeGraphInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<z.infer<typeof outputSchema>> {
  if (config.dataDir === undefined || config.dataDir.length === 0) {
    throw new Error("graph resume requires a configured persistent data directory");
  }
  if (config.museSessionId === undefined || config.museSessionId.length === 0) {
    throw new Error("graph resume requires a host-injected Muse session id");
  }
  const graph = loadSessionGraphForResume(config.dataDir, config.museSessionId, input.runId) as executeGraphTool.ExecuteGraphToolInput["graph"];
  return executeGraphTool.run(model, { graph, runId: input.runId, source: input.source }, config, signal);
}
