#!/usr/bin/env bash
# Installed-package fixture checks only. Passing this script is not live Muse
# session qualification: it does not prove scheduled hooks or MCP activation.
set -euo pipefail

export MUSE_NO_AUTO_UPDATE="${MUSE_NO_AUTO_UPDATE:-1}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_dir="$repo_root/tests/fixtures/muse"
candidate_dir="$repo_root/dist/muse-plugins/jeverb"
qualification_session="jeverb-host-qualification-$$"
if ! command -v muse >/dev/null 2>&1; then
  echo "muse CLI is required for installed-package fixture checks" >&2
  exit 2
fi
if [ ! -d "$candidate_dir" ]; then
  echo "built Muse candidate is missing: $candidate_dir; run npm run build first" >&2
  exit 2
fi

inspect="$(muse plugins inspect jeverb --json)"
expected_hooks="$(jq '.capabilities.hooks | length' "$candidate_dir/.muse-plugin/plugin.json")"
installed_hooks="$(jq '.plugin.capabilities.hooks | length' <<<"$inspect")"
installed_cache="$(jq -r '.record.cache_path' <<<"$inspect")"
if [ "$installed_hooks" -ne "$expected_hooks" ]; then
  echo "installed Jeverb candidate is stale: Muse has $installed_hooks hooks; built candidate has $expected_hooks. Refresh the installed package before fixture checks." >&2
  exit 3
fi
for bundle in hook.mjs mcp.mjs; do
  candidate_hash="$(sha256sum "$candidate_dir/plugin/dist/$bundle" | cut -d' ' -f1)"
  installed_hash="$(sha256sum "$installed_cache/plugin/dist/$bundle" | cut -d' ' -f1)"
  if [ "$candidate_hash" != "$installed_hash" ]; then
    echo "installed Jeverb candidate bundle differs from built candidate: $bundle" >&2
    exit 3
  fi
done
if [ "${1:-}" = "--check-only" ]; then
  echo "Muse installed candidate matches built candidate: $installed_hooks hooks, hook/MCP bundle hashes match (inventory check only; no hook invocation)"
  exit 0
fi
if [ "$#" -gt 0 ]; then
  echo "usage: $0 [--check-only]" >&2
  exit 2
fi

run_hook() {
  local hook_id="$1"
  local fixture="$2"
  local expected_status="$3"
  local fixture_path output status actual_status actual_exit
  fixture_path="$(mktemp "${TMPDIR:-/tmp}/jeverb-hook-fixture.XXXXXX.json")"
  if jq --arg session_id "$qualification_session" '.stdin.session_id = $session_id' \
    "$fixture_dir/$fixture" >"$fixture_path"; then
    :
  else
    status=$?
    rm -f -- "$fixture_path"
    printf 'Muse hook fixture input failed: hook=%s fixture=%s exit_code=%s\n' \
      "$hook_id" "$fixture" "$status" >&2
    return "$status"
  fi
  if output="$(muse plugins hook test "jeverb:$hook_id" --fixture "$fixture_path" --json)"; then
    :
  else
    status=$?
    rm -f -- "$fixture_path"
    printf 'Muse hook fixture invocation failed: hook=%s fixture=%s exit_code=%s\n' \
      "$hook_id" "$fixture" "$status" >&2
    return "$status"
  fi
  rm -f "$fixture_path"
  if jq -e --arg status "$expected_status" '.terminals[0].status == $status and .terminals[0].exit_code == 0' <<<"$output" >/dev/null; then
    printf 'Muse hook fixture passed: %s (%s)\n' "$hook_id" "$expected_status"
  else
    actual_status="$(jq -r '.terminals[0].status // "missing"' <<<"$output" 2>/dev/null || printf 'invalid-json')"
    actual_exit="$(jq -r '.terminals[0].exit_code // "missing"' <<<"$output" 2>/dev/null || printf 'invalid-json')"
    printf 'Muse hook fixture mismatch: hook=%s fixture=%s expected=%s/0 actual=%s/%s\n' \
      "$hook_id" "$fixture" "$expected_status" "$actual_status" "$actual_exit" >&2
    return 1
  fi
}

run_hook jev-session-start session-start.json completed
run_hook jev-user-prompt user-prompt-submit.json completed
run_hook jev-pre-tool pretool-benign.json completed
run_hook jev-pre-tool pretool-destructive.json blocked
run_hook jev-permission-request permission-request-destructive.json blocked
run_hook jev-post-tool post-tool-use.json completed
run_hook jev-tool-failure post-tool-use-failure.json completed
run_hook jev-tool-batch post-tool-batch.json completed
run_hook jev-subagent-start subagent-start.json completed
run_hook jev-subagent-stop subagent-stop.json completed
run_hook jev-stop stop-empty.json blocked
run_hook jev-session-end session-end.json completed
run_hook jev-pre-llm-call pre-llm-call.json completed
run_hook jev-post-llm-call post-llm-call.json completed
run_hook jev-pre-compact pre-compact.json completed
run_hook jev-post-compact post-compact.json completed
run_hook jev-stop-failure stop-failure.json completed
run_hook jev-notification notification.json completed

echo "Muse installed-package hook fixture checks passed (17 lifecycle hooks, 18 fixtures; not live-session qualification)"
