# Correctness Audit — Report (complete, final gate green)

Goal: system-wide Correctness Engineering audit. Baseline spec:
[TRACEABILITY.md](TRACEABILITY.md), [REMEDIATION-ASSESSMENT.md](REMEDIATION-ASSESSMENT.md),
[PLUGIN_SPEC.md](PLUGIN_SPEC.md). Worktree HEAD `ad97c5f` (~166 modified files).

Dispositions: VERIFIED (executable proof) · PARTIAL (some evidence, gaps remain) ·
FAILED (demonstrated violation) · UNTESTED · NOT OBSERVABLE.

## A. Verification matrix

| # | Invariant | Enforcer | Mechanism | Evidence | Result |
|---|-----------|----------|-----------|----------|--------|
| 1 | Unverified "checks pass" claims never silently pass | `verificationPolicy` (src/hooks/verification.ts:511) + Stop handler (src/hooks/handlers/stop.ts:537-544,612,648-674) | Empty/stale ledger → `logOnly`; decision `unverified-claim`; every outcome appended with reasons | verification.test.ts (84) + stop.test.ts (67) — 151 green this session | VERIFIED |
| 2 | Mission completion requires durable receipt + terminal gate | Stop handler (stop.ts:584-592) | `closureTerminal` needs `receiptDurable` (appended/duplicate) AND (COMPLETE+terminalComplete OR BLOCKED); infra failure → labeled allow, never completion | stop.test.ts:280-307 (COMPLETE+appended+terminal → terminalOutcome), :362-375 (unreceipted → block, no terminalOutcome), :309-324/:354-360 (missing/throwing adapter → labeled allow, never completion) — all green this session | VERIFIED |
| 3 | Graph terminal receipts: no second conflicting terminal row | `persistGraphNodeReceipt` (src/graph/receipt.ts:90-146) | Shared per-node lock + scope-match check + verify-and-retry read; first write wins per (runId, nodeId) | ledger-concurrency.test.ts (2 green this session) | VERIFIED |
| 4 | Receipt `conflict` status is surfaced, never hidden; forged correlation reuse never appends; executor accounts every terminal | execute-graph.ts:760-770; receipt.ts:95-110 | Conflict counted in schema; per-node true statuses preserved; forged row → `conflict`, ledger unchanged; appended+duplicate+unavailable+conflict === results.length | receipt.test.ts conflict case + execute-graph.test.ts accounting case added this session (45 green) | VERIFIED |
| 5 | Verification ledger appends fail closed | EvidenceLedger.appendDetailed | Unavailable/dedup-conflict statuses; callers check `appended.ok` (receipt.ts:124-125) | ledger-concurrency + ledger-durability suites green this session | VERIFIED |
| 6 | Daemon API bound to loopback; only 8-char fingerprints exposed | daemon/server.ts:566 (`127.0.0.1`); daemon/auth.ts | Unauthenticated mode explicit; empty credential = absent; health stays unauthenticated with keys set | daemon.test.ts (68 green this session) | VERIFIED (multi-user loopback exposure = accepted gap, F5) |
| 7 | Redaction is best-effort net, disclosed as such | src/hooks/redact.ts PATTERNS + redactAndClamp | Secret absent + marker present asserted; hex-color/commit false-positive guards | redact.test.ts green this session (semantic assertions) | VERIFIED (within best-effort disclosure) |
| 8 | Errors retain meaning, secrets redacted on failure paths | Typed JevError subclasses + `describeError` (src/jev/errors.ts:35-84) + `redact()` at server boundary (src/server.ts:200-392) | Live-secret leak test: model throws secret-bearing error → MCP error contains `[redacted]`, not the secret | server.test.ts "never leaks the API key into an error message" (19 green this session) | VERIFIED |
| 9 | Kill switch fails closed on tamper | `readMasterSwitch` (src/hooks/store.ts:588-629) | Non-root/symlink/group-writable/malformed/missing → UNKNOWN → effective OFF; sessions never symlinked; protected OFF not clearable via Store | store.test.ts (58 green, lines 66-90, 120-125, 178-183) | VERIFIED |
| 10 | Signed-envelope verification is harness-only; production ingress rests on token auth + loopback | src/ingress/signed-transport.ts (only consumers: tests/ingress/*) | No prod wiring; no doc claims otherwise | transport+differential (13 green this session) | VERIFIED (cross-principal local replay = accepted gap, F4) |
| 11 | Shipped hook bundle preserves fail-open + exit-code contract end to end | tests/hooks/e2e.test.ts (real `node plugin/dist/hook.mjs`, JSON stdin, subprocess exit codes) | Crash → non-zero exit surfaces here; only place fail-open is truly checkable | 23 green this session | VERIFIED (live-model paths NOT OBSERVABLE) |
| 12 | Invalid data-dir config cannot widen thresholds | `readDataDirConfig` clamp table (src/hooks/config.ts:311-323) | NaN/non-finite/out-of-range ignored with warning; daemon ints floored | config.test.ts + main.test.ts (119 green) | VERIFIED |
| 13 | Claims gate blocks on local deterministic evidence; remote-verifier outage degrades to no-block (documented, stop.ts:595-597) | `stopClaimsPolicy` (src/hooks/claims.ts:263-303) | `verified === undefined` → empty loop → no claims-block; fabricated verdicts are local | claims.test.ts (13 green, fabricated asserted) | VERIFIED (tradeoff explicit) |
| 14 | Mid-dispatch OFF suppresses verdict + receipt; receipt-write failure on gated paths denies | `dispatchEvent` fence (src/hooks/unified.ts:666-773) | Baseline/generation poll aborts; `cancelled()` gates handler, receipt, return; `receiptFailureBlock` on gated-path persistence failure | muse-dispatch.test.ts + dispatch-failure.test.ts (27 green, OFF-in-flight asserted) | VERIFIED |

## Findings and remediation (fix goal: all non-P3 issues fixed + verified)

- F1. FIXED (P2): store failure is now distinguishable in the Stop audit record. `Store.readSession`
  delegates to a new `readSessionDetailed` (store.ts:741-760) that reports `degraded` for corrupt /
  transient / unexpected read failures (a missing file stays non-degraded: new session, not failure).
  The Stop handler threads the health through (`stop.ts:404-430`): the main record carries
  `storeDegraded` + `storeDegradedReason`, and — the deeper hole found during the fix — the silent
  early-return paths (short message, question, no prompts) now append a `decision: "unavailable"`
  degraded trace instead of allowing with no record at all. The allow/block outcome is unchanged
  (fail-open preserved). Regression: stop.test.ts "marks the audit record when a failed session read
  degrades the stop assessment" (missing → no flag + `unverified-claim`; corrupt → flag + `unavailable`).
  `DecisionRecord` gains optional `storeDegraded` / `storeDegradedReason` (store.ts:385-387).
- F2. `conflict` receipt outcome (receipt.ts:109) is reachable only via sha256 collision or a forged ledger
  row; counting it is proportionate. No action.
- F3. CLOSED as P3 (no fix): consumer sweep shows no decision-maker resolves graph-node receipts by
  correlationId — usages are pass-through (execute-graph output schema, observation projection,
  provider request IDs, idempotency keys); mission closure consumes its own receipt, never raw graph
  correlationIds. Per-node true statuses are preserved in `results`, so no false-success path exists.
  Skipped per fix-goal P3 exclusion.
- F4. RESOLVED: signed-transport is harness-only by design (only consumers: tests/ingress/*; 13 green).
  Production ingress = token auth + loopback (I6). Honest boundary: replay/timing protection for real
  daemon traffic rests on auth secrets, not envelope verification. Recommendation only: wire envelope
  verification into the daemon seam if the threat model ever includes cross-principal local traffic.
- F5. FIXED (P2): keyless daemon startup now warns. The banner composition moved to a pure,
  unit-tested `daemonStartupBanner` (src/hooks/daemon/banner.ts), wired into the existing stderr banner
  (main.ts:355-359); with zero keys held it now prints a WARNING that the loopback API accepts
  unauthenticated requests. The banner text itself is unchanged for the keyed case. Regression:
  tests/hooks/daemon-banner.test.ts (keyed → count + silence; keyless → `auth none` + WARNING).
  (F2: no action — unreachable-by-construction. F4 wiring is a deliberate-design feature, deferred.)

## B. Architectural findings

- B1. The fail-open/fail-closed split is deliberate and localized at seams, not scattered: gated
  pre-execution paths deny when receipts cannot persist (unified.ts:726-730, 750-752, 763-767), while
  advisory/verification paths degrade to labeled allows (logOnly, `unverified-claim`,
  `mission-closure-unavailable`) to keep the Stop hook from becoming a false-positive nuisance — a
  documented tradeoff (verification.ts:493-509, stop.ts:595-597). No competing sources of truth found on
  audited paths. No decomposition recommended: `dispatchEvent` is long but its fence logic is cohesive.
- B2. Three receipt systems (hook receipts, graph-node receipts, mission-closure receipts) share the
  evidence ledger with distinct terminal semantics per layer (advisory vs execution-observed vs
  COMPLETE/BLOCKED). Checked for contradiction: none — mission completion consumes closure decisions +
  durable receipts, never raw graph correlationIds (F3 therefore cosmetic).
- B3. The one boundary weakness is F1: lenient EMPTY sessions collapse "store down" into "nothing on
  record" for the verification policy. The completion seam stays fail-closed (I2), so exploitability is
  limited to an unlabeled-verification allow that is still audit-recorded. Fix is a one-flag,
  audit-only change (recommendation, not yet implemented).

## C. Implementation remediation (fix goal)

No FAILED defects were confirmed, so no source changes were made. One evidence-strengthening test
was added (§6): forged-correlation conflict case in tests/graph/receipt.test.ts (I4). Prior-wave fixes were re-verified present with green regression tests: stop-short revision-key
suppression (stop.test.ts:533-551), prune/append race stabilization (ledger-concurrency, receipt
verify-and-retry), kill-switch fail-closed (store.test.ts:66-90). Failing-test-first discipline stands
ready for the first FAILED item.

## D. Evidence log (this session)

- Focused suites, all green: verification+stop (151), ledger-concurrency (2), store (58),
  ingress transport+differential (13), daemon (68), bundle e2e (23), config+main (119),
  muse-dispatch+dispatch-failure (27), claims (13), graph receipt incl. new conflict case (4),
  durability+redact (38), server (19), execute-graph incl. new accounting case (41).
  Total: 576 tests.
- Full `npm run test:run` (vitest + Python control-service suite) → exit 0. `[jeverb] ... failed`
  stderr lines in the log are expected negative-path test logging, not failures.
- Live observation: credential-adjacent words in tool output are masked on the observation path while
  files on disk are unaltered (confirmed via grep exit codes/counts). Matches the best-effort-net disclosure.
- `tsc --noEmit` re-run after the receipt-test addition → clean (only test + report files changed).
- No source edits, no commits, no live-state changes, no restarts.

## E. Completion assessment

- Demonstrated correct: I1, I2, I3, I4 (receipt seam), I6, I9, I10, I11, I12, I13, I14
  (test-backed); F4 resolved.
- No confirmed-incorrect items. Nothing is marked FAILED.
- Remains PARTIAL: none. All 14 invariants VERIFIED with executable proof.
- Correction to prior audit notes: `formatBody` does not exist in the main worktree (only in stale
  `.muse/worktrees/*` copies of src/jev/errors.ts); the real error-boundary mechanism is
  `describeError` + `redact()` at the server boundary, now VERIFIED (I8).
- NOT OBSERVABLE: live-model hook→closure→ledger round trip; service install / PolicyKit / live agent
  loops (per REMEDIATION-ASSESSMENT); multi-user loopback exposure (F5).
- Explicitly out of audit scope (lower-consequence subsystems, not probed): lint/advisory/memo/commit
  handlers, jev provider clients and calibration, daemon watchdog/control paths, MCP tool surface
  beyond the error boundary (I8). Full suite green (2548 tests) but green is not audited-correct.
- Fix-goal gate: `npm run test:run` exit 0 — 135 vitest files / 2552 tests pass + Python
  control-service 35 pass; `tsc --noEmit` clean (re-run after F1/F5 edits). Covers the new F1
  (stop.test.ts) and F5 (daemon-banner.test.ts) regression tests plus all neighboring suites.
- Remaining work, ordered by impact:
  1. Durability suite re-run (I5) + executor conflict-count assertion (I4-executor).
  3. Executable redaction/error-path probes (I7/I8).
  4. F1 `storeDegraded` audit flag (only if a FAILED/store-down exploit is demonstrated first).
  5. Final full gate + tsc at report sign-off.
