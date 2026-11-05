# Pass 4 — Installed-Runtime Qualification Runbook

Status: NOT EXECUTED. Every step below crosses the deployment boundary
(install, activate, authorize) and requires explicit user authorization.
Nothing here has been run.

Preconditions (all must hold before starting):

- Pass 1–3 artifacts present: full suite green, `bench/results/heldout-*`
  receipts, `bench/results/calibration-manifest-20261031.json`,
  `bench/results/heldout-mission-completion.manifest.json` (inconclusive).
- Release gates for corrective action (>=0.95) and stop false-block (zero
  false blocks across at least 149 negatives, giving a one-sided 95% upper
  bound <=0.02) remain UNMET on current evidence. Do not mark them met without
  new independently labeled evaluation. The runbook measures the installed
  behavior they govern; it does not waive them.

Dataset split inputs (local preparation; no inference):

- Run `npm run bench:build-datasets && npm run bench:build-lockbox` to
  reproduce the calibration pools, explicit splits, and completion lockbox.
- For validation, pair `heldout-mission-completion.jsonl` with
  `development-mission-completion-v1.jsonl`; use the corresponding
  `heldout-{corrective-action,stop-intervention,adversarial-review}.jsonl`
  and `development-*-v1.jsonl` files for those families.
- The unsuffixed `*-v1.jsonl` files are combined coverage pools and contain
  the heldout-prefixed rows. Do not use a combined pool as the development
  side of its own heldout evaluation; the qualifier rejects overlapping case
  IDs. The dataset tests verify that each explicit pair is disjoint and covers
  its pool exactly once.
- These splits establish case separation, not release-grade statistical
  power. In particular, the 11-case stop validation set is far below the
  149-negative false-block gate; no current split closes that release gate.

Step 1 — Install the packaged plugin (no source edits).

- `npm run build && npm run plugin:integrity-check`
- Install `dist/muse-plugins/jeverb` through the normal Muse plugin
  route. Do not bypass package ownership or capability-review safeguards.

Step 2 — Live gateway exchange.

- Configure the typed Jev backend (gateway URL, model id, credentials) in
  the host environment, not in the repo. Confirm no secret lands in the
  worktree (`git status`, credential grep over new artifacts).
- Send one typed `closure` request for a known-INCOMPLETE fixture and one
  for a known-COMPLETE fixture; record provider, model version,
  questionHash, latency. Both must return well-formed answers; the
  INCOMPLETE case must not return COMPLETE.

Step 3 — ON/OFF enforcement via the protected control service.

- Install the service per `scripts/install-control-service.sh` only with
  explicit authorization (real PolicyKit transitions, not stubs).
- With the switch ON: drive a Stop event on an incomplete mission, confirm
  the block carries the structured directive naming the exact criterion.
- Flip the switch OFF mid-inference: confirm stale Jev output is suppressed
  (no block, no completion claim recorded).
- Flip ON again: confirm a durable COMPLETE receipt on a fully verified
  mission terminates the host run.

Step 4 — End-to-end agent loop (the milestone that matters).

- Task an agent with a small mission containing one deliberately omitted
  criterion. Expected sequence: correction directive naming the criterion
  -> agent performs it -> independent verification binds the current
  candidate revision -> durable completion receipt -> host terminates.
- Repeat with: a transient failure (bounded RETRY then success), a repeated
  identical failure (CHANGE_APPROACH or BLOCKED, never an infinite loop),
  an external credential requirement (BLOCKED naming the operator action).
- Log every disposition with evidence revisions; any repeated correction
  against unchanged evidence is a failure of this step.

Step 5 — Record the outcome.

- Re-run `scripts/jev-qualify.ts` against the new installed-run receipts.
  Held-out runs must pass `--development-dataset`; lockbox runs also pass
  `--validation-dataset`. The verifier checks all three case-ID sets for
  overlap. It recomputes answer correctness from the labeled dataset, binds
  receipt model/version/adapter identities and active policy thresholds, and
  refuses authorization when the family gate or any judgment fails. A
  `decision:"qualified"` remains a human release act, but it cannot override
  a failed metric gate. Review and adversarial-review families remain
  advisory until their own independent release policies are defined.

Rollback: stopping the service alone is NOT a valid OFF transition —
trusted persisted ON state survives service shutdown. The proper rollback is:
first perform an authorized `SET_OFF`, verify the persisted OFF state from
trusted storage, and only then stop the service. If the socket service is
unavailable, run the root-only `--emergency-off` command documented in
`docs/CONTROL-SERVICE.md` and require its trusted-state readback confirmation.
Then remove the installed plugin and confirm the switch still reads OFF. The
repository tests cover the recovery path, but a disposable-host test against
the installed payload remains required before relying on it operationally.
The repo worktree is untouched by all steps above; verify with `git status`
afterward.
