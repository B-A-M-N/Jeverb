# jev benchmarks

Measured 2026-09-21 on jevwire 0.6.2, from a real decision log (1,017 records of ordinary Claude Code
use) plus in-process microbenchmarks and the built bundle. Numbers are what the deployed plugin
actually did, not a synthetic loop — the log is one developer's session with the gate, stop check,
screen and lint all on.

## Bundle size (what ships and cold-starts on every hook)

| bundle | size | deps |
|---|---|---|
| `plugin/dist/hook.mjs` | **287 KiB** | none (no zod, no MCP SDK) |
| `plugin/dist/mcp.mjs` | 1,469 KiB | MCP SDK + zod (only loaded when the MCP server runs, not on hooks) |

The hook bundle is deliberately dependency-free: it is parsed on every tool call on the command-hook
fallback path, and its cold start is a tax on the whole session. A static test holds it under 300 KiB.

## The common case is free: the skip path (no model call)

Most tool calls never reach the model. A read-only command, or an edit that matches no lint gate, is
decided in code by the prefilter and the regex gate:

| step | per call | what it decides |
|---|---|---|
| `prefilter` (Bash skip-path) | **~24 µs** | is this a read-only/allowlisted call → no judgment |
| lint regex gate (no match) | **~9.6 µs** | does this edit match any lint pattern → no model call |

At tens of microseconds, the skip path is free relative to the tool call it precedes. This is the
mechanism behind "most edits cost nothing": the model is asked only when a regex first found the shape.

The daemon skip-path (an http hook that resolves without a model) answers in **~1.4 ms** end to end
(measured warm at release); the command-hook fallback pays node's cold start (~0.5–2 s) but only when
the daemon is not up.

## When the model is asked: judged latency (live)

Over 740 real model calls in the log (memo hits and the one aborted outlier excluded):

| latency | value |
|---|---|
| p50 | **536 ms** |
| p95 | **1,168 ms** |

Both sit under the 1,500 ms per-call hook timeout, so a judged hook rarely times out on the hot path.
A memoized repeat of an identical call returns in ~3 ms with no tokens spent.

## Cost (live)

- **~1.53M input tokens** across the whole log's lifetime → **≈ $0.064** at $0.042/Mtok (Jev bills input
  tokens only). That is the cost of a heavy development session with every hook on.
- The gate is the bulk of it (689 PreToolUse records); the stop check (20) and screen (33) are a small
  tail. Lint had just been installed, so it is barely represented yet (6 records).

## What the hooks actually did (live decision mix)

| event | total | outcomes |
|---|---|---|
| PreToolUse (gate) | 689 | allow 500, silent-scope 73, advise 49, note 17, ask 17, **trip 10**, error 7 |
| Stop | 20 | allow 18, (blocks are rare and one-per-prompt) |
| PostToolUse (screen) | 33 | clean 31 |
| UserPromptSubmit | 58 | prompt recorded |
| verification (code, no model) | 200 | test/typecheck/build results tracked for the stop check |

Read this as the design intends: the overwhelming outcome is **silent** (allow), notes are occasional,
and trips (denials) are rare — 10 in 689 gate decisions, each re-issuable with a marker.

## How to reproduce

- Bundle: `npm run build` then `ls -la plugin/dist/*.mjs`.
- Skip-path microbench: a tight loop over `prefilter(...)` and `lintPrefilter(...)` (both pure, no
  network); warm first, then time.
- Live numbers: `npm run capture -- --summary <fixture>` for the policy view, or read
  `~/.claude/plugins/data/jev-<marketplace>/decisions.jsonl` directly — every judged record carries its
  `latency_ms` and `input_tokens`.

These feed the verdict phase directly: the targets there are judged p50 ≤ 450 ms (currently 536 ms —
close, and dominated by network RTT to the API, not the plugin), skip ≤ 10 ms (met, ~1.4 ms), and cost
≤ $0.05/day (a heavy day here was $0.064, an ordinary day well under).

## OpenRouter route calibration (Jeverb addition)

The native TypeSafe endpoint was unreachable from this environment (direct key rejected), so
calibration runs through `src/jev/openrouter.ts` against `typesafe/jev-router` via OpenRouter
chat-completions. The adapter maps chat JSON onto the same `Answer` shapes and rejects anything
unparseable as `JevValidationError` (unavailable, never a verdict).

Method: `scripts/jev-calibrate.ts` validates a labeled JSONL dataset before making provider calls
(`bench/datasets/jev-calib-v1.jsonl`, 8 cases: benign typo/test/rename vs rm-rf, auth-bypass removal,
DROP TABLE, major dep bump, workflow `write-all`). It reports per-answer in-range accuracy, a Noul
threshold sweep (TP/FP/TN, TPR, FPR, precision, recall), and probability reliability metrics for
labeled Noul answers (Brier score, log loss, expected calibration error, and a 10-bin reliability
table). Every receipt includes the observed provider/model, the full question-set hash, an individual
question-definition hash, and the full dataset revision hash. The summary includes the configured
model and all observed model/provider/question-set pins, plus a calibration revision derived from
those pins and the benchmark algorithm version. It also reports successful/failed cases, expected and missing answers so failure and
coverage cannot disappear behind an accuracy denominator. Thresholds are reported, never written to
policy; these metrics do not establish TypeSafe-native Jev calibration when collected from a chat
relay.

Seed result (live, 2026-10-29): **14/16 answers in range**; threshold 0.5–0.8 gives TPR 0.8 /
FPR 0 at precision 1.0 on the seed set. Two honest misses: an unquoted-variable `rm -rf` rated
0.4 (below the 0.6–1.0 expectation band) and a pure rename flagged REVIEW at 0.7. Reproduce with
`OPENROUTER_API_KEY=$(cat $HOME/JEV.txt) npx tsx scripts/jev-calibrate.ts
bench/datasets/jev-calib-v1.jsonl`.

Caveat: chat self-reported probabilities are NOT TypeSafe-native Jev outputs. No threshold measured
here transfers to another backend — re-run the bench per backend before touching policy.

## Prompt classification question benchmark

`bench/datasets/prompt-routing-v1.jsonl` is a 16-case labeled corpus for the live
`UserPromptSubmit` `kind` and `ambiguity` questions. It contains two cases for
each task kind and covers all three ambiguity score levels. The offline test
pins each case's question definitions to the hook's actual question object, so
editing wording, criteria, or option IDs forces an explicit corpus update. It
also checks corpus shape and label coverage in CI. These are authored reference
labels, not empirically verified model outcomes or a calibration pin.

Run the provider benchmark with the selected backend's approved credentials:

```sh
npm run bench:prompt-routing
```

The command reports answer accuracy, probability reliability, model/provider,
question hashes, and the dataset revision using the same receipt format as the
review bench. It does not change routing policy. Run separately for each
backend; a relay result cannot certify native TypeSafe Jev calibration.
