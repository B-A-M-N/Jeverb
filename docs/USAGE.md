# Usage

## MCP tools

The server registers typed Jev decision tools: `jev_evaluate`, `jev_rank`, `jev_pick`, `jev_verify`, `jev_gate_action`, `jev_next_step`, and `jev_list_models`. It also provides `jev_execute_graph`, `jev_execute_graph_mod`, `jev_read_graph_output`, `jev_graph_history`, `jev_resume_graph`, and `jev_observations`.

The decision tools return bounded structured results. Graph submission/edit/resume may cause local effects; use the host's permission flow and Jeverb's deterministic policy. Never treat a model judgment or a graph's claimed output as independent verification.

## Deterministic demo

Check confinement first:

```sh
npm run sandbox:probe
npm run demo:deterministic -- --output /tmp/jev-demo.json
```

The deterministic demo runs the existing graph/mission path with fixtures, including success and adversarial outcomes. It is intended as a reproducible local integration exercise, not live model qualification. Inspect the produced JSON and its embedded outcomes; do not infer production readiness from a fixture pass.

## Historical replay

Replay analyzes a retained result without contacting a model:

```sh
npm run demo:replay -- --output /tmp/jev-replay.json
```

Replay outputs are derived views. Preserve original result files and hashes; use the provenance and limitations described in [`docs/DUAL-MODE-DEMO.md`](DUAL-MODE-DEMO.md).

## Graph behavior

Graph definitions express node dependencies, branches, and optional bounded constructs. The executor validates the graph, admits actions through the configured authorizer, runs permitted shell work in Bubblewrap, and journals attempts. A failed or interrupted side effect may be marked uncertain and requires reconciliation; do not blindly resubmit it. Graph shell, network, retry, and artifact capture are disabled unless the operator enables the corresponding policy. See [Architecture](ARCHITECTURE.md) and [Configuration](CONFIGURATION.md#graph-execution).

## Control operations

The `jev-control` command and control plugin are operator interfaces for the protected service. They are not agent tools and must not be used to fabricate an ON state. Follow the [control service procedure](CONTROL-SERVICE.md) and its qualification requirements.
