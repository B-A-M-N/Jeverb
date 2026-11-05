/**
 * Purpose: build a test-only hook bundle in an invocation-private directory.
 * Owner: hook integration-test harness; production bundles belong to scripts/build-plugin.ts.
 * Lifecycle: remove the temporary bundle after its test file and on process exit.
 */
import { afterAll } from "vitest";
import { buildSync } from "esbuild";
import { rmSync } from "node:fs";
import { mkdtempSync } from "./temp-directory.js";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tempRoot = mkdtempSync(join(tmpdir(), "jeverb-test-hook-"));
export const TEST_HOOK_BUNDLE = join(tempRoot, "hook.mjs");

process.once("exit", () => rmSync(tempRoot, { recursive: true, force: true }));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

buildSync({
  entryPoints: [join(root, "src/hooks/cli.ts")],
  outfile: TEST_HOOK_BUNDLE,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  minifyIdentifiers: false,
  write: true,
  define: { __JEV_TEST_CONTROL_BUILD__: "true" },
});
