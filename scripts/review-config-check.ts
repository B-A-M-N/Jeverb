#!/usr/bin/env tsx
/** Fail-closed review config validation for CI: parse + shape-check. */
import { loadReviewConfig } from "../src/review/load-config.js";

const loaded = loadReviewConfig();
if (loaded.invalid !== undefined) {
  console.error(`review config invalid: ${loaded.invalid}`);
  process.exit(1);
}
if (loaded.checks.length === 0) {
  console.error("review config has no checks");
  process.exit(1);
}
console.log(`review config ok: ${loaded.checks.length} checks (source: ${loaded.source ?? "defaults"})`);
