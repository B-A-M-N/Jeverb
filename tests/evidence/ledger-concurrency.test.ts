import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import { setTestSwitch, testLedger, testSwitchPath } from "../helpers/control-state.js";

const root = new URL("../../", import.meta.url).pathname;

function bundleLedger(dir: string): string {
  const out = join(dir, "ledger.bundle.mjs");
  buildSync({
    entryPoints: [join(root, "src/evidence/ledger.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    logLevel: "silent",
  });
  return out;
}

function childScript(dir: string, bundle: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `import { EvidenceLedger } from ${JSON.stringify(bundle)};\n${body}`, "utf8");
  return path;
}

function runChild(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, ...args], { timeout: 30_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`ledger child failed: ${String(stderr).slice(0, 500)}`));
      else resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("evidence ledger append/prune concurrency", () => {
  it("returns a typed failure when the cross-process lock stays busy", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-ledger-lock-timeout-"));
    const path = join(dir, "evidence.log");
    const lockDir = `${path}.lock`;
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, "owner"), `${process.pid}:${Date.now()}:held`, { mode: 0o600 });

      setTestSwitch(dir, "ON");
      const result = testLedger(dir).appendDetailed({
        schema: 1,
        id: "timeout",
        ts: new Date().toISOString(),
        sessionId: "ledger-race",
        event: "PreToolUse",
        subjectHash: "ab".repeat(16),
        policyVersion: "test",
        deterministicFindings: [],
        enforcement: "allow",
        reasons: [],
        latencyMs: 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("LEDGER_LOCK_TIMEOUT");
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 5000);

  it("does not lose concurrent append-only receipts while maintenance rewrites the ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-ledger-race-"));
    // Child processes enforce the same fail-closed control check as the
    // parent: hand them the test switch path explicitly.
    setTestSwitch(dir, "ON");
    const switchPath = testSwitchPath(dir);
    const path = join(dir, "evidence.log");
    const bundle = bundleLedger(dir);
    const gate = join(dir, "go");
    const writer = childScript(
      dir,
      bundle,
      "writer.mjs",
      `import { existsSync, writeFileSync } from "node:fs";
const [ledgerPath, switchPath, readyPath, gatePath, prefix] = process.argv.slice(2);
const ledger = new EvidenceLedger(ledgerPath, { switchPath, requireRootOwnedSwitch: false });
writeFileSync(readyPath, "ready");
while (!existsSync(gatePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
for (let i = 0; i < 40; i++) {
  const id = prefix + "-" + i;
  const ok = ledger.append({ schema: 1, id, ts: new Date().toISOString(), sessionId: "ledger-race", event: "PreToolUse", subjectHash: "abababababababababababababababab", policyVersion: "test", deterministicFindings: [], enforcement: "allow", reasons: [], latencyMs: 0 });
  if (!ok) throw new Error("append failed: " + id);
}`,
    );
    const pruner = childScript(
      dir,
      bundle,
      "pruner.mjs",
      `import { existsSync, writeFileSync } from "node:fs";
const [ledgerPath, switchPath, readyPath, gatePath] = process.argv.slice(2);
const ledger = new EvidenceLedger(ledgerPath, { switchPath, requireRootOwnedSwitch: false });
writeFileSync(readyPath, "ready");
while (!existsSync(gatePath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
for (let i = 0; i < 80; i++) ledger.prune({ maxCount: 1000 });`,
    );
    const ready = [join(dir, "writer-a.ready"), join(dir, "writer-b.ready"), join(dir, "pruner.ready")];
    const processes = [
      runChild(writer, [path, switchPath, ready[0]!, gate, "a"]),
      runChild(writer, [path, switchPath, ready[1]!, gate, "b"]),
      runChild(pruner, [path, switchPath, ready[2]!, gate]),
    ];
    try {
      const deadline = Date.now() + 10_000;
      while (!ready.every(existsSync) && Date.now() < deadline) await delay(10);
      expect(ready.every(existsSync)).toBe(true);
      writeFileSync(gate, "go");
      await Promise.all(processes);

      const read = new EvidenceLedger(path).read();
      expect(read.corrupt).toBeUndefined();
      expect(read.records).toHaveLength(80);
      expect(new Set(read.records.map((entry) => entry.id)).size).toBe(80);
    } finally {
      writeFileSync(gate, "go");
      await Promise.allSettled(processes);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
