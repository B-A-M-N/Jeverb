import { join } from "node:path";
import { z } from "zod";
import { GraphOutputArtifactStore } from "../graph/artifact.js";
import type { ToolConfig } from "./shared.js";

export const name = "jev_read_graph_output";
export const description = [
  "Read a complete graph-node output requested with captureOutput:true, or a plugin artifact URI returned by ctx.artifact.",
  "The artifact is private, bounded to 4 MiB, and verified against its stored SHA-256 digest before it is returned.",
].join("\n");

export const inputShape = {
  runId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
  artifactId: z.string().uuid().optional(),
  artifactRef: z.string().regex(/^jeverb-artifact:\/\/[A-Za-z0-9_-]{1,100}\/[0-9a-f-]{36}$/).optional(),
} as const;

export const inputSchema = z.object(inputShape).strict().refine((value) => {
  if (value.artifactRef !== undefined) return value.runId === undefined && value.artifactId === undefined;
  return value.runId !== undefined && value.artifactId !== undefined;
}, "provide either artifactRef or both runId and artifactId");
export const outputShape = {
  runId: z.string(),
  nodeId: z.string(),
  artifactId: z.string().uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  content: z.string(),
} as const;
export const outputSchema = z.object(outputShape);

export function run(input: z.input<typeof inputSchema>, config: ToolConfig): z.infer<typeof outputSchema> {
  if (config.dataDir === undefined || config.dataDir.length === 0) {
    throw new Error("graph output retrieval requires a configured persistent data directory");
  }
  if (config.execution?.allowOutputArtifacts !== true) {
    throw new Error("operator policy does not allow full-output artifact access");
  }
  const parsed = inputSchema.parse(input);
  let runId = parsed.runId;
  let artifactId = parsed.artifactId;
  if (parsed.artifactRef !== undefined) {
    const match = /^jeverb-artifact:\/\/([A-Za-z0-9_-]{1,100})\/([0-9a-f-]{36})$/.exec(parsed.artifactRef);
    if (match === null) throw new Error("invalid plugin artifact reference");
    runId = match[1];
    artifactId = match[2];
  }
  if (runId === undefined || artifactId === undefined) throw new Error("artifact reference is incomplete");
  const artifact = new GraphOutputArtifactStore(join(config.dataDir, "graph-artifacts")).read(runId, artifactId);
  return artifact;
}
