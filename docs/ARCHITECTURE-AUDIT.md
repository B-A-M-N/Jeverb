# Architecture Audit — Boundaries, Modularity & Responsibility (read-only; no code changed)

Method: static import-graph over `src/**/*.ts` (value vs `import type` edges separated,
Tarjan SCC), symbol inventories per candidate, execution-path spot checks. All structural
claims below were re-derived from the current worktree, not taken on trust.

## A. Executive Assessment

Overall health: functionally decomposed at the top level (`hooks`, `decision`,
`evidence`, `graph`, `mission`, `control`, `tools`); problems concentrate in a few
oversized units and two inverted dependencies. Suitable for continued implementation;
no rewrite warranted.

Most consequential structural risks, in order:
1. One genuine 3-module **runtime** import cycle: `handlers/pre-tool-use.ts` ↔
   `handlers/lint.ts`, `handlers/commit.ts` (shared output helpers live in the wrong module).
2. Inverted dependency: `evidence/ledger.ts` and `control/client.ts` import master-switch
   behavior from `hooks/store.ts` — a lower layer depending on a higher one.
3. `Store` owns ~8 session-adjacent domains behind one class (disciplined internally, but
   every session-domain change lands in the same file).
4. 728-line `executeGraph` concentrates scheduling, recovery, authorization-adjacent
   orchestration, and terminal recording in one function.

## B. Actual Architecture

Subsystem map (verified by imports + entrypoints):
- **Ingestion**: `plugin/dist/hook.mjs` (bundle) → `hooks/main.ts` (CLI/composition) →
  `hooks/unified.ts` `dispatchEvent` (master-switch generation fence + receipt
  failure semantics) → per-event handlers (`handlers/`).
- **Judgment**: handlers → `decision/` (policy, Noul questions) → `jev/` (model clients) →
  daemon (`hooks/daemon/`) for resident inference; `hooks/memo.ts` caches identical requests.
- **Persistence**: `hooks/store.ts` (sessions, decision log, locks, trips, tasks) and
  `evidence/ledger.ts` (one authoritative JSONL ledger) + `graph/journal.ts` per-run journals.
- **Execution plane**: MCP tools (`tools/`, `plugin/dist/mcp.mjs`) → `graph/executor.ts` +
  `tools/execute-graph.ts` adapter; mission gates in `mission/`.
- **Control plane**: `control/` (service protocol) + master-switch files; daemon lifecycle
  in `hooks/daemon/control.ts` (port-is-authority, re-probe under lock).

Runtime dependency directions (value edges): handlers → store/ledger/decision/jev;
`tools/*` → `graph/*`, `evidence/*`; daemon → hooks/*; `evidence/ledger.ts` →
`hooks/store.ts` (inverted, §D1); `control/client.ts` → `hooks/store.ts` (inverted, §D1).
No runtime SCCs besides the handler 3-cycle. One 8-module **type-only** SCC exists
(`mission/receipt`, `hooks/types`, `hooks/verification`, `hooks/daemon/registry`,
`hooks/store`, `evidence/ledger`, `mission/closure`, `hooks/config`) — erased at compile
time; shared config/evidence types, not a runtime hazard.

State ownership: per-session files owned exclusively by `Store` methods under
per-session locks; evidence ledger has a single writer implementation; graph journals
are per-run files. No shared mutable cross-module singletons found (daemon registry
is in-memory per process; memo cache is per-process LRU).

## C. God Object Inventory

| Module (current size) | Responsibilities found | Verdict |
|---|---|---|
| `hooks/store.ts` (1414 lines) | FS/ownership primitives; switch inspection; session CRUD + transactions; intervention claims; disabled state; reissue queue; post-observation dedup/fold; subagent tasks (TTL/cap); trip lifecycle ×6; note dedup; decision log + rotation; retention | **CONFIRMED god object** (P0). Mitigating: single lock primitive, tolerant reads. Decompose behind the `Store` API per §F. |
| `graph/executor.ts` (1586) | Pure helpers already extracted (`collectDepEvidence`, `buildJevState`, `parseJevVerdict`, `graphHash`, `expandGraphLoops`, `validateGraph` 278 lines) + 728-line `executeGraph` (scheduling, recovery, terminal recording) | **CONFIRMED overloaded** (P1). Pure parts done; remaining work is the scheduler core — high value, high blast radius, so after the cheap boundary fixes. |
| `handlers/pre-tool-use.ts` (654; handler fn ~464) | Prefilter → trip resolution → lint/commit routing → health circuit → inference → recording, plus the three shared output helpers that cause the cycle | **CONFIRMED overloaded + cycle source** (P0 for the helper extraction; P1 for the pipeline split). Order prefilter→trip→judgment is behavioral; preserve it. |
| `tools/execute-graph.ts` (799; `runLocked` ~428) | Policy validation, journals, graph expansion, per-node-kind dispatch, extractors, model requests, receipts | **INFERRED overloaded adapter** (P1). Authority line between adapter and executor needs the trace the prior review did; do not create a second scheduler. |
| `mission/closure.ts` (1425) | Mechanical checks, affirmative + adversarial evaluation, repair planning, cached decisions, timeouts, durable receipts, two gate classes | **CONFIRMED multi-phase** (P1). Phases already function-separated in-file; extract policy/adjudication without touching gate coordination. |
| `handlers/stop.ts` + `handlers/stop-policy.ts` | Stop orchestration (claims, workspace verification, closure, deadlines, intervention dedup, audit) plus a policy leaf (questions, request builders, thresholds) | **BOUNDARY REPAIR FIXED:** mission evidence lookup and persisted control-loop calls had leaked into `stop-policy.ts`; these orchestration helpers now live in `stop.ts`, with a static dependency assertion. Further decomposition remains deferred unless behavior churn demonstrates another seam. |
| `hooks/prefilter.ts` (1470) + `hooks/mcp-policy.ts` (new) | Bash tokenizer/scanner + classifiers + policy (`scanBash` → `prefilterBash` is already a parse/decide split); MCP identity/allowlist classification extracted to `mcp-policy.ts` after the misleading-name skip bypass proved a policy boundary | **PARTIALLY EXTRACTED** (MCP boundary FIXED; grammar/dispatch DEFERRED). Remaining size is grammar coverage, not fused responsibilities; splitting further scatters one grammar. Reopen on a parser/policy defect or repeated change coupling. |
| `hooks/daemon/server.ts` (622) | HTTP routing + auth + registry + deadlines + metrics + idle/grace timers + shutdown in `startDaemon` closures | **INFERRED intertwined** (P2, opportunistic). Preserve loopback binding and response contracts. |

Kept as-is (agree with prior review): `unified.ts` (central fence must stay whole),
`evidence/ledger.ts` (single writer is a correctness asset), `review/service.ts`,
`report.ts`, `main.ts` (composition root).

## D. Boundary & Invariant Violations

- **D1 (CONFIRMED, P1): 3-module runtime cycle.** `pre-tool-use.ts:34-35` imports
  `handleLint`/`handleCommit`; `lint.ts:22` and `commit.ts:19` import `noteOutput`,
  `tripChannel`, `tripOutput` back. Benign today (helpers are pure; all call sites are
  inside handler functions, so ESM live bindings resolve by call time — no init-order
  hazard under current usage), but it is unnecessary coupling that will bite the first
  module-eval-time use. Fix: `handlers/response.ts` with the three helpers, imported by
  all three handlers; must not import any handler. Fan-in is exactly these three files.
- **D2 (CONFIRMED, P1): master-switch inversion.** `evidence/ledger.ts:6` and
  `control/client.ts:3` take `readMasterSwitch` (+ types) from `hooks/store.ts`
  (value imports, not types). Fix: `control/master-switch.ts` owning the switch
  functions/types; store, ledger, control client depend on it. No behavior change.
- **D3 (CONFIRMED, P0 context): Store multi-domain ownership** (8 domains, §C). No
  competing authority found (single lock primitive, one transaction path), so this is
  maintainability debt, not a correctness defect. Do not let repositories invent
  separate locking.
- **D4 (INFERRED, P2): no automated dependency enforcement.** Nothing rejects a new
  runtime cycle or a new `control/ → hooks/store` edge. Add a static test (the
  `/tmp/import-graph.mjs` approach: Tarjan over value edges, fail on SCC>1) plus an
  explicit allowlist for the `evidence → hooks/store-lock` (lock primitive, fine) edge.
- Invariant ownership spot-checks (all single-owner, no action): kill-switch
  fail-closed (`store.readMasterSwitch`), receipt idempotency (`graph/receipt.ts`
  scope-match), loopback-only bind (`daemon/server.ts` + `main.ts`), threshold
  clamping (`config.ts` + registry validation).

## E. Target Architecture

- **KEEP:** `unified.ts` dispatch fence, single ledger writer, daemon port-authority
  lifecycle, `SessionConfig` Omit-pattern (new config fields propagate automatically;
  proven when it caught missing validation during the retention work).
- **DECOMPOSE:** Store → repositories behind the `Store` API (one domain at a time);
  executor scheduler core after pure parts; mission policy/adjudication out of the gates.
- **REALIGN:** output helpers → `handlers/response.ts`; master-switch → `control/`.
- **CONSOLIDATE:** nothing found duplicated.
- **ENFORCE:** static runtime-cycle test; `control/, evidence/ → hooks/store.ts` ban
  (allow `store-lock.ts` primitive).
- **SIMPLIFY:** nothing structural; the codebase already prefers plain modules.
- **DEFER:** prefilter split (parse/decide already separated); daemon server split;
  stop.ts selective extraction — all reopen on defect or churn, not on size.
- Dependency rules: handlers → store/ledger/decision/jev (never reverse at runtime);
  tools → graph/evidence; daemon → hooks; control → nothing in hooks except the new
  master-switch module; `import type` freely for shared types.

## F. Prioritized Code-Edit Plan

1. **P1 — response.ts extraction** (unblocks the cycle): new
   `src/hooks/handlers/response.ts` with `tripChannel`, `tripOutput`, `noteOutput`
   moved verbatim; update imports in the three handlers; add static cycle test.
   Verify: full gate + cycle test green.
2. **P1 — master-switch module**: new `src/control/master-switch.ts` (move
   `readMasterSwitch`, `MasterSwitchStatus`, related consts from `store.ts`);
   re-export or redirect `store.ts`, `ledger.ts`, `control/client.ts` imports.
   Verify: full gate + the new dependency-ban test.
3. **P0 — Store decomposition** (incremental, API-preserving): extract one domain at
   a time (trips → subagent tasks → observations → retention), each as a module
   taking the Store's lock/IO primitives as parameters. Characterization: existing
   `store.test.ts` + concurrency suites must stay green at each step.
4. **P1 — executor scheduler core**: extract terminal-result construction and
   recovery validation first (pure, testable), scheduling last. Keep `executeGraph`
   as the entrypoint; invariants in §C hold.
5. **P1/P2 — tool adapter, closure policy, stop/daemon splits** as ordered in §C,
   each with focused regression + full gate.

## G. Acceptance Gate

**CONDITIONAL.** The two boundary defects (D1, D2) are real but contained — the cycle
is benign under current deferred-call usage, and the inversion works — so they do not
undermine the correctness, failure-model, or resilience audits already performed.
Downstream engineering may proceed. Minimum to clear: F1 (cycle) + F2 (inversion) +
the static enforcement test (D4) — **CLEARED** (both FIXED, enforcement test green,
full gate green). Store/executor decomposition proceeds in parallel
without gating other work. No BLOCKED items.

## Disposition Log (per AGENTS.md audit rule)

| Finding | Disposition | Evidence / condition |
|---|---|---|
| D1 handler cycle | FIXED | Helpers moved verbatim to `handlers/response.ts`; `tests/architecture/dependency.test.ts` cycle assertion green; `never-allow` ask-site pins updated to new site; full gate green (137 files / 2565 tests + 35 Python) |
| D2 master-switch inversion | FIXED | `control/master-switch.ts` owns switch state; `control/client.ts` + `evidence/ledger.ts` redirected; `store.ts` re-exports for compat; inversion assertion green; full gate green |
| D3 Store god object | DEFERRED (7 domains extracted: master-switch, decision-record, trips, subagent-tasks, observations, decision-log, file-helpers; `store.ts` 1414 → ~900 lines) | What remains is the actual Store: session CRUD, locks, transactions — extracting that changes the API every caller uses; each further slice needs focused + full gate. Reopens on: a reproduced unsafe concurrent write, a lock-scope defect, or repeated change coupling forcing cross-domain edits |
| Executor pure-ops extraction | FIXED | `graph/validate.ts` (validate/expand/describe/hash/parse/topoSort, byte-identical move); scheduler core (`executeGraph`) untouched; 28 graph/tool/mission files green |
| Executor scheduler core | DEFERRED (admission, deadline, when-binding, and listener-lifecycle repairs landed; see new rows) | Remaining `executeGraph` complexity is intentional size. Reopens on: a new reproduced scheduling failure (not line count), conflicting ownership, or repeated change coupling across scheduler/admission concerns |
| Closure adversarial-core split | FIXED | `mission/adversarial-closure.ts` (types, question builders, gap validators, finding validation); gates and verdict phase stay; 135 mission/decision/bench tests green |
| Store trip transitions | FIXED | Pure `apply*Trip` fns in `hooks/tripwire.ts`; `Store` methods are thin wrappers; new unit tests; full gate green (141 files / 2594 tests + 35 Python) |
| Store subagent-task domain | FIXED | `hooks/subagent-tasks.ts` (types + pure transitions + select); `session-source.ts` redirected; new unit tests; gate green |
| Store observation/reissue domain | FIXED | `hooks/observations.ts` (vocabulary + pure tx bodies); `Store` keeps lock/runner wrappers; new unit tests; gate green |
| Store decision log + file helpers | FIXED | `hooks/decision-log.ts` (`DecisionLog` class); shared file helpers moved to `store-lock.ts` leaf; `store.ts` 1414 → ~900 lines; gate green |
| Executor terminal results | FIXED | `graph/terminal.ts` (`buildTerminalResult` + context); scheduler keeps thin wrapper; new unit tests; gate green |
| Tool-adapter bindings | FIXED | `tools/graph-bindings.ts` (binding/pointer/policy-hash helpers); adapter keeps orchestration; new unit tests; gate green |
| Stop policy split | FIXED | `handlers/stop-policy.ts` (questions, policy, builders); `stop.ts` 765 → 415 lines, keeps `handleStop`; 151 stop tests green |
| Stop policy orchestration leakage | FIXED | `currentCorrectionDirective` and `currentInterventionRevisionKey` moved to `stop.ts`; the policy leaf no longer owns mission evidence lookup or control-loop execution. The AST dependency assertion reproduced both forbidden runtime edges before the move and passes after it; architecture + Stop suites pass 83/83, and `npm run type-check` passes. |
| DOX governance | FIXED | Root `AGENTS.md` ownership map + child index + read/update lifecycle; `dependency.test.ts` enforces leaf-direction for all 14 leaves (incl. `hooks/mcp-policy.ts`) |
| Ledger receipt-validation split | FIXED | `evidence/receipt-validation.ts` (outcomes vocabulary, hash/resolve/validate); `ledger.ts` re-exports; 238 evidence/mission/graph tests green |
| Daemon splits | DEFERRED (opportunistic) | No defect demonstrated; server/main/control stay whole until one appears. Reopens on: a reproduced auth/binding/shutdown defect or conflicting ownership |
| Prefilter MCP policy boundary | FIXED | Reopen condition fired (misleading-name skip bypass). `src/hooks/mcp-policy.ts` owns MCP identity/allowlist classification; Bash parsing and shell safety stay in `prefilter.ts`. Read-verb and substring heuristics removed; unknown tools judged; `JEV_MCP_SKIP` allowlist threaded from `pre-tool-use.ts`. `tests/hooks/mcp-policy.test.ts` (misleading names, allowlist, OWN_TOOL_NAMES sync) + updated `prefilter.test.ts` dispatch expectations |
| Prefilter remainder (grammar/dispatch) | DEFERRED | Shell tokenizer, file-tool checks, and dispatch stay whole: size is grammar coverage, not fused responsibilities. Reopens on: a parser/policy defect or repeated change coupling between Bash parsing and classification |
| unified.ts kept whole | VERIFIED NON-ISSUE | Fence must stay whole |
| Dependency-test prefix defect | FIXED | Leaf rules compared `src/`-prefixed paths against stripped targets and could never match; normalized to SRC-relative both sides; analyzer upgraded to TS AST (value re-exports, dynamic `import()`); negative tests added; 8/8 arch tests green |
| Store SessionStart read/write race | FIXED | `session-start.ts` claims `key_warned` inside `lockedUpdate`; corrupt/unreadable files fail closed without rewrite; 4 new regression tests; 29/29 session tests green |
| Scheduler late-authorization execution | FIXED | Post-grant level-preemption check blocks not-started nodes after sibling failure (attempts still 0); rescue nodes in later levels unaffected; 5 admission tests green |
| Graph deadline vs pending authorization | FIXED | `authorizeBounded` races grants against graph revocation; late/never grants settle cancelled promptly; try/finally clears the deadline timer; attempts-0 distinct from outcome_unknown interruption |
| Async `when()` vs graph revocation | FIXED | `evaluateWhen` bounded by the same revocation authority as `authorizeBounded`; late true/false/never-resolving predicates settle `cancelled` with 0 attempts; throwing predicates fail; side-effect-free predicate requirement documented on `GraphNode.when`; 9 admission tests green |
| MCP misleading-name skip bypass | FIXED | `mcp__external__get_and_delete_all` and `mcp__maljevhost__jev_delete_all` classified `skip` by read-verb/substring heuristics; now judged. Exact `(server, tool)` recognition + operator allowlist (see Prefilter MCP policy boundary row) |
| Caller abort listener accumulation | FIXED | Named `onCallerAbort` removed in the outer `finally` (success, cancellation, thrown errors); master→level propagation removed in a level-scoped `finally`; 5-run shared-signal repro leaves 0 listeners (`tests/graph/abort-lifecycle.test.ts`, 4 tests) |
| Logical deadline vs physical termination | CHARACTERIZED (not a code defect) | Shutdown contract documented on `ExecuteOptions.signal`: revocation is a logical deadline (no new attempts, late settlements cannot authorize); physical kill is the sandbox shell runner's job (`execFile` signal+timeout kills the `systemd-run` scope leader; child exit confirms). Generic async runners get signal notification only; a runaway delays completion but its late result records `cancelled`/`outcome_unknown`, never success |
| Disposable stub-host smoke qualification | BLOCKED (environmental, pre-existing) | `harness/mcp-stub-smoke.sh` and `harness/muse-hook-stub-smoke.sh` fail at the install-wide master-switch gate before any repaired code runs: no `/var/lib/jeverb/control-state.json` in this container → `readMasterSwitch` UNKNOWN → effective OFF → hook dispatch early-returns (exit 0, no judgment, no receipt). Unblocks on: operator `jev-control on` (or equivalent control-service state) in the qualification environment. Not caused by the P1-A/B/C diffs (gate precedes all changed code; prefilter probe still returns `judge` for the smoke's Bash input) |
| Live Muse host plugin qualification | BLOCKED (needs operator approval) | `muse` CLI present with an installed jeverb candidate, but its bundles differ from the workspace build (`--check-only` exit: hook.mjs differs). Refreshing the live install is deployment — left to explicit operator approval per review constraints. Unblocks on: operator refresh of the installed candidate, then `harness/muse-hook-qualification.sh` (fixture-based, no live session side effects) |
