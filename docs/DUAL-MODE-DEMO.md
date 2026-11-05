# Integrated Jev demo

The demo has three modes. Deterministic and live advisory modes share the v2
eight-case prompt set and production graph runner. Replay mode reads the raw
November 3 live artifact and performs no inference.

## Deterministic demonstration

```sh
npm run demo:deterministic -- --output /tmp/jev-demo-deterministic.json
```

The model evaluates only advisory questions. Host policy separately admits a
fixed, local `source.csv` to `summary.json` task. The task graph produces the
summary, runs independent digest and field checks, and joins only after both
checks succeed. A host file-state verifier persists a receipt bound to the
producer and candidate. The mission contract then passes through the real
closure runner and Stop handler. Closure judgment uses a deterministic demo
fixture, so this exercise demonstrates lifecycle wiring without qualifying
semantic mission closure.

The runner also mutates the produced bytes after the producer receipt and
submits a false completion claim. The independent verifier records failure,
closure returns INCOMPLETE, and Stop blocks. A separate shell attempt writes
partial bytes and is killed; the runner reconciles its journal and same-run
resume must be blocked without another attempt. A privileged command is
refused before execution.

Run only where the graph runner's Bubblewrap confinement probe passes. The
runner fails closed if shell isolation is unavailable. A result with failed or
blocked task nodes is an inconclusive environment run, not a passed demo.

## Historical replay; no inference

```sh
npm run demo:replay -- --output /tmp/jev-demo-live-replay.json
# Or specify a different original schema-v1 artifact:
npm run demo -- --mode replay --input /path/to/original-live-run.json
```

Replay defaults to `/tmp/jev-demo-live-advisory-2026-11-03.json`, hashes the
source bytes, and leaves them unchanged. It embeds the source result under
`historicalResult`; the separate reviewed report at
`/tmp/jev-demo-live-advisory-2026-11-03-reviewed.json` is postprocessed and is
not presented as raw output. The historical artifact recorded 8 requests,
4,427 input tokens, 444 output tokens, and returned
`typesafe/jev-1.14-20261014` from `jev-gateway`.

Provenance fields are deliberately separate. The local Jev gateway request
used configured model `typesafe/jev-1.14`. The operator reports that the
gateway uses OpenRouter and that the desired upstream alias is
`typesafe/jev-latest`; the historical response does not independently prove
the upstream provider or alias. The returned dated model ID is recorded as
the returned model. It is not copied into a separate deployed-version field.

## Live advisory mode

Preflight makes no request:

```sh
npm run demo:live-advisory
```

The command requires explicit approval for the provider, configured model,
endpoint, request cap, and budget attestation before it can call the provider.
Live answers stay advisory. They do not select or authorize the host's fixed
task graph. There is no retry or fallback; the call cap is eight and calls are
serialized. Do not run live mode without a fresh, explicit budget approval.

## Result interpretation

The result records model advice, host policy, actual graph node statuses,
independent verification, closure, false-claim handling, uncertain execution,
and refusal separately. Every case includes fixed reference labels; those
labels and internal case IDs are absent from model-visible instructions and
executor state. The choice schema lists the allowed answer labels, as required
for classification, without identifying the expected answer.

Consequential routing, mission closure, installed-host enforcement, and
production readiness remain unqualified by this demo. The November 3 live
artifact predates the v2 case set and is historical evidence only.
