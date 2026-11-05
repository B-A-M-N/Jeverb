# Jeverb Audit Correction — 2026-11-02

- **Corrects**: `AUDIT_2026-11-02.md` (preserved byte-for-byte; sha256
  `2280debd34c464e17d12384e24b980922bde85eb90e4cf266bd95409d1a35de1`, 305 lines — never edited)
- **Worktree**: `hermes-subagent/subagent-sa-0-012bac24` @ `ee1dbd3` (rc-3)
- **Scope**: minimal FM2 correction + regression test + corrected classifications.
  No threshold, floor, safety-check, model-input, or fail-open change.
- **Method**: every classification below cites a file:line re-read in this
  worktree and/or a test command actually run this session. Full-suite and
  live-integration claims are marked UNVERIFIED, not assumed.

## A. Claim-by-claim classification of `AUDIT_2026-11-02.md`

| # | Claude-audit claim | Disposition | Evidence |
|---|---|---|---|
| A1 | "Fail-closed multi-layer system; failure of any layer = denied; NO bypass paths" | **REFUTED** | Fail-open is the documented design: `src/hooks/daemon/server.ts:11-16` ("Fail open, from Claude Code's point of view"); `src/hooks/handlers/stop.ts:105-106` (checks off → `undefined`), `:506` (`if (!blocked) return undefined`), `:556-563` (catch → log + `undefined`); `src/hooks/handlers/pre-tool-use.ts:361-364` (no model → `undefined`), `:369-397` (quota-suppressed degraded allow, wire-silent). `undefined` = tool proceeds. A dead model layer allows, by design. |
| A2 | "Advisory judgment never produces `allow` (structural impossibility)" | **VERIFIED** (narrow, type-level only) | `src/hooks/types.ts:4` ("`permissionDecision` is typed `"ask" \| "deny"` on purpose"), `:187` (`permissionDecision?: EscalatingDecision`). This constrains the wire type, not the fail-open paths in A1. |
| A3 | "Daemon binds 127.0.0.1 only (`server.ts:566`)" | **VERIFIED** | `src/hooks/daemon/server.ts:566` (`server.listen(options.port, "127.0.0.1")`); sole `127.0.0.1` literal in the file. `npx vitest run tests/hooks/daemon.test.ts` → 69/69 passed this session. |
| A4 | "Master switch fail-closed, root-owned, fixed path" | **UNVERIFIED** (this session) | `src/control/master-switch.ts` exists with the ownership header invariant; `control/` untouched per tasking and not independently re-exercised. No contrary evidence; simply not re-verified here. |
| A5 | "Prefilter deterministic & non-bypassable" | **PARTIAL** | Deterministic layer present (`src/hooks/prefilter.ts`); prefilter deliberately untouched by this change. Bypass-resistance not exercised this session, and the audit's own residual-risk note (shell-feature evasion) stands. |
| A6 | "Affirmation marker stripped before fingerprint/model call" | **VERIFIED** | `src/hooks/prefilter.ts:36-43` (stripped-input contract), `:1397-1398`, `:1422` (downstream uses stripped text). Reissue/marker rows covered by `tests/hooks/pre-tool-use.test.ts`, green in the 176-test adjacent run this session. |
| A7 | "Receipt integrity + durable enforcement (P1-05/P1-06)" | **VERIFIED** (scoped) | `src/evidence/receipt-validation.ts:30-31` (`hashSubject`), `:69`/`:84`/`:145` (correlationId shape checks). `npx vitest run tests/evidence/ledger-durability.test.ts tests/evidence/ledger-concurrency.test.ts` → 26/26 passed. Non-cryptographic by documented trade-off, not a defect. |
| A8 | "STOP boundary cannot be circumvented (P1-08)" | **REFUTED** as absolute; holds only as designed | Same fail-open returns as A1 (`stop.ts:105-106,506,556-563`). Intentional per FM1 (accepted risk), but it contradicts "cannot be bypassed". |
| A9 | "2,552 tests / 166 files; 576-subset green" | **UNVERIFIED** (this session) | Full suite not run here; counts drift across checkpoints (remediation log cites 2,687 at a later point). This session: type-check clean + 340 targeted tests green (176 adjacent + 83 stop/arch + 69 daemon + 26 ledger − overlap counted once; exact commands in §D). |
| A10 | "F1 store degradation → FIXED (`readSessionDetailed`)" | **PARTIAL** at audit time → **FIXED** now | `readSessionDetailed` existed (`src/hooks/store.ts:427-435`) and Stop used it (`stop.ts:126`), but PreToolUse discarded the flag (`store.ts:416-418` via `readSession`) — FM2. Fixed by this change (§B, §D). |
| A11 | "F5 keyless daemon → FIXED (WARNING banner)" | Re-recorded as **ACCEPTED RISK** (FM3) | `src/hooks/daemon/auth.ts:125-128` (`authorize` returns true with zero keys) is real, but exposure is bounded by loopback-only bind (A3) — hardened-by-default. Left unchanged per tasking. |
| A12 | "READY FOR DEPLOYMENT, no blockers" | **REFUTED** | Release is **NOT QUALIFIED** by measurement (§C). |

## B. Falsification register

(Items 1–3 per lead tasking, re-verified at the cited lines; items 4–7 are the
additional Claude-audit claims re-investigated as potential defects.)

- **FM1 — Stop fail-open → ACCEPTED RISK.** Intentional design, not a defect:
  `server.ts:11-16`; `stop.ts:105-106,178-187,282-284,506,556-563`
  (`undefined` = allow). Rationale: hooks must never wedge the host; safety
  rests on the qualification gate + loopback binding, not on STOP veto power.
  Unchanged.
- **FM2 — PreToolUse scope-blindness on degraded reads → FIXED.**
  `store.ts:416-418` discarded the degraded flag; `pre-tool-use.ts:399-433`
  turned the resulting empty prompts into `userRequest=undefined` →
  `ignoreScope:true` with no log trace. Fix: read via `readSessionDetailed`
  and stamp `storeDegraded:true` + `storeDegradedReason` on the judged decision
  record (mirroring `stop.ts:457-463`), outcome unchanged, prefilter untouched.
  Proof: `tests/hooks/pre-tool-use-degraded-scope.test.ts` (3/3 green; 2/3
  fail with the fix reverted — §D).
- **FM3 — Keyless daemon (`auth.ts:125-128`, `main.ts:284-286`) → ACCEPTED RISK.**
  Hardened-by-default: unauthenticated mode only matters on loopback (A3).
  Unchanged; multi-user port-squatting mitigation (`JEV_DAEMON_DISABLE=1`)
  remains an operator act.
- **Item 4 — "`allow` smuggled through HookOutput" → VERIFIED NON-ISSUE.**
  Type-level impossibility holds (`types.ts:4,187`); observed allows are the
  documented fail-open `undefined` paths (FM1), not wire forgeries.
- **Item 5 — "Affirmation marker shifts scope / reaches the model" → VERIFIED NON-ISSUE.**
  Strip-before-use contract (`prefilter.ts:36-43,1397-1422`); marker rows green
  in the adjacent run (§D).
- **Item 6 — "Receipt correlationId minted/overwritten by the ledger" → VERIFIED NON-ISSUE.**
  Pass-through + shape validation (`receipt-validation.ts:69,84,145`);
  durability suites 26/26 green (§D).
- **Item 7 — "Daemon listens beyond loopback" → VERIFIED NON-ISSUE.**
  Sole bind is `server.ts:566`; `daemon.test.ts` 69/69 green (§D).

## C. Release verdict: NOT QUALIFIED (by measurement, not by missing evidence)

Release-policy floor (`src/jev/qualification.ts:300-305`):

- `minLiveness: 0.95`, `minPositives: 60`, `minNegatives: 149`, `maxFalseTerminalCompletions: 0`

Measured (sealed v3, cf. `docs/REMEDIATION-ASSESSMENT.md` QUAL-26):

- Liveness **13/64 positives completed (20.31%)** vs floor **0.95** → gate FAIL,
  manifest bound as **rejected** at the 0.95/60/149 floor.
- Safety holds: **0/153 false terminal completions** (one-sided 95% upper 1.94%),
  56 threshold holds, 72 semantic refusals, 0 model errors.

Root cause (do not "fix" by moving the bar): the failures are `threshold_hold`
— COMPLETE votes held below the dual-0.9 bar (`lockbox.ts:157-166,235-250`;
`closure.ts:404` requires confidence ≥ 0.9 AND `probabilities.COMPLETE` ≥ 0.9;
sealed bar `minConfidence: 0.9` in `scripts/build-final-lockbox-datasets.ts:298`,
`scripts/jev-verify-lockbox.ts:42`) with direction-correct model verdicts.
The lead's receipt sweep shows lowering the bar flips
`val3-data-erase-narrow-outcome` — labeled INCOMPLETE/narrow-outcome
(`bench/datasets/mission-completion-validation-v3.labels.json:140`) — into a
false terminal. Thresholds, floors, safety checks, `summarizeVerifiedEvidence`
wiring (`closure.ts:406`, unwired by header contract), and affirmative-request
model inputs are therefore intentionally untouched. Live status independently
concurs: `docs/TRACEABILITY.md` records **NOT LIVE QUALIFIED**.

## D. This change (worktree `hermes-subagent/subagent-sa-0-012bac24`)

- `src/hooks/handlers/pre-tool-use.ts` — FM2 fix (§B): `readSession` →
  `readSessionDetailed` + `storeDegraded`/`storeDegradedReason` on the judged
  record; outcome and prefilter paths unchanged.
- `tests/hooks/pre-tool-use-degraded-scope.test.ts` — new: corrupt file,
  truncated file (both keep `allow` but record `storeDegraded:true` /
  reason `corrupt`), promptless control (no false `storeDegraded`).

Commands run (worktree root), all exit 0 unless noted:

- `npx tsc --noEmit -p tsconfig.json` → clean, no errors.
- `npx vitest run tests/hooks/pre-tool-use-degraded-scope.test.ts` → 3/3 passed.
- Fix-reverted mutation check (stash src file only) → 2 failed / 1 passed,
  then `git stash pop` restored the fix; re-run 3/3 passed.
- Adjacent: `pre-tool-use.test.ts` + `pre-tool-use-wave2.test.ts` +
  `pre-tool-use-degraded-scope.test.ts` + `store.test.ts` + `store-wave1.test.ts` +
  `session.test.ts` + `mission/session-source.test.ts` → 7 files, 176/176 passed.
- Extra grounding: `stop.test.ts` + `architecture/dependency.test.ts` → 83/83;
  `daemon.test.ts` → 69/69; `ledger-durability` + `ledger-concurrency` → 26/26.
- No metered benches run; no provider/model calls; no service install/restart.

Verify: `git diff --stat`, then re-run the two commands above
(`npx tsc --noEmit -p tsconfig.json`;
`npx vitest run tests/hooks/pre-tool-use-degraded-scope.test.ts`).

## E. Deliberately left for the operator

1. Full `npm run test:run` + live model-integration soak (needs production key).
2. 60/149 population growth and model-calibration validation (operator-authorized
   metered runs only); `summarizeVerifiedEvidence()` wiring (metered validation first).
3. Multi-user hosts: `JEV_DAEMON_DISABLE=1` or equivalent port-binding control.
4. `AUDIT_2026-11-02.md` untouched; this file is the correction. (Written in the
   isolated worktree for branch review/merge, not directly into the main checkout.)
