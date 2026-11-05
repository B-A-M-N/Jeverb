import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSandboxAvailable, runShellConstrained } from "../../src/graph/runner.js";

describe("runShellConstrained", () => {
  let root: string;
  let work: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jev-runner-"));
    work = join(root, "work");
    outside = join(root, "outside-secret.txt");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "placeholder.txt"), "x\n");
    writeFileSync(outside, "operator-secret-material\n");
    delete process.env.JEVERB_TEST_MARKER;
    delete process.env.JEVERB_API_KEY;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.JEVERB_TEST_MARKER;
    delete process.env.JEVERB_API_KEY;
  });

  it("requires an operational sandbox backend", async () => {
    // No skip: if this fails, the backend is broken and every protected
    // node must refuse — which is exactly what the next tests assert.
    expect(await isSandboxAvailable()).toBe(true);
  });

  it("runs ordinary commands inside the sandbox", async () => {
    const ran = await runShellConstrained("echo hello", {
      workspaceRoot: work,
      timeoutMs: 10_000,
      allowNetwork: false,
    });
    expect(ran.output.trim()).toBe("hello");
    expect(ran.sandboxed).toBe(true);
  });

  it("never leaks operator secrets through the environment", async () => {
    process.env.JEVERB_TEST_MARKER = "marker-secret-xyz";
    process.env.JEVERB_API_KEY = "[REDACTED]";
    const ran = await runShellConstrained("env", {
      workspaceRoot: work,
      timeoutMs: 10_000,
      allowNetwork: false,
    });
    expect(ran.output).not.toContain("marker-secret-xyz");
    expect(ran.output).not.toContain("[REDACTED]");
  });

  it("cannot read a planted secret outside its workspace", async () => {
    await expect(
      runShellConstrained(`cat ${outside}`, {
        workspaceRoot: work,
        timeoutMs: 10_000,
        allowNetwork: false,
      }),
    ).rejects.toThrow(/shell node failed/);
    // The workspace itself stays readable.
    const ran = await runShellConstrained("cat placeholder.txt", {
      workspaceRoot: work,
      timeoutMs: 10_000,
      allowNetwork: false,
    });
    expect(ran.output.trim()).toBe("x");
    expect(ran.sandboxed).toBe(true);
  });

  it("cannot climb out with parent traversal", async () => {
    await expect(
      runShellConstrained("cat /work/../outside-secret.txt", {
        workspaceRoot: work,
        timeoutMs: 10_000,
        allowNetwork: false,
      }),
    ).rejects.toThrow(/shell node failed/);
  });

  it("cannot create files outside the workspace", async () => {
    const escape = join(root, "escaped.txt");
    await expect(
      runShellConstrained(`touch ${escape} && echo escaped`, {
        workspaceRoot: work,
        timeoutMs: 10_000,
        allowNetwork: false,
      }),
    ).rejects.toThrow();
    const { existsSync } = await import("node:fs");
    expect(existsSync(escape)).toBe(false);
    // Writing inside the workspace works: the boundary is selective, not
    // a blanket denial.
    const ran = await runShellConstrained("touch /work/inside.txt && echo wrote-inside", {
      workspaceRoot: work,
      timeoutMs: 10_000,
      allowNetwork: false,
    });
    expect(ran.output.trim()).toBe("wrote-inside");
    expect(existsSync(join(work, "inside.txt"))).toBe(true);
  });

  it("denies loopback network by default and allows it when permitted", async () => {
    // A real listener on loopback: reaching it proves the namespace is
    // shared, failing to reach it proves isolation. A closed port would
    // fail either way and prove nothing.
    const server = createServer((_req, res) => {
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const probe = `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}' && echo connected`;
      await expect(
        runShellConstrained(probe, { workspaceRoot: work, timeoutMs: 10_000, allowNetwork: false }),
      ).rejects.toThrow();
      const ran = await runShellConstrained(probe, {
        workspaceRoot: work,
        timeoutMs: 10_000,
        allowNetwork: true,
      });
      expect(ran.output.trim()).toBe("connected");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses to run when the workspace cannot be confined", async () => {
    // A missing workspace breaks the bind mount: bwrap fails, and the
    // command must not run anywhere else.
    await expect(
      runShellConstrained("echo should-never-run", {
        workspaceRoot: join(root, "no-such-dir"),
        timeoutMs: 10_000,
        allowNetwork: false,
      }),
    ).rejects.toThrow(/refusing shell execution/);
  });

  it("marks a timeout kill as outcome_unknown, not ordinary failure", async () => {
    await expect(
      runShellConstrained("sleep 5", {
        workspaceRoot: work,
        timeoutMs: 300,
        allowNetwork: false,
      }),
    ).rejects.toThrow(/outcome_unknown/);
  });

  it("marks death by signal as outcome_unknown", async () => {
    // A process that kills itself may or may not have finished its side
    // effects: that is exactly the uncertainty outcome_unknown names.
    await expect(
      runShellConstrained("kill -9 $$", {
        workspaceRoot: work,
        timeoutMs: 10_000,
        allowNetwork: false,
      }),
    ).rejects.toThrow(/outcome_unknown/);
  });

  it("reports an abort as cancellation", async () => {
    const ctrl = new AbortController();
    const running = runShellConstrained("sleep 5", {
      workspaceRoot: work,
      timeoutMs: 10_000,
      signal: ctrl.signal,
      allowNetwork: false,
    });
    ctrl.abort();
    await expect(running).rejects.toThrow(/cancelled/);
  });

  it("does not expose host configuration directories", async () => {
    // /etc and /opt are no longer bound at all: the node cannot read host
    // config regardless of what the command pattern matcher thinks.
    for (const probe of ["test ! -e /etc/hostname", "test ! -e /opt", "test ! -e /etc/shadow"]) {
      const ran = await runShellConstrained(`${probe} && echo hidden`, {
        workspaceRoot: work,
        timeoutMs: 10_000,
        allowNetwork: false,
      });
      expect(ran.output.trim()).toBe("hidden");
    }
  });

  it("applies resource ceilings from the profile", async () => {
    const limits = { maxMemoryMb: 64, maxProcesses: 8, maxFileBytes: 1024 * 1024, maxCpuSeconds: 10 };
    // Soft queries report what the sandbox set (hard sets apply where the
    // kernel permits; soft always applies to the node).
    const mem = await runShellConstrained("ulimit -S -v", {
      workspaceRoot: work,
      timeoutMs: 10_000,
      allowNetwork: false,
      resourceLimits: limits,
    });
    expect(mem.output.trim()).toBe(String(64 * 1024));
    const procs = await runShellConstrained("ulimit -S -u", {
      workspaceRoot: work,
      timeoutMs: 10_000,
      allowNetwork: false,
      resourceLimits: limits,
    });
    expect(procs.output.trim()).toBe("8");
    // The implement preset is the default: 512 MiB address space.
    const preset = await runShellConstrained("ulimit -S -v", {
      workspaceRoot: work,
      timeoutMs: 10_000,
      allowNetwork: false,
    });
    expect(preset.output.trim()).toBe(String(512 * 1024));
  });

  it("contains a memory hog inside the systemd scope", async () => {
    // 200MB allocation under a 50MB ceiling must die, not complete. Slow
    // by design (the allocator must actually touch the ceiling).
    await expect(
      runShellConstrained(`x=$(printf '%0200000000d' 0); echo survived:\${#x}`, {
        workspaceRoot: work,
        timeoutMs: 30_000,
        allowNetwork: false,
        resourceLimits: { maxMemoryMb: 50, maxProcesses: 64, maxFileBytes: 10 * 1024 * 1024, maxCpuSeconds: 60 },
      }),
    ).rejects.toThrow();
  });

  it("contains a fork bomb and stays responsive", async () => {
    // With max user processes at 16 the bomb cannot reproduce: forks fail
    // immediately and the node exits instead of thrashing the machine. An
    // uncontained bomb could never exit 0 here — it would hang until the
    // 8s timeout. Either layer containing it, the machine stays responsive.
    const start = Date.now();
    const ran = await runShellConstrained(":(){ :|:& }; :", {
      workspaceRoot: work,
      timeoutMs: 8_000,
      allowNetwork: false,
      resourceLimits: { maxMemoryMb: 512, maxProcesses: 16, maxFileBytes: 100 * 1024 * 1024, maxCpuSeconds: 60 },
    });
    expect(Date.now() - start).toBeLessThan(8_000);
    expect(ran.sandboxed).toBe(true);
    const after = await runShellConstrained("echo responsive", {
      workspaceRoot: work,
      timeoutMs: 10_000,
      allowNetwork: false,
    });
    expect(after.output.trim()).toBe("responsive");
  });

  it("reaps the process tree on timeout", async () => {
    const marker = `jeverb-reap-${Date.now()}`;
    await expect(
      runShellConstrained(`sleep 30 # ${marker}`, {
        workspaceRoot: work,
        timeoutMs: 1_000,
        allowNetwork: false,
      }),
    ).rejects.toThrow(/outcome_unknown/);
    const { execFileSync } = await import("node:child_process");
    let lingering = "";
    try {
      lingering = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" });
    } catch {
      lingering = "";
    }
    expect(lingering.trim()).toBe("");
  });

  it("enforces the file-size ceiling inside the sandbox", async () => {
    await expect(
      runShellConstrained("head -c 5000000 /dev/zero > /tmp/big && echo wrote", {
        workspaceRoot: work,
        timeoutMs: 15_000,
        allowNetwork: false,
        resourceLimits: { maxMemoryMb: 512, maxProcesses: 64, maxFileBytes: 1024 * 1024, maxCpuSeconds: 60 },
      }),
    ).rejects.toThrow();
  });

  it("binds the workspace read-only under the inspect profile", async () => {
    await expect(
      runShellConstrained("touch /work/nope && echo wrote", {
        workspaceRoot: work,
        timeoutMs: 10_000,
        allowNetwork: false,
        profile: "inspect",
      }),
    ).rejects.toThrow();
    // Scratch space stays writable: read-only means the workspace, not everything.
    const ran = await runShellConstrained("echo scratch > /tmp/ok && cat /tmp/ok", {
      workspaceRoot: work,
      timeoutMs: 10_000,
      allowNetwork: false,
      profile: "inspect",
    });
    expect(ran.output.trim()).toBe("scratch");
  });

  it("binds the workspace read-only with an explicit flag", async () => {
    await expect(
      runShellConstrained("touch /work/nope && echo wrote", {
        workspaceRoot: work,
        timeoutMs: 10_000,
        allowNetwork: false,
        readOnlyWorkspace: true,
      }),
    ).rejects.toThrow();
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(work, "nope"))).toBe(false);
  });
});
