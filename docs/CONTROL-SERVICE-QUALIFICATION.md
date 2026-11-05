# Jeverb control service qualification report

**Date:** 2026-10-31
**Disposition:** Repository qualification passed; protected host qualification remains incomplete.
**Live changes:** None. No service was installed, enabled, started, or transitioned. No commit or push was made.

## Code changes and evidence

### PolicyKit identity and authorization

`control-service/jeverb_control_service.py` obtains caller PID, UID, and GID from Unix `SO_PEERCRED`. Before PolicyKit it records process start ticks and checks `/proc/<pid>` ownership. It invokes `pkcheck` with `pid,start_ticks,uid`, then repeats the process identity checks after authorization. Each ON/OFF request gets a fresh action-specific authorization; the service does not retain approvals.

The service protocol accepts only `STATUS`, `SET_ON`, and `SET_OFF`. It rejects extra fields, caller-asserted identity/origin, unsupported operations, stale generations, and replayed request IDs. Conflicting transitions are serialized by the state lock and only one generation can win.

### Frozen candidate installation

`scripts/install-control-service.sh` no longer reads executable payloads from the checkout. It requires an absolute candidate under root-owned, non-group/world-writable directories; exactly five regular files; a reviewed SHA256SUMS digest; and matching payload hashes. It copies those verified bytes to a new root-owned private staging directory, verifies the staged manifest and payloads again, and installs only from that stage.

After installing from the root-owned stage, the installer runs `verify_installed.py` from that stage. It requires all three installed destinations to be regular files and compares their bytes against the staged copies before invoking `systemctl`. A mismatch aborts before service activation. Four unprivileged Python tests exercise the same verifier against a temporary install root, including modified, missing, and symlinked destinations. The npm package dry run also confirms the verifier is shipped. The privileged copy/install path itself was not executed.

The disposable Muse plugin package candidate is `/tmp/jeverb-qualification-candidate-20261031-final`, owned by `bamn` with mode `0755`, and is **not eligible for installation**. Its manifest digest is:

```text
45d5495330d1c18919a890a265930163ef50e04c660cdc1f78be5305af7e0b3f
```

`npm run plugin:integrity-check -- --candidate /tmp/jeverb-qualification-candidate-20261031-final` passed. It confirmed complete packaging and exact review-file sourcing. It reported calibration as **uncalibrated** and protected-operation review as disabled pending configuration. This is candidate integrity evidence, not proof that installed root-owned bytes match it.

The separate control-service assembler produced `/tmp/jeverb-control-service-candidate-20261031-final`. Its five entries match the installer's exact required set; `sha256sum --check` passed for all four payloads. The manifest digest is `8dc44113a674510c184363ea362e97d9af8ae0eab1deebad1191ee34e50e7545`. It remains owned by `bamn` with mode `0755` and **is not install-eligible**. The root-owned promotion and installer invocation were not performed. Four assembler tests cover exact contents/digest, snapshot independence from later checkout edits, refusal to overwrite, and symlink refusal.

### Service availability and persisted state

`control-service/jeverb_control_service.py` gives initial request parsing a 2-second deadline, caps connections globally and per UID, and admits only one pending PolicyKit challenge. Other transition requests receive `authorization_busy`; STATUS runs on its own admitted connection while authorization is pending.

The state is persisted, not leased. A trusted persisted ON remains effective if the service stops; missing, malformed, or untrusted state fails OFF. `docs/CONTROL-SERVICE.md` records this behavior and explains that an agent invoking the CLI is not authorization.

Read-only inspection found `/var/lib/jeverb/control-state.json` and `/run/jeverb-control/control.sock` absent, so the protected switch reader fails OFF. No state was created or changed. A direct `systemctl is-active` check in this qualification shell failed with `Failed to connect to bus: Operation not permitted`; service-manager state could not be independently refreshed here. The actual PolicyKit path has not been exercised on this host.

### OFF transition and Jeverb enforcement

Hook dispatch, daemon startup/watchdog reconciliation, MCP work, and graph execution use switch-generation checks and cancellation signals around asynchronous work. Stale work is suppressed from publishing Jeverb decisions, state changes, or receipts after OFF or a generation change; graph work receives cancellation where supported. This does not cancel Muse’s own tool execution.

The exact `/jev:on` and `/jev:off` prompts remain fail-closed. No hook JSON field, environment variable, TTY, session identifier, marker, or agent-authored message is accepted as operator authorization. The separate `jev-control` CLI reaches the protected local service and still requires a new PolicyKit decision per transition.

`docs/CONTROL-SERVICE.md` includes the proposed minimal Muse host callback for operator-originated TUI commands. Until Muse provides that trusted callback, direct slash transitions remain unavailable.

OFF-transition coverage includes hook dispatch and output fencing, MCP cancellation, graph cancellation, daemon startup/watchdog generation checks, stale evidence suppression, and OFF persistence across fresh hook processes. Cancellation is best-effort for in-flight Jeverb work; work that cannot be cancelled is fenced from publishing later Jeverb effects. Muse tool execution itself is outside Jeverb's cancellation authority.

The extractor registry now resolves `HOME` at call time before falling back to the OS home directory. This fixed a worker-thread regression found during full-suite requalification. Vitest uses its threads pool to avoid the default fork pool's `onTaskUpdate` timeout on long policy-matrix files. The concurrent switch test accepts `authorization_busy` or `stale_generation` for the losing transition; both are safe rejections under single-flight authorization.

### Review behavior

The default `commit_enforcement` policy is advisory. An absent, uncalibrated, unavailable, or model-derived commit review does not deny an ordinary local commit in that mode. Explicit `mandatory` mode retains fail-closed unavailable behavior. Independent deterministic prohibitions and Muse’s own permission boundary remain in force. This changes Jeverb’s review authority; it does not disable Muse sandboxing or grant host access.

Calibration eligibility now requires exact question-set, backend/model/version, calibration version, dataset revision, and evaluation-hash bindings. The service does not yet load and independently verify a calibration-results manifest against labeled evaluation data; those provenance fields alone are not measurement evidence. The checked-in and packaged review policy remains **uncalibrated**; no calibration claim was added, and probabilistic review is not qualified for enforcement.

## Qualification results

| Check | Result |
| --- | --- |
| `npm run build` (TypeScript, hook bundles, both Muse package roots) | Passed |
| `npm run type-check` / `npm run build:tsc` | Passed |
| Full Vitest suite | Passed: 107 files, 2,296 tests (threads pool) |
| Latest control-service Python suite | Passed: 24/24; service, four temporary-root verifier, and four candidate-assembler tests |
| Installer integration guard | Passed: 2/2; verifier invocation precedes service activation |
| npm package dry run | Passed; includes the verifier and candidate assembler |
| `npm run plugin:integrity-check` | Passed |
| Disposable assembled candidate integrity | Passed; review config byte-matches source; remains uncalibrated |
| Full PolicyKit process tuple regression | Passed with mocked `pkcheck` argument assertion |
| Incomplete connection and authorization flood behavior | Passed in isolated service tests |
| Replay, stale generation, conflicting ON/OFF requests | Passed in isolated service tests |
| OFF races in hook/model, graph, MCP, daemon/watchdog paths | Covered by passing isolated regression tests |
| Both separately installable Muse packages | Build and packaging tests passed (`jeverb` runtime package and `jev` command package) |
| Candidate-to-stage and stage-to-installed byte checks | Implemented; staged verifier passes four temporary-root tests; actual privileged install comparison not run |
| Real desktop PolicyKit ON/OFF and cancellation flows | Not run |
| Muse host-enforced protection against same-UID plugin/config tampering | Not provided by Jeverb; requires Muse/launcher isolation |

Built bundle SHA-256 values:

```text
plugin/dist/hook.mjs  6dc81379ecb4b1cb0ded082240fe2bb87fe120d46fed5789e96122b2a3e99842
plugin/dist/mcp.mjs   226593d2e31889601503a47ec093b849e64c9330e460de0b01f08e5c1370d7a7
dist/muse-plugins/jeverb/.muse-plugin/plugin.json  96dfab7f73bba23fd35fd4fdfc38bfc771ab3c8ccabfa02740ae7b9c9629d8d3
dist/muse-plugins/jev/.muse-plugin/plugin.json     cd27e06cb5f9fdac05c7751e100166c576b9f9f757d5221c8ba61493b8586974
```

## Remaining real-host checks

1. On a disposable qualification host, promote the assembled five-entry control-service candidate to a root-owned immutable directory after independently reviewing its digest. Run the installer there and inspect the recorded stage and installed destinations. The staged verifier and candidate assembler are tested against temporary roots; the privileged install path has not been executed.
2. With the real desktop authentication agent, verify operator ON and OFF, dismissed/unavailable authentication leaving state unchanged, and action-specific fresh authorization for every transition.
3. Verify an unprivileged agent request cannot change state without operator authentication, cannot reuse a previous approval, and cannot produce a misleading retained-authorization prompt.
4. Verify trusted persisted ON behavior across a service stop/restart and fail-OFF for missing, corrupt, or untrusted state on the deployed host.
5. Separately qualify Muse’s launcher/plugin integrity boundary. A same-UID agent can still alter user-owned plugin registration or files; the root service alone does not prevent that bypass. This needs host-enforced mandatory artifacts and/or execution under a distinct Unix identity.
6. Qualify native `/jev:on` and `/jev:off` only after Muse exposes the trusted operator-originated TUI callback. Until then, the slash prompts must continue to fail closed and recovery uses the separately authorized local CLI.

**Release decision:** Do not describe the protected control service as operational or the release as fully host-qualified. Repository implementation and automated tests pass; real PolicyKit authentication and root-owned installation integrity remain pending by design.

## Operator install handoff — 2026-11-02

Prepared (unprivileged, no install performed): `python3 scripts/assemble_control_candidate.py --out /tmp/jeverb-control-candidate`.

```text
manifest_sha256: f0cda5fc4d4038052a14b39bf730011eda25a4b57763c89a52101830bc60a763
3c5cb2c1bfe6bef99e4d6402c88f6e75f9794d189738566413ba65c16a763fca  jeverb-control.service
1310173fc1ce90ddc27665c9efa0e665c9caf6fbe5bdd7954f55c0abb79901  jeverb_control_service.py
37c7d06c40b4ea7d5da56cd7f9a4d41f08648dc5b927093b0a4e129a6fb1710f  org.jeverb.control.policy
43523025f1f1d4d7153a65ce48ecb2f2e091ae14f6a1c7  verify_installed.py
```

Payload hashes inside the candidate verify (`sha256sum --check --status SHA256SUMS` passes). The digest above is reproducible from this checkout via the assembler; re-run it after any `control-service/` change — a different digest means different bytes under review.

Operator steps (privileged session; nothing below was executed here):

1. Review the four payload files out-of-band against this checkout, then stage as root:
   `sudo mkdir -p /root/jeverb-candidate && sudo cp /tmp/jeverb-control-candidate/* /root/jeverb-candidate/ && sudo chown -R root:root /root/jeverb-candidate && sudo chmod 755 /root/jeverb-candidate && sudo chmod 444 /root/jeverb-candidate/*`
2. `sudo bash scripts/install-control-service.sh /root/jeverb-candidate f0cda5fc4d4038052a14b39bf730011eda25a4b57763c89a52101830bc60a763`
3. Readbacks: `jev-control status` (expect OFF after fresh install), then authorized `jev-control on` + `status` (ON), `jev-control off` + `status` (OFF), emergency-OFF procedure per `control-service/` docs if the socket is unreachable.
4. Rollback: authorized `SET_OFF` with readback first; service removal alone is not OFF (trusted ON persists across shutdown).

Blocker if install is attempted from an unprivileged session: `sudo` requires a password here and the installer refuses non-root (`id -u` must be 0).
