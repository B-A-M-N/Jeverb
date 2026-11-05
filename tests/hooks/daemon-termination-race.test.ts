import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopDaemon } from "../../src/hooks/daemon/control.js";

describe("daemon termination race", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not send SIGKILL after the owned PID exits while another process keeps the port", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jeverb-daemon-termination-race-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    const childPid = child.pid;
    if (childPid === undefined) throw new Error("child process did not receive a pid");

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(termSent ? { service: "foreign" } : { jev: true, pid: childPid }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no TCP port");

    const signals: Array<string | number | undefined> = [];
    const realKill = process.kill;
    let termSent = false;
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === childPid && signal !== 0) {
        signals.push(signal);
        if (signal === "SIGTERM") termSent = true;
      }
      return realKill.call(process, pid, signal);
    });

    try {
      await expect(stopDaemon(dataDir, address.port, 50)).resolves.toBe("stopped");
      expect(signals).toEqual(["SIGTERM"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);
});
