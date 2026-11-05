# AGENTS.md

## Commands

- `npm run test:run` - run the full test suite
- `npm run build` - build the project
- `npm start` - start the project

## Code Map

- `src` - application source
- `tests` - automated tests
- `docs` - project documentation
- `.github` - project configuration

## Conventions

- Use ESM `import` with `.js` extensions for relative imports.
- Name test files `*.test.ts`.
- Read the root contract (this file) and every applicable domain contract before editing.
- After a consequential edit, update the nearest owning contract and run the relevant verification.

## Ownership

Leaf modules own one domain each. Import direction is one-way, leaf-ward;
a leaf must never import its former parent at runtime (`import type` is
erased and allowed). Enforced by `tests/architecture/dependency.test.ts`.

| Domain | Owner file | May be imported by |
|---|---|---|
| Hook output helpers | `src/hooks/handlers/response.ts` | `handlers/*`, `unified.ts` |
| Master switch | `src/control/master-switch.ts` | `control/*`, `evidence/*`, `hooks/*`, `src/*` |
| Pure graph ops | `src/graph/validate.ts` | `graph/*`, `tools/*` |
| DAG execution and branch admission | `src/graph/executor.ts` | `decision/evidence.ts` (type only), `graph/validate.ts`, `lib.ts`, `tools/*`, tests only |
| Terminal results | `src/graph/terminal.ts` | `graph/executor.ts` only |
| Decision records/prompts | `src/hooks/decision-record.ts` | `handlers/*`, `hooks/*` |
| Receipt validation | `src/evidence/receipt-validation.ts` | `evidence/*`, `tools/*`, `mission/*`, `graph/*` |
| Host proof-plan proposal | `src/mission/proof-plan.ts` | `hooks/main.ts`, tests only |
| Trip transitions | `src/hooks/tripwire.ts` (apply* fns) | `hooks/store.ts` only |
| MCP tool identity | `src/hooks/mcp-policy.ts` | `hooks/prefilter.ts`, `hooks/handlers/pre-tool-use.ts` |
| Subagent tasks | `src/hooks/subagent-tasks.ts` | `hooks/store.ts`, `mission/session-source.ts` |
| Observations/reissues | `src/hooks/observations.ts` | `hooks/store.ts` only |
| Decision log | `src/hooks/decision-log.ts` | `hooks/store.ts` only |
| Tool bindings | `src/tools/graph-bindings.ts` | `tools/execute-graph.ts` only |
| Stop policy | `src/hooks/handlers/stop-policy.ts` | `handlers/stop.ts` only |
| Three-stage lockbox scoring | `src/jev/lockbox.ts` | `scripts/jev-lockbox.ts`, tests only |
| Blind evaluation annotation | `src/jev/annotation.ts` | `scripts/jev-annotation.ts`, tests only |
| Installed telemetry aggregation | `src/jev/telemetry-audit.ts` | `scripts/jev-audit-installed-logs.ts`, tests only |
| Gateway receipt correlation | `src/jev/gateway-receipt-correlation.ts` | `scripts/jev-correlate-gateway-receipts.ts`, tests only |
| File lock/IO primitives | `src/hooks/store-lock.ts` | `hooks/*`, `control/*`, `evidence/*`, `graph/*` |

Global invariants: no runtime import cycles; `control/` and `evidence/`
never depend on `hooks/store.ts` at runtime (`store-lock.ts` excepted);
`hooks/store.ts` stays the session-state API (delegates, never reimplements).

## Child DOX Index

Domains are files, not folders: each owner file's header block is its
domain contract (purpose, ownership, forbidden responsibilities). The
Ownership table above is the index; there are no child AGENTS.md files.
Tests in `tests/architecture/dependency.test.ts` enforce the map.

## Audit Dispositions

Every audit must close each material finding with exactly one disposition:

- `FIXED` — corrected and independently verified (a different check than the one that made the fix: rerun the failing test, the full gate, or a fresh reproduction).
- `VERIFIED NON-ISSUE` — investigated and established not to be a defect, with evidence.
- `ACCEPTED RISK` — real but consciously left in place, with owner and rationale recorded.
- `DEFERRED` — real, tracked for later, with the condition that reopens it.
- `BLOCKED` — cannot proceed without named external input or state change.

A fix is not complete until independently verified. Do not advance to the next audit phase while an unresolved finding invalidates it.
