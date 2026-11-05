# Getting started

## Prerequisites

- Linux is the verified graph-execution platform.
- Node.js 20+ and npm for build and tests.
- Bubblewrap (`bwrap`) and a host permitting its user/network namespaces for confined shell graph execution.
- Muse Code only if installing the native Muse plugin.
- A provider credential only for live Jev requests. Deterministic tests and the deterministic demo do not need one.

## Checkout, build, and verify

```sh
git clone <repository-url>
cd Jeverb
npm ci
npm run type-check
npm run build
npm run plugin:integrity-check
```

The public canonical Jeverb repository URL is not established in this checkout's current documentation. Use the repository URL supplied by its maintainer in place of `<repository-url>`; do not assume the JevWire upstream URL is the Jeverb fork.

## Install in Muse Code

```sh
muse plugins install dist/muse-plugins/jeverb --scope user
muse plugins inspect jeverb
```

Muse reviews the plugin package and its hooks/MCP capabilities separately. Approve the exact capability IDs through Muse's documented review flow, then inspect again. Installing a package does not mean hooks or MCP tools are active. Keep graph execution disabled unless you have reviewed [configuration and control requirements](CONFIGURATION.md#graph-execution).

The build also produces a `jev` control plugin package. Install it only if you specifically need its operator commands; it is not required for the decision plugin itself.

## Local smoke checks

```sh
npm run smoke:mcp-stub
npm run smoke:muse-hook-stub
```

These use local fixtures/stubs; they do not make provider requests. For the end-to-end deterministic graph exercise, first run `npm run sandbox:probe`, then follow [Usage](USAGE.md#deterministic-demo).
