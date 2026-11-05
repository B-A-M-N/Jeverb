import type { HookInput, ToolCallBatchEntry } from "../../hooks/types.js";
import { normalizeToolName } from "../../hooks/types.js";

/**
 * Muse tool identifiers observed in native hook payloads and their Jeverb
 * handler equivalents. Keep this allowlist explicit: a new Muse tool does not
 * inherit another tool's policy merely because the names look similar.
 */
const MUSE_TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  read_file: "Read",
  edit_file: "Edit",
  write_file: "Write",
  subagent_spawn: "Agent",
};

function adaptName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const exact = MUSE_TOOL_NAMES[name.trim().toLowerCase()];
  return exact ?? normalizeToolName(name);
}

function adaptBatchEntry(entry: ToolCallBatchEntry): ToolCallBatchEntry {
  const toolName = adaptName(entry.tool_name);
  return toolName === undefined ? { ...entry } : { ...entry, tool_name: toolName };
}

/** Normalize Muse's verified native identifiers once while retaining source names for diagnostics. */
export function adaptMuseHookInput(input: HookInput): HookInput {
  // Always replace any supplied diagnostic value with the actual incoming
  // identifier; hook stdin is not trusted to attest its own provenance.
  const original = input.tool_name;
  const toolName = adaptName(input.tool_name);
  return {
    ...input,
    ...(original !== undefined ? { original_tool_name: original } : {}),
    ...(toolName !== undefined ? { tool_name: toolName } : {}),
    ...(Array.isArray(input.tool_calls)
      ? { tool_calls: input.tool_calls.map(adaptBatchEntry) }
      : {}),
  };
}
