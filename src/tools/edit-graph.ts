/** Edit a saved Jive graph by JSON Pointer and immediately execute the new revision. */
import { z } from "zod";
import type { DecisionModel } from "../decision/types.js";
import { loadGraphDefinition } from "../graph/store.js";
import * as executeGraphTool from "./execute-graph.js";
import type { ExecuteGraphToolInput } from "./execute-graph.js";
import type { ToolConfig } from "./shared.js";

export const name = "jev_execute_graph_mod";
export const description = [
  "Apply bounded JSON Pointer edits to a graph previously saved by jev_execute_graph, then execute the edited graph as a new run.",
  "This does not mutate the saved source run. JSON null deletes the addressed object property or array element.",
  "Text replacement applies only when the addressed value is a string. Every resulting graph is validated and every shell node still passes deterministic authorization and the constrained runner.",
].join("\n");

const editSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path: z.string().max(1024), value: z.unknown() }).strict(),
  z.object({ op: z.literal("replace_text"), path: z.string().min(1).max(1024), search: z.string().min(1).max(64_000), replacement: z.string().max(64_000) }).strict(),
]);

export const inputShape = {
  sourceRunId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/).describe("Run id returned by a prior jev_execute_graph call."),
  source: z.string().min(1).max(200).describe("Claimed submitter attribution; it grants no execution authority."),
  edits: z.array(editSchema).min(1).max(32).describe("Ordered JSON Pointer edits applied to a private copy of the saved graph."),
} as const;

export const inputSchema = z.object(inputShape).strict();
export type EditGraphInput = z.infer<typeof inputSchema>;
type EditableGraph = ExecuteGraphToolInput["graph"];

export const outputShape = {
  basedOnRunId: z.string().describe("Saved run whose graph definition was edited."),
  ...executeGraphTool.outputShape,
};
export const outputSchema = z.object(outputShape);

function tokens(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error("edit path must be an RFC 6901 JSON Pointer");
  const parts = path.slice(1).split("/");
  if (parts.some((part) => /~(?![01])/.test(part))) throw new Error("edit path has an invalid JSON Pointer escape");
  return parts.map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function arrayIndex(token: string, length: number, allowAppend: boolean): number {
  if (token === "-" && allowAppend) return length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new Error(`invalid array index in graph edit: ${token}`);
  const index = Number(token);
  if (!Number.isSafeInteger(index) || index > length || (!allowAppend && index === length)) {
    throw new Error(`graph edit array index is out of range: ${token}`);
  }
  return index;
}

function applyOne(root: unknown, edit: EditGraphInput["edits"][number]): unknown {
  const path = tokens(edit.path);
  if (path.length === 0) {
    if (edit.op === "replace_text") throw new Error("replace_text cannot target the graph root");
    if (edit.value === null) throw new Error("the graph root cannot be deleted");
    return edit.value;
  }
  let parent = root;
  for (const token of path.slice(0, -1)) {
    if (token === "__proto__" || token === "prototype" || token === "constructor") throw new Error("unsafe JSON Pointer path");
    if (Array.isArray(parent)) parent = parent[arrayIndex(token, parent.length, false)];
    else if (typeof parent === "object" && parent !== null && Object.hasOwn(parent, token)) parent = (parent as Record<string, unknown>)[token];
    else throw new Error(`graph edit path does not exist: ${edit.path}`);
  }
  const key = path[path.length - 1] as string;
  if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error("unsafe JSON Pointer path");
  const isArray = Array.isArray(parent);
  if (!isArray && (typeof parent !== "object" || parent === null)) throw new Error(`graph edit parent is not a container: ${edit.path}`);
  const objectParent = parent as Record<string, unknown>;
  const hasValue = isArray
    ? /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < (parent as unknown[]).length
    : Object.hasOwn(objectParent, key);
  const current = isArray && hasValue ? (parent as unknown[])[Number(key)] : objectParent[key];
  if (edit.op === "replace_text") {
    if (typeof current !== "string") throw new Error(`replace_text target is not a string: ${edit.path}`);
    const updated = current.replaceAll(edit.search, edit.replacement);
    if (isArray) (parent as unknown[])[arrayIndex(key, (parent as unknown[]).length, false)] = updated;
    else objectParent[key] = updated;
    return root;
  }
  if (isArray) {
    const list = parent as unknown[];
    const index = arrayIndex(key, list.length, !hasValue);
    if (edit.value === null) {
      if (!hasValue) throw new Error(`cannot delete missing graph edit path: ${edit.path}`);
      list.splice(index, 1);
    } else if (hasValue) list[index] = edit.value;
    else list.splice(index, 0, edit.value);
  } else if (edit.value === null) {
    if (!hasValue) throw new Error(`cannot delete missing graph edit path: ${edit.path}`);
    delete objectParent[key];
  } else {
    objectParent[key] = edit.value;
  }
  return root;
}

export function applyGraphEdits(graph: EditableGraph, edits: EditGraphInput["edits"]): EditableGraph {
  let updated: unknown = JSON.parse(JSON.stringify(graph)) as unknown;
  for (const edit of edits) updated = applyOne(updated, edit);
  return updated as EditableGraph;
}

export async function run(
  model: DecisionModel | null,
  input: EditGraphInput,
  config: ToolConfig,
  signal?: AbortSignal,
): Promise<z.infer<typeof outputSchema>> {
  const dataDir = config.dataDir;
  if (dataDir === undefined || dataDir.length === 0) throw new Error("graph edit/replay requires a configured persistent data directory");
  const saved = loadGraphDefinition(dataDir, input.sourceRunId) as EditableGraph;
  const graph = applyGraphEdits(saved, input.edits);
  if (model === null && graph.nodes.some((node) => node.kind === "jev")) {
    throw new Error("edited graph contains Jev nodes but no API key is configured");
  }
  const result = await executeGraphTool.run(model, { source: input.source, graph }, config, signal);
  return { basedOnRunId: input.sourceRunId, ...result };
}
