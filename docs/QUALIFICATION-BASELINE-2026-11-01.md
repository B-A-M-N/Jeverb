# Qualification Baseline — 2026-11-01

This records the exact integration worktree before remediation work in this continuation. The integration checkout remains authoritative; no tracked or untracked project files were changed to create the snapshot.

## Repository identity

- Repository: `/home/bamn/Jeverb`
- Branch: `main`
- HEAD: `ad97c5f` (`Add mission workflows, graph execution, and master switch`)
- Ahead of `origin/main`: 69 commits
- Worktree: 123 tracked modified files and 78 untracked paths (201 changed paths total)
- `git diff --stat`: 8,472 insertions / 3,948 deletions across tracked files

## Environment

- Node: `v22.22.3`
- npm: `10.9.8`
- Git: `2.34.1`
- Installed direct dependencies: MCP SDK 1.30.0, TypeScript 5.9.3, TypeScript native preview 7.0.0-dev.20260707.2, Vitest 3.2.7, tsx 4.23.13, esbuild 0.28.2, AJV 8.20.0, Zod 4.6.5, Node types 24.13.4
- Package manifest SHA-256: `9bd6cd8f37115206135cb047641896b70fff5a3067a85ee182984adb4c31c94b`
- Lockfile SHA-256: `dfff40421df38eb6a3cbfbec9ef97e319b5c065a04f5fa278f52a3a1bc3cb06a`
- Muse hook bundle SHA-256: `1fa7a11c55c41b733dc7e3b701c8bf3a136c51a99a186d15179fab37ee5e0c98`
- Muse MCP bundle SHA-256: `ff1564f26c2a91a862048bf82a921b063d9218bfeebd87c464504ee5cecb03f9`
- Muse plugin manifest SHA-256: `96dfab7f73bba23fd35fd4fdfc38bfc771ab3c8ccabfa02740ae7b9c9629d8d3`

## Snapshot artifacts

A content snapshot excluding `.git`, `node_modules`, and Python `__pycache__` is at `/tmp/jeverb-phase0-2026-11-01/worktree-snapshot.tar.gz` (SHA-256 `47bf102e729b5939c256af0af37ab73bea9ac20bc7cb3bb0f15000c0aa90ff2e`). Its sorted per-file content/mode manifest is `/tmp/jeverb-phase0-2026-11-01/tree-manifest.json` (SHA-256 `6e57cd55b185395de22e322abbd37437935753da04694a37c1965184f1e0a7db`; 6,056 paths). These artifacts are local to this host and should be copied to durable storage before host cleanup.

## Verification provenance

The supplied architecture review reports a fresh focused run of 42 tests in four suites and `tsgo --noEmit` passing. Those focused test file names were not included in that report, and this continuation has not yet rerun them. The repository report `docs/REMEDIATION-ASSESSMENT.md` reports earlier test/build results, but its counts differ from the review's newest numbers. No current full-suite or build result is claimed by this baseline.

## Reproduction commands

The current `package.json` defines `npm run type-check`, `npm run build`, `npm run test:run`, and `npm run plugin:integrity-check`. Reproduction must use the archived tree, install dependencies from its lockfile, and record the exact command outputs. Build and test attempts should run in a disposable extraction because build scripts update generated Muse bundles.
