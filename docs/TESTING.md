# Testing and evidence

## Test layers

| Check | Command | What it establishes |
|---|---|---|
| TypeScript type analysis | `npm run type-check` | Static type consistency in the checked project. |
| Unit/integration plus control service | `npm run test:run` | The repository's deterministic test contracts; not live-provider quality. |
| Build and package assembly | `npm run build` | TypeScript output and plugin package generation. |
| Package integrity | `npm run plugin:integrity-check` | Manifest, bundle, and package path consistency. |
| MCP loopback smoke | `npm run smoke:mcp-stub` | Stdio MCP interaction with a local provider stub. |
| Muse hook loopback smoke | `npm run smoke:muse-hook-stub` | Built hook/config/adapter behavior against a local stub. |
| Confinement check | `npm run sandbox:probe` | Whether this host can run the configured Bubblewrap confinement probe. |
| Local deterministic workflow | `npm run demo:deterministic` | Graph/verification/closure wiring with fixtures, not live Jev quality. |

## Reading evaluation evidence

Benchmark files under `bench/` preserve datasets, labels, raw receipts, and summaries. A historical percentage applies only to its named model, version, questions, evidence construction, data split, and gate. Do not combine mission-completion liveness with a separate advisory classification demonstration. A single successful corrective workflow establishes that the path can work once; it does not estimate reliability.

The retained 2026-11-04 development corrective-loop result records one actual Jev request and a successful verifier-backed repair. It is useful product evidence but is neither a qualification sample nor evidence that the installed production host is qualified. Refer to the result directory's manifest and hashes before relying on individual artifacts.

## Current local verification note

The repository-quality pass began from a dirty `rc-3` checkout with substantial pre-existing source, tests, generated bundles, and benchmark evidence changes. A baseline full-suite run completed with **188 files passed, 9 failed; 3,080 tests passed, 28 failed**. Therefore the suite is not currently recorded as green. Those failures need to be interpreted against the current dirty tree and host environment; this documentation pass should not attribute them to README/docs changes. See final work report for commands rerun after documentation changes.

The rerun in this pass reproduced 9 failing files: `tests/bench/semantic-lockbox.test.ts`, `tests/conformance/lifecycle-conformance.test.ts`, `tests/hooks/config-manifest.test.ts`, `tests/hooks/main.test.ts`, `tests/hooks/store.test.ts`, `tests/jev/lockbox.test.ts`, `tests/jev/qualification-3stage.test.ts`, `tests/scripts/jev-demo.test.ts`, and `tests/scripts/jev-qualify-lockbox.test.ts`. Several lockbox failures reflect strict qualification/preflight behavior; the full failure set has not been independently diagnosed here. The protected-switch tests also observed the host's current root-owned switch state, so results are host-sensitive.

The current MCP and Muse local smoke scripts are not passing with the current adapter: `harness/stub-relay.py` only accepts `/api/v1/chat/completions`, while the OpenRouter typed-decision adapter sends `/api/alpha/decisions`. The MCP smoke therefore receives 404; the Muse hook smoke then fails because the expected request log was never created. This is a harness/adapter contract mismatch, not a live-provider test. Do not report these smoke checks as green until the local stub is updated and rerun.
