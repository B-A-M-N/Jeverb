import { z } from "zod";
import { listSessionGraphHistory } from "../graph/history.js";
import type { ToolConfig } from "./shared.js";

export const name = "jev_graph_history";
export const description = [
  "List recent, durable Jive graph runs recorded for the current host-injected Muse session.",
  "The result contains run and node status summaries only; command text and node output are never returned.",
  "Unscoped, malformed, or unverifiable journals are counted as unavailable and cannot be resumed through this history path.",
].join("\n");

export const inputShape = {
  limit: z.number().int().min(1).max(50).optional().describe("Maximum recent runs to return (default 20)."),
} as const;
export const inputSchema = z.object(inputShape).strict();

const runSchema = z.object({
  runId: z.string(),
  graphHash: z.string(),
  policyHash: z.string(),
  updatedAt: z.string(),
  definitionAvailable: z.boolean(),
  nodes: z.record(z.string(), z.number().int().nonnegative()),
  uncertainAttempts: z.number().int().nonnegative(),
});

export const outputShape = {
  sessionId: z.string(),
  runs: z.array(runSchema),
  unavailable: z.number().int().nonnegative(),
} as const;
export const outputSchema = z.object(outputShape);

export function run(input: z.infer<typeof inputSchema>, config: ToolConfig): z.infer<typeof outputSchema> {
  if (config.dataDir === undefined || config.dataDir.length === 0) {
    throw new Error("graph history requires a configured persistent data directory");
  }
  if (config.museSessionId === undefined || config.museSessionId.length === 0) {
    throw new Error("graph history requires a host-injected Muse session id");
  }
  const history = listSessionGraphHistory(config.dataDir, config.museSessionId, input.limit ?? 20);
  return { sessionId: config.museSessionId, ...history };
}
