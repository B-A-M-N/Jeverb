/**
 * What actually ships.
 *
 * A plugin install runs no build step, so `plugin/dist/*.mjs` is the artifact,
 * and its contents are a property worth testing. In particular the hook bundle
 * must not drag in the MCP SDK or zod: it runs on every tool call, and its
 * cold start is a tax on the whole session.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Kept in step with `scripts/build-plugin.ts`, which fails the build on these. */
const HOOK_FORBIDDEN = ["@modelcontextprotocol", "zod"];

const root = new URL("../../", import.meta.url).pathname;
const hook = `${root}plugin/dist/hook.mjs`;
const mcp = `${root}plugin/dist/mcp.mjs`;

describe("plugin/dist", () => {
  it("ships both bundles", () => {
    expect(existsSync(hook), "run `npm run build:plugin`").toBe(true);
    expect(existsSync(mcp), "run `npm run build:plugin`").toBe(true);
  });

  it("keeps the MCP SDK and zod out of the hook bundle", () => {
    const text = readFileSync(hook, "utf8");
    for (const name of HOOK_FORBIDDEN) {
      expect(text, `${name} must not be bundled into hook.mjs`).not.toContain(name);
    }
    expect(text).not.toContain("node_modules/zod");
  });

  it("keeps the hook bundle small enough to start fast", () => {
    // Generous headroom; the point is to notice a dependency creeping in.
    // 0.4.0 added the daemon, its control plane and the memo: about +19 KiB of
    // first-party code, and no new dependency. The P0 review-config work
    // (config states, calibration binding) added ~15 KiB more first-party
    // code, taking the measured bundle to ~347 KiB with no new dependency.
    // P1 review bounds (diff parser, hunk chunking, bounded inference) and
    // the daemon capability token added ~12 KiB more, all first-party.
    // P1 convergence (daemon privilege tiers + session-scope validation,
    // lock-guarded session transactions with atomic writes, review
    // calibration pins, secret redaction table) added ~20 KiB more, all
    // first-party, taking the measured bundle to ~404 KiB with no new
    // dependency. Mission closure adds ~29 KiB of first-party session and
    // evidence handling. PermissionRequest, bounded input failures, and
    // timeout/runtime receipts put the measured bundle just over 482 KiB; retain a tight margin
    // while still detecting an external dependency or large feature creeping in.
    expect(statSync(hook).size).toBeLessThan(483 * 1024);
  });

  it("contains the daemon, so the http hooks have something to talk to", () => {
    // There is no third bundle: `node hook.mjs daemon` is the server, which is
    // what guarantees the handlers cannot drift between the two transports.
    const text = readFileSync(hook, "utf8");
    expect(text).toContain("/v1/hook/");
    expect(text).toContain("/v1/health");
    expect(text).toContain("/v1/session/start");
    expect(text).toContain("jev-daemon");
  });

  it("uses only the node builtins the daemon is allowed to reach for", () => {
    // `node:http`, `node:net`, `node:crypto` and `node:child_process` came with
    // the 0.4.0 daemon; `node:util` came with 0.6.0's `workspace.ts` (promisified
    // `execFile` for git); `node:url` came with the review-config states work
    // (`fileURLToPath` for bundle-relative config resolution in load-config.ts
    // — builtin, no dependency, reviewed and approved). `node:constants` is
    // used by host verifiers for O_NOFOLLOW/O_RDONLY when reading approved
    // evidence paths. Anything else new here
    // is worth a second look, because the reason this bundle has no
    // dependencies is that it runs on every call.
    const chunks = readdirSync(join(root, "plugin", "dist", "chunks"))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => readFileSync(join(root, "plugin", "dist", "chunks", name), "utf8"));
    const text = [readFileSync(hook, "utf8"), ...chunks].join("\n");
    const imported = new Set([...text.matchAll(/from\s*"(node:[a-z_/]+)"/g)].map((match) => match[1] as string));
    expect([...imported].sort()).toEqual(
      [
        "node:child_process",
        "node:constants",
        "node:crypto",
        "node:fs",
        "node:http",
        "node:net",
        "node:os",
        "node:path",
        "node:url",
        "node:util",
      ].sort(),
    );
  });

  it("bundles the MCP SDK into the server", () => {
    expect(readFileSync(mcp, "utf8")).toContain("@modelcontextprotocol");
  });

  it("keeps src/hooks off the MCP file layer, so hook.mjs never pulls it in", () => {
    // The one hook-side reader is `src/hooks/workspace.ts`, with its own
    // refusals; `src/files/` (zod, the whole file layer) must stay out of the
    // dependency-free bundle. This is the static guard on that.
    const hooksDir = join(root, "src", "hooks");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          if (/from\s+"(?:\.\.\/)+files\//.test(readFileSync(full, "utf8"))) offenders.push(full);
        }
      }
    };
    walk(hooksDir);
    expect(offenders).toEqual([]);
  });

  it("adds no shebang to the hook, which is invoked as `node <file>`", () => {
    expect(readFileSync(hook, "utf8").startsWith("#!")).toBe(false);
    // mcp.mjs inherits the one on src/index.ts, which is harmless: Node accepts
    // it, and it keeps the bundle runnable directly the way the npm bin is.
    expect(readFileSync(mcp, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("is not gitignored", () => {
    const ignore = readFileSync(`${root}.gitignore`, "utf8");
    const patterns = ignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    // A bare `dist/` would match plugin/dist too. It must be anchored.
    expect(patterns).toContain("/dist/");
    expect(patterns).not.toContain("dist/");
    expect(patterns).not.toContain("plugin/dist/");
  });
});

describe("plugin manifest", () => {
  it("wires each native Muse hook to a unique generated entrypoint", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), ".muse-plugin/plugin.json"), "utf8")) as {
      capabilities: { hooks: Array<{ event: string; command: string[] }>; skills: Array<{ id: string; path: string }> };
    };
    const hooks = manifest.capabilities.hooks;
    const events = hooks.map((entry) => entry.event);
    const sources = hooks.map((entry) => entry.command.at(-1));
    expect(new Set(events).size).toBe(events.length);
    expect(new Set(sources).size).toBe(sources.length);
    expect(events).toContain("PermissionRequest");
    expect(events).toEqual([
      "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse",
      "PostToolUseFailure", "PostToolBatch", "SubagentStart", "SubagentStop", "Stop", "SessionEnd",
      "PreLLMCall", "PostLLMCall", "PreCompact", "PostCompact", "StopFailure", "Notification",
    ]);
    for (const source of sources) expect(existsSync(join(process.cwd(), source as string))).toBe(true);
    expect(manifest.capabilities.skills).toEqual([
      { id: "jev-decide", path: "skills/jev-decide/SKILL.md" },
      { id: "jev-run-graph", path: "skills/jev-run-graph/SKILL.md" },
    ]);
    for (const skill of manifest.capabilities.skills) expect(existsSync(join(process.cwd(), skill.path))).toBe(true);
  });

  it("keeps the explicit decision skill from treating Jev confidence as proof or authority", () => {
    const skill = readFileSync(join(process.cwd(), "skills/jev-decide/SKILL.md"), "utf8");
    expect(skill).toContain("confidence measures concentration");
    expect(skill).toContain("never authorizes an action");
    expect(skill).toContain("independent verification");
  });

  it("never maps the plugin option onto TYPESAFE_API_KEY, which would mask a shell-exported key when the option is empty", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "plugin/.claude-plugin/plugin.json"), "utf8")) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    for (const server of Object.values(manifest.mcpServers)) {
      expect(Object.keys(server.env ?? {})).not.toContain("TYPESAFE_API_KEY");
    }
  });
});
