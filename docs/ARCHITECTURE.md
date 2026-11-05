# Architecture

Jeverb adds bounded Jev judgments to agent workflows while keeping execution and completion authority in deterministic host controls.

## Main components

| Component | Responsibility |
|---|---|
| `src/jev/` | Provider adapters and typed Jev requests for TypeSafe, OpenRouter-compatible endpoints, and the local Jev gateway. |
| `src/hooks/` | Host lifecycle integration, request screening, policy decisions, session state, and evidence observations. |
| `src/server.ts`, `src/tools/` | MCP transport registration and tool implementations. Transport wiring is separate from tool behavior. |
| `src/graph/` | Graph validation, dependency traversal, deterministic admission, constrained execution, journaling, replay, and receipts. |
| `src/enforcement/`, `src/control/` | Deterministic invariants and protected master-switch/control-service boundary. |
| `src/evidence/`, `src/mission/` | Evidence validation, mission criteria, proof-plan associations, verifier receipts, and closure policy. |
| `plugin/`, `.muse-plugin/`, `skills/` | JevWire-compatible plugin packaging and native Muse package assets. |

## Execution and trust flow

1. A host event or MCP request enters through a hook or tool adapter.
2. Deterministic screening handles mechanically decidable cases. When configured, Jev receives bounded context and a typed question; the result is advice whose authority is limited by the caller's policy and qualification pin.
3. Graph definitions are validated and traversed by dependency state. The model cannot invent an executable command through a decision result.
4. Effectful graph operations pass deterministic authorization and the constrained runner. Shell is disabled by default; Bubblewrap supplies the Linux isolation boundary.
5. The executor persists attempts and journal state. Host verifiers produce separately attributed observations/receipts; agent statements are not promoted into trusted outcomes.
6. Mission closure checks explicit criteria, trusted evidence, deterministic gates, and any configured qualified semantic backstop. Unknown, missing, failed, stale, or contradictory evidence must not become success because a model is confident.

The protected control service owns the host-wide switch. A plugin configuration setting is not a substitute for that service or an operator grant.

## Distribution and compatibility

The native Muse plugin is named `jeverb`; the package/MCP compatibility track remains named `jevwire` in `package.json` and MCP server metadata. Tests pin these identities. JevWire lineage does not imply identical upstream behavior.

Jeverb's relationship to JevHook/`jev-hooks` is inspiration and attribution, not runtime dependency. JIVE is a separate project. Selected graph concepts are independently implemented in Jeverb; interoperability is experimental and incomplete. See [Limitations](LIMITATIONS.md).

## Meta integration

Muse Code contributes the agent host lifecycle: hooks, plugin capability review, permission requests, MCP process lifecycle, and session identity. Jeverb adapts those host contracts and correlates its observations with host sessions. Muse permissions remain authoritative, while Jev remains a separately configured decision model.
