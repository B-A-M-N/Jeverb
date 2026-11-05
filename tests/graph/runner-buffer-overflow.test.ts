import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSandboxAvailable, runShellConstrained } from "../../src/graph/runner.js";

// Live flood probes for the graph shell runner output caps.
// No mocks: every test executes a real sandboxed shell node.
describe("runShellConstrained output flood caps", () => {
  let work: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jev-runner-overflow-"));
    work = join(root, "work");
    mkdirSync(work, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("truncates a ~100MB stdout flood at the configured cap with a reason", async () => {
    expect(await isSandboxAvailable()).toBe(true);
    const cap = 32 * 1024;
    // ~100MB of stdout, generated without storing it in the workspace.
    const flood = `head -c 100000000 /dev/zero | tr '\\0' 'x'`;
    let settled: unknown;
    try {
      settled = await runShellConstrained(flood, {
        workspaceRoot: work,
        timeoutMs: 30_000,
        allowNetwork: false,
        maxOutputBytes: cap,
      });
    } catch (error) {
      settled = error;
    }
    // Either a resolved truncated result or a rejection that still records
    // truncation is acceptable; silent unbounded output or an OOM is not.
    if (settled instanceof Error) {
      expect(String(settled.message)).toMatch(/truncat/i);
      return;
    }
    const result = settled as { output: string; truncated?: boolean; truncationReason?: string };
    expect(typeof result.output).toBe("string");
    expect(result.output.length).toBeLessThanOrEqual(cap);
    const reason = `${String((result as { truncationReason?: unknown }).truncationReason ?? "")} ${String((result as { truncated?: unknown }).truncated ?? "")}`;
    expect(reason).toMatch(/truncat/i);
  });

  it("truncates a ~100MB stderr flood without unbounded buffering", async () => {
    expect(await isSandboxAvailable()).toBe(true);
    const cap = 32 * 1024;
    // Tiny stdout, ~100MB on stderr.
    const flood = `head -c 100000000 /dev/zero 1>&2 | tr '\\0' 'x' 1>&2; echo done`;
    let settled: unknown;
    try {
      settled = await runShellConstrained(flood, {
        workspaceRoot: work,
        timeoutMs: 30_000,
        allowNetwork: false,
        maxOutputBytes: cap,
      });
    } catch (error) {
      settled = error;
    }
    if (settled instanceof Error) {
      // A stderr flood must surface as a bounded truncation/failure note,
      // never as an unbounded dump in the message.
      expect(settled.message.length).toBeLessThanOrEqual(cap + 2000);
      expect(String(settled.message)).toMatch(/truncat|failed|outcome_unknown/i);
      return;
    }
    const result = settled as { output: string; truncated?: boolean; truncationReason?: string };
    expect(result.output.length).toBeLessThanOrEqual(cap);
  });

  it("terminates slow-drip output past the node deadline as outcome_unknown/timeout", async () => {
    expect(await isSandboxAvailable()).toBe(true);
    const drip = `for i in $(seq 1 60); do echo tick-$i; sleep 1; done`;
    await expect(
      runShellConstrained(drip, {
        workspaceRoot: work,
        timeoutMs: 10_000,
        deadlineMs: 1_500,
        allowNetwork: false,
      }),
    ).rejects.toThrow(/outcome_unknown|timed out|timeout/i);
  });
});
