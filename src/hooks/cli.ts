/**
 * Entry point bundled into `plugin/dist/hook.mjs`.
 *
 * Its only job is the outermost try/catch. `main` is a separate module so the
 * tests can import it without running it.
 *
 * There is exactly one exit code: 0. Exit 2 from a PreToolUse hook is a deny,
 * and a deny produced by a crash is the opposite of what this plugin promises.
 */

import { main } from "./main.js";
import { redact } from "./redact.js";

main().then(
  () => {
    process.exitCode = 0;
  },
  (err: unknown) => {
    // Fail-open exit, but never a silent crash: a sanitized one-liner on
    // stderr names the failure. stdout stays clean protocol.
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    process.stderr.write(`[jeverb] hook failed: ${redact(message).slice(0, 300)}\n`);
    process.exitCode = 0;
  },
);
