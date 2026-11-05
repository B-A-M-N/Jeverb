# Protected control service

The install-wide Jeverb switch is read from `/var/lib/jeverb/control-state.json`.
Only the root-owned `jeverb-control.service` writes it. It exposes `STATUS`,
`SET_ON`, and `SET_OFF` over `/run/jeverb-control/control.sock`. Every transition
requires a fresh, action-specific PolicyKit challenge; the policy deliberately
uses `auth_admin`, never a retained authorization. The challenge text names the
requested ON/OFF transition. State changes use a generation check and atomic
replacement, and malformed state is quarantined and recovered as OFF.

The same service records operator-signed independent verification attestations
in a sibling root-owned file (`control-attestations.json`, read-only to agents)
and approved host proof plans in `control-proof-plans.json`.
`ATTEST_STATUS` lists them per mission without authorization; `ATTEST_PASS` and
`ATTEST_FAIL` each require a fresh action-specific PolicyKit challenge
(`org.jeverb.control.attest-pass` / `attest-fail`), bind one mission revision
and evidence revision to one candidate digest, and carry the consumed request id
as the attestation's receipt correlation. The hook layer — never the agent —
copies matching records into a mission contract; the session source only honors
them when the bound revisions equal the current candidate. Replays, stale
generations, malformed fields, and corrupt attestation state all fail closed
(empty read / rejected write / quarantined store).

`PROOF_PLAN_STATUS` reads one mission's approved host proof plan.
`PROOF_PLAN_SET` stores a plan only after a fresh
`org.jeverb.control.proof-plan` PolicyKit authorization. The root-owned record
binds the mission revision and original-objective digest to the complete
criterion set, explicit graph run/node/attempt associations, and TypeScript
source paths. The service hashes the plan and records the approving UID,
timestamp, and consumed request ID. Plans are atomically replaced under a
separate lock; stale generations, duplicate requests, malformed plans, and
corrupt plan state fail closed.

The hook compares the plan with the current user-authored contract, validates
every producer against the persisted graph journal, reads the approved source
files through the symlink-safe verifier boundary, and includes the plan and
source digests in candidate identity. AST structure is recomputed on each
closure snapshot, so edits during semantic review change the evidence
revision. A host test record and durable per-criterion verifier receipts are
still required. The plan does not assert that a test passed and cannot replace
the separate mission-level operator verification attestation.

Operators prepare a mapping file from host evidence and review it before
approval:

```json
{
  "schema": "jeverb-host-proof-plan-input/1",
  "workspaceRoot": "/absolute/canonical/workspace",
  "criteria": [
    {
      "criterionId": "criterion-01",
      "testCommand": "npm test -- --run tests/module.test.ts",
      "producers": [{ "runId": "run-id", "nodeId": "verification-node", "attemptId": "attempt-id" }],
      "codeFiles": ["src/module.ts", "tests/module.test.ts"]
    }
  ]
}
```

Then run `jev-control proof-plan-set <session-id> <mapping.json>`. The command
requires an explicit complete mapping, verifies each producer against the
current persisted journal and parses each declared source file before it
requests PolicyKit authorization. An agent-supplied association alone is not
trusted; the control service's approval receipt is required.
The host displays the exact test command before approval, stores only its
SHA-256, and accepts a test record only when its command hash and workspace
root match the approved criterion plan.

Plans that authorize supplemental semantic probes use input schema `/3`.
Each probe is nested under its criterion and names the exact graph producer
attempts whose evidence it may investigate. The host displays the probe ID,
description, command, command SHA-256, producer run/node/attempt identities,
graph node ID, and maximum execution count in the PolicyKit approval summary.
The service validates that every referenced producer is an exact member of
that criterion's producer set; the plan digest covers all of these fields.
Jev can return only a registered probe ID. The host resolves the approved
command from the root-owned plan and dispatches it through the existing graph
executor. A probe result remains supplemental and cannot satisfy the
criterion's required verifier by itself.

Input schema `/4` adds an optional, single host-approved repair action for a
criterion and carries the exact test command as well as its hash. PolicyKit
approval displays both the repair command and the verification commands. The
runtime can dispatch only that registered repair command through the same
confined graph executor, with one non-retrying attempt. It then reruns every
criterion test command and the exact selected probe in the same sequential
graph. Completion still requires durable host verifier receipts, current
candidate binding, independent operator evidence, and the existing global
semantic gate. A missing journal, `outcome_unknown`, failed repair, or failed
post-repair check is escalated; the repair is never automatically repeated.
Plans without a repair action retain the bounded agent-facing repair task.

Example `/2` criterion mapping:

```json
{
  "criterionId": "criterion-01",
  "testCommand": "npm test -- --run tests/access.test.ts",
  "producers": [{ "runId": "run-id", "nodeId": "verification-node", "attemptId": "verification-node/1" }],
  "codeFiles": ["src/access.ts", "tests/access.test.ts"],
  "probeActions": [{
    "id": "revoked-membership",
    "description": "Check access after membership revocation",
    "command": "npm test -- --run tests/access.test.ts -t revoked-membership",
    "producers": [{ "runId": "run-id", "nodeId": "verification-node", "attemptId": "verification-node/1" }],
    "nodeId": "probe-revoked-membership",
    "maxExecutions": 1
  }]
}
```

`scripts/install-control-service.sh` is a privileged, explicit system install
operation. It requires a verified frozen candidate, copies only that candidate
as root-owned files, and enables the systemd unit. It is not run by the build or
test commands. The candidate includes `verify_installed.py`, which compares the
three installed files against the hash-verified staging copy before systemd is
activated. The unit initializes missing state to OFF and stores it under
`/var/lib`, so the state survives service, Muse, and machine restarts. Removing
or corrupting state cannot turn Jeverb ON.

To prepare a reviewable, unprivileged snapshot, run
`python3 scripts/assemble_control_candidate.py --out /tmp/jeverb-control-candidate`.
It emits exactly four payload files plus `SHA256SUMS` and prints the digest the
installer requires. The output remains user-owned and is not install-eligible.
An operator must independently review that digest and copy the candidate into a
root-owned, non-writable directory before considering installation.

### Root-owned staging and installer verification

Do not pass the user-owned `/tmp` candidate directly to the installer: every
directory in its path must be root-owned and not writable by group or other.
Copy the five candidate files to a private root-owned directory, then verify
the candidate manifest digest and all four payload hashes there. The installer
script is not part of `SHA256SUMS`; independently review its digest too, copy
it into the same private root-owned area, and execute that verified copy rather
than the mutable checkout file:

```sh
sudo install -d -o root -g root -m 0700 /root/jeverb-control-candidate
for f in SHA256SUMS jeverb_control_service.py jeverb-control.service \
         org.jeverb.control.policy verify_installed.py; do
  sudo install -o root -g root -m 0444 "/tmp/jeverb-control-candidate/$f" \
    "/root/jeverb-control-candidate/$f"
done
sudo sha256sum /root/jeverb-control-candidate/SHA256SUMS
sudo sh -c 'cd /root/jeverb-control-candidate && sha256sum --check SHA256SUMS'
sudo install -o root -g root -m 0500 \
  /home/bamn/Jeverb/scripts/install-control-service.sh \
  /root/install-jeverb-control-service.sh
sudo sha256sum /root/install-jeverb-control-service.sh
# Compare both printed digests with independently reviewed values before continuing.
sudo /root/install-jeverb-control-service.sh \
  /root/jeverb-control-candidate <reviewed-manifest-sha256>
```

The installer enables and starts the unit after verifying the installed
payloads. On a fresh install, absent state initializes to OFF. Reinstalling
over an existing trusted state preserves that state, including ON; read back
`jev-control status` after installation and obtain a fresh PolicyKit
authorization for OFF before host qualification if it reports anything other
than `desired=OFF` and `effective=OFF`.

ON is a persistent desired state, not a lease: if the control service stops,
hooks continue to honor a trusted persisted ON state. Missing, corrupt, or
untrusted state remains effectively OFF. The service is needed to change the
state, not to renew it. Initial request parsing has a short deadline, incomplete
connections are capped per UID, and only one PolicyKit challenge may be active;
STATUS remains available while that challenge is pending.

The ordinary CLI can read status and submit a request, but the local service is
the only component with switch-write authority. Direct Muse `/jev:on` and
`/jev:off` prompts remain fail-closed until Muse supplies a trusted
operator-origin callback.

The `jev-control` executable is the `jevwire` npm package's `bin` entry; the
privileged service installer does not install the client. Ensure that package
client is available before the operator readbacks below. From a built checkout,
the equivalent invocations are `node dist/control.js status`,
`node dist/control.js on`, and `node dist/control.js off`.

## Emergency OFF recovery

If the socket service is unavailable while trusted state is ON, an operator
with root access can run the installed service payload in one-shot recovery
mode:

```sh
sudo /usr/bin/python3 /usr/lib/jeverb/control-service/jeverb_control_service.py --emergency-off
```

This mode accepts no state-path override and can only write OFF. It acquires the
same state lock as normal transitions, rotates the generation (so a request
authorized against older state cannot later turn the switch back on), writes
atomically, and independently reads the root-owned state back. It reports
success only when that read confirms OFF. If the state contents are corrupt,
the regular root-owned file is preserved under a unique `.corrupt.*` name
before OFF is written. Unsafe ownership, symlinks, or storage errors fail
closed and require operator repair. Stopping the service alone is never proof
that the switch is OFF.

State and attestation lock acquisition is bounded to five seconds. If recovery
reports `lock_timeout`, it has not changed persisted state; investigate and
stop the stuck service process if appropriate, then retry recovery. Do not
delete the lock file: the kernel lock is held on its open file description, so
removing the pathname would not safely release it.

The repository tests exercise recovery against isolated temporary state roots,
including malformed and missing state plus an in-flight authorized request.
The command has not been run against an installed service or live host; that
still requires a disposable host qualification.

## Rollback after a controlled installation

Do not stop or remove the service as a substitute for switching OFF: a trusted
persisted ON state remains effective when the service stops. While the service
is reachable, perform and verify OFF first:

```sh
jev-control off       # requires a fresh PolicyKit authorization
jev-control status   # require desired=OFF and effective=OFF
```

If the socket is unavailable, use the one-shot emergency OFF command above and
require its `verified desired=OFF` result. If it reports a lock timeout, it did
not change state; investigate the service/lock owner and retry recovery. Never
delete the lock file. Do not proceed with removal until OFF has been
independently read back.

To uninstall the service after OFF is verified:

```sh
sudo systemctl disable --now jeverb-control.service
sudo rm -- /etc/systemd/system/jeverb-control.service
sudo rm -- /usr/share/polkit-1/actions/org.jeverb.control.policy
sudo rm -- /usr/lib/jeverb/control-service/jeverb_control_service.py
sudo systemctl daemon-reload
sudo rmdir /usr/lib/jeverb/control-service 2>/dev/null || true
sudo cat /var/lib/jeverb/control-state.json  # require desired=OFF
```

Systemd removes `/run/jeverb-control` with the stopped unit. Keep the persisted
OFF state, attestations, install-staging snapshot, and their audit evidence;
deleting state is not rollback and could destroy the OFF proof. After uninstall,
the CLI cannot change the switch until the verified service is reinstalled.
Reinstallation initializes a missing state to OFF and still requires a fresh
PolicyKit authorization for ON.

## Host boundary and qualification limit

The service protects the switch against a same-UID agent that can write files
available to its execution context: it cannot modify the root-owned state,
service, policy, or unit. An agent can invoke `jev-control`, but invocation is
not authorization; the action-specific PolicyKit check must succeed for each
transition. The request's asserted origin and session fields are rejected.

This does not make a user-owned Muse installation tamper-proof. A same-UID
agent can still edit or replace plugin files, user configuration, launchers, or
other user-owned executables, and can attempt to influence the desktop
authorization prompt. Preventing those bypasses requires the Muse host and
launcher to load mandatory, root-owned plugin/configuration artifacts and to
isolate agent execution under a distinct Unix identity (or an equivalent
host-enforced execution boundary). The current Jeverb checkout cannot provide
that boundary itself.

This checkout has not installed or started the service. Real PolicyKit
challenge display and successful operator ON/OFF remain unqualified until an
operator installs it and completes a controlled host test. Unit tests exercise
the service protocol with an injected authorizer; they do not claim to prove a
real desktop authentication flow.

## Minimal Muse host API proposal

Muse should expose a TUI command-registration callback that runs before the
command text is submitted as model input:

```ts
muse.registerOperatorCommand({
  id: "jeverb.switch",
  commands: ["/jev:on", "/jev:off"],
  handler: (action, hostContext) => jeverbControl(action, hostContext),
});
```

Muse must invoke this callback only for a command entered in its trusted
operator TUI path. `hostContext` should be an opaque, host-created capability
bound to the operator principal, session, command, and one invocation. It must
not be constructible from hook JSON or model text, and it must expire after
that invocation. Hooks can keep rejecting exact slash-command prompts until
this callback exists. The Jeverb handler can then request the corresponding
OS authorization; a generic `origin: "operator"` field is insufficient.
