# Failure Engineering — Reproduction Evidence and Mechanism Analysis

This report preserves the original failure reproductions and source analysis. The current
disposition register is [REMEDIATION-ASSESSMENT.md](REMEDIATION-ASSESSMENT.md); the initial
assessment and its measurements below predate several corrections and are not the current
repository status. Original reproducers ran in isolated `/tmp` harnesses.

The original failure hypotheses remain useful for provenance, but apply their current
dispositions only from the canonical register.

## A. Executive Failure Assessment

- **FM-1 — torn ledger tails:** the original reproduction showed that a partial final JSONL line
  made all readers fail closed. `EvidenceLedger.repair()` now recovers only `corrupt-truncated`
  tails while preserving valid prefix bytes; mid-file corruption remains manual and fail-closed.
  Rewrite failures now clean temporary files, and daily maintenance reaps only provably dead
  owners' crash-orphaned atomic-write temps.
- **FM-2 — ledger growth:** the original measurements remain valid as a historical performance
  curve (145ms @10k records to 8.8s @200k / ~128MB). The claimed live-lock takeover consequence
  was incorrect: `ownerAlive()` checks process liveness after the stale age, so a slow live owner
  is not stolen. Daily retention now has production callers and defaults to 365 days / 100k
  records. Per-installation growth rates and latency under unusually large bursts remain unknown.
- **FM-3 — async lock wait:** the deadline is checked at the top of every acquisition iteration;
  the current bounded-wait regression passes.
- **FM-4 — daemon takeover race:** after SIGTERM, termination now probes the port owner again
  before SIGKILL and skips escalation when a foreign listener, a different daemon PID, or a
  dead target is observed. `tests/hooks/daemon-termination-race.test.ts` reproduces the former
  SIGTERM→SIGKILL sequence and now observes SIGTERM only; the existing hung-daemon replacement
  test still passes. PID-only signaling cannot atomically prevent reuse between the final check
  and the signal; this residual is limited to that OS-level window.
- **FM-7 — graph journals:** daily cleanup now retains malformed, pending, uncertain, and
  active-mission journals. Reaping is per-run-lock serialized and bounded by file and byte caps.
- **G-1/G-2:** corrupt reason and byte offset reach the denial site. Daemon health stays
  liveness-only because per-installation ledgers are outside its ownership; see the accepted
  risk in the canonical register.

## B. Failure Mechanism Register

The rows describe the initial hypotheses and proposed corrections, not current dispositions.
FM-1, FM-2, and FM-3 were implemented; the current evidence and retained risks are summarized
above and tracked in the canonical register.

| ID | Sev | Subsystem | Trigger | Root cause | Propagation | Invariant | Evidence | Conf. | Remediation |
|----|-----|-----------|---------|------------|-------------|-----------|----------|-------|-------------|
| FM-1 | P1 | evidence ledger (`src/evidence/ledger.ts`) | Machine crash / SIGKILL mid-append (any non-durable write; durable writes can also tear) | JSONL has no record framing or checksum; a torn tail poisons all subsequent reads; no trim/repair API; `prune()` cannot fix invalid JSON | `read()` → `corrupt-truncated` → all consumers (`graph/receipt.ts:94,132`, `mission/receipt.ts:146`, `mission/closure.ts:1136`, `decision/loop.ts:257`) fail closed permanently; Stop/mission completion impossible; hook evidence unavailable → gated pre-exec denies | Recovery must produce a valid or explicitly repaired state; availability on crash | REPRODUCED `/tmp/torn-tail.ts`: valid append ok → torn tail planted → `read` returns 1 record + `corrupt-truncated@654` → graph receipt `unavailable` → `prune({maxCount:100000})` keeps 2 lines, still corrupt (`corrupt-record`) | REPRODUCED | Add explicit `EvidenceLedger.repair()` (truncate at first corrupt offset via temp+rename, maintenance-only, never automatic in hooks); surface corrupt offset/reason in deny reasons; regression test torn-tail → unavailable → repair → clean |
| FM-2 | P2 | evidence ledger growth + `store-lock.ts` takeover | Months of hook events on a busy machine (~150k records / ~100MB) | No production retention caller for `EvidenceLedger.prune()` (only tests call it) + full-file parse per `read()` + fixed 5s `LOCK_STALE_MS` | Slow critical sections under per-node/per-ledger locks → contender takes over stale lock → concurrent read-modify-write → lost session updates / duplicate terminal rows (I3 violation at extreme size) | Exactly-once projection; lock mutual exclusion while holder is alive | PROBABLE: measured `/tmp/ledger-bench.ts` (145ms@10k, 665ms@50k, 2213ms@100k, 8848ms@200k) + source (zero prod `prune` callers) | PROBABLE | Production retention (e.g., watchdog-enforced maxCount/maxAge) and/or streaming read path; regression benchmark gate on read time vs fixture size |
| FM-3 | P3 | `withFileLockAsync` (`src/hooks/store-lock.ts:56-85`) | Unwritable-but-statable lock dir + contention (exotic) | Deadline checked only in the ownerAlive-true branch; tryMkdir-false + ownerAlive-false + failing rmSync loops forever, ignoring abort signals. Sync `acquire()` checks the deadline every iteration — the async variant does not | Hung hook process (graph run lock is the sole caller, `execute-graph.ts:354`); unbounded hang, one process | Bounded waits; lock attempts must terminate | SOURCE-CONFIRMED by inspection; prerequisites not demonstrated | Move deadline check to loop top (mirror sync `acquire`); unit test with unwritable dir |
| FM-4 | P3 | daemon `replaceDaemon`/`terminate` (`src/hooks/daemon/control.ts:396-413,323-335`) | Stale daemon exits AND foreign process binds the same port inside the probe→kill window (ms) | pid↔port binding not re-verified between the fresh probe in `replaceDaemon` and `terminate`; SIGKILL escalation keys off port-held, which may then be a stranger | SIGTERM/SIGKILL to a same-UID process holding a wanted port; bounded, no privilege issue | No action against non-owned processes | HYPOTHESIS with mitigation: `replaceDaemon` re-probes before killing; `silent` path refuses strangers and re-probes at 1s | Chaos handoff candidate; no code change proposed in this phase |
| FM-5 | — | SubagentStop store-contention path | Lock-unavailable/corrupt session during `dropSubagentTask` (pre-try throw) | `updateSession` throws on failed commit | Caught by `dispatchEvent` catch → error receipt → fail-open allow; task record survives but TTL (30min) + `MAX_SUBAGENT_TASKS` cap the leak | Fail-open with trace | DISPROVEN as defect: contained by design (dispatch catch + error receipt + TTL cap) | None |
| FM-6 | — | memo cache (`src/hooks/memo.ts`) | Identical evaluation request within 5min TTL | Key = sha256 over full model+state+questions; hits are genuine duplicates; receipts carry `memo` flag | Same verdict reused; attributability preserved | No false success from caching | DISPROVEN as defect | None |
| FM-7 | P3 | graph journals (`dataDir/graph-journals/`) | Years of runs; small disks | No journal cleanup anywhere; journals are write-once/read-for-reconcile | Disk pressure → ENOSPC → fail-closed denies; stale journals cannot confuse resume (fresh runs refuse colliding journals; resume validates runId/graphHash/policyHash/malformed) | Bounded resource use | SOURCE-CONFIRMED (no cleanup callers; resume validation verified) | Optional retention for journals |

## C. Architectural Failure Analysis

- **Common-mode mechanism:** every evidence consumer shares one failure mode — `LedgerRead.corrupt`.
  One torn tail remains a single point of denial until an operator invokes the explicit repair
  API. That is intentional fail-closed behavior; repair does not run automatically in hook paths.
- **Fail-closed with bounded recovery:** session writes never synthesize over corrupt state;
  ledger reads report corruption rather than empty; gated receipt gaps deny; and mission closure
  downgrades undurable completion. `EvidenceLedger.repair()` now supplies the explicit maintenance
  path for torn tails while refusing mid-file corruption.
- **Shared-state hazards, checked:** session read-modify-write is lock-serialized per session;
  decision-log rotation happens under the per-ledger lock; daemon spawn is serialized by
  `withLock` with re-probe under the lock; graph runIds are exclusive via run lock with
  journal-identity validation on resume. No lock-order inversion found (single-lock disciplines,
  no nesting across lock names except prune-under-ledger-lock which is leaf-only).
- **God objects:** `dispatchEvent` (`unified.ts:666-773`) is long but its fence logic is cohesive
  (baseline B1 stands). `Store` is broad (sessions, log, locks, switch, tasks) but each method
  is independently locked and tolerant/transactional as appropriate — breadth without shared
  mutable state across methods. No decomposition recommended.
- **Recovery paths:** `prune()` is not a corruption repair; `repair()` is. Both ledger rewrites
  use the shared atomic replace primitive and clean temp files on handled failures. Daily temp
  cleanup uses the shared PID/timestamp contract. Daemon restart/replace paths are careful
  (port-is-authority, re-probe under lock, stale criteria on protocol/bundle/keys). Resume paths
  validate identity before trusting prior outcomes.

## D. Reproduction Evidence

- **REPRODUCED — FM-1 torn-tail wedge** (`/tmp/torn-tail.ts`, tsx, isolated dir):
  `append valid durable: true` → torn tail planted → `read records: 1, corrupt: {offset:654,
  reason:corrupt-truncated}` → `persistGraphNodeReceipt → {status:unavailable,
  reason:evidence ledger is corrupt}` → `prune({maxCount:100000}) kept: 2` →
  `read after prune corrupt: {reason:corrupt-record}` (wedge persists; prune converted the
  framing failure, not the invalid JSON). Matches the proposed causal chain exactly.
- **Measured — FM-2 growth curve** (`/tmp/ledger-bench.ts`): 10k/6.4MB/145ms,
  50k/32MB/665ms, 100k/64MB/2213ms, 200k/128MB/8848ms — superlinear; the 5s takeover
  threshold falls between 100k and 200k records.
- **SOURCE-CONFIRMED — FM-3** (`store-lock.ts:62-79` vs sync `acquire` lines 131-156, which
  checks the deadline every iteration); sole caller `execute-graph.ts:354`.
- **SOURCE-CONFIRMED — FM-7** (no journal cleanup callers; resume validation at
  `execute-graph.ts:435-462` refuses colliding/foreign journals).
- **DISPROVEN — FM-5** (dispatch catch + error receipt + TTL cap contain it), **FM-6**
  (key binds full request; `memo` flag preserves attributability).
- **HYPOTHESIS — FM-4** (window narrowed to ms by re-probe; needs a foreign binder in-window).
- **NOT OBSERVABLE in this pass:** live-host crash behavior (power loss, OOM-killer timing),
  multi-process lock contention at scale, real-world ledger growth rates per installation.

## E. Original Remediation Plan (Historical)

This was the plan at the time of the initial read-only pass. Its completed work is recorded in
source and regression tests; the canonical register holds current dispositions.

1. **FM-1 (P1):** add `EvidenceLedger.repair()` — truncate at first corrupt offset via
   temp-file + rename + fsyncs, callable only from explicit maintenance flows (never automatic
   in hooks; never silent). Surface `LedgerCorrupt` offset/reason in `receiptFailureBlock`
   reasons and Stop deny reasons (closes G-1 for the corrupt case). Regression tests:
   torn-tail → `unavailable` → `repair()` → clean read + successful append; prune-still-corrupt
   case. Verification: repro harness green; full gate green. Risk: truncation discards the torn
   record (partial by definition) — acceptable; never truncate past valid records.
2. **FM-2 (P2):** enforce production retention for `evidence.log` (preferred owner: daemon
   watchdog or an explicit maintenance command; e.g. `{maxCount, maxAgeMs}` config with
   conservative defaults) and add a read-time benchmark gate to prevent regressions. Risk:
   retention must never delete evidence a pending closure/reconcile needs — prune is
   oldest-first and retention windows must exceed mission lifetimes; document the bound.
3. **FM-3 (P3):** hoist the deadline check to the top of the `withFileLockAsync` loop;
   unit test with an unwritable lock dir asserting `locked:false` within `LOCK_WAIT_MS`.
4. **FM-7 (P3, optional):** journal retention (age/count cap) for `graph-journals/`.
5. **G-1/G-2 observability:** add ledger-readiness (writable? corrupt?) to daemon state and
   `/v1/health`; include corrupt offset in user-facing deny reasons. Verification: health
   reflects a planted torn tail within one poll interval.

## F. Chaos Engineering Handoff

1. **Torn-tail injection (validates FM-1 remediation):** hypothesis — after `repair()`
   exists, a truncated final line degrades one append then recovers. Target: isolated
   `EvidenceLedger`. Fault: truncate file mid-line. Expect: `corrupt-truncated` reported,
   repair restores clean reads. Indicators: `read().corrupt`, receipt statuses.
   Isolation: `/tmp` dir only. Abort: delete harness dir.
2. **Ledger-growth contention (validates FM-2 bound):** hypothesis — retention keeps reads
   under the takeover threshold indefinitely. Target: ledger + per-node locks. Fault:
   pre-grown ledger (synthetic records) + concurrent receipts. Expect: no takeover, no
   duplicate terminal rows. Indicators: lock-takeover log lines, duplicate counts.
   Isolation: `/tmp`, bounded record counts. Abort: timeout cap.
3. **Stale-daemon replacement race (tests FM-4 window):** hypothesis — no signal reaches a
   non-daemon process. Target: `ensureDaemon`/`replaceDaemon` on a test port. Fault:
   bind a foreign HTTP server on the port mid-replacement. Expect: `conflict`, no kill of
   the foreign pid. Indicators: `conflict` result, foreign process alive. Isolation: test
   port, synthetic daemons only. Abort: kill spawned test processes.
4. **Lock-dir permission failure (validates FM-3 fix):** hypothesis — contended async lock
   returns `locked:false` within budget instead of hanging. Target: `withFileLockAsync`.
   Fault: read-only lock dir + contender. Expect: bounded `locked:false`. Indicators:
   elapsed time < `LOCK_WAIT_MS` + margin. Isolation: `/tmp`. Abort: timeout cap.

## Current Dispositions

The [canonical remediation register](REMEDIATION-ASSESSMENT.md) owns all current audit
dispositions. This evidence report intentionally does not duplicate that status table.

## Open threads (explicitly not claimed)

- Real-world per-installation ledger growth rates and maintenance latency under unusually large bursts.
- Live-host crash and OOM-killer behavior; multi-user loopback exposure (not qualified by local tests).
