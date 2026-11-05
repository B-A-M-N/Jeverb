/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __JEV_TEST_CONTROL_BUILD__: "true" },
  test: {
    globals: true,
    environment: "node",
    // Thread workers avoid the fork-pool RPC update timeout on long policy
    // matrix files while retaining real subprocess coverage in those tests.
    pool: "threads",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // A few tests spawn real git/node subprocesses; on a loaded machine those
    // exceed the 5 s default under CPU starvation even though they take ~1 s
    // unloaded. 20 s tolerates that while still catching a genuine hang.
    testTimeout: 40_000,
    // The policy matrices run one long task per file. Keeping a single worker
    // avoids Vitest's 60 s runner RPC deadline expiring while both matrices
    // saturate a host during synchronous handler calls.
    maxWorkers: 1,
  },
});
