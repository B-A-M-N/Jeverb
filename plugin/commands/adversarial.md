---
name: adversarial
description: Turn the adversarial mission-closure pair (Jev A + Jev B) on, off, or show its state. Pair mode doubles inference at each completion checkpoint.
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# /jev:adversarial

Run exactly this command with the Bash tool, replacing `status` with `on` or `off` to flip the toggle:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/hook.mjs" adversarial status
```

What it does:

- `status` (default) — reports whether the pair is on and whether the adversarial calibration record is present. No state changes.
- `on` — enables the pair for this install by writing `adversarial_closure: true` to the install-scoped data-dir `config.json`, the same trust boundary as the planted credential. Takes effect on the next hook invocation; daemon sessions pick it up when the session (re)starts.
- `off` — disables the pair the same way. Deterministic preflight and the single-judge closure gate keep operating either way.

Two things to tell the user plainly:

- Pair mode doubles inference at each mission-completion checkpoint. It is for meaningful completions, not every tool call.
- The switch alone does not produce judgments: without a measured `adversarial_calibration_version` in the install config, Jev B stays silent and the controller gathers evidence instead of closing. If status shows the toggle on but calibration missing, the next step is measuring that calibration — not more toggling.

Do not present this as a session-scoped or reversible-by-restart setting. It persists in the install config until flipped back with `/jev:adversarial off`.
