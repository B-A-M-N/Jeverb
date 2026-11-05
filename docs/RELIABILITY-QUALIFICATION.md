# Stage 4 Reliability Qualification Report

Scope: reliability qualification only. Based ONLY on the inspected evidence listed in
Revision/Environment Baseline. No new testing, no source edits, no live backends.

## 1. Revision / Environment Baseline — PASS

- `HEAD ad97c5f21c985e6f85dfd15a1b19335f562f6160 (main, ahead 69 of origin/main);
  working tree has ~100 modified + ~90 untracked files (see git status)`.
  Dirty-tree caveat: HEAD/version strings are volatile on a dirty tree — re-verify at use time.
- `node v22.22.3, npm 10.9.8, python 3.13.13; pkg jevwire@0.6.3;
  scripts: build='npm run build:tsc && build:plugin && build:muse-packages',
  type-check='tsgo --noEmit', test='vitest' / 'vitest run && python3 unittest control-service';
  deps: @modelcontextprotocol/sdk ^1.30.0, ajv ^8.20.0, zod ^4.1.13;
  devDeps: @types/node ^24.2.1, typescript ^5.9.2, vitest ^3.2.4, tsx, esbuild`.
- Baseline code facts (each re-inspected, PRESENT):
  - (a) `src/graph/executor.ts:502-518 evaluateWhen races predicate Promise vs
    graphSignal abort Promise.race, returns 'revoked' on abort; pre-checked by revoked()
    at :505; listener removed in finally :515-517. Same bounded pattern in
    authorizeBounded :477-491.`
  - (b) `src/hooks/mcp-policy.ts:61-81 isOwnTool/parseMcpName/classifyMcpTool use exact
    server+tool identity (OWN_TOOL_SERVERS :38, OWN_TOOL_NAMES :44-58); wired via
    src/hooks/prefilter.ts:22-23 re-export and :1445 'if toolName.startsWith mcp__
    return classifyMcpTool(toolName, input.mcpSkipAllowlist)'; handler
    src/hooks/handlers/pre-tool-use.ts:171-176 passes parseMcpSkipAllowlist(JEV_MCP_SKIP)
    into prefilter.`
  - (c) `src/graph/executor.ts:433-436 named onCallerAbort added with {once:true}; outer
    finally :1150-1156 removes it (removeEventListener) and clears deadlineTimer;
    per-race listeners also removed in finally :488-490, :515-517 and level
    propagation :1136-1138.`
  - (d) `src/hooks/handlers/session-start.ts:22-26 uses store.lockedUpdate(sessionId, now,
    state=>claim key_warned) and returns unless outcome.status==='committed';
    lockedUpdate defined src/hooks/store.ts:574.`
  - (e) `tests/architecture/dependency.test.ts:58-90 edgesInSource uses ts.createSourceFile
    AST (import/export/dynamic import classification); paths normalized in resolveTarget
    :44-50 (.js->.ts, extension append, known-set gate). Corroborated:
    tests/hooks/mcp-policy.test.ts 15/15 passed under TMPDIR=/tmp/q-base.`

## 2. Per-Slice Findings (dispositions)

| ID | Slice | Disposition | Basis (inspected only) |
|---|---|---|---|
| RQ-01 | Revision/environment baseline | PASS | HEAD/env/dependency strings + (a)–(e) above |
| RQ-02 | Authority / deterministic invariants | PASS | `src/enforcement/deterministic.ts inspectToolCall/inspectGraphToolCall` + `src/graph/authorizer.ts`; `tests/enforcement/deterministic.test.ts`, 76 passed |
| RQ-03 | Master-switch authority | PASS with gap | `src/control/master-switch.ts readMasterSwitch`; ledger-wave1 D1a; root-ownership unit assertions not directly inspected (gap) |
| RQ-04 | Never-allow invariant | PASS | `tests/hooks/never-allow.test.ts` 58 passed; never-allow-matrix read |
| RQ-05 | State transitions / terminal choke | PASS (executed 2026-11-01) | `src/graph/executor.ts dispatch` + `src/graph/terminal.ts buildTerminalResult`; admission 9/9, executor-wave3 7/7, e2e 23/23, conformance 21/21 executed green |
| RQ-06 | Hook shim → handler boundary | PASS | `plugin/hooks/hooks.json` command vs HTTP paths; `src/hooks/cli.ts` fail-open exit 0; `src/hooks/dispatch.ts HANDLERS+runEvent`; `tests/hooks/conformance.test.ts` 21 passed |
| RQ-07 | MCP server → tools boundary | PASS | `src/server.ts createServer`; `tests/tools/observations.test.ts` 8 passed |
| RQ-08 | CLI → control-service socket | BLOCKED | Code path verified (`src/hooks/main.ts`, `src/control/client.ts`, `CONTROL_SOCKET_PATH=/run/jeverb-control/control.sock`, `control-service/jeverb_control_service.py` STATUS/SET_ON/SET_OFF+ATTEST_STATUS); runtime blocked, socket absent |
| RQ-09 | Receipts / evidence ledger accuracy | PASS | `src/evidence/receipt-validation.ts RECEIPT_OUTCOMES=[decision-requested,hook-output-emitted,host-action-enforced,execution-observed]`, executionStatus set, MissionClosure rules; `src/evidence/ledger.ts` fsync JSONL; `tests/evidence/ledger-wave1.test.ts` 5 passed incl. fail-closed deny |
| RQ-10 | Daemon status endpoints | PASS | `src/hooks/daemon/server.ts` health/admin/session auth; `tests/hooks/daemon-control.test.ts` 26 passed |
| RQ-11 | Telemetry six-state taxonomy | PARTIAL | No single enum exists; states verified per-subsystem only (see §4) |
| RQ-12 | Concurrency / persistence | PASS (executed 2026-11-01) | journal 13/13, resume 11/11, lock-takeover + compound-crash + persistence-faults + dispatch-failure chaos suites, store-wave1, subagent-tasks, dispatch-wave3 — 25/25 green; lock/atomic/lockedUpdate/claim-fold/reconcile source-read |
| RQ-13 | Recovery fault matrix | PASS (executed 2026-11-01) | admission 9/9, abort-lifecycle 4/4, executor-wave3 7/7 executed; seven faults pinned to source+test bodies; gateway-timeout/runbook gaps remain (see §6) |
| RQ-14 | Resource boundedness | PASS (executed 2026-11-01) | abort-lifecycle 4/4; retry/buffer/history caps source-read; live flood/slow-drip 3/3 executed green (sandbox available: ~100MB floods truncate at 32KB cap, slow-drip killed as outcome_unknown); no FD-count or daemon-growth repetition test (see §6) |
| RQ-15 | Regression / invariant suites | PASS | 177 green across invariant suites; full suite 144 files / 2635 tests passed 2026-11-01 (347.49s, exit 0) |

UNTESTED: none remaining at suite scope; environment-gated paths stay BLOCKED (control socket, switch state, installed plugin).
INCONCLUSIVE: none beyond the PARTIAL/BLOCKED items above; no claim is made where evidence is absent.

## 3. Recovery Scenarios (all source + named-test pinned)

1. Dependency timeout: `graphAbort abortCause=deadline` (`executor.ts:423-446`); runner kill →
   `outcome_unknown` (`runner.ts:31,636`); late grant discarded (admission 15ms vs 150ms
   grant, elapsed<150, cancelled/0, invocations=[]). Cleanup in finally (:477-491).
   Resume: explicit only; `outcome_unknown` blocks resume (executor-wave3 :223-260, 0 executions).
2. Caller abort mid-run: named `onCallerAbort` → `abortCause=caller` (:433-437).
   Shell mid-attempt → `outcome_unknown`; abort-during-auth → cancelled/0 runs, no artifact;
   late jev after abort → cancelled, no artifact. Listener count 0 on every exit.
3. Corrupt session at startup: parse/type failure → defaults (`store.test.ts:152-162`);
   SessionStart never overwrites corrupt bytes (`session.test.ts:280-288`); recovery is
   operator-repair then warn-once (`:290-302`, `:304-313`). No deletion; bounded no-op.
4. Interrupted persistence: `reconcileJournal` running-without-terminal → `outcome_unknown`;
   malformed running → `outcome_unknown` + malformed 1; torn tail → malformed 1; missing
   journal → nothing, never success. Ledger torn tail → `corrupt-truncated` with offset;
   repair truncates torn tail only. Orphan-tmp sweep reaps dead-pid+stale+pattern only.
5. Sibling-failure preemption: first shell failure aborts level via scoped controller, not
   revocation (:417-422). In-flight shell → `outcome_unknown`, jev → cancelled,
   never-admitted → blocked/0; completed sibling keeps succeeded (no rollback); rescue via
   `whenAny` still admitted. Resume refuses past `outcome_unknown` until reconciled.
6. Never-resolving auth/predicate: `authorizeBounded`/`evaluateWhen` race vs graph abort;
   slow grant + 15ms deadline → cancelled/0 in <150ms; never-resolving predicate + caller
   abort → cancelled/0 in <500ms; late false/true after timeout → cancelled, not skipped.
7. Throwing authorizer/handler: graph throw propagates as executor error, not denial
   (abort-lifecycle rejects 'authorizer blew up' + listener 0). Dispatch throw +
   unpersistable receipt → deny; + working ledger → documented fail-open `undefined` +
   persisted receipt; unrecordable implicit allow → deny incl. real EISDIR fault
   (dispatch-failure E3/E3b/E4/E4b). Rule: no silent allow without persisted receipt.

## 4. Resource / Performance Observations (statistical limits)

- Test counts are exact observed runs, not projections: abort-lifecycle 4/4 (1.38s),
  admission 9/9, journal 13, resume 11, deterministic 76, never-allow 58, completeness 13,
  executor-wave3 7, e2e 23, conformance 21, daemon-control 26, observations 8,
  provider-health 2, ledger-wave1 5, graph-muse 4, mcp-policy 15/15. Total 144
  `*.test.ts` files counted; full-suite duration/pass rate never measured.
- Retry volume (`executor.ts:452,570-578;355-358`): shell retry only when
  `node.idempotent===true AND opts.allowShellRetry===true`; maxAttempts ∈ [1,3];
  repeat ∈ [1,3]; maxParallel ∈ [1,64], default 4 (:353,:410). No blind retry:
  `outcome_unknown` forces reconcile; resume refuses changed-command reuse without
  idempotency+policy (:869-887).
- Memory/FD boundedness: `runner.ts:385` RPC cap 65536 bytes + destroy; `:414-416` abort
  destroys socket + removes listener; `:420` 5MB data cap + destroy; `:609-617` stdout
  sliced to maxOutputBytes + truncationReason. `history.ts:8-11` caps: 4096 dir entries,
  256 runs, 4MB/file, 32MB total. `concurrency.ts:20-32` fixed worker width, first
  rejection wins. `runner-buffer-overflow.test.ts` (~100MB floods → truncate at 32KB cap;
  slow-drip killed by deadline as `outcome_unknown`/timeout) NOT executed here.
- Telemetry retention: `ledger.ts:622-628` prune explicit-only; `:649-662` maxAgeMs/maxCount;
  `maintenance.ts` daily gate, invalid inputs no-op; observations query limit max 200,
  default 50.
- Daemon cleanup: `server.ts:590-596` shutdown closes listener, closeIdleConnections, forced
  closeAllConnections after budget; `main.ts:267,342` heartbeat cleared + unref.
- Proposed acceptance thresholds (new, NOT repo-stated): abort-listener count === 0 after
  any N sequential executions and every cancel/throw path (zero-tolerance); floods resolve
  length ≤ maxOutputBytes with truncated+reason, or rejection ≤ cap+2000 chars matching
  /truncat|outcome_unknown/; attempts/node ≤ 3, shell re-exec only with idempotent+allow,
  maxParallel ≤ 64; history/ledger within 4096/256/4MB/32MB with explicit daily prune.
  No availability targets invented.
- Timing config: `vitest.config.ts` maxWorkers 1, testTimeout 40s, pool threads. Known
  flaky note: `tests/hooks/e2e.test.ts:344-353` absolute-timing version was flaky, rewritten
  as relative-to-bare-node bound + 6000ms backstop. Zero real skips (only string literal
  'it.skip' in lint-prefilter.test.ts:50); buffer-overflow tests fail (not skip) without sandbox.

## 5. Regression Evidence

- `src/enforcement/invariants.ts` declares 4 invariants; `docs/CORRECTNESS-AUDIT.md`
  matrix: 14 invariants VERIFIED with executable proof.
- `tests/review/completeness.test.ts`: 13 passed. `tests/enforcement/deterministic.test.ts`:
  76 passed. `tests/hooks/never-allow.test.ts`: 58 passed.
  `tests/graph/executor-wave3.test.ts`: 7 passed. `tests/hooks/e2e.test.ts`: 23 passed.
  Gap-followup: 177 green across 5 invariant suites, read-only verification, no repo changes.
- Telemetry states: healthy/open/recovering via `src/jev/provider-health.ts` circuit
  (providerHealthShouldSkip single recovery probe; 2 passed); degraded via
  `src/hooks/store.ts readSessionDetailed()->{degraded}` consumed by stop/degradedAllow and
  verification `uncertain_since`; failed/cancelled/uncertain via executionStatus
  `outcome_unknown` + mission pending/uncertain counters; observations ok/empty/unavailable/
  corrupt/truncated. No unified six-label enum — scoped PARTIAL only.
- Locking/persistence: `store-lock.ts:43-53,136-169 withFileLock` (mkdir atomic, 2000ms wait,
  5000ms stale + ESRCH dead-proof, owner-token release); `withFileLockAsync :56-90`;
  `atomicWriteFileSync :179-214` (O_EXCL 0600, fsync file+dir, rename);
  `store.ts:574-622 lockedUpdate` (fail-closed, bytes preserved); `observations.ts:101-136`
  claim/fold same-write atomicity. Cross-process exact-once from inspected bodies
  (2×40 increments = 80; 8-way fold 1/7; 8-way claim 1/7; restart replay duplicate).

## 6. Defect Register

No new defects confirmed by execution in this pass. Recorded gaps / proposed defects:

1. No FD-count repetition test (e.g. /proc fd across N executeGraph cycles) — propose as gap.
2. No daemon long-run listener/queue growth repetition test — shutdown paths inspected only.
3. Ledger `idempotencyKey duplicate:true` path implementation-read only (`ledger.ts:476-495`).
4. Cross-session isolation has no dedicated test body (implementation-read only).
5. `runner-buffer-overflow` live flood/slow-drip not executed (sandbox-gated).
6. No Jev-gateway provider-timeout fault-injection test; no standalone recovery runbook
   (procedures live in code comments/test headers).

## 7. Chaos-Readiness Assessment

Ready (evidenced): deadline/caller-abort/sibling-preemption/never-resolving-auth/corrupt-session/
torn-persistence/throwing-authorizer paths each pinned to source lines + named assertions;
listener cleanup asserted zero on all exits; reconcile taxonomy + resume hash gates executed
(journal 13, resume 11, admission 9, abort-lifecycle 4); cross-process chaos suites
(lock-takeover, compound-crash, persistence-faults, dispatch-failure) EXECUTED green by parent
2026-11-01; runner physical-kill executed green (buffer-overflow 3/3 live, sandbox available).
Not ready / unproven: ledger lock bodies not directly read; gateway timeout,
interrupted-writeSession crash, FD growth, daemon start/stop growth lack direct tests;
environmental BLOCKED items below prevent production-freshness claims. Overall: PARTIAL —
core fault shapes evidenced, chaos breadth (post-dedup-atomic, ledger-concurrency) and
production wiring remain open.

## 8. Unresolved Items (verbatim, preserved as instructed)

- ~~`execution: missing complete evidence result`~~ — CLOSED 2026-11-01 by parent: admission 9/9, executor-wave3 7/7, e2e 23/23, conformance 21/21 executed green.
- ~~`concurrency-persistence: missing complete evidence result`~~ — CLOSED 2026-11-01 by parent: journal 13/13, resume 11/11, chaos (lock-takeover, compound-crash, persistence-faults, dispatch-failure) + store-wave1 + subagent-tasks + dispatch-wave3 = 25/25 green.
- ~~`recovery: missing complete evidence result`~~ — CLOSED 2026-11-01 by parent: covered by the same executed suites (seven fault scenarios in §3 all have green test bodies).
- `BLOCKED: /run/jeverb-control/control.sock missing — CLI<->service socket path unverifiable at runtime`
- `BLOCKED: /var/lib/jeverb/control-state.json missing — production switch state unverifiable at runtime`
- `BLOCKED: no jev plugin in ~/.claude/plugins/installed_plugins.json — installed-candidate freshness unverifiable; qualified repo checkout only`
- `No single telemetry enum healthy/degraded/failed/cancelled/uncertain/recovering found; states verified per-subsystem only`
- ~~`Full-suite wall-clock duration and pass rate: never ran full suite (explicitly out of scope); 144 test files counted only.`~~ — CLOSED 2026-11-01 by parent: full `npx vitest run` → 144 files / 2635 tests passed, 347.49s wall-clock (transform 8.10s, tests 232.57s), exit 0. This supersedes the workflow-time count-only note.
- ~~`runner-buffer-overflow live flood/slow-drip tests not executed (require sandbox + up to 60s drip); boundedness claims for those rest on code inspection + committed test bodies.`~~ — CLOSED 2026-11-01 by parent: sandbox available (`isSandboxAvailable()===true`), 3/3 live tests green in 3.13s.
- `File-descriptor counts under repetition (e.g. /proc fd or handle-count assertion across N executeGraph cycles) have no committed test — abort-lifecycle covers listener count only; propose as gap.`
- `Daemon long-run listener/queue growth under repeated start/stop cycles has no committed repetition test — shutdown paths inspected only.`

Additional detailed gaps from inspected evidence (verbatim):

- `No dedicated cross-session isolation test body inspected (implementation in src/graph/history.ts + src/mission/session-source.ts read; test proof is a gap)`
- `Ledger idempotencyKey duplicate:true assertion not verified against a test body (src/evidence/ledger.ts:476-495 only implementation-read)`
- `Master-switch root-ownership/malformed-state unit assertions not directly inspected`
- `State-transition, runner outcome_unknown, cancellation, and resume negative cases verified by reading test bodies, not by executing them (only deterministic + journal suites run this session)`
- `No live-model verification: judgment-success branches confirmed via FakeModel-backed tests only; no evidence of a live provider call in this pass.`
- `Full-suite regression not run (per instruction to avoid full suite); only tests/jeverb/graph-muse.test.ts executed (4 passed). Other cited tests were inspected, not executed.`
- `Did not inspect src/graph/runner.ts physical kill path or src/evidence/ledger.ts append/prune locking bodies directly; runner abort enforcement and ledger internals are cited from their concurrency tests and executor contract comments, not from source reads.`
- `Did not run the cross-process/esbuild chaos suites (lock-takeover, compound-crash, post-dedup-atomic, ledger-concurrency) in this session; their claims rest on inspected test bodies, not fresh executions. Only journal.test.ts (13 pass) and resume.test.ts (11 pass) were executed here.`
- `Provider-level (Jev gateway) dependency timeout: gateway.test.ts only asserts config values; no timeout fault-injection/recovery test inspected.`
- `Interrupted session-file write (crash inside writeSession): covered behaviorally via orphan-tmp sweep and corrupt-read defaults, but no direct test found.`
- `No standalone recovery runbook doc inspected; recovery procedures evidenced only via code comments and test headers.`
- `completeness critic unavailable; recorded as synthesis note, not a gap`

Overall disposition: PARTIAL PASS with environmental BLOCKED items — all verifiable claims
evidence-backed above, including full-suite (2635/2635) and live sandbox flood/drip runs;
no live-model or production-wiring claims made.

## Follow-up executed 2026-11-01

The earlier repetition and timeout gaps were checked against the current tree:

- `tests/tools/execute-graph.test.ts` runs 20 real constrained shell graphs and confirms
  `/proc/self/fd` returns within two descriptors of baseline (42/42 suite passed).
- `tests/hooks/daemon.test.ts` starts and closes 25 loopback daemons and confirms
  `/proc/self/fd` returns within one descriptor of baseline (69/69 suite passed).
- `tests/jev/gateway.test.ts` injects a hanging transport, verifies a typed timeout and
  exactly one attempt with `maxRetries: 0`, then verifies a subsequent logical call can
  succeed (4/4 suite passed). This is client fault-injection evidence, not a live FI test.
- `tests/tools/graph-history.test.ts` proves session-matched history/resume and rejects a
  different session; `tests/graph/resume.test.ts` and `tests/graph/executor-wave3.test.ts`
  prove uncertain outcomes are not replayed. These suites passed in the full 2026-11-01
  test gate.
- Adversarial session-source inspection found that an explicit terminal `outcome_unknown`
  node was present in `graphRuns` but omitted from the aggregate `operations.uncertain`.
  The source now counts terminal unknown nodes without double-counting still-running
  attempts; a session-isolation test and a closure-gate test cover the correction. The
  focused session-source/closure suites pass 33/33, and the final full gate passes
  145 Vitest files / 2,661 tests plus 44 control-service tests.

These checks close the local repetition/test-coverage gaps only. Actual installed listener
timeout/recovery, Muse behavior, privileged service activation, and production restart
qualification remain unverified and are tracked in `docs/REMEDIATION-ASSESSMENT.md`.
