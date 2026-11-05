---
name: jev-run-graph
description: Compile repeatable mechanical work into a bounded Jive graph, run it via jev_execute_graph, persist the run ID, retrieve compact outcomes, and resume after interruption.
---

# Run a bounded Jive graph

Use this skill when a task decomposes into repeatable mechanical steps: inspect source, derive targets, run independent checks, review evidence, return a compact result.

1. Compile the work into a bounded DAG: shell nodes for deterministic steps, Jev nodes for typed judgments over dependency evidence, review nodes for diffs. Declare dependencies explicitly; pass data only through bounded `JIVE_REF_*` bindings, never source interpolation.
2. Call the `jev_execute_graph` MCP tool with the graph. Shell nodes must pass deterministic policy; retries require `idempotent: true` and operator permission. Jev answers are advisory evidence, never authorization.
3. Persist the returned run ID immediately. Retrieve compact outcomes with `jev_read_graph_output`; do not re-run side-effecting nodes to inspect results.
4. After an interruption, resume through `jev_resume_graph` with the same run ID. Reconciliation replays only what the journal proves incomplete; never blindly repeat an uncertain side effect.
5. Expose node outcomes, output digests, and durable receipts downstream for independent qualification (e.g. Veyrict). Caller-claimed `source` strings are attribution, not authorization.

## Limits

- Default-deny shell, retry, and network settings are security properties, not missing features. Do not work around them.
- Branch on typed evidence (`decision.verdict`, `decision.choice`); do not branch on untyped prose.
- A passing local check is execution success, not independent verification. Terminal completion claims require the mission-closure path with a trusted, revision-bound verifier attestation.
- If the MCP server is unavailable, say so and continue with deterministic steps or report the dependency. Never fabricate a run ID, receipt, or judgment.
