# Third-party notices

## Brainwires/jevwire (MIT; upstream source)
Jeverb is a separate continuation of the JevWire source. The original project
is maintained at [Brainwires/jevwire](https://github.com/Brainwires/jevwire).
The MIT copyright and permission notice is retained in [`LICENSE`](LICENSE).
This repository's npm package is named `jevwire` for compatibility; it is
distinct from the upstream scoped npm package `@brainwires/jevwire`.

## 7hemas7er/jev-hooks (MIT)
Review lanes (BLOCK, SECURITY REVIEW, NITS, MERGE), checks/policy calibration
methodology, and deterministic detector escalation approach. Upstream
`config/checks.json` calibration note: changing instructions, criteria, or
choice option order invalidates question calibration fits. Thresholds in
`config/review/policy.json` are placeholders pending a Jev 1.14 benchmark, not
a verbatim copy of upstream tuned values.

## DarioFontanel/jev-claude-code (MIT, via jev-hooks)
Original question set and lane concept from which jev-hooks derives, as
recorded in upstream jev-hooks THIRD_PARTY_NOTICES.md.

## merijjeyn/jive (MIT)
Graph execution pattern: validated DAG, dependency ordering, bounded retries,
per-node authorization seam. Jeverb's `src/graph/executor.ts` is an
independent port behind an `Authorizer` interface; Jive's standalone agent,
providers, and TUI are not included. Upstream executes shell via
`spawn("bash", ["-c", script])`; Jeverb requires authorization before any
node runs so graph execution cannot bypass Muse hooks.
