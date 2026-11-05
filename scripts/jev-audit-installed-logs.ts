#!/usr/bin/env tsx
/** Read-only, content-redacting summary of installed Muse hook telemetry. */
import { readFileSync, writeFileSync } from "node:fs";
import { summarizeInstalledTelemetry } from "../src/jev/telemetry-audit.js";
import { assertOutputPathAvailable } from "./artifact-output.js";

function required(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i < 0 ? undefined : process.argv[i + 1];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

try {
  const decisionsPath = required("--decisions");
  const evidencePath = required("--evidence");
  const outPath = required("--out");
  const summary = summarizeInstalledTelemetry({
    decisionsText: readFileSync(decisionsPath, "utf8"),
    evidenceText: readFileSync(evidencePath, "utf8"),
  });
  assertOutputPathAvailable(outPath);
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const source = summary.sources as { decisions: { records: number }; evidence: { records: number } };
  console.log(JSON.stringify({ status: "summarized", decisions: source.decisions.records, evidence: source.evidence.records, rawContentIncluded: false }));
} catch (error) {
  console.error(`jev-audit-installed-logs: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
