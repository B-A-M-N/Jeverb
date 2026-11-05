#!/usr/bin/env tsx
/**
 * Live Jev rank benchmark for the shipped retry/backoff example.
 *
 * Runs the README query against TypeScript files under src at several caps
 * caps. Results are observations from the configured provider/model, not a
 * calibration claim. No output files or policy settings are changed.
 *
 *   TYPESAFE_API_KEY=... npm run bench:rank
 *   npm run bench:rank -- --caps 16,24,32,48,200 --repeats 3
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { JevDecisionModel } from "../src/jev/client.js";
import * as rankTool from "../src/tools/rank.js";

const DEFAULT_CAPS = [16, 24, 32, 48, 200];
const DEFAULT_REPEATS = 3;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function parseCaps(value: string | undefined): number[] {
  const caps = (value ?? DEFAULT_CAPS.join(",")).split(",").map(Number);
  if (caps.length === 0 || caps.some((cap) => !Number.isInteger(cap) || cap < 1 || cap > rankTool.MAX_CANDIDATES_PER_REQUEST)) {
    throw new Error(`--caps must be comma-separated integers from 1 to ${rankTool.MAX_CANDIDATES_PER_REQUEST}`);
  }
  return caps;
}

async function main(): Promise<number> {
  const config = loadConfig();
  if (config.apiKey === null) {
    console.error("bench:rank requires TYPESAFE_API_KEY; no live ranking calls were made.");
    return 2;
  }
  const caps = parseCaps(flag("--caps"));
  const repeats = Number(flag("--repeats") ?? DEFAULT_REPEATS);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) {
    throw new Error("--repeats must be an integer from 1 to 20");
  }

  const clientPath = resolve(config.projectRoot, "src/jev/client.ts");
  const sourceLines = readFileSync(clientPath, "utf8").split(/\r?\n/);
  const targetLine = sourceLines.findIndex((line) => line.includes("const ceiling = Math.min(BACKOFF_CAP_MS")) + 1;
  if (targetLine === 0) throw new Error(`Could not locate the backoff implementation in ${clientPath}`);

  const model = new JevDecisionModel({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });
  const toolConfig = {
    model: config.model,
    thresholds: config.thresholds,
    maxConcurrency: config.maxConcurrency,
    maxConcurrencyExplicit: config.maxConcurrencyExplicit,
    files: { root: config.projectRoot },
  };

  console.log(`model=${config.model} root=${config.projectRoot} target=src/jev/client.ts:${targetLine}`);
  console.log("cap,repeat,target_rank,requests,choice_margin,score_spread,input_tokens,latency_ms");
  for (const cap of caps) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const result = await rankTool.run(
        model,
        { query: "where are retries and backoff implemented", glob: "src/**/*.ts", unit: "chunk", top_k: 500 },
        { ...toolConfig, rankMaxCandidatesPerRequest: cap },
      );
      const target = result.ranked.find(
        (row) => row.path === "src/jev/client.ts" && row.start_line !== undefined && row.end_line !== undefined &&
          row.start_line <= targetLine && row.end_line >= targetLine,
      );
      console.log([
        cap,
        repeat,
        target?.rank ?? "not_found",
        result.chunks,
        result.choice_margin,
        result.score_spread,
        result.usage.input_tokens,
        result.latency_ms,
      ].join(","));
    }
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(`bench:rank: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
