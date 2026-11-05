# Actual Model and Architecture Convergence — 2026-11-03

## Scope and result

This investigation used the retained v3 datasets, labels, receipts, manifests,
production decision code, and repository tests. It ran one bounded native
OpenRouter development evaluation and did not change the sealed datasets or
historical receipts. The current worktree also contains pre-existing
uncommitted demo files; they were preserved.
The inspected repository HEAD is `e2fe2a14`; the previously cited local
architecture qualification is `75d4e45`. The earlier 3,044-test full suite
predates the final graph-guard edits. Those edits passed focused
graph/admission/architecture suites, a fresh type-check, and a bundle build;
the graph-tool suite still has sandbox-dependent failures because this
environment lacks `bwrap` and blocks loopback binds.

**Qualification verdict: neither the current Jeverb product nor the current Jev
model is qualified.** The historical gateway candidate failed mission-closure
liveness (13/64 against a 95% requirement); the native OpenRouter
`typesafe/jev-latest` development run also failed the liveness gate at 2/12.
It resolved to the same reported Jev 1.14 version as the historical gateway
run. The current workspace build is installed in Muse at package hash
`6dd9e05d…`, but Muse reports zero effective hook/MCP capabilities. The
protected host switch is absent, and no current end-to-end lifecycle has
shown actual Jev selecting a consequential graph transition followed by
deterministic authorization, execution, durable evidence, independent
verification, and mission closure. Passing local tests and fixing a locally
reproducible integration defect are implementation evidence only; they are not
architecture, model, host, or release qualification.

Local graph tests verify traversal, typed branches, authorization boundaries,
resume/reconcile, and durable receipts. They do not establish that the proposed
model/provider path improves a real consequential graph lifecycle over the old
installed version.

The older installed bundle and its logs are the deployed-state baseline; the
current workspace candidate has now been measured on the development split
and installed in Muse, but its hooks/MCP capabilities remain ineffective. The
local OpenRouter changes correct provider
identity, request binding, and the qualification path. The
development-split comparison used retained baseline receipts on the same
cases, question hash, and thresholds. Model-only and integrated choices and
integrated outcomes matched the gateway baseline on all 32 cases. This shows no
decision-quality improvement on the measured split. Separate graph lifecycle
evidence is still required to establish improvement in consequential traversal
or execution.

The historical **13/64** result measures `typesafe/jev-1.14-20261014` through
the `jev-gateway` backend. The retained eight-case demo reports that same
backend and returned model ID, but it evaluates a different task and does not
evaluate mission closure. An exact request-ID join to the retained Locus
gateway log establishes that all calls in both the 13/64 final evaluation
and its development baseline used OpenRouter's Jev Decisions route and
completed successfully. The new run measures the requested
`typesafe/jev-latest` route through OpenRouter on the same 32 development cases,
question hash, and thresholds as the retained baseline; the actual serving
version and paired results are recorded below. Jeverb's earlier OpenRouter Jev
path used chat-completions to ask a generative model to imitate Jev's typed
interface; that is the wrong protocol for measuring Jev. The corrected path
sends the original typed `state` and `questions` to OpenRouter's native
Decisions API and retains the returned serving model and request ID. The
generic chat adapter remains separate for ordinary generative models. The
lockbox runner uses the native Jev path and disables retries so its request
ceiling is explicit.

There is also a retained 11-case OpenRouter `typesafe/jev-router` closure
probe on the same question hash. It returned 7/11 exact labels (2/2 COMPLETE,
2/2 BLOCKED, 1/2 INCOMPLETE, and 2/5 INSUFFICIENT_EVIDENCE), with no transport
or parse failures. It used the old chat-completions imitation adapter, one
closure call per case, a different dataset, and no integrated threshold
stage; it is diagnostic evidence about that adapter run, not a Jev native
result or a comparable before/after score.

## Historical 13/64 root cause

The final v3 run has 217 labeled cases: 64 `COMPLETE`, 95 `INCOMPLETE`, 50
`INSUFFICIENT_EVIDENCE`, and 8 `BLOCKED`. Its bytes match the sealed freeze
record. The receipt verifier passed with zero errors. Every one of the 64
positive cases passed deterministic preflight; none was stopped before model
review.

| Stage/result | Count | Interpretation |
|---|---:|---|
| Model-only selected `COMPLETE`, positive cases | 62/64 | The two remaining model-only calls selected `INCOMPLETE`. |
| Integrated terminal completion, positives | 13/64 (20.31%) | Below the fixed 95% liveness gate. |
| Integrated `threshold_hold`, positives | 49/64 | All 49 had integrated confidence below 0.90. In 37, both confidence and P(COMPLETE) were below 0.90; in 12, confidence was below 0.90 while P(COMPLETE) was at least 0.90. |
| Integrated semantic refusal, positives | 2/64 | Both selected `INCOMPLETE`; these are actual semantic misses. |
| Integrated transport/protocol/model errors | 0 | No timeouts, transport errors, or invalid judgments explain the liveness result. |
| Model-only false `COMPLETE` votes, all non-COMPLETE cases | 56/153 | Raw model judgment is unsafe to use as terminal authority. |
| Integrated false terminal completions | 0/153 | The deterministic preflight and confidence gate prevented them in this run. The recorded one-sided 95% upper bound of 1.94% assumes independent cases. |

The full confusion counts distinguish raw semantic choice errors from the
integrated gate's conservative holds:

| Expected | Model-only `COMPLETE` | Model-only `INCOMPLETE` | Model-only `BLOCKED` | Model-only `INSUFFICIENT_EVIDENCE` | Integrated `COMPLETE` | Integrated `INCOMPLETE` | Integrated `BLOCKED` | Integrated `INSUFFICIENT_EVIDENCE` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| COMPLETE (64) | 62 | 2 | 0 | 0 | 13 | 2 | 0 | 49 |
| INCOMPLETE (95) | 45 | 46 | 0 | 4 | 0 | 92 | 0 | 3 |
| BLOCKED (8) | 5 | 0 | 3 | 0 | 0 | 0 | 8 | 0 |
| INSUFFICIENT_EVIDENCE (50) | 9 | 29 | 0 | 12 | 0 | 30 | 0 | 20 |

Of the 49 positive threshold holds, integrated confidence ranged 0.31–0.89
(mean 0.733), while P(COMPLETE) ranged 0.48–0.92 (mean 0.80). The two
semantic refusals were `f3-log-retention-full-complete-v0` (INCOMPLETE, 0.81
confidence, P(COMPLETE)=0.07) and `...-v2` (INCOMPLETE, 0.87,
P(COMPLETE)=0.05). These are semantic misses, unlike the 49 confidence holds.

For scale only, a naive Wilson 95% interval for 13/64 is 12.3%–31.7%; it
assumes independent cases and is not a valid interval for these clustered
variants. At the domain level, 6/16 domains had any completed variant (naive
Wilson interval 18.5%–61.4%), which is a different outcome measure and also
does not account for domain sampling uncertainty.

The dominant cause of the 13/64 result is therefore **the pinned model's low
confidence on positive completions under the unchanged dual 0.90 threshold**.
The gate behaved as specified; lowering it would weaken the release contract.
There were also two semantic refusals and broad raw model-only class errors.
The failure is not attributable to transport, parsing, question-hash binding,
or preflight on this recorded run. The model-only and integrated calls are
separate provider requests, but they use the same state and question: direct
comparison against the production `affirmativeRequest` builder found zero
state differences across all 281 development, validation, and final v3 cases.
Their confidence can still vary between calls, so model-only accuracy cannot
be substituted for integrated liveness.

The 64 positives are four variants of each of 16 mission domains. They are
clustered observations, not 64 independent positive tasks: only 6 of 16 domains
had any integrated completion, and 10 had none. A case-level binomial interval
would overstate precision. The lockbox labels are described by their builder as
hand-authored; preflight expectations are checked during construction, but no
independent adjudication record is retained. The sealed results are useful
diagnostic evidence, not independently labeled ground truth. The row-level
failure appendix lists each model-only or integrated miss with its label,
objective, criterion evidence, confidence, result, and failure class:
[v3 r1 failure rows](../bench/analysis/mission-completion-lockbox-v3-r1-failures.csv).

## Identity and harness correction

The old receipts consistently report backend `jev-gateway`, requested model
`typesafe/jev-1.14`, and returned model version
`typesafe/jev-1.14-20261014`. The receipts do not carry provider metadata.
However, every retained `modelRequestId` and `integratedRequestId` from the
217-case final run (358 actual calls) and 32-case development baseline (54
actual calls) exactly matches Locus's `incoming_request_id`, which its source
sets from `X-Request-ID`. All matched records identify provider
`openrouter_jev`, endpoint `/jev/api/alpha/decisions`, model
`typesafe/jev-1.14`, upstream/downstream HTTP 200, and final outcome
`success`. At Locus commit `7796207f`, the `jev` environment maps to
`openrouter_jev`, whose adapter forwards typed Decisions requests to
OpenRouter. This establishes the provider path and successful HTTP delivery
for the historical evaluation without rewriting its receipts. The new native run records
backend `openrouter`, requested alias `typesafe/jev-latest`, returned model
`typesafe/jev-1.14-20261014`, provider request IDs, per-call usage/cost, and
latency. The retained eight-case demo artifact likewise reports backend
`jev-gateway` and returned
model `typesafe/jev-1.14-20261014`; it records eight prompt cases, 4,427 input
tokens, and 444 output tokens, with mission completion explicitly
`not-evaluated-by-demo-graph`. It reports 8/8 expected routing decisions, but
its task, case set, and success criterion differ from the 13/64 closure
evaluation. Its `questionSetIdentity` field contains a per-case question
hash; those identities do not match the frozen mission-closure question hash,
so it cannot establish question-level equivalence. The corrected OpenRouter
Jev adapter sends typed questions through `/api/alpha/decisions`, uses the
response's `model` field as the serving identity, retains its `id` as the
provider request id, and rejects a successful response missing either field.
OpenRouter documents this Decisions API's typed request/response contract and
its returned `model` identity in the
[API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request).
Lockbox row v3 now records each call's provider, serving model, question hash,
request id, token usage, provider-reported cost where available, latency, and
model-only probabilities; its verifier checks those bindings. Historical v1
and v2 receipts remain verifiable without being rewritten.

The lockbox CLI's OpenRouter path now defaults to `typesafe/jev-latest`,
`openrouter`, and zero retries. Its unscored identity probe pins the observed
serving identity; an explicit `--model-version` must match. If later calls
resolve to a different version, the integrated binding rejects them; this is a
qualification miss, not a reason to relabel the response. Direct OpenRouter mission closure was
hard-disabled in runtime configuration and terminal receipt validation, so a
three-stage OpenRouter run could not become a product result even after
qualification. That integration defect is now corrected: OpenRouter closure
can be admitted only by its own verified manifest, exact requested and
returned model identities, question hash, policy hash, provider request id,
and unchanged release thresholds. Without that provider-specific evidence it
remains uncalibrated. Protected graph routing still requires its separate
consequential-routing qualification.

The OpenRouter lockbox runner now makes one unscored identity probe when no
serving-version pin is supplied, records its provider, returned model, request
id, question hash, usage, and latency in the run summary, and uses that
returned model id as the exact pin for scored calls. A later identity change
stops the run. An explicitly supplied `--model-version` must match the probe.
Jev aliases are canonicalized to OpenRouter's `~typesafe/jev-latest` slug for
this native Decisions request; the observed response model is separately
bound as the exact serving version.

The question/evidence contract remained the frozen v3 contract during this
run: question hash
`6714d6c0af29dd7eea06eb4b658a686035d96b25b5b03ead11c503507699df63`, with
the existing lockbox-to-`MissionClosureEvidence` mapping. Lockbox row v3 is a
separate evidence-schema revision; it does not change the question identity or
historical records. Any future prompt/evidence change must receive a new
question hash and qualification identity.

## Jev to graph boundary

The runtime already has a guarded path for actual Jev branch selection:
`src/graph/executor.ts` reads typed verdict/choice/score answers from a
successful Jev node, requires the configured branch and confidence threshold,
and records a skipped node when the condition does not qualify. Before
execution of a protected successor, `src/tools/execute-graph.ts` loads an
operator-provisioned routing manifest and re-verifies its dataset, receipts,
backend/model/adapter identity, question-family hash, and active policy hash.
The executor's deterministic authorizer still decides whether the command is
allowed; Jev's branch choice cannot grant shell permission. Missing or stale
qualification means no protected branch execution.

During the current DAG wiring audit, a regression exposed an indirect-admission
gap: a Jev-conditioned non-shell node could succeed, then a dependent shell
could run through `whenAll` without the Jev branch itself passing routing
qualification. `executeGraph` now checks whether a Jev-conditioned node has a
shell descendant (including a shell inside a dependent expansion template) and
applies consequential-routing admission at that branch. The regression asserts
that the Jev branch, dependent shell, and shell attempts all remain skipped
without admission. This closes that specific executor path; it does not create
a routing qualification or establish model quality.

The executor also rejects a function-valued shell predicate when the DAG
contains any Jev node. Such callbacks can inspect every prior result, so the
runtime cannot bind their decision to a qualified typed answer. Callers must
use a declarative decision condition for model-dependent shell gates; callbacks
remain available for shell graphs without Jev nodes.

The architecture has regression coverage in `tests/tools/execute-graph.test.ts`,
`tests/graph/routing-enforcement.test.ts`, and qualification/admission tests.
Those tests establish local boundary behavior. The deterministic graph demo
also traversed the current task and verification path, but used fixture Jev
answers and a host-approved task. A bounded live trace in
[`jev-live-graph-integration-2026-11-03.json`](../bench/results/jev-live-graph-integration-2026-11-03.json)
used two real OpenRouter Decisions calls through `jev_execute_graph`: the
requested alias resolved to `typesafe/jev-1.14-20261014`, Jev selected `defer`,
and the runtime executed only the defer branch. This confirms advisory graph
traversal for that trace. No routing manifest or independently labeled
60-case graph-route evaluation exists, so consequential traversal remains
unqualified.

## Evidence matrix

### Separate release verdicts

| Axis | Verdict | Evidence boundary |
|---|---|---|
| Architecture correctness | **Prior baseline qualified; current DAG admission regression fixed and independently retested.** | Graph traversal, branches, journals, authorization, and verification have local coverage. The new regression demonstrated that a Jev-conditioned non-shell node could indirectly release a dependent shell; the executor now treats that branch as consequential. This does not qualify Jev's route judgments. |
| Local end-to-end integration | **Deterministic fixture lifecycle passed.** | Real graph execution, independent checks, false-claim rejection, and uncertain-run recovery were exercised; Jev answers were fixtures. |
| Consequential-routing model | **Unqualified.** | One live advisory graph trace exists, but no independently labeled branch-routing dataset or consequential-routing qualification manifest exists. |
| Mission-closure model | **Rejected at current release floor.** | Historical 13/64 liveness; same-split native OpenRouter run reproduced 2/12 positive completion with no decision changes. |
| Integrated live Jev graph execution | **Partial integration evidence; not qualified.** | A bounded two-call trace used the actual graph tool and Jev selected an advisory defer branch. No consequential route or shell execution was attempted. |
| Installed-host enforcement | **OFF / unqualified.** | The rebuilt candidate is installed and hook/MCP hashes match the build, but Muse reports zero effective hook/MCP capabilities and the protected switch is absent. Historical logs contain no attributable provider/model judgments or graph-route traces. |
| Production readiness | **NO.** | Routing, closure, live integrated behavior, and installed-host requirements remain unmet. |

| Requirement | Evidence available in this checkout | Verdict and boundary |
|---|---|---|
| Graph traversal correctness | `src/graph/*`; runner, loops, resume, branch, and graph-execution tests; prior local qualification at `75d4e45` | **Prior local qualification plus a fixed transitive branch-admission regression.** The branch and dependent shell are skipped without admission; focused tests and type-check pass. No current qualified Jev decision is bound to a consequential graph transition. |
| Authorization and enforcement | graph admission/policy/routing enforcement; master-switch, tool, and stop policy tests | **Local boundary tests pass; not host-qualified.** Protected host switch is absent and runtime is OFF. |
| Durability and recovery | graph journal, receipts, resume/reconcile code and tests | **Local boundary tests pass; not installed-host-qualified.** No live-host crash recovery canary. |
| Independent verification | verifier registry, host-verification pipeline, verified-completion gates, mission receipt tests | **Local tests and deterministic demo pass; not live-model-qualified.** No current model-conditioned lifecycle proves the installed verifier path. |
| Jev consequential graph-routing judgment quality | `prompt-routing-v1` measures prompt intent for `UserPromptSubmit`, not graph branch selection; routing admission/floor code and fixtures exist, but no independently labeled consequential-route dataset or model receipts bound to branch decisions exist | **Unqualified; no suitable dataset yet**. |
| Jev mission-completion judgment quality | v3 gateway receipts, OpenRouter native Decisions API run, row-level same-split comparison | Historical pinned gateway candidate **rejected** at 13/64 liveness. Latest alias resolved to the same Jev 1.14 version; OpenRouter candidate scored 19/32 model-only, 16/32 integrated, and 2/12 positive completions on development, exactly matching all baseline choices/outcomes. **No improvement measured; not qualified.** |
| Integrated live-model execution | native OpenRouter model calls reached the real `decideMissionClosure` entry point in the lockbox; separate two-call graph trace used the real tool and actual Jev typed choices to execute an advisory defer branch. Deterministic fixture graph demo verifies independent checks, false-claim rejection, and recovery boundaries. | **Partial integration evidence; not qualified.** No consequential route or shell execution was attempted; the model remains unqualified. |
| Installed-host enforcement coverage | Muse install metadata says Jeverb 0.1.0 is enabled, with 5,722 decision records and 122,776 evidence records from Oct 29–Nov 1 (1,673 and 11,534 distinct session IDs respectively). Every retained `PreToolUse` and `Stop` decision is an error, mostly unexpected status from `/api/alpha/decisions`; the gateway's upstream provider and numeric statuses are absent. The rebuilt candidate is now installed at package hash `6dd9e05d…` and its hook/MCP bundle hashes match the build. Muse still reports zero effective hook/MCP capabilities due store-lock and inventory-integrity diagnostics; protected switch state is absent, so enforcement remains OFF. The inspected host exposes one global manifest/data root that may be shared by several Muse instances. | Historical hook activity and errors are **verified**; fresh package installation is **verified**; effective enforcement, attributable model decisions, and separate per-instance coverage remain **unproven/OFF**. No production-readiness claim. |

### Installed Muse telemetry checked read-only

The install manifest at `~/.local/share/muse/plugins/installed.json` records
Jeverb 0.1.0 as enabled and points to a local package. Its install-scoped
`decisions.jsonl` contains 5,722 parseable events, including 3,610
`PreToolUse` entries and 1,906 verification entries, across 1,673 session IDs.
Its `evidence.log` contains 122,776 parseable records across 11,534 session
IDs, spanning Oct 29 through Nov 1: 74,487 `observed`, 36,949 `advise`, 11,277
`continue_work`, 53 `deny`, and 10 `error` enforcement values. This proves
that installed hooks wrote substantial persistent telemetry. These are
self-reported plugin records; their volume does not by itself prove that a
protected action was blocked or that independent verification succeeded.

The data directory also has a legacy `disabled` marker. Source inspection
confirms the current switch ignores that marker and reads only the protected
service state. `/var/lib/jeverb/control-state.json` and `/var/lib/jeverb/` are
absent on this host, and a missing/unknown protected state is effective OFF.
The manifest's enabled bit does not mean current enforcement is active. On
2026-11-03, after the user requested installation, `muse plugins update jeverb`
refreshed the enabled user-scope package from `dist/muse-plugins/jeverb` to
package hash `6dd9e05d42ff0fb90ab905404f652033a770d859f71397b45d51cd01c24183e5`.
The installed hook and MCP bundle hashes match the rebuilt candidate, and
`harness/muse-hook-qualification.sh --check-only` confirms 17 hooks without
invoking one. Muse still reports zero effective capabilities because the
installed-store lock and agent-definition inventory checks fail. No capability
approval or Muse session restart was performed. The operator reports Jeverb
has been installed in several Muse instances; the inspected host has one global
plugin manifest/data root, which may be shared by multiple app instances, so
the logs cannot count instances or attribute individual sessions to them.

The old plugin did log extensively. The installed config used backend
`jev-gateway`, requested model `typesafe/jev-1.14`, and a loopback gateway URL;
this does not identify the gateway's upstream provider. The 5,722-row decision
log contains 3,610 `PreToolUse/error` and 32 `Stop/error` records. A sanitized
classification of those errors found 3,591 messages saying TypeSafe returned
an unexpected status from `/api/alpha/decisions` (3,560 PreToolUse, 31 Stop),
40 aborts (39 PreToolUse, one Stop), and 11 JSON parse failures. There are no
successful PreToolUse or Stop decisions in this log. The old installed source
did not retain the numeric status, so the exact HTTP failure cannot be
reconstructed; the message alone does not prove a particular redirect or
upstream cause. The old receipts lack the status needed to distinguish the
response class.

Among 122,776 evidence records, 284 say `MODEL_NOT_CONFIGURED`; the 3,610
`JUDGMENT_ATTEMPTED` markers mean an attempt produced no classified result,
not that a valid model judgment was recorded. The decision log has a `model`
field on only two rows, both `stub-muse-hook`, and has no provider/backend
fields. No `tool_name` identifies a graph, Jev, mission, next-step, or
verification tool. These logs prove long-running installed hook activity and
durable logging while revealing a broad decision-endpoint error pattern; they
do not provide model-quality or graph-routing receipts. A content-redacted
summary with source hashes is retained in
[installed-muse-telemetry-audit-2026-11-03.json](../bench/results/installed-muse-telemetry-audit-2026-11-03.json).

## Current Locus gateway check

After the operator reported that the new gateway was up, a read-only GET to
`127.0.0.1:18769/__locus_gateway_health` returned `200 ok`. The documented
readiness GET returned HTTP 200 but `status=unknown`, `configured=false`, and
no provider entries. This confirms process liveness only; the running
OpenRouter route and its credential binding are not health-verified. No model
request was sent. The local Locus checkout was clean at
`7796207f9bbf0650306b06f2ed6fff782723a154`. Its source includes Jev Latest in
the OpenRouter Decisions provider and routes `/<environment>/api/alpha/decisions`
to the configured upstream; it also requires a separate `LOCUS_JEV_API_KEY`
and refuses to reuse `LOCUS_OPENROUTER_API_KEY`. Those source facts do not
prove which upstream the running process has configured. The sanitized probe
and source-hash record is
[locus-gateway-status-2026-11-03.json](../bench/results/locus-gateway-status-2026-11-03.json).
Use a bounded provider identity probe through the configured gateway before
counting its output as the requested OpenRouter Jev candidate.

A later read-only recheck at 22:03:51 UTC received connection refused on the
same loopback health endpoint; no matching process or listener was visible.
The user service manager could not be queried because its bus denied access.
This supersedes the earlier liveness observation for current availability; no
restart or inference request was attempted.

At 22:29:11 UTC, a read-only `GET https://openrouter.ai/api/v1/key` using the
shell's `OPENROUTER_API_KEY` returned HTTP 200. Its suffix matched the
operator-specified key rule. OpenRouter reports a $2 weekly key spending
limit and $1.963042352 remaining ($0.036957648 used this week). No inference
request was made. This establishes that this shell key is not at its spending
limit. It does not establish the status of Locus's separate
`LOCUS_JEV_API_KEY`, which was not present in this shell, or which credential
the stopped gateway had loaded. A sanitized snapshot is retained at
[openrouter-key-status-2026-11-03.json](../bench/results/openrouter-key-status-2026-11-03.json).

The retained gateway request log provides additional historical provider
evidence. A content-free streaming audit of its 853,659,624 bytes found 3,638
requests through provider `jev` to `/jev/api/alpha/decisions`, requested model
`typesafe/jev-1.14`, with OpenRouter upstream status 403 and
`quota_exhausted`: 3,561 on Oct 30 and 77 on Oct 31 UTC. The installed Muse
decision log records 3,519 unexpected-status errors on Oct 30 and 72 on Oct
31. Those same-date counts are close (47 fewer Muse errors); the Muse rows
contain no timestamp, request ID, trace ID, or provider identity, so they
cannot be joined one-to-one. This is strong evidence that quota exhaustion
caused most of the old endpoint failures, while the precise attribution of
each hook error remains unproven. It is a runtime/provider failure, separate
from the 13/64 semantic liveness result.

The same gateway log contains 1,123 requests through `openrouter_jev` for that
endpoint and model: 1,113 on Nov 2 and 10 on Nov 3. Exact correlation matches
all 358 calls from the 13/64 final run and all 54 calls from its development
baseline to Nov 2 records, with no unmatched or duplicate IDs. Every matched
request has upstream and downstream status 200 and final outcome `success`.
The other 711 successful requests do not match these benchmark runs. The
reproducible, content-free join is retained in
[jev-gateway-receipt-correlation-2026-11-03.json](../bench/results/jev-gateway-receipt-correlation-2026-11-03.json);
the CLI keeps IDs in memory and emits only hashes and aggregates. The process
is currently unavailable at the last recheck. The hash-bound,
content-redacted aggregate is
[jev-gateway-request-audit-2026-11-03.json](../bench/results/jev-gateway-request-audit-2026-11-03.json);
its source is the shared gateway request log, so its rows are not attributed
to a particular Muse instance.

Static comparison of the active installed hook bundle and workspace candidate
explains why the old logs hid this likely cause. Installed
`jeverb-0.1.0-5ea8cd87`'s hook bundle (SHA-256
`2cd9ff2888c78f2d9b8cdc249f7e0fb596b1fa65663791fd3b38dff11c9fdcfc`)
has no HTTP 403 branch in its Jev client: it falls through to the generic
"unexpected status" error. The workspace candidate includes explicit
quota/entitlement and forbidden-response classification; the shared client
retains status 403 and sanitized provider diagnostics. A regression in
`tests/jev/gateway.test.ts` supplies a 403 quota response and verifies a
`JevQuotaError` with status 403. The focused gateway and telemetry tests pass
(7 tests), type-check passes, and `git diff --check` passes. This improves
diagnosis in the uninstalled candidate; it does not repair the already
installed plugin or improve Jev's measured completion decisions.

These architecture verdicts are repository-level evidence. Final local gates:

- `npm run test:run`: full Vitest suite passed (190 files, 3,044 tests) and
  control-service unittest suite passed (44 tests). Loopback, subprocess, and
  sandbox-dependent tests required the authorized elevated test run because
  the default sandbox denied those operations.
- Focused OpenRouter, lockbox, qualification, closure, receipt, and manifest
  suites passed 92/92. The local HTTP-stub identity-probe regression passed 1/1.
- `npm run type-check`, the full `npm run build`, `npm run
  plugin:integrity-check`, and `git diff --check`: passed after the current
  changes. The build and integrity commands required elevated local socket
  access because the sandbox denied tsx's IPC socket.
- The historical v3 final receipts still verify against the frozen dataset and
  original policy: 217 cases, `ok: true`, 123 model-only correct, 133
  integrated correct. The sealed dataset and label hashes remain unchanged.

These gates establish repository behavior only. They cannot substitute for
model or installed-host evidence.

## Evaluation validity and comparison rules

The v3 development and validation files each contain 32 cases, 12 positive,
with 22 cases labeled preflight-ready. The bounded three-stage protocol makes
at most 54 scored model calls per development split (32 model-only plus 22
integrated). The OpenRouter runner adds one unscored identity probe, making
the total ceiling 55 provider calls.

The retained baseline manifest
`mission-completion-dev-v3.jevgateway-3stage-r1` binds the same development
dataset hash (`e91a505a…`), mission-closure question hash
(`6714d6c0…`), and 0.90 confidence/probability thresholds used for the
OpenRouter candidate. Baseline results: 19/32 model-only judgments correct
and 16/32 integrated judgments correct; 2/12 positive cases reached integrated
`COMPLETE` (16.7%); 0 false terminal
completions among 20 negatives; 12 threshold holds; 8 semantic refusals; and
0 invalid/model-error cases. By expected class, model-only results were
COMPLETE 12/12, BLOCKED 2/2, INCOMPLETE 5/14, and
INSUFFICIENT_EVIDENCE 0/4. The integrated stage correctly classified 16/32:
COMPLETE 2/12, BLOCKED 2/2, INCOMPLETE 12/14, and
INSUFFICIENT_EVIDENCE 0/4. The run is already rejected at the configured
release gate. The native OpenRouter candidate returned the same aggregate
metrics: 19/32 model-only, 16/32 integrated, 2/12 positive completions, 0/20
false terminal completions, 12 threshold holds, 8 semantic refusals, and zero
errors. The raw model-only stage voted false `COMPLETE` on 9/20 non-complete
cases; deterministic preflight and the confidence gate prevented false
terminal completion in the integrated result. It matched the baseline's model choice, integrated choice, and
integrated outcome on all 32 cases. Thus the candidate shows no decision-
quality improvement on this split. The labels are not independently
adjudicated, so this is diagnostic evidence rather than qualification or proof
of generalization. The paired per-case responses and criterion evidence are in
[the comparison table](../bench/analysis/mission-completion-dev-v3-openrouter-2026-11-03-comparison.csv).

| Development metric | Gateway baseline | Native OpenRouter Jev Latest | Change |
|---|---:|---:|---:|
| Model-only accuracy | 19/32 | 19/32 | 0 |
| Integrated accuracy | 16/32 | 16/32 | 0 |
| Positive completions | 2/12 | 2/12 | 0 |
| False terminal completions | 0/20 | 0/20 | 0 |
| Threshold holds | 12 | 12 | 0 |
| Semantic refusals | 8 | 8 | 0 |
| Provider/protocol errors | 0 | 0 | 0 |
| Per-case model/integrated decisions and outcomes agreeing | — | 32/32 | exact match |

Confidence values shifted without changing decisions: mean absolute paired
change was 0.0294 for model-only confidence and 0.0423 for integrated
confidence. Integrated confidence was lower by 0.0177 on average. These shifts
do not improve liveness under the unchanged 0.90 threshold.
The development set has only six distinct objective clusters (two positive
variants each). A 100,000-resample percentile bootstrap by exact objective
text gives 95% intervals of 48.4%–69.7% for model-only accuracy,
36.7%–60.6% for integrated accuracy, and 0%–33.3% for positive completion
rate. Six clusters and non-adjudicated labels are too weak for release
inference; these intervals describe sampling uncertainty only.
Descriptive probability metrics (multiclass Brier / log loss / five-bin
top-label ECE) were 0.5691 / 1.1145 / 0.1584 for the candidate's 32
model-only votes and 0.3395 / 0.6892 / 0.0759 for its 22 integrated raw
votes. The gateway's 22 integrated raw votes scored 0.3305 / 0.6734 / 0.1700.
The small sample and authored labels make these calibration differences
inconclusive; they do not establish a confidence-policy improvement.
The repository's independent `jev-verify-lockbox.ts` recomputation returned
`ok: true`, zero errors, and the same 19/32 and 16/32 counts for the retained
baseline receipts.

The separate retained validation split was also independently recomputed:
19/32 model-only correct, 18/32 integrated correct, and 2/12 positive cases
completed. It uses the same pinned gateway model and thresholds and predates
the current candidate changes, so it is a historical generalization check, not
a validation of the new OpenRouter alias. The 217-case final receipt set
independently recomputes to 123/217 model-only correct and 133/217 integrated
correct, with 13/64 positive completions and zero false terminal completions
among 153 negatives. All four verifier runs (the three retained splits and
the new OpenRouter development run) returned `ok: true` with zero
errors and the frozen dataset revisions.

The lockbox model request carries the case state and question; the benchmark
case ID is used for receipt/evidence correlation and is not included in the
affirmative production request. The v3 question and 0.90 decision thresholds
remain unchanged for this comparison. This comparison measures the model and
provider path at mission closure. It does not measure graph traversal, shell
authorization, host enforcement, or installed lifecycle behavior. Those are
separate architecture and deployment claims.

The lockbox runner disables hidden retries and stops on request errors or
identity mismatch. It stops before the integrated call after a model-only
error or binding mismatch, and stops on false integrated `COMPLETE`. Native
Decisions requests carry the original structured state/questions; there is no
chat `max_tokens` cap or generated JSON to parse. The exact serialized native
request bodies total 88,067 characters across the 55-call ceiling. The actual
run used all 55 requests, with no retries or early stop. OpenRouter reported
39,921 input tokens, 3,154 output tokens, and $0.001676682 total cost across
55/55 responses. Latency was 119 ms minimum, 186 ms p50, 289 ms p95, and 519
ms maximum. The pre-run character-to-token estimate (17.6k–29.4k input tokens,
$0.00074–$0.00124) was low; use provider-reported usage/cost for this run.
OpenRouter's current Jev Latest page resolves the alias to Jev 1.14 and states
the alias has no fixed price; the serving-model price applies. Jev 1.14 is
currently listed at $0.042/M input and free output. See [Jev
Latest](https://openrouter.ai/~typesafe/jev-latest/) and [Jev 1.14
pricing](https://openrouter.ai/typesafe/jev-1.14/).

`prompt-routing-v1.jsonl` has 16 authored cases for prompt-intent
classification. It is useful only for that advisory task. It does not label
the runtime graph's consequential `decision.verdict`, `decision.choice`, or
`decision.score` branches. The routing release floor is 60 cases at 90%
accuracy, and no independent routing case pool or corresponding model
receipts are present. Do not treat this prompt-intent corpus or the
corrective-action family as consequential-routing qualification.

Development is the only split suitable for iteration. Validation can assess
generalization after one development change. The frozen final split must stay
untouched until a separately authorized final evaluation. Before treating
results as qualification, the labels need blinded independent adjudication,
and repeated variants must be analyzed by mission-domain cluster as well as
case. Report class accuracy, false-COMPLETE rate, liveness, deferrals,
invalid responses, provider errors, confidence, and token/latency summaries.

The current v3 completion set has 32 development cases, 32 validation cases,
and 217 final cases, but its builder-authored labels have no retained
independent adjudication. Keep those results as historical diagnostics. For a
release evaluation, obtain two blind, independent annotations per case from
the objective, acceptance criteria, task results, verifier evidence, and
contradictions; resolve disagreements with a third adjudicator before any
model output is shown. Split by mission domain and underlying scenario before
annotation so variants cannot cross development, validation, and sealed final.
Preserve the existing question/evidence contract until the same-split target
run identifies a justified change; any change gets a new question hash and
qualification identity. The completion release floor remains 60 positive
`COMPLETE` cases, 149 non-COMPLETE cases, zero false terminal completions, and
at least 95% positive liveness.

The locally actionable label-process defect is partly corrected:
`src/jev/annotation.ts` and `scripts/jev-annotation.ts` now create randomized
answer-free packets from labeled or unlabeled choice cases, keep source IDs in
a separate mode-0600 key, validate distinct reviewers' rationales and
evidence citations, and retain their independent judgments in an audit
sidecar. Unresolved disagreements do not produce a labeled dataset; a distinct
third adjudicator can resolve them. Regression tests cover redaction,
unlabeled intake, provenance binding, agreement, disagreement, and
adjudication. This is annotation infrastructure, not independent labeling: no
reviewers have supplied labels, and the existing v3 cases have already been
seen by Jev. Their re-labeling could audit historic ground truth but cannot
make those cases a fresh sealed test. See
[INDEPENDENT-ANNOTATION-PROTOCOL.md](INDEPENDENT-ANNOTATION-PROTOCOL.md).
An answer-free historical label-audit packet for all 217 final v3 cases is
prepared at
[mission-completion-lockbox-v3-final-blind-audit.json](../bench/annotation/mission-completion-lockbox-v3-final-blind-audit.json).
Its key remains local with mode 0600; those cases are excluded from any future
sealed qualification.

For consequential routing, build a separate dataset from the actual runtime
`decision.verdict`, `decision.choice`, and `decision.score` branch contracts.
Each case needs the proposed transition and available authorized alternatives,
dependency/verification state, expected typed model judgment, and an
independent policy-grounded rationale. Labels must distinguish a valid route
proposal from deterministic execution authorization. Use the same blind
two-annotator plus adjudicator process and domain-disjoint splits. The current
route floor is at least 60 measured judgments at 90% accuracy; report each
class, deferrals, invalid/provider errors, false route proposals, and any
downstream protected action that reached the authorizer. No route pool meeting
this contract exists in the checkout, so live routing calls were excluded from
the completed closure-only run.

The same-split comparison is now measured. OpenRouter resolved
`typesafe/jev-latest` to `typesafe/jev-1.14-20261014`, the version reported by
the old gateway receipts. Exact model-only and integrated choices and all
integrated outcomes matched on all 32 cases; aggregate correctness and
2/12 positive liveness were unchanged. The exact request-ID join now
establishes that the old gateway baseline used the same OpenRouter Jev
Decisions provider route with successful HTTP delivery. This establishes no
quality gain on the measured development set.

The candidate's deterministic graph lifecycle demo was run after the local
gates: all 8 advisory fixture decisions matched, with zero unauthorized
executions; the host-authorized task traversed prepare, generate, two
independent verifiers, and join, then closed from deterministic fixture
judgment. A mutated output failed verification and blocked closure; an
uncertain execution stayed blocked on replay without retry; a privileged
command was refused before execution. This is direct evidence for the
candidate graph and evidence wiring, not a Jev-selected transition, a
comparison against the installed version, or qualification.

## Findings and dispositions

| Finding | Disposition | Reopen condition / action |
|---|---|---|
| The enabled MuseFI package cache was stale relative to the validated candidate. | **FIXED** | `muse plugins update jeverb` refreshed the package from `dist/muse-plugins/jeverb`; registry hash is `6dd9e05d…`, and installed hook/MCP hashes match the build. Muse still exposes zero runtime capabilities because of the reported store-lock and inventory-integrity diagnostics. Reopen after those host diagnostics clear, then verify an actual Muse session. |
| A Jev-conditioned non-shell node could indirectly release a dependent shell through `whenAll` without routing qualification. | **FIXED** | Reproduced in `tests/graph/routing-enforcement.test.ts`; executor now classifies Jev branches with shell descendants as consequential. The regression and routing-admission tests pass after the change. Reopen if dependency or expansion traversal semantics change. |
| A function-valued shell predicate could inspect Jev outputs without a bound typed routing condition. | **FIXED** | The executor skips dynamic shell predicates when the graph contains Jev nodes; a regression asserts the callback never runs and no shell attempt is made. Declarative conditions remain the admitted model-routing form. |
| The 13/64 liveness result is chiefly confidence-threshold holds on a pinned gateway model. | **DEFERRED** | Receipt analysis attributes 49/64 positive misses to threshold holds and 2/64 to semantic refusal; transport/protocol errors were 0. The native OpenRouter dev run reproduced the exact baseline decisions and outcomes. The low-liveness behavior remains unresolved; revisit question/evidence changes after independent label adjudication and only on development data. |
| Different model-only and integrated state construction could explain the positive confidence gap. | **VERIFIED NON-ISSUE** | Comparing `affirmativeRequest(lockboxEvidence(case))` with each dataset model-only state found exact JSON equality for all 281 development, validation, and final v3 cases; the same question hash is independently verified. The stages are separate calls, so score variation remains model response variance, not a lockbox state transformation. |
| OpenRouter adapter and calibration runner treated requested/display names as serving identity; closure config and receipts excluded OpenRouter even under provider-specific qualification. | **FIXED** | Reopen if provider response schema changes; regressions cover serving identity, request id, exact closure binding, manifest admission, and fail-closed unqualified behavior. |
| OpenRouter Jev evaluation used chat-completions prompt-and-parse rather than Jev's native typed Decisions API, so its probabilities were not Jev judgments and could not support Jev qualification. | **FIXED** | Native adapter sends typed state/questions to `/api/alpha/decisions`; generic chat adapter stays separate. Native endpoint, model/request identity, response usage/cost, factory selection, the full 3,044-test suite, build, plugin integrity check, and the 55-response live run were independently verified. Reopen if the provider response contract changes. |
| No repeatable blind annotation path existed for independent ground-truth review. | **FIXED** | The blind packet/reconciliation CLI and protocol are implemented; four unit tests, CLI smoke, source/key binding, reviewer separation, agreement and disagreement handling, and private key modes passed. This fixes the workflow gap only; actual independent labels remain deferred. |
| Installed Muse hook telemetry was interpreted as successful model operation. | **VERIFIED NON-ISSUE** | Logs show 3,591 unexpected-status errors, 40 aborts, and 11 JSON parse errors across 3,642 decision error records; every PreToolUse and Stop decision record is an error. The new report does not count attempted hooks as successful judgments. |
| Old Muse unexpected-status errors were caused by Jev model judgments. | **DEFERRED** | Gateway records show 3,638 OpenRouter 403 quota-exhaustion responses on Oct 30–31, while Muse records 3,591 generic unexpected-status errors on those dates; the installed bundle maps 403 to that generic error. This strongly implicates quota exhaustion in the old hook errors, but those Muse rows lack timestamps/request IDs for exact joining. This is separate from the 13/64 evaluation: its 358 calls join exactly to successful HTTP 200 gateway records. Gateway operator to retain correlation IDs for future Muse hook events. |
| Installed Jev client diagnostics hid upstream quota responses as unexpected statuses. | **DEFERRED** | The active installed 0.1.0 bundle has no 403 classification and maps it to the generic unexpected-status error. The workspace candidate classifies the same quota response as `JevQuotaError` (status 403), independently verified by the focused gateway regression. The rebuilt bundle is now installed in Muse and hash-matched to the candidate; no live hook request can run while effective capabilities remain zero. Reopen after host inventory is repaired and the installed diagnostic is exercised. |
| Historical Muse telemetry establishes actual Jev decisions and consequential graph behavior. | **DEFERRED** | Read-only reanalysis proves hook/log activity but finds no attributable provider, actual model response, or graph-route trace; model identity exists on only two rows and is the test stub. Reopen with an installed-version trace binding provider/model request, graph branch judgment, deterministic authorization, execution, journal, verifier, and closure. |
| New Locus gateway is currently operational for Jev requests. | **DEFERRED** | Exact request-ID joins prove successful OpenRouter Jev delivery for every call in the 13/64 final run and its development baseline on Nov 2. The latest health recheck got connection refused; the earlier readiness response reported `configured=false`. The shell's active OpenRouter key has $1.963 weekly limit remaining, but Locus's separate Jev credential is unavailable for inspection. Reopen when the process is live and provider-ready; current gateway credential status remains unverified. |
| Existing v3 labels have no retained independent adjudication and positive variants are clustered. | **DEFERRED** | Obtain blinded independent adjudication and report domain-cluster uncertainty before claiming qualification. |
| Current requested OpenRouter model has no retained comparable mission-closure evaluation. | **FIXED** | The bounded native Decisions run is retained and independently verified. Exact gateway request-ID joins establish the 32-case baseline used the OpenRouter Jev Decisions route; native OpenRouter matches all baseline choices and integrated outcomes, with no measured liveness gain. Model qualification remains rejected. |
| Consequential graph routing has no independently labeled case pool matching the runtime branch contract. | **DEFERRED** | Build a route-specific development/validation/sealed dataset, obtain independent adjudication, then evaluate it under the 60-case / 90% routing floor. |
| Installed-host enforcement and live actual-model lifecycle remain unproven. | **BLOCKED** | The rebuilt package is installed, but Muse reports zero effective hook/MCP capabilities due `plugin_package_retention_refused` and `agent_definition_review_unavailable`; protected switch state is also absent. Reopen after host capability inventory is repaired, protected state is available under operator control, and the model is qualified for the protected decision scope. |

## Bounded live development evaluation

The operator-authorized run completed on the development split:

The persisted [run summary](../bench/results/mission-completion-dev-v3.openrouter-jev-latest-2026-11-03.summary.json)
and [per-case receipts](../bench/results/mission-completion-dev-v3.openrouter-jev-latest-2026-11-03.receipts.jsonl)
retain identity, usage, cost, latency, and score evidence.

- **Provider/endpoint:** OpenRouter native Decisions API, `https://openrouter.ai/api/alpha/decisions`.
- **Requested/served model:** `typesafe/jev-latest` (wire alias `~typesafe/jev-latest`) resolved to `typesafe/jev-1.14-20261014`; all 55 responses reported the same serving identity.
- **Split and binding:** `bench/datasets/mission-completion-dev-v3.jsonl`, 32 cases and 12 positives; dataset hash `e91a505a…`, question hash `6714d6c0…`, `mission-closure/1`, and 0.90 thresholds.
- **Requests:** 55 total (one unscored identity probe, 32 model-only, 22 integrated), zero retries, no early stop. All 55 returned request IDs and provider usage/cost; zero auth, rate-limit, transport, parse, or identity errors.
- **Observed:** 39,921 input tokens, 3,154 output tokens, $0.001676682 provider-reported cost; 119 ms min, 186 ms p50, 289 ms p95, 519 ms max.
- **Result:** 19/32 model-only correct, 16/32 integrated correct, 2/12 positive completions, 9/20 raw model-only false `COMPLETE` votes, zero false terminal completions among 20 negatives, 12 threshold holds, and 8 semantic refusals. The model choices, integrated choices, and integrated outcomes matched the gateway baseline on every case.
- **Interpretation:** this is a development-set comparison using builder-authored, non-independently adjudicated labels. It does not qualify the model or authorize graph routing. The baseline receipts omit provider fields, but exact request-ID joins bind all baseline calls to Locus's OpenRouter Jev route with successful HTTP delivery. Native OpenRouter produced the same choices and integrated outcomes.

The pre-run estimate used serialized character count and underestimated actual token usage and cost. Actual provider usage is retained in row v3 receipts and summarized in the run output above. No validation or sealed-final requests were made. OpenRouter's current [Decisions API documentation](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) describes the typed request and response contract; its [Jev Latest page](https://openrouter.ai/~typesafe/jev-latest/) points to Jev 1.14 and says alias pricing follows the served model. The [Jev 1.14 page](https://openrouter.ai/typesafe/jev-1.14/) currently lists $0.042/M input and free output.
