# Development

## Setup

Use Node.js 20 or newer:

```sh
npm ci
npm run type-check
```

The repository contracts in [`AGENTS.md`](../AGENTS.md) define module ownership, import direction, and test naming. Before editing an owner module, read its header contract and preserve existing worktree changes.

## Common commands

```sh
npm run type-check
npm run test:run
npm run build
npm run plugin:integrity-check
npm run smoke:mcp-stub
npm run smoke:muse-hook-stub
```

For focused work, invoke Vitest on the relevant `tests/<domain>/*.test.ts` files. Graph integration tests need working Bubblewrap; establish that with `npm run sandbox:probe`. The full test command includes Python control-service tests and may need system facilities for its integration cases.

## Packaging

`npm run build` compiles TypeScript, bundles the JevWire-compatible plugin, and assembles Muse packages. `plugin/dist/` is intentionally part of the installable plugin distribution. Rebuilds may change generated bundle files; review those diffs rather than discarding them. `npm run plugin:integrity-check` checks package contents and internal paths.

## Evaluation discipline

Provider requests are metered and must be separately authorized. Offline fixtures do not establish model reliability. Evaluation identities bind question, dataset, policy, backend, and model; do not edit frozen inputs or thresholds in place. Preserve raw responses and provenance; clearly mark development evidence and experimental questions.
