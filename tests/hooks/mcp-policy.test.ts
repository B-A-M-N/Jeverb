import { describe, expect, it } from "vitest";
import {
  classifyMcpTool,
  isOwnTool,
  mcpToolSegment,
  OWN_TOOL_NAMES,
  parseMcpName,
  parseMcpSkipAllowlist,
} from "../../src/hooks/mcp-policy.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("parseMcpName", () => {
  it("parses server and tool from an mcp__ name", () => {
    expect(parseMcpName("mcp__external__get_items")).toEqual({ server: "external", tool: "get_items" });
  });
  it("keeps extra segments in the server part", () => {
    expect(parseMcpName("mcp__plugin_jev_jev__jev_rank")).toEqual({ server: "plugin_jev_jev", tool: "jev_rank" });
  });
  it("returns undefined for non-mcp names", () => {
    expect(parseMcpName("Bash")).toBeUndefined();
    expect(parseMcpName("mcp__onlyserver")).toBeUndefined();
  });
  it("returns undefined for an empty tool", () => {
    expect(parseMcpName("mcp__srv__")).toBeUndefined();
  });
});

describe("review reproductions: misleading names receive judgment", () => {
  it("mcp__external__get_and_delete_all is judged, not skipped", () => {
    expect(classifyMcpTool("mcp__external__get_and_delete_all").kind).toBe("judge");
  });
  it("mcp__maljevhost__jev_delete_all is judged, not skipped", () => {
    expect(classifyMcpTool("mcp__maljevhost__jev_delete_all").kind).toBe("judge");
  });
  it("read-verb prefix on an unknown server is judged", () => {
    for (const name of ["mcp__x__get_thing", "mcp__x__list_stuff", "mcp__x__read_file", "mcp__x__describe_y"]) {
      expect(classifyMcpTool(name).kind).toBe("judge");
    }
  });
  it("own tool name on a foreign server is judged", () => {
    expect(isOwnTool("mcp__maljevhost__jev_execute_graph")).toBe(false);
    expect(classifyMcpTool("mcp__maljevhost__jev_execute_graph").kind).toBe("judge");
  });
});

describe("own tools keep the low-latency skip", () => {
  it("every own tool on an own server skips", () => {
    for (const tool of OWN_TOOL_NAMES) {
      expect(classifyMcpTool(`mcp__jev__${tool}`).kind).toBe("skip");
    }
  });
  it("non-mcp names are judged", () => {
    expect(classifyMcpTool("Bash").kind).toBe("judge");
  });
});

describe("operator allowlist", () => {
  it("parses server__tool entries, ignoring blanks and junk", () => {
    expect(parseMcpSkipAllowlist("a__b, c__d,, no-sep , e__f")).toEqual(["a__b", "c__d", "e__f"]);
    expect(parseMcpSkipAllowlist(undefined)).toEqual([]);
    expect(parseMcpSkipAllowlist("")).toEqual([]);
  });
  it("allowlisted pair skips; non-allowlisted pair is judged", () => {
    const allow = parseMcpSkipAllowlist("trusted__fetch_rows");
    expect(classifyMcpTool("mcp__trusted__fetch_rows", allow).kind).toBe("skip");
    expect(classifyMcpTool("mcp__trusted__drop_rows", allow).kind).toBe("judge");
  });
});

describe("OWN_TOOL_NAMES stays synced with src/tools", () => {
  it("every exported tool name on disk is recognized", () => {
    const toolsDir = join(__dirname, "..", "..", "src", "tools");
    const names = readdirSync(toolsDir)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => {
        const src = readFileSync(join(toolsDir, f), "utf8");
        return [...src.matchAll(/export const name = "(jev_[a-z_]+)"/g)].map((m) => m[1]!);
      });
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(OWN_TOOL_NAMES.has(n), `tool ${n} missing from OWN_TOOL_NAMES`).toBe(true);
    }
  });
  it("every OWN_TOOL_NAMES entry exists on disk", () => {
    const toolsDir = join(__dirname, "..", "..", "src", "tools");
    const disk = readdirSync(toolsDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(join(toolsDir, f), "utf8"))
      .join("\n");
    for (const n of OWN_TOOL_NAMES) {
      expect(disk.includes(`"${n}"`), `OWN_TOOL_NAMES entry ${n} not found in src/tools`).toBe(true);
    }
  });
});

describe("mcpToolSegment", () => {
  it("extracts the tool segment for error messages", () => {
    expect(mcpToolSegment("mcp__external__get_and_delete_all")).toBe("get_and_delete_all");
    expect(mcpToolSegment("Bash")).toBeUndefined();
  });
});
