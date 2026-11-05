#!/usr/bin/env tsx
/**
 * CI review entry point for the jev-review workflow.
 *
 *   review-ci --base <sha> [--detectors-only]
 *
 * Diffs <base>...HEAD, runs the deterministic detectors over it, and —
 * unless --detectors-only — the full ReviewService with the Jev model from
 * the environment (TYPESAFE_API_KEY, JEV_MODEL default jev-1.14.0).
 *
 * Exit codes: 0 MERGE/NITS, 1 BLOCK or SECURITY REVIEW, 2 UNAVAILABLE or
 * infrastructure failure. UNAVAILABLE is fail-neutral: it never passes as a
 * merge, and it is distinct from a successful review.
 */

import { execFileSync } from "node:child_process";
import { JevDecisionModel } from "../src/jev/client.js";
import { loadReviewConfig } from "../src/review/load-config.js";
import { runDetectors } from "../src/review/detectors.js";
import { ReviewService } from "../src/review/service.js";

function usage(): never {
  console.error("usage: review-ci --base <sha> [--detectors-only]");
  process.exit(2);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : (process.argv[i + 1] ?? "");
}

const base = flag("--base");
if (base === undefined || base === "") usage();
const detectorsOnly = process.argv.includes("--detectors-only");

let diff: string;
try {
  diff = execFileSync("git", ["diff", `${base}...HEAD`, "--"], { encoding: "utf8", maxBuffer: 20_000_000 });
} catch (err) {
  console.error(`review-ci: cannot diff against ${base}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

if (detectorsOnly) {
  const result = runDetectors({ diff });
  console.log(JSON.stringify({ mode: "detectors-only", hardBlock: result.hardBlock }, null, 2));
  if (result.hardBlock.length > 0) {
    console.error(`review-ci: BLOCK — ${result.hardBlock.length} deterministic finding(s)`);
    process.exit(1);
  }
  console.log("review-ci: detectors clean");
  process.exit(0);
}

const loaded = loadReviewConfig();
if (loaded.invalid !== undefined) {
  console.error(`review-ci: review config invalid: ${loaded.invalid}`);
  process.exit(2);
}

const apiKey = process.env.TYPESAFE_API_KEY ?? "";
if (apiKey === "") {
  console.log(JSON.stringify({ lane: "UNAVAILABLE", reason: "TYPESAFE_API_KEY is not set" }));
  process.exit(2);
}

const baseUrl = process.env.TYPESAFE_BASE_URL;
const model = new JevDecisionModel({
  apiKey,
  ...(baseUrl !== undefined && baseUrl !== "" ? { baseUrl } : {}),
  model: process.env.JEV_MODEL ?? "jev-1.14.0",
});
const service = new ReviewService(model, { checks: loaded.checks, policy: loaded.policy });
const result = await service.review({ diff });
console.log(JSON.stringify({ lane: result.lane, source: result.source, findings: result.findings }, null, 2));
if (result.lane === "BLOCK" || result.lane === "SECURITY REVIEW") process.exit(1);
if (result.lane === "UNAVAILABLE") process.exit(2);
process.exit(0);
