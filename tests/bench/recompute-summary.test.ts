import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "../helpers/temp-directory.js";

const script = fileURLToPath(new URL("../../scripts/jev-recompute-summary.ts", import.meta.url));

describe("jev-recompute-summary artifact lifecycle", () => {
  it("preserves an existing backup and refuses a second rewrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-recompute-summary-"));
    const summaryPath = join(dir, "sample.summary.json");
    const receiptsPath = join(dir, "sample.receipts.jsonl");
    const labelsPath = join(dir, "failed-labels.json");
    const backupPath = join(dir, "sample.summary.pre-inclusive.json");
    const originalSummary = `${JSON.stringify({ cases: 1, answerable: 1, inRange: 1 })}\n`;
    const originalBackup = "older preserved summary\n";
    writeFileSync(summaryPath, originalSummary);
    writeFileSync(receiptsPath, `${JSON.stringify({
      case: "case-1",
      question: "q",
      answer: { type: "choice", choice: "A" },
      expected: { choice: "A" },
      inRange: true,
    })}\n`);
    writeFileSync(labelsPath, JSON.stringify({ provenance: "synthetic", cases: {} }));
    writeFileSync(backupPath, originalBackup);

    const args = ["--import", "tsx", script, summaryPath, receiptsPath, labelsPath];
    const wronglyNamedSummary = join(dir, "sample.json");
    writeFileSync(wronglyNamedSummary, originalSummary);
    const invalidName = spawnSync(process.execPath, ["--import", "tsx", script, wronglyNamedSummary, receiptsPath, labelsPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(invalidName.error, invalidName.error?.message).toBeUndefined();
    expect(invalidName.status).not.toBe(0);
    expect(readFileSync(wronglyNamedSummary, "utf8")).toBe(originalSummary);

    const blocked = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(blocked.error, blocked.error?.message).toBeUndefined();
    expect(blocked.status).not.toBe(0);
    expect(readFileSync(summaryPath, "utf8")).toBe(originalSummary);
    expect(readFileSync(backupPath, "utf8")).toBe(originalBackup);

    rmSync(backupPath);
    const first = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(first.error, first.error?.message).toBeUndefined();
    expect(first.status, first.stderr).toBe(0);
    const preservedSummary = readFileSync(backupPath, "utf8");
    const inclusiveSummary = readFileSync(summaryPath, "utf8");
    expect(preservedSummary).toBe(originalSummary);
    expect(JSON.parse(inclusiveSummary).accountingVersion).toBe("inclusive/1");

    const repeated = spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(repeated.error, repeated.error?.message).toBeUndefined();
    expect(repeated.status).not.toBe(0);
    expect(readFileSync(backupPath, "utf8")).toBe(preservedSummary);
    expect(readFileSync(summaryPath, "utf8")).toBe(inclusiveSummary);
  });
});
