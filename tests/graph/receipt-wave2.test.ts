import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "../helpers/temp-directory.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLedger } from "../../src/evidence/ledger.js";
import { setTestSwitch, testLedgerForFile, testSwitchPath } from "../helpers/control-state.js";
import { persistGraphNodeReceipt } from "../../src/graph/receipt.js";
import type { ExecutorResult } from "../../src/graph/executor.js";

function makeResult(digestChar: string, status: ExecutorResult["status"]): ExecutorResult {
  return {
    nodeId: "compile",
    ok: status === "succeeded",
    output: `output variant ${digestChar}`,
    attempts: 1,
    status,
    inputHash: "a".repeat(64),
    outputHash: "b".repeat(64),
    outputDigest: digestChar.repeat(64),
  };
}

function makeArgs(ledger: EvidenceLedger, result: ExecutorResult) {
  return {
    ledger,
    runId: "run_wave2",
    graphHash: "d".repeat(64),
    policyHash: "e".repeat(64),
    result,
  };
}

function terminalRows(ledger: EvidenceLedger) {
  return ledger
    .read()
    .records.filter(
      (entry) =>
        entry.event === "GraphNodeTerminal" &&
        entry.turnId === "run_wave2" &&
        entry.deterministicFindings.some((finding) => finding.startsWith("node_id_hash=")),
    );
}

describe("wave2 receipt atomicity", () => {
  it("collapses conflicting duplicate projections to a single terminal row", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-wave2-receipt-"));
    const ledger = testLedgerForFile(join(dir, "evidence.log"));
    const first = persistGraphNodeReceipt(makeArgs(ledger, makeResult("c", "succeeded")));
    expect(first.status).toBe("appended");
    // A racing duplicate projection of the same node (different attempt
    // outcome) must not append a conflicting second terminal row: it must
    // report the existing row instead.
    const second = persistGraphNodeReceipt(makeArgs(ledger, makeResult("f", "failed")));
    expect(second.status).toBe("duplicate");
    expect(second.correlationId).toBe(first.correlationId);
    const rows = terminalRows(ledger);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.correlationId).toBe(first.correlationId);
  });

  it("survives a prune/append race with a single terminal row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-wave2-race-"));
    setTestSwitch(dir, "ON");
    const switchJson = JSON.stringify(testSwitchPath(dir));
    const ledgerPath = join(dir, "evidence.log");
    const barrier = join(dir, "go");
    const tsxBin = join(process.cwd(), "node_modules", ".bin", "tsx");
    const receiptPath = join(process.cwd(), "src", "graph", "receipt.ts");
    const ledgerModule = join(process.cwd(), "src", "evidence", "ledger.ts");
    const workers = ["c", "e", "f", "9"].map(
      (digest, index) =>
        new Promise<{ status: string }>((resolve, reject) => {
          const child = execFile(
            tsxBin,
            [
              "-e",
              [
                `(async () => {`,
                `const fs = require("node:fs");`,
                `for (let i = 0; i < 600 && !fs.existsSync(${JSON.stringify(barrier)}); i++) await new Promise((r) => setTimeout(r, 25));`,
                `const { EvidenceLedger } = await import(${JSON.stringify(ledgerModule)});`,
                `const { persistGraphNodeReceipt } = await import(${JSON.stringify(receiptPath)});`,
                `const ledger = new EvidenceLedger(${JSON.stringify(ledgerPath)}, { switchPath: ${switchJson}, requireRootOwnedSwitch: false });`,
                `const outcome = persistGraphNodeReceipt({ ledger, runId: "run_wave2", graphHash: ${JSON.stringify("d".repeat(64))}, policyHash: ${JSON.stringify("e".repeat(64))}, result: { nodeId: "compile", ok: ${index === 0 ? "true" : "false"}, output: "race", attempts: 1, status: ${index === 0 ? `"succeeded"` : `"failed"`}, inputHash: ${JSON.stringify("a".repeat(64))}, outputHash: ${JSON.stringify("b".repeat(64))}, outputDigest: ${JSON.stringify(digest.repeat(64))} } });`,
                `console.log(JSON.stringify({ status: outcome.status, correlationId: outcome.correlationId }));`,
                `})().catch((e) => { console.error(String(e)); process.exit(1); });`,
              ].join("\n"),
            ],
            { timeout: 30_000 },
            (error, stdout) => {
              if (error) {
                reject(error);
                return;
              }
              try {
                resolve(JSON.parse(stdout.trim().split("\n").at(-1) as string) as { status: string });
              } catch (parseError) {
                reject(parseError);
              }
            },
          );
          void child;
        }),
    );
    const pruner = new Promise<void>((resolve, reject) => {
      execFile(
        tsxBin,
        [
          "-e",
          [
            `(async () => {`,
            `const fs = require("node:fs");`,
            `for (let i = 0; i < 600 && !fs.existsSync(${JSON.stringify(barrier)}); i++) await new Promise((r) => setTimeout(r, 25));`,
            `const { EvidenceLedger } = await import(${JSON.stringify(ledgerModule)});`,
            `const ledger = new EvidenceLedger(${JSON.stringify(ledgerPath)}, { switchPath: ${switchJson}, requireRootOwnedSwitch: false });`,
            // Keep-all retention: still exercises the temp-file + rename
            // path concurrently with the racing appends.
            `for (let i = 0; i < 25; i++) { ledger.prune({ maxAgeMs: 365 * 24 * 3600 * 1000 }); await new Promise((r) => setTimeout(r, 20)); }`,
            `})().catch((e) => { console.error(String(e)); process.exit(1); });`,
          ].join("\n"),
        ],
        { timeout: 30_000 },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
    // Release all racers at once.
    await new Promise((r) => setTimeout(r, 500));
    writeFileSync(barrier, "go");
    const outcomes = await Promise.all(workers);
    await pruner;
    expect(outcomes.filter((o) => o.status === "appended")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "duplicate")).toHaveLength(workers.length - 1);
    const ledger = testLedgerForFile(ledgerPath);
    expect(terminalRows(ledger)).toHaveLength(1);
  });

  it("restart persistence: re-open shows the single terminal", () => {
    const dir = mkdtempSync(join(tmpdir(), "jeverb-wave2-restart-"));
    const ledgerPath = join(dir, "evidence.log");
    const first = persistGraphNodeReceipt(makeArgs(testLedgerForFile(ledgerPath), makeResult("c", "succeeded")));
    expect(first.status).toBe("appended");
    const second = persistGraphNodeReceipt(makeArgs(testLedgerForFile(ledgerPath), makeResult("f", "failed")));
    expect(second.status).toBe("duplicate");
    // Simulate a process restart: a fresh handle must see one terminal row.
    expect(existsSync(ledgerPath)).toBe(true);
    const reopened = testLedgerForFile(ledgerPath).read();
    expect(reopened.corrupt).toBeUndefined();
    const rows = reopened.records.filter((entry) => entry.event === "GraphNodeTerminal");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.correlationId).toBe(first.correlationId);
  });
});
