#!/usr/bin/env bash
# Verify a frozen Jeverb candidate installs into an isolated Muse plugin
# store with its hooks AND its MCP server approved and discoverable.
#
# Usage: harness/verify-install.sh --candidate DIR --evidence-dir DIR
# Exit 0 when: validate passes, install succeeds, hook + mcp capabilities
# approve, inspect shows both active, and a hook fixture runs.
# This does not prove live tool invocation (that is step 06); it proves the
# installed package exposes what the manifest declares.
set -u

CANDIDATE=""
EVIDENCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --candidate) CANDIDATE="$2"; shift 2;;
    --evidence-dir) EVIDENCE="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$CANDIDATE" ] || { echo "missing --candidate" >&2; exit 2; }
[ -n "$EVIDENCE" ] || { echo "missing --evidence-dir" >&2; exit 2; }
[ -d "$CANDIDATE" ] || { echo "candidate dir not found: $CANDIDATE" >&2; exit 2; }

mkdir -p "$EVIDENCE/install-home/data" "$EVIDENCE/install-home/config"
export XDG_DATA_HOME="$EVIDENCE/install-home/data"
export XDG_CONFIG_HOME="$EVIDENCE/install-home/config"

echo "[install] validating $CANDIDATE"
muse plugins validate "$CANDIDATE" --json > "$EVIDENCE/validate.json" || { echo "validate failed" >&2; exit 3; }

echo "[install] installing"
muse plugins install "$CANDIDATE" --json > "$EVIDENCE/install.json" || { echo "install failed" >&2; exit 3; }

echo "[install] approving hooks and MCP server"
muse plugins approve jeverb --json > "$EVIDENCE/approve.json" || { echo "approve failed" >&2; exit 3; }

echo "[install] inspecting"
muse plugins inspect jeverb --json > "$EVIDENCE/inspect.json" || { echo "inspect failed" >&2; exit 3; }

python3 - "$EVIDENCE/inspect.json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
caps = d["plugin"]["capabilities"]
hooks = caps.get("hooks", [])
mcps = caps.get("mcp_servers", [])
hook_ids = {h.get("id") for h in hooks}
assert "jev-pre-tool" in hook_ids, f"pre-tool hook missing: {sorted(hook_ids)}"
assert any(m.get("id") == "jeverb" for m in mcps), f"jeverb MCP server missing: {mcps}"
print(f"hooks={len(hooks)} mcp_servers={[m['id'] for m in mcps]} active={d.get('active')}")
assert d.get("active") is True, "plugin not active after approval"
EOF
[ $? -eq 0 ] || { echo "capability assertion failed" >&2; exit 4; }

echo "[install] running one hook fixture"
FIXTURE="$CANDIDATE/tests/fixtures/muse/pretool-destructive.json"
if [ -f "$FIXTURE" ]; then
  muse plugins hook test jeverb:jev-pre-tool --fixture "$FIXTURE" --json > "$EVIDENCE/hook-test.json" \
    || { echo "hook test failed" >&2; exit 5; }
  head -c 300 "$EVIDENCE/hook-test.json"; echo
else
  echo "no fixture at $FIXTURE, skipping hook test" >&2
fi

echo "[install] OK"
