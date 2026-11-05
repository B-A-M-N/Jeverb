/**
 * CI sandbox-backend gate: prove the production confinement probe passes.
 *
 * Fails with a clear infrastructure diagnosis when Bubblewrap (or the
 * systemd scope backend the runner depends on) is unavailable — the
 * sandbox integration suites fail closed without one, and that must read
 * as "runner lacks a backend", never as a confusing test failure.
 */
import { isSandboxAvailable } from "../src/graph/runner.js";

const ok = await isSandboxAvailable();
if (ok) {
  console.log("sandbox backend confining: production probe passed");
  process.exit(0);
}
console.error(
  "sandbox backend unavailable: bwrap/systemd-run confinement probe failed. " +
    "Install bubblewrap and ensure a systemd user bus is reachable; " +
    "graph shell nodes refuse to run without isolation.",
);
process.exit(1);
