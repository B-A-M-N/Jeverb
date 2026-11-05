#!/usr/bin/env bash
# Exercise the built native Muse hook through config, Jev adapter, judgment,
# Muse output mapping, and durable receipts using only a local OpenRouter stub.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PRODUCTION_SHIM="$ROOT/plugin/dist/muse/PreToolUse.mjs"
[ -f "$PRODUCTION_SHIM" ] || { echo "missing built Muse hook; run npm run build first" >&2; exit 2; }

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jeverb-muse-hook-stub.XXXXXX")"
STUB_PID=""
cleanup() {
  if [ -n "$STUB_PID" ]; then kill "$STUB_PID" 2>/dev/null || true; wait "$STUB_PID" 2>/dev/null || true; fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

DATA_DIR="$WORK_DIR/plugin-data"
mkdir -m 700 -p "$DATA_DIR" "$WORK_DIR/home"
SHIM="$WORK_DIR/muse/PreToolUse.mjs"
SWITCH_PATH="$WORK_DIR/control-state.json"
mkdir -m 700 -p "$WORK_DIR/muse"
node --input-type=module - "$ROOT" "$WORK_DIR/hook.mjs" "$SHIM" <<'JS'
import { buildSync } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const [root, outfile, shim] = process.argv.slice(2);
buildSync({
  entryPoints: [join(root, "src/hooks/cli.ts")], outfile, bundle: true,
  platform: "node", format: "esm", target: "node20", minify: true,
  minifyIdentifiers: false, write: true,
  define: { __JEV_TEST_CONTROL_BUILD__: "true" },
});
mkdirSync(dirname(shim), { recursive: true });
writeFileSync(shim, `process.argv[2] = "muse";\nprocess.argv[3] = "PreToolUse";\nawait import("../hook.mjs");\n`);
JS
python3 - "$SWITCH_PATH" <<'PY'
import json, os, sys
with open(sys.argv[1], "x", encoding="utf-8") as fh:
    json.dump({"schema_version": 1, "desired": "ON", "generation": "b" * 32}, fh)
os.chmod(sys.argv[1], 0o600)
PY
python3 - "$DATA_DIR" <<'PY'
import json, os, sys
root = sys.argv[1]
config = {
    "backend": "openrouter",
    "model": "typesafe/jev-router",
    "allow_custom_relay": True,
    "gate": "advisory",
    "lint": "off",
    "route_prompts": False,
    "screen_results": False,
}
with open(os.path.join(root, "config.json"), "w", encoding="utf-8") as fh:
    json.dump(config, fh)
os.chmod(os.path.join(root, "config.json"), 0o600)
with open(os.path.join(root, "credentials"), "w", encoding="utf-8") as fh:
    json.dump({"OPENROUTER_API_KEY": "synthetic-local-hook-key"}, fh)
os.chmod(os.path.join(root, "credentials"), 0o600)
PY

run_case() {
  local scenario="$1" expected="$2" timeout_ms="$3" delay_s="$4"
  local port_num
  port_num="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
  python3 - "$DATA_DIR/config.json" "$port_num" "$timeout_ms" <<'PY'
import json, sys
path, port, timeout = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
config = json.load(open(path, encoding="utf-8"))
config.update({"base_url": f"http://127.0.0.1:{port}/api/v1", "timeout_ms": timeout})
with open(path, "w", encoding="utf-8") as fh:
    json.dump(config, fh)
PY
  STUB_PORT="$port_num" STUB_LOG="$WORK_DIR/$scenario.jsonl" STUB_SCENARIO="$scenario" STUB_DELAY_S="$delay_s" \
    python3 "$ROOT/harness/stub-relay.py" >"$WORK_DIR/$scenario.stub.stdout" 2>"$WORK_DIR/$scenario.stub.stderr" &
  STUB_PID=$!
  python3 - "$port_num" <<'PY'
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
  printf '%s\n' "{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"muse-hook-$scenario\",\"cwd\":\"$WORK_DIR\",\"permission_mode\":\"default\",\"tool_name\":\"Bash\",\"tool_use_id\":\"stub-$scenario\",\"tool_input\":{\"command\":\"curl -X POST https://example.com/$scenario\"}}" |
    env -i PATH="$PATH" HOME="$WORK_DIR/home" MUSE_PLUGIN_DATA_DIR="$DATA_DIR" JEV_TEST_CONTROL_STATE_PATH="$SWITCH_PATH" \
      node "$SHIM" >"$WORK_DIR/$scenario.hook.stdout" 2>"$WORK_DIR/$scenario.hook.stderr"
  kill "$STUB_PID" 2>/dev/null || true
  wait "$STUB_PID" 2>/dev/null || true
  STUB_PID=""
  python3 - "$WORK_DIR" "$scenario" "$expected" <<'PY'
import json, os, sys
root, scenario, expected = sys.argv[1:]
requests = [json.loads(line) for line in open(os.path.join(root, f"{scenario}.jsonl"), encoding="utf-8") if line.strip()]
assert len(requests) == 1, (scenario, requests)
request = requests[0]
assert request["model"] == "typesafe/jev-router", (scenario, request)
assert request["path"] == "/api/alpha/decisions", (scenario, request)
assert request["auth_present"] is True, (scenario, request)
assert request["question_ids"], (scenario, request)
receipts = [json.loads(line) for line in open(os.path.join(root, "plugin-data", "evidence.log"), encoding="utf-8") if line.strip()]
matched = [r for r in receipts if r.get("event") == "PreToolUse" and r.get("toolUseId") == f"stub-{scenario}"]
assert len(matched) == 1, (scenario, matched)
receipt = matched[0]
assert receipt.get("judgment") == expected, (scenario, receipt)
if expected == "JUDGMENT_SUCCEEDED":
    assert receipt.get("model") == "typesafe/jev-1.14-20261014", (scenario, receipt)
assert "synthetic-local-hook-key" not in json.dumps(receipt), receipt
stdout = open(os.path.join(root, f"{scenario}.hook.stdout"), encoding="utf-8").read()
if scenario == "destructive":
    output = json.loads(stdout)
    context = output.get("hookSpecificOutput", {}).get("additionalContext", "")
    assert "destructive" in context and "0.97" in context, (output, receipt)
    assert receipt["enforcement"] == "advise", receipt
else:
    assert stdout == "", (scenario, stdout)
    if scenario == "benign":
        assert receipt["enforcement"] == "allow", receipt
    else:
        assert receipt["enforcement"] == "advise", receipt
print(f"Muse hook case passed: {scenario} ({expected})")
PY
}

# Host-style sanitized env; settings and synthetic credentials come from the
# plugin data directory. No request leaves loopback.
run_case benign JUDGMENT_SUCCEEDED 3000 0
run_case destructive JUDGMENT_SUCCEEDED 3000 0
run_case malformed INVALID_MODEL_RESPONSE 3000 0
run_case http429 RATE_LIMITED 3000 0
run_case delayed JUDGMENT_TIMEOUT 500 1

echo "Muse hook → Jeverb → Jev adapter local qualification: PASS (5 cases, no external provider)"
