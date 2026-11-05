---
name: jev-decide
description: Use Jev for bounded typed comparisons, ambiguous choices, or a second opinion on evidence. Jev confidence is not proof, permission, or a replacement for deterministic checks.
---

# Ask Jev for a bounded judgment

Use this skill when a task contains a small, explicit choice that Jev can answer from supplied evidence: compare candidates against stated criteria, classify a finding, or check whether evidence supports a narrow claim.

1. State the decision in one closed, typed question. Name the options or rubric and include only the evidence needed to answer it.
2. Call the `jev_evaluate` MCP tool with the evidence and question. Use `jev_rank` for ordering several candidates or `jev_verify` for a bounded claim when those schemas fit better.
3. Report the selected outcome, its probability distribution, provider/model, and any validation or calibration status returned by the tool. If the call fails or the response is uncalibrated, say so and continue with the remaining deterministic work.
4. Check the answer against the original request and independent evidence. Jev's confidence measures concentration over the supplied choices; it does not establish objective correctness.

## Limits

- A Jev answer never authorizes an action, overrides a deterministic policy, or substitutes for required tests, review, or independent verification.
- Do not use Jev for arithmetic, counting, date comparisons, command execution, or multi-step reasoning. Compute or execute those deterministically.
- Do not make a terminal completion claim from Jev confidence alone. Use Jeverb's mission-closure path, and report incomplete or insufficient evidence when its gates do not pass.
- If the MCP tool is unavailable, do not pretend a judgment occurred. Continue without it or report the dependency if the task requires it.
