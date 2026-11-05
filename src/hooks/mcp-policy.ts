/**
 * MCP tool identity policy: which MCP tools bypass model judgment.
 *
 * Trusts exact identities only. A tool name is operator- or host-assigned
 * metadata (`mcp__<server>__<tool>`), so substring heuristics — a "read
 * verb" prefix, a server name merely containing "jev" — let an external
 * server claim a trusted identity (`mcp__maljevhost__jev_delete_all`).
 * Unknown tools receive judgment; skipping is reserved for exactly
 * recognized own tools and an explicit operator allowlist.
 */

export interface McpName {
  server: string;
  tool: string;
}

/** `mcp__<server>__<tool>`; the server may itself contain `__` separators. */
export function parseMcpName(toolName: string): McpName | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const parts = toolName.split("__");
  if (parts.length < 3) return undefined;
  const tool = parts[parts.length - 1]!;
  if (tool === "") return undefined;
  return { server: parts.slice(1, -1).join("__"), tool };
}

/** `mcp__<server>__<tool>`, or `mcp__plugin_<plugin>_<server>__<tool>`. */
export function mcpToolSegment(toolName: string): string | undefined {
  return parseMcpName(toolName)?.tool;
}

/**
 * Server ids this plugin trusts as its own bundling. Matched exactly:
 * host configuration assigns server ids, so an external server cannot
 * claim one by crafting a tool name — but a substring test would let
 * `maljevhost` pass as "jev".
 */
export const OWN_TOOL_SERVERS: ReadonlySet<string> = new Set(["plugin_jev_jev", "jeverb", "jev"]);

/**
 * This plugin's own tool names. Keep in sync with the `name` export of
 * each module in `src/tools/`; `tests/hooks/mcp-policy.test.ts` enforces it.
 */
export const OWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "jev_execute_graph",
  "jev_execute_graph_mod",
  "jev_evaluate",
  "jev_gate_action",
  "jev_graph_history",
  "jev_list_models",
  "jev_next_step",
  "jev_observations",
  "jev_pick",
  "jev_rank",
  "jev_read_graph_output",
  "jev_resume_graph",
  "jev_verify",
]);

/** This plugin's own tools, whether reached bare or through its bundled server. */
export function isOwnTool(toolName: string): boolean {
  const parsed = parseMcpName(toolName);
  return parsed !== undefined && OWN_TOOL_SERVERS.has(parsed.server) && OWN_TOOL_NAMES.has(parsed.tool);
}

/** Exact `server__tool` entries from `JEV_MCP_SKIP` (comma-separated). */
export function parseMcpSkipAllowlist(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "" && entry.includes("__"));
}

/** Classify an MCP tool: skip only exact own tools or allowlisted pairs. */
export function classifyMcpTool(toolName: string, allowlist: readonly string[] = []): { kind: "skip" | "judge"; reason: string } {
  const parsed = parseMcpName(toolName);
  if (parsed === undefined) return { kind: "judge", reason: "not an MCP tool name" };
  if (isOwnTool(toolName)) return { kind: "skip", reason: "this plugin's own tool" };
  if (allowlist.includes(`${parsed.server}__${parsed.tool}`)) {
    return { kind: "skip", reason: "operator-allowlisted MCP retrieval" };
  }
  return { kind: "judge", reason: "MCP tool with an unknown effect" };
}

/**
 * An MCP tool name never confers authority. Tool names (and the server ids
 * inside them) are operator- or host-assigned routing metadata: an external
 * server can craft any `mcp__<server>__<tool>` string, so treating the name
 * as a grant would let an attacker self-authorize (`mcp__maljevhost__...`).
 * Skipping judgment for exact own tools or the operator allowlist is a
 * scheduling decision, not a grant — execution still requires the
 * deterministic authorizer. Always returns false; the value is the invariant,
 * executable and testable.
 */
export function toolNameConfersAuthority(_toolName: string): false {
  return false;
}
