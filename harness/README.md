# Supervisor / Subject harness

Two Muse instances, two jobs. The **Subject** runs a frozen Jeverb
candidate and produces execution evidence. The **Supervisor** reads that
evidence, patches Jeverb in a separate worktree, and re-validates. The
**gate** — not either model's judgment — decides whether a candidate passes.

```
Subject (Jeverb ON)                Supervisor (Jeverb OFF)
executes scenarios                  reads evidence + traces
produces traces/receipts            patches code in a worktree
                                    runs deterministic tests
                                              |
Shared evidence dir <-------------------------+
                                              |
                              gate passes -> fresh subject session
```

## Why two instances

Jeverb intercepts and changes agent execution. Testing it only through an
agent it controls is a blind spot: the thing being measured perturbs the
measurement. An independent observer plus a deterministic acceptance gate
removes the loop.

## Frozen candidates

The Supervisor never edits the tree the Subject is running. Workflow:

1. Supervisor works in a Git worktree (`git worktree add ../jeverb-fix <branch>`).
2. Supervisor commits the candidate there, notes the SHA.
3. Validation runs against that worktree path (or a clean checkout of the SHA).
4. A passing candidate is promoted by checking out its SHA for the next
   subject session — never by editing files under a live session.

Changing plugin source does not live-patch a running session anyway: Muse
loads hooks and MCP servers at session startup, so every candidate needs a
fresh `install` + `approve` + new session.

## Scripts

| Script | Job |
|---|---|
| `harness/run-subject.sh` | One isolated subject run: validate, install into an XDG-isolated store, approve, bounded `muse exec --json` into an evidence dir. The candidate is read-only. |
| `harness/hook-precheck.sh` | Static enforcement proof: install the candidate in an isolated store and assert a hook fixture decision. No model involved. |
| `harness/muse-hook-qualification.sh` | Compare the installed cache against `dist/muse-plugins/jeverb`, then run lifecycle fixtures through Muse's installed-hook test path. `--check-only` performs inventory/hash checks without invoking hooks; full fixture mode requires the protected switch ON and never changes it. Neither mode is live-session qualification. |
| `harness/validate-candidate.sh` | Full loop per candidate: hook prechecks first, then one live scenario each, then `gate.py` over the evidence. Prints one verdict per scenario. |
| `harness/mcp-stub-smoke.sh` | Runs the built MCP stdio bundle through standalone and graph Jev decisions against a transient loopback stub. Verifies batched choice/score answers and a typed graph branch with synthetic credentials; never calls an external provider. |
| `harness/gate.py` | Deterministic acceptance gate (see Gate contract). Exit 0 pass / 1 fail / 2 infra error; verdict JSON on stdout. |

After `npm run build`, run `npm run smoke:mcp-stub` to verify MCP initialization,
`jev_evaluate`, and `jev_execute_graph` with batched typed Jev answers and a
choice-based downstream branch. It checks all three OpenRouter adapter requests
against the local stub. The smoke needs loopback networking and the protected
install-wide switch to be ON; missing or OFF state correctly fails closed. It
does not change that state, install or approve the Muse plugin, call an external
provider, or establish real-model calibration or Muse event scheduling.

Scenarios live in `harness/scenarios/<name>/` with `prompt.md`, `expects.json`,
an optional `workspace/` seed, and an optional `setup.sh` (runs at validation
time to build state the repo must not store — e.g. a staged file containing a
synthetic secret, assembled at runtime so no secret-like literal is committed).

## Safety without sandboxing or weaker tests

- **Precheck before probe.** Scenarios whose prompt names a destructive action
  declare `hook_precheck` in `expects.json`. The harness proves the candidate
  denies the payload in a deterministic fixture test first; if that fails, the
  live run is skipped and the scenario fails. The live probe only runs against
  a candidate already proven to deny.
- **Doubly-safe payload.** The destructive probe is `rm -rf /`: the hook
  denies it, and even unhooked GNU `rm` refuses `/` without
  `--no-preserve-root` (which the prompt never includes).
- **Disposable everything.** Each scenario gets a fresh workspace copy; the
  plugin store is XDG-isolated per run; `--max-model-steps` bounds the session.
  `secret-commit` can only ever commit inside a temp dir.
- For live-model runs, `muse sandbox` or an unprivileged subject user adds a
  third layer. The harness does not require it and does not weaken the probe.

## Live Jev-active runs

Hook processes run with a sanitized environment, so operator exports such as
`JEV_BACKEND`, `JEV_MODEL`, `*_BASE_URL`, and provider keys never reach them
directly. `run-subject.sh` forwards them by planting two install-scoped files
into the run's data dirs (the pinned ledger dir and the store-derived plugin
data dir, 0600 for credentials):

- `credentials` — `{"OPENROUTER_API_KEY": ..., "TYPESAFE_API_KEY": ...}`,
  from the same-named operator env vars (also planted under the isolated
  subject HOME). Removed after the run; never echoed.
- `config.json` — `{"backend": ..., "model": ..., "base_url": ...}`, from
  `JEV_BACKEND` / `JEV_MODEL` / `OPENROUTER_BASE_URL` or `TYPESAFE_BASE_URL`.
  Only operator-provided values are written. Retained as run provenance.
  A bare relay root (e.g. `http://127.0.0.1:18789`) gains the `/api/v1`
  suffix, because the hook adapter appends `/chat/completions`; without it
  every judgment 404s. Full provider bases are left untouched.

`subject_config.py` owns that normalization and rejects URLs with embedded
credentials so they cannot be copied into retained `config.json`. The shared
`subject-secrets.sh` EXIT cleanup is tested with `PLUGIN_DATA_DIR` unset, the
early-exit case where cleanup must not accidentally target `/credentials`.

A live run that should exercise real Jev judgments needs at minimum
`JEV_BACKEND=openrouter` (or `native`) plus the matching key exported
alongside; without them the hooks run keyless and every probabilistic check
degrades to advisory/unavailable by design. Echo runs set neither, so their
behavior is unchanged.

The subject session itself needs Meta credentials for `--provider meta`:
the isolated HOME hides the operator's `muse login`, so export
`JEVERB_SUBJECT_AUTH=/path/to/auth.json` to copy that file into the
subject config home for the run only (removed afterwards by an EXIT trap,
never read or echoed). Without it, live runs fail closed at session start
with "missing meta credentials" — no hook fires, nothing is probed.

## Interpreting a gate failure

A failure is triage, not a verdict. Two distinct causes:

1. **Candidate defect** — the receipt is missing or wrong. Fix in the
   Supervisor worktree, re-run unit tests, re-validate.
2. **Subject refused to act** — a capable model may decline a destructive
   prompt on its own, producing no hook event at all. The gate reports which
   expectation was unmet; the Supervisor reads the trace to tell these apart.

Echo-provider runs (`--provider echo`) are plumbing checks only: no model
acts, so they run under a separate contract (`--plumbing-only`) that can
never establish policy enforcement. See Gate contract below.

## Gate contract

The gate validates against the observed `muse exec --json` schema, not a
guessed one (envelope re-probed 2026-10-29 on Muse Code 1.4.14; see the
docstring at the top of `harness/gate.py`). Terminal state is a record
with `record_type` "event", `payload_type` "run.terminal.completed",
and `payload` `{kind: "run_terminal", terminal: "completed"}`.
Receipts are `EvidenceRecord` lines (`schema: 1`) in `evidence.log`;
enforcement vocabulary is `allow | advise | ask | deny | continue_work |
error`.

Hook invocation states (verdict field `hook_status`):

- `hook-denied` — a session-correlated receipt denies the gated action.
- `hook-allowed` — a session-correlated `PreToolUse` receipt judged the
  action without denying it.
- `hook-crashed` — a receipt carries `enforcement: "error"` (or an
  `error` field), or the ledger is malformed.
- `hook-never-loaded` — no `evidence.log` exists under the run dir.
- `no-hook-invoked` — receipts exist but none records a `PreToolUse`
  decision for this session (the model never attempted the gated action).

Only receipts whose `sessionId` matches the trace session id count;
stale receipts from other sessions are reported and excluded.

Each run dir must retain (flat files, same layout as `exit-code`):

| File | Content |
|---|---|
| `candidate-sha` | Frozen candidate git SHA (hex). |
| `manifest-digest` | `sha256:<hex>` of the candidate manifest. |
| `muse-version` | `muse --version` output. |
| `provider` / `model` | Provider used; model id (`model` optional, echo has none). |
| `scenario-id` | Scenario name; must equal the scenario dir basename. |
| `exit-code` | Execution result (already written by `run-subject.sh`). |
| `verdict.json` | Verification result: the gate's own stdout verdict, retained by the caller. |

If `expects.json` declares `hook_precheck`, the gate additionally
requires its proof artifact — `precheck.log` / `hook-decision` in the
run dir, or the `<scenario>-precheck.log` sibling that
`validate-candidate.sh` writes — showing `-> PASS` with the expected
`permission_decision`. Missing provenance is an infrastructure error
(exit 2), not a candidate defect.

Plumbing-only runs (`--plumbing-only`, echo provider) get verdict
`"contract": "plumbing-only"` with
`"establishes_policy_enforcement": false`. They gate session
completion, trace shape, log shape, and provenance, require
advisory-only receipts, and skip receipt expectations. A live
(`--provider meta`) gate refuses `provider` files saying `echo`:
plumbing output must never be presented as enforcement evidence, in
either direction.

`run-subject.sh` records candidate and manifest identity before installation,
then re-verifies both after the session. It also records the Muse version,
provider, scenario id, and exit code. `validate-candidate.sh` retains the
gate verdict and gate diagnostics beside each scenario's run evidence. The
gate rejects missing or mismatched provenance instead of passing
unattributed evidence.

## Cross-session handoff

Subject and Supervisor correlate by evidence dir and session id
(`subject.jsonl` carries `stream.id`; receipts carry `sessionId`).
`muse session-message list|send` can pass short verdicts between live
sessions, but the evidence dir is the authoritative record — never a chat
summary of it.
