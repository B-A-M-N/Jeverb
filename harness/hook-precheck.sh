#!/usr/bin/env bash
# Static enforcement proof BEFORE any live subject session attempts a gated
# action. Installs the candidate into an isolated plugin store, approves it,
# runs one hook fixture, and asserts the decision — no model involved.
#
# If the candidate does not deny what it must deny, the harness aborts the
# live run instead of probing a broken enforcement path with a live agent.
#
# Usage:
#   harness/hook-precheck.sh --candidate DIR --store-dir DIR \
#     --fixture FILE --hook HOOK_ID --expect deny|proceed

set -u
CANDIDATE=""
STORE=""
FIXTURE=""
HOOK=""
EXPECT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --candidate) CANDIDATE="$2"; shift 2;;
    --store-dir) STORE="$2"; shift 2;;
    --fixture) FIXTURE="$2"; shift 2;;
    --hook) HOOK="$2"; shift 2;;
    --expect) EXPECT="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
for v in CANDIDATE STORE FIXTURE HOOK EXPECT; do
  if [ -z "${!v}" ]; then echo "missing --$(echo "$v" | tr 'A-Z-' 'a-z-')" >&2; exit 2; fi
done

mkdir -p "$STORE/data" "$STORE/config"
export XDG_DATA_HOME="$STORE/data"
export XDG_CONFIG_HOME="$STORE/config"

muse plugins install "$CANDIDATE" > /dev/null || exit 3
muse plugins approve jeverb > /dev/null || exit 3
out="$(muse plugins hook test "$HOOK" --fixture "$FIXTURE" --json 2>/dev/null)" || exit 3
python3 - "$out" "$EXPECT" <<'EOF'
import json, sys
raw, expect = sys.argv[1], sys.argv[2]
try:
    decision = json.loads(raw)["decision"]
except (json.JSONDecodeError, KeyError) as e:
    print(f"precheck: unparsable hook result: {e}")
    sys.exit(3)
perm = decision.get("permission_decision")
if expect == "deny":
    ok = perm == "deny"
elif expect == "proceed":
    ok = perm is None and not decision.get("should_block", False)
else:
    print(f"precheck: unknown expect {expect!r}")
    sys.exit(2)
print(f"precheck: permission_decision={perm!r} expect={expect} -> {'PASS' if ok else 'FAIL'}")
sys.exit(0 if ok else 1)
EOF
