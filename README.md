# Jeverb

**Jeverb connects TypeSafe Jev's bounded semantic judgments to agent workflows, while keeping execution authority in deterministic policy and host verification.** It is an experimental decision, review, and graph-execution layer for Muse Code and MCP-compatible clients.

Jev can help assess whether an action fits a request, whether evidence appears relevant, or which bounded next step is appropriate. Jeverb does not treat a model answer as proof that code ran correctly, permission to execute, or authority to declare a mission complete. Those boundaries belong to deterministic controls, the host, and independent verifiers.

> **Status:** Experimental. Some local workflows and integration paths have been demonstrated, but model reliability, installed-host enforcement, and production terminal completion are not generally qualified. See [Limitations](docs/LIMITATIONS.md) and the dated evidence in [`docs/`](docs/INDEX.md).

## What it does

- Adds Jev judgments to agent hooks and MCP tools using explicit typed questions.
- Runs dependency-ordered execution graphs through deterministic admission and a constrained runner.
- Records graph state, attempts, and bounded receipts for replay and reconciliation.
- Connects mission criteria to execution and verifier evidence; missing or uncertain evidence fails closed.
- Packages a native Muse Code plugin with lifecycle hooks, skills, and an MCP server.
- Keeps a JevWire-compatible npm/MCP distribution identity for existing integrations.

Jeverb is most useful when an agent needs bounded semantic review or a controlled, auditable workflow around code changes. It is not a general-purpose coding model, shell sandbox by itself, or replacement for host permissions and tests.

## How the pieces fit

```mermaid
flowchart LR
  A[Agent: Muse Code or MCP client] --> B[Hooks and typed MCP tools]
  B --> C[Jev adapter: bounded semantic judgment]
  B --> D[Graph and mission policy]
  D --> E[Deterministic authorization]
  E --> F[Constrained graph runner]
  F --> G[Journal and execution receipts]
  G --> H[Independent verifier evidence]
  H --> I[Deterministic closure gates]
  I -->|semantic backstop where configured| C
```

Jev provides advice at defined decision points. The graph executor owns dependency ordering and attempts; deterministic policy admits actions; external or host-owned checks establish outcomes. Production closure remains guarded by qualification and the protected control boundary. More detail is in [Architecture](docs/ARCHITECTURE.md).

## Project identity and related work

This repository is **Jeverb**, descended from the JevWire codebase and preserving its package/API compatibility track. The npm package and MCP server identify as `jevwire@0.6.3`; the native Muse plugin identifies as `jeverb@0.1.0`. These are distribution identities in the current source, not a claim that upstream JevWire and Jeverb have identical behavior. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Jeverb descends from [JevWire](https://github.com/Brainwires/jevwire). It incorporates ideas from the related [JevHook / `jev-hooks`](https://github.com/7hemas7er/jev-hooks) work, including bounded review lanes and calibration discipline, without depending on it at runtime. **JIVE integration is experimental:** Jeverb independently ports selected [JIVE](https://github.com/merijjeyn/jive) graph-execution patterns and exposes some JIVE-shaped interfaces, but does not claim full compatibility. Workspace artifact semantics and imported conversation history are not implemented as JIVE-compatible features. See [Limitations](docs/LIMITATIONS.md).

### Meta technology

The native Muse Code package is a substantive integration: it provides Muse lifecycle hooks, a `/jev-decide` skill, tool-name and permission-boundary adapters, a bundled stdio MCP server, and session-scoped evidence correlation. Muse's own permission system remains authoritative. Muse does not provide Jev's judgments; Jeverb connects Muse workflows to the configured Jev backend. Installed-host behavior depends on Muse capability review and host policy.

## Place in the larger system

Jeverb is the execution and evidence boundary between an orchestrator and its workers: [ORX can submit a graph](docs/ORX-JEVERB-VEYRICT.md), Jeverb applies local admission and records attempts/receipts, and Veyrict can consume those receipt-backed observations. The observation contract is read-only; it does not grant acceptance, deployment, or authorization. This repository documents the integration contract, while the ORX and Veyrict implementations are maintained separately.

## Quick start

### Build and install the Muse plugin

Requirements: Node.js 20 or newer, npm, and Muse Code for host installation. From a checkout:

```sh
npm ci
npm run build
muse plugins install dist/muse-plugins/jeverb --scope user
muse plugins inspect jeverb
```

Jeverb's hooks and MCP server are separate Muse capabilities. Review the exact capabilities shown by Muse and approve only what you intend to enable. Installation alone does not enable those capabilities. Do not enable graph shell execution unless you have reviewed the [control service and execution policy](docs/CONFIGURATION.md#graph-execution).

### Run the local deterministic demo

The demo requires a working Bubblewrap confinement backend for graph execution and makes no model request in deterministic mode:

```sh
npm run sandbox:probe
npm run demo:deterministic -- --output /tmp/jev-demo.json
```

This exercises the local graph, verifier, closure, refusal, false-claim, and interrupted-execution paths with deterministic model fixtures. It does **not** qualify live Jev judgments or production completion. See [Usage](docs/USAGE.md#deterministic-demo).

## Using Jev

The server offers typed decision tools (`jev_evaluate`, `jev_rank`, `jev_pick`, `jev_verify`, `jev_gate_action`, `jev_next_step`, `jev_list_models`) plus graph, history, output, and observation tools. The graph tools can execute shell work and are effectful; they are not read-only. Tool schemas and annotations are defined in `src/server.ts` and `src/tools/`.

For a standalone local MCP client, build the project and register `dist/index.js` as its stdio server. Configure `JEV_BACKEND`, the matching provider key, and optionally `JEV_MODEL` in the MCP client's protected environment or use the plugin data-dir mechanism described in [Configuration](docs/CONFIGURATION.md). Never put API keys in source control or command history. The default OpenRouter model is `typesafe/jev-latest`; an alias can resolve to a changing concrete version, so record the returned model for qualification evidence. The [ORX–Jeverb–Veyrict contract](docs/ORX-JEVERB-VEYRICT.md) shows how an external orchestrator can submit a graph and consume receipt-backed observations; it does not grant caller authority.

## Repository map

| Path | Purpose |
|---|---|
| `src/` | TypeScript application, Jev adapters, hooks, graph executor, evidence, mission closure, tools |
| `plugin/` | JevWire-compatible plugin and committed bundled runtime |
| `.muse-plugin/`, `skills/` | Native Muse manifest and packaged skills |
| `jev-control-plugin/`, `control-service/` | Operator-facing control integration and host service candidate |
| `tests/` | Unit, integration, policy, conformance, and architecture tests organized by domain |
| `harness/` | Isolated host and MCP smoke/qualification helpers |
| `config/` | Review policy and routing configuration |
| `bench/` | Datasets, analysis, and retained evaluation evidence; not production qualification by itself |
| `docs/` | Architecture, operation, limits, qualification, and historical reports |
| `scripts/` | Build, packaging, audit, demo, and evaluation entry points |

## Verification

```sh
npm run type-check
npm run test:run
npm run build
npm run plugin:integrity-check
npm run smoke:mcp-stub
npm run smoke:muse-hook-stub
```

`test:run` includes the TypeScript suite and control-service Python tests. Bubblewrap-backed tests require Bubblewrap and a host that permits its namespaces; run `npm run sandbox:probe` before interpreting graph-execution failures. Offline tests establish behavior for their fixtures, not live provider quality, installed Muse capability activation, or production readiness. See [Testing](docs/TESTING.md).

## Evidence and current limits

One retained development run demonstrates a corrective cycle: Jev returned an uncertain judgment, selected a registered authorization probe, deterministic policy admitted it, a host verifier observed the defect, an authorized repair ran, and independent verification passed. The recorded request cost was **$0.000080892** for that one request. This is a single development observation, not a reliability estimate, qualification result, or production claim. Evidence and hashes are retained under [`bench/results/jev-corrective-loop-dev-2026-11-04/`](bench/results/jev-corrective-loop-dev-2026-11-04/).

Known limits include:

- Jev routing and mission-completion reliability have not met the project's established qualification requirements across representative data.
- Production terminal completion remains disabled unless the exact model, backend, question, and policy have valid qualification evidence.
- Privileged host enforcement requires the root-owned control service and operator-controlled switch; local fixtures do not prove host-wide enforcement.
- Live gateway alias resolution and installed Muse operation depend on the deployed gateway and host capability state.
- JIVE interoperability is experimental and partial.
- Linux with Bubblewrap is the verified graph-execution target; other operating systems are not qualified.

See [Limitations](docs/LIMITATIONS.md), [Traceability](docs/TRACEABILITY.md), and [the model convergence record](docs/ACTUAL-MODEL-CONVERGENCE-2026-11-03.md) for details and dated evidence.

## Contributing, security, and license

Read [Development](docs/DEVELOPMENT.md) before changing code. Preserve the domain ownership rules in [`AGENTS.md`](AGENTS.md) and add tests for behavioral changes. Report vulnerabilities using [`SECURITY.md`](SECURITY.md); do not include credentials in issues or logs.

The repository is MIT-licensed; see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The current GitHub remote and package identity retain JevWire lineage. The Jeverb public repository/umbrella navigation should be updated when its canonical public URL is established; no unverified project URL is presented here.
