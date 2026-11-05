/**
 * Isolation boundaries: master-switch denial vs confinement denial.
 *
 * These fixtures reproduce each failure independently with explicit,
 * isolated preconditions so a red run names its cause:
 * - master switch OFF (never set ON) + backend present => the tool
 *   refuses with the switch message, never a confinement message. This
 *   pins the SERVER-01 mechanism: a missing/untrusted switch reads as
 *   OFF; it is not a sandbox problem.
 * - backend missing (empty PATH) => the confinement probe fails closed
 *   and shell execution refuses without running the command. Fail-closed
 *   is asserted, never bypassed: no flag, mock, or skip weakens
 *   isolation to make the test green.
 *
 * The available-backend + switch-ON control proves the fixtures
 * discriminate: identical code path, only the precondition changes.
 * This file never modifies server, config, or confinement sources.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSandboxAvailable, runShellConstrained } from "../../src/graph/runner.js";
import { createServer } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import { setTestSwitch, testSwitchPath } from "../helpers/control-state.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-isolation-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function historyResult(): Promise<{ isError?: unknown; content?: unknown }> {
  vi.stubEnv("JEV_GRAPH_SHELL", "allow");
  vi.stubEnv("MUSE_SESSION_ID", "isolation-switch-session");
  // Isolate the journal store: the server resolves its data dir from the
  // ambient process env, and a host journal directory is unbounded.
  vi.stubEnv("JEV_HOOKS_DATA_DIR", dir);
  const config = { ...loadConfig({}), masterSwitchPath: testSwitchPath(dir) };
  const server = createServer(null, config);
  const client = new Client({ name: "isolation-probe", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.callTool({ name: "jev_graph_history", arguments: {} })) as {
      isError?: unknown;
      content?: unknown;
    };
  } finally {
    await client.close();
    await server.close();
  }
}

function historyText(result: { content?: unknown }): string {
  return JSON.stringify(result.content ?? []);
}

describe("switch vs confinement isolation boundaries", () => {
  it("attributes a switch-OFF history refusal to the master switch, not confinement", async () => {
    // Deliberately no setTestSwitch: missing switch state reads as OFF.
    const result = await historyResult();
    expect(result.isError).toBe(true);
    const text = historyText(result);
    expect(text).toMatch(/master switch/i);
    expect(text).not.toMatch(/confinement|bwrap/);
  });

  it("serves history when the switch is explicitly ON", async () => {
    setTestSwitch(dir, "ON");
    const result = await historyResult();
    expect(result.isError).not.toBe(true);
  });

  it("fails closed with a confinement refusal when the backend is missing", async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), "jev-no-backend-"));
    vi.stubEnv("PATH", emptyBin);
    await expect(isSandboxAvailable()).resolves.toBe(false);
    const work = mkdtempSync(join(tmpdir(), "jev-isolation-work-"));
    await expect(
      runShellConstrained("echo should-never-run", {
        workspaceRoot: work,
        timeoutMs: 5_000,
        allowNetwork: false,
      }),
    ).rejects.toThrow("confinement backend is unavailable");
  });
});
