#!/usr/bin/env bash
# Exercise built MCP stdio producer and Veyrict observation consumer against a local Jev stub.
# No Muse installation, provider account, or external network endpoint is used.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PRODUCTION_BUNDLE="$ROOT/dist/muse-plugins/jeverb/plugin/dist/mcp.mjs"
[ -f "$PRODUCTION_BUNDLE" ] || { echo "missing built Muse candidate MCP bundle; run npm run build first" >&2; exit 2; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/jeverb-mcp-stub-smoke.XXXXXX")"
STUB_PID=""
PLUGIN_DATA="$TMP/plugin-data"
mkdir -m 700 -p "$PLUGIN_DATA"
cleanup() {
  if [ -n "$STUB_PID" ]; then kill "$STUB_PID" 2>/dev/null || true; wait "$STUB_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# Build the same MCP entry for an isolated test switch. The production build
# intentionally hard-pins the root-owned switch path, which is OFF on this
# host; this test-only compile-time seam exercises the MCP behavior without
# changing or bypassing the installed control service.
TEST_BUNDLE="$TMP/mcp.mjs"
SWITCH_PATH="$TMP/control-state.json"
node --input-type=module - "$ROOT" "$TEST_BUNDLE" <<'JS'
import { buildSync } from "esbuild";
import { join } from "node:path";
const [root, outfile] = process.argv.slice(2);
buildSync({
  entryPoints: [join(root, "src/index.ts")], outfile, bundle: true,
  platform: "node", format: "esm", target: "node20", write: true,
  define: { __JEV_TEST_CONTROL_BUILD__: "true" },
});
JS
python3 - "$SWITCH_PATH" <<'PY'
import json, os, sys
with open(sys.argv[1], "x", encoding="utf-8") as fh:
    json.dump({"schema_version": 1, "desired": "ON", "generation": "a" * 32}, fh)
os.chmod(sys.argv[1], 0o600)
PY

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
STUB_PORT="$PORT" STUB_LOG="$TMP/stub.jsonl" python3 "$ROOT/harness/stub-relay.py" >"$TMP/stub.stdout" 2>"$TMP/stub.stderr" &
STUB_PID=$!

python3 - "$PORT" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
for _ in range(50):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=.2):
            raise SystemExit(0)
    except OSError:
        time.sleep(.1)
raise SystemExit("local stub did not become ready")
PY

python3 "$ROOT/harness/mcp-stub-client.py" "$TEST_BUNDLE" "$PLUGIN_DATA" "$PORT" "$SWITCH_PATH"
python3 - "$TMP/stub.jsonl" <<'PY'
import json, sys
requests = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
assert len(requests) == 3, requests
assert all(row["model"] == "typesafe/jev-router" and row["auth_present"] is True for row in requests), requests
assert all(row["path"] == "/api/alpha/decisions" for row in requests), requests
assert [row["question_ids"] for row in requests] == [["benign"], ["risk", "route"], ["q"]], requests
print("MCP stdio + local Jev stub: PASS (3 authenticated synthetic requests, no external provider)")
PY
