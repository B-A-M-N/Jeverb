import { request } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "../helpers/temp-directory.js";

const script = join(process.cwd(), "scripts", "spike-http-hook.mjs");

function start(port: string, logPath?: string, tempRoot = tmpdir()) {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tempRoot };
  if (logPath === undefined) delete env.JEV_SPIKE_LOG;
  else env.JEV_SPIKE_LOG = logPath;
  return spawn(process.execPath, [script, port, "json"], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
}

async function waitForListener(child: ReturnType<typeof start>): Promise<{ port: number; logPath: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`listener startup timed out: ${output}`)), 3_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
      const match = /spike listener on http:\/\/127\.0\.0\.1:(\d+).* logging privately to (.+)\n/.exec(output);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), logPath: match[2] });
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`listener exited before startup (code=${code}, signal=${signal}): ${output}`));
    });
  });
}

async function stop(child: ReturnType<typeof start>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("listener did not stop within 2 seconds")), 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function postSyntheticHeaders(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ hook_event_name: "Stop", session_id: "BODY-PRIVATE" });
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/hook/Stop?token=URL-PRIVATE",
        headers: {
          authorization: "Bearer HEADER-PRIVATE",
          "set-cookie": ["session=ARRAY-PRIVATE-A", "session=ARRAY-PRIVATE-B"],
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(`unexpected status ${res.statusCode}`))));
      },
    );
    req.once("error", reject);
    req.setTimeout(2_000, () => req.destroy(new Error("synthetic request timed out")));
    req.end(body);
  });
}

describe("spike HTTP hook artifact lifecycle", () => {
  it("redacts scalar and array header values and writes a private bounded log", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-spike-hook-test-"));
    const child = start("0", undefined, root);
    try {
      const ready = await waitForListener(child);
      expect(dirname(dirname(ready.logPath))).toBe(root);
      expect(basename(dirname(ready.logPath))).toMatch(/^jev-spike-/);
      await postSyntheticHeaders(ready.port);
      await stop(child);

      const text = readFileSync(ready.logPath, "utf8");
      const row = JSON.parse(text) as { url: string; session: string; headers: Record<string, string | string[]> };
      expect(text).not.toMatch(/PRIVATE/);
      expect(row.url).toBe("/v1/hook/Stop");
      expect(row.session).toMatch(/^\d+ chars$/);
      expect(row.headers.authorization).toMatch(/^\d+ chars$/);
      expect(row.headers["set-cookie"]).toHaveLength(2);
      expect(row.headers["set-cookie"]).toEqual([expect.stringMatching(/^\d+ chars$/), expect.stringMatching(/^\d+ chars$/)]);
      if (process.platform !== "win32") expect(statSync(ready.logPath).mode & 0o777).toBe(0o600);
      expect(statSync(ready.logPath).size).toBeLessThanOrEqual(4 * 1024 * 1024);
    } finally {
      await stop(child);
    }
  });

  it("refuses existing logs and paths inside the repository without changing either", () => {
    const root = mkdtempSync(join(tmpdir(), "jev-spike-hook-test-"));
    const existing = join(root, "existing.jsonl");
    const sentinel = "preserve existing diagnostic evidence\n";
    writeFileSync(existing, sentinel, { mode: 0o600 });
    const refusesExisting = spawnSync(process.execPath, [script, "0", "json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, JEV_SPIKE_LOG: existing },
      timeout: 3_000,
    });
    expect(refusesExisting.error).toBeUndefined();
    expect(refusesExisting.status).not.toBe(0);
    expect(refusesExisting.stderr).toMatch(/EEXIST/);
    expect(readFileSync(existing, "utf8")).toBe(sentinel);

    const inRepo = join(process.cwd(), `.spike-http-hook-${process.pid}-${Date.now()}.jsonl`);
    try {
      const refusesRepositoryPath = spawnSync(process.execPath, [script, "0", "json"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, JEV_SPIKE_LOG: inRepo },
        timeout: 3_000,
      });
      expect(refusesRepositoryPath.error).toBeUndefined();
      expect(refusesRepositoryPath.status).not.toBe(0);
      expect(refusesRepositoryPath.stderr).toContain("must be outside the repository");
      expect(() => statSync(inRepo)).toThrow();
    } finally {
      rmSync(inRepo, { force: true });
    }
  });

  it("removes the empty default log directory after a clean shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-spike-hook-test-"));
    const child = start("0", undefined, root);
    let logPath: string | undefined;
    try {
      const ready = await waitForListener(child);
      logPath = ready.logPath;
      await stop(child);
      expect(existsSync(logPath)).toBe(false);
      expect(existsSync(dirname(logPath))).toBe(false);
    } finally {
      await stop(child);
    }
  });
});
