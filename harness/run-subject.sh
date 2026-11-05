#!/usr/bin/env bash
# Run ONE frozen Jeverb candidate as the Test Subject.
#
# The subject gets an isolated plugin store (XDG_DATA_HOME/CONFIG under the
# evidence dir), so installs and approvals here never touch the operator's or
# the Supervisor's plugin environment. The candidate directory is used
# read-only: validate + install + approve, then a bounded headless session
# whose JSONL trace lands in the evidence dir.
#
# Usage:
#   harness/run-subject.sh --candidate DIR --workspace DIR --prompt-file FILE \
#     --evidence-dir DIR [--max-steps N] [--provider echo|meta] [--model ID]
#
# Exit code: the `muse exec` exit code (0 = session completed).

set -u
CANDIDATE=""
WORKSPACE=""
PROMPT_FILE=""
EVIDENCE=""
MAX_STEPS="30"
PROVIDER="echo"
MODEL=""
SCENARIO_DIR=""
HARNESS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --candidate) CANDIDATE="$2"; shift 2;;
    --workspace) WORKSPACE="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --evidence-dir) EVIDENCE="$2"; shift 2;;
    --max-steps) MAX_STEPS="$2"; shift 2;;
    --provider) PROVIDER="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --scenario-dir) SCENARIO_DIR="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

for v in CANDIDATE WORKSPACE PROMPT_FILE EVIDENCE; do
  if [ -z "${!v}" ]; then echo "missing --$(echo "$v" | tr 'A-Z-' 'a-z-')" >&2; exit 2; fi
done
[ -d "$CANDIDATE" ] || { echo "candidate dir not found: $CANDIDATE" >&2; exit 2; }
[ -d "$WORKSPACE" ] || { echo "workspace dir not found: $WORKSPACE" >&2; exit 2; }
[ -f "$PROMPT_FILE" ] || { echo "prompt file not found: $PROMPT_FILE" >&2; exit 2; }

mkdir -p "$EVIDENCE/subject-home/data" "$EVIDENCE/subject-home/config"
export XDG_DATA_HOME="$EVIDENCE/subject-home/data"
export XDG_CONFIG_HOME="$EVIDENCE/subject-home/config"
source "$HARNESS_DIR/subject-secrets.sh"
# Backstop: planted secrets (below) must never survive in retained evidence,
# even when the script exits early. The explicit removals after the session
# are the primary path; this trap covers every `exit` in between.
trap cleanup_subject_secrets EXIT
# Full home isolation: hook credential lookup falls back to
# `$HOME/.config/jeverb/credentials`, so the subject gets a home of its
# own. Operator-provided provider keys are planted there (0600, JSON) —
# never echoed, and removed after the run. Env vars still cover
# transports that inherit the environment; the file covers hooks whose
# runtime sanitizes it.
export HOME="$EVIDENCE/subject-home"
mkdir -p "$EVIDENCE/subject-home/.config/jeverb"
# Opt-in subject authentication for live (`--provider meta`) runs: the
# isolated HOME hides the operator's `muse login`, so without this the
# subject session fails with "missing meta credentials" before any hook
# fires. Set JEVERB_SUBJECT_AUTH to a muse auth.json to copy into the
# subject config home for the duration of the run. The copy is removed by
# the EXIT trap above; its content is never read, echoed, or retained.
# Unset (the default) means live-model runs fail closed at session start.
if [ -n "${JEVERB_SUBJECT_AUTH:-}" ]; then
  [ -f "$JEVERB_SUBJECT_AUTH" ] || { echo "JEVERB_SUBJECT_AUTH not found: $JEVERB_SUBJECT_AUTH" >&2; exit 2; }
  mkdir -p "$EVIDENCE/subject-home/config/muse"
  cp "$JEVERB_SUBJECT_AUTH" "$EVIDENCE/subject-home/config/muse/auth.json"
  chmod 600 "$EVIDENCE/subject-home/config/muse/auth.json"
  echo "[subject] subject auth installed for this run only (removed afterwards)"
fi
if [ -n "${OPENROUTER_API_KEY:-}" ] || [ -n "${TYPESAFE_API_KEY:-}" ]; then
  python3 - "$EVIDENCE/subject-home/.config/jeverb/credentials" <<'PYEOF'
import json, os, sys
creds = {}
for field in ("OPENROUTER_API_KEY", "TYPESAFE_API_KEY"):
    value = os.environ.get(field, "").strip()
    if value:
        creds[field] = value
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(creds, fh)
os.chmod(sys.argv[1], 0o600)
print(f"planted {len(creds)} credential field(s)", file=sys.stderr)
PYEOF
fi

# Frozen-candidate provenance, computed BEFORE install: the identity recorded
# here is what every execution receipt must carry. A dirty tree (uncommitted
# or untracked content) is rejected unless JEVERB_ALLOW_DIRTY=1, in which
# case the dirty-tree content hashes become part of the frozen identity.
candidate_identity() {
  # $1 = scratch dir for the dirty-tree manifest. Prints identity to stdout.
  local scratch="$1" head_sha dirty_list dirty_sum
  if git -C "$CANDIDATE" rev-parse --git-dir >/dev/null 2>&1; then
    head_sha="$(git -C "$CANDIDATE" rev-parse HEAD)" || { echo "candidate has no HEAD commit" >&2; return 3; }
    dirty_list="$(git -C "$CANDIDATE" status --porcelain=v1 -uall)"
    if [ -n "$dirty_list" ]; then
      printf '%s\n' "$dirty_list" > "$scratch/dirty-manifest"
      printf '%s\n' "$dirty_list" | sed 's/^.\{3\}//' | while IFS= read -r entry; do
        f="${entry##* -> }"
        f="${f%\"}"; f="${f#\"}"
        if [ -f "$CANDIDATE/$f" ]; then (cd "$CANDIDATE" && sha256sum "$f"); else printf 'MISSING %s\n' "$f"; fi
      done > "$scratch/dirty-hashes" 2>/dev/null
      if [ "${JEVERB_ALLOW_DIRTY:-0}" != "1" ]; then
        echo "[subject] rejecting dirty candidate: commit the tree or re-run with JEVERB_ALLOW_DIRTY=1" >&2
        return 3
      fi
      dirty_sum="$(cut -d' ' -f1 "$scratch/dirty-hashes" | sha256sum | cut -d' ' -f1)"
      printf '%s+dirty:%s' "$head_sha" "$dirty_sum"
    else
      printf '%s' "$head_sha"
    fi
  else
    find "$CANDIDATE" -type f | sort | sha256sum | cut -c1-40 | tr -d '\n'
  fi
}

mkdir -p "$EVIDENCE/provenance"
if ! candidate_identity "$EVIDENCE/provenance" > "$EVIDENCE/provenance/identity-raw"; then
  cp "$EVIDENCE/provenance/dirty-manifest" "$EVIDENCE/dirty-manifest" 2>/dev/null || true
  cp "$EVIDENCE/provenance/dirty-hashes" "$EVIDENCE/dirty-hashes" 2>/dev/null || true
  exit 3
fi
tr -d '\n' < "$EVIDENCE/provenance/identity-raw" > "$EVIDENCE/candidate-sha"
if [ -f "$EVIDENCE/provenance/dirty-manifest" ]; then
  echo "[subject] dirty-tree snapshot accepted (JEVERB_ALLOW_DIRTY=1)"
  cp "$EVIDENCE/provenance/dirty-manifest" "$EVIDENCE/dirty-manifest"
  cp "$EVIDENCE/provenance/dirty-hashes" "$EVIDENCE/dirty-hashes"
fi
# Artifact digest BEFORE install: the exact manifest the Subject will load.
[ -f "$CANDIDATE/.muse-plugin/plugin.json" ] || { echo "candidate manifest not found: $CANDIDATE/.muse-plugin/plugin.json" >&2; exit 3; }
echo "sha256:$(sha256sum "$CANDIDATE/.muse-plugin/plugin.json" | cut -d' ' -f1)" > "$EVIDENCE/manifest-digest"
# Candidate attribution for receipts, exported BEFORE install so every hook
# in the session stamps the same SHA it was installed from. The hook runtime
# sanitizes subprocess env, so the `candidate` file planted below (read by
# the ledger as its fallback) is the reliable channel; the env var covers
# transports that do inherit it.
JEVERB_CANDIDATE="$(cat "$EVIDENCE/candidate-sha")"
export JEVERB_CANDIDATE
# Pin the installed plugin's actual data dir via the documented operator
# override (highest precedence in resolveDataDir) and record it for the
# gate, so receipts are located by identity — never by a hardcoded
# marketplace-derived path.
PINNED_LEDGER_DIR="$EVIDENCE/ledger"
mkdir -p "$PINNED_LEDGER_DIR"
export JEV_HOOKS_DATA_DIR="$PINNED_LEDGER_DIR"
printf '%s' "$PINNED_LEDGER_DIR" > "$EVIDENCE/ledger-dir"
cp "$EVIDENCE/candidate-sha" "$PINNED_LEDGER_DIR/candidate"

echo "[subject] validating candidate: $CANDIDATE"
muse plugins validate "$CANDIDATE" || exit 3
echo "[subject] installing candidate (isolated store)"
muse plugins install "$CANDIDATE" || exit 3
echo "[subject] approving jeverb capabilities"
muse plugins approve jeverb || exit 3

# Catalog seed: `muse exec --provider meta` reads its model list from an
# on-disk cache; a relay that only serves the API shape cannot satisfy the
# installed CLI's catalog fetch. Seed the cache from the versioned repo
# file (override via JEVERB_SEED_CATALOG). Missing seed is a loud warning,
# not a silent live-session failure.
SEED_SRC="${JEVERB_SEED_CATALOG:-$(dirname "$0")/freeonly-seed-catalog.json}"
SEED_DST="$EVIDENCE/subject-home/data/muse/model-catalog/6d657461__p746268.json"
mkdir -p "$(dirname "$SEED_DST")"
if [ -f "$SEED_SRC" ]; then
  cp "$SEED_SRC" "$SEED_DST"
  echo "[subject] seeded model catalog from $SEED_SRC"
else
  echo "[subject] WARNING: no seed catalog at $SEED_SRC; live session may fail at catalog fetch"
fi

# Static enforcement proof before any live session attempts a gated action:
# if the scenario declares a hook_precheck, run it into this run's evidence
# dir and abort the live run when the candidate does not deny what it must.
if [ -n "$SCENARIO_DIR" ] && [ -f "$SCENARIO_DIR/expects.json" ]; then
  SPEC="$(python3 -c 'import json,sys; e=json.load(open(sys.argv[1])).get("hook_precheck") or {}; print((e.get("fixture") or ""), (e.get("hook") or ""), (e.get("expect") or ""), sep="\t")' "$SCENARIO_DIR/expects.json")"
  FIXTURE="$(printf '%s' "$SPEC" | cut -f1)"
  if [ -n "$FIXTURE" ]; then
    HOOK="$(printf '%s' "$SPEC" | cut -f2)"
    EXPECT="$(printf '%s' "$SPEC" | cut -f3)"
    echo "[subject] hook precheck ($HOOK expect $EXPECT)"
    if ! bash "$(dirname "$0")/hook-precheck.sh" --candidate "$CANDIDATE" \
        --store-dir "$EVIDENCE/precheck-store" --fixture "$CANDIDATE/$FIXTURE" \
        --hook "$HOOK" --expect "$EXPECT" > "$EVIDENCE/precheck.log" 2>&1; then
      echo "[subject] precheck FAILED; live run skipped (see $EVIDENCE/precheck.log)"
      exit 3
    fi
  fi
fi

TRACE="$EVIDENCE/subject.jsonl"
# Belt and braces: if the host sanitizes JEV_HOOKS_DATA_DIR out of hook
# environments, hooks fall back to the store-derived data dir. Plant the
# frozen identity in every plugin data dir already present under this run's
# isolated store (the post-run re-verify below confirms which one won).
# The data dir itself is created lazily by the first hook write, so it
# usually does not exist yet — also plant at every installed plugin root
# (plugins/cache/...), which the ledger's bundle-adjacent fallback reads
# by walking up from the running hook bundle.
while IFS= read -r d; do
  [ -n "$d" ] || continue
  cp "$EVIDENCE/candidate-sha" "$d/candidate" 2>/dev/null || true
done <<DIRS
$(find "$EVIDENCE/subject-home" "$EVIDENCE/precheck-store" -maxdepth 6 -type d -path "*plugins/data/*" 2>/dev/null)
$(find "$EVIDENCE/subject-home" -type d -path "*plugins/cache/local/jeverb" 2>/dev/null)
$(find "$EVIDENCE/subject-home" -type d -path "*plugins/cache/*jeverb*" -name "package" 2>/dev/null)
DIRS
# Credential plant for the sanitized hook environment: the hooks always
# resolve the store-derived plugin data dir (MUSE_PLUGIN_DATA_DIR), so a
# 0600 credentials file there is reachable no matter how much of the
# operator env the host strips. Best-effort (the layout is host-owned);
# the HOME-planted file and env passthrough above remain as fallbacks.
# Key material is never echoed; the file is removed with the block below
# after the session.
PLUGIN_DATA_DIR="$EVIDENCE/subject-home/data/muse/plugins/data/jeverb"
# Backend/model/base_url propagation: hook transports sanitize operator env,
# so JEV_BACKEND / JEV_MODEL / *_BASE_URL never reach hook processes
# directly. The hook reads install-scoped config.json from its resolved data
# dir (env wins when both are set), so the harness forwards those three
# operator settings through the same plant locations as the credentials.
# Only operator-provided values are written — nothing is invented here, so
# echo/plumbing runs without backend env behave exactly as before.
# Live Jev-active runs need at minimum: JEV_BACKEND=openrouter (or native
# with TYPESAFE_API_KEY) plus the matching key exported alongside.
if [ -n "${JEV_BACKEND:-}" ] || [ -n "${JEV_MODEL:-}" ] || [ -n "${OPENROUTER_BASE_URL:-}" ] || [ -n "${TYPESAFE_BASE_URL:-}" ] || [ -n "${JEV_HOOK_TIMEOUT_MS:-}" ]; then
  mkdir -p "$PINNED_LEDGER_DIR" "$PLUGIN_DATA_DIR"
  python3 - "$HARNESS_DIR" "$PINNED_LEDGER_DIR/config.json" "$PLUGIN_DATA_DIR/config.json" <<'PYEOF'
import json, os, sys
sys.path.insert(0, sys.argv[1])
from subject_config import subject_hook_config
cfg, warnings = subject_hook_config(dict(os.environ))
for warning in warnings:
    print(warning, file=sys.stderr)
for path in sys.argv[2:]:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh)
print(f"planted data-dir config: {sorted(cfg)}", file=sys.stderr)
PYEOF
fi
if [ -n "${OPENROUTER_API_KEY:-}" ] || [ -n "${TYPESAFE_API_KEY:-}" ]; then
  mkdir -p "$PLUGIN_DATA_DIR"
  python3 - "$PLUGIN_DATA_DIR/credentials" <<'PYEOF'
import json, os, sys
creds = {}
for field in ("OPENROUTER_API_KEY", "TYPESAFE_API_KEY"):
    value = os.environ.get(field, "").strip()
    if value:
        creds[field] = value
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(creds, fh)
os.chmod(sys.argv[1], 0o600)
print("planted data-dir credentials", file=sys.stderr)
PYEOF
fi
echo "[subject] executing bounded session (max-steps=$MAX_STEPS, provider=$PROVIDER)"
if [ -n "$MODEL" ]; then
  muse exec --workspace "$WORKSPACE" --max-model-steps "$MAX_STEPS" \
    --provider "$PROVIDER" --model "$MODEL" --json \
    --prompt-file "$PROMPT_FILE" > "$TRACE"
else
  muse exec --workspace "$WORKSPACE" --max-model-steps "$MAX_STEPS" \
    --provider "$PROVIDER" --json \
    --prompt-file "$PROMPT_FILE" > "$TRACE"
fi
code=$?
echo "$code" > "$EVIDENCE/exit-code"
# The planted operator credentials served the live session; remove them now
# so retained evidence never carries key material (the EXIT trap repeats
# this on every path, including early exits). Hook receipts redact
# secrets by construction, and the gate re-checks provenance without keys.
cleanup_subject_secrets
echo "[subject] operator credential files removed from retained evidence"
# Re-verify AFTER the run: the candidate tree must still describe the same
# frozen identity the session was installed from. A mismatch means the tree
# moved under a live session and the receipts are unattributed — fail closed.
REVERIFY_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/jeverb-reverify-XXXXXX")"
if ! candidate_identity "$REVERIFY_SCRATCH" > "$REVERIFY_SCRATCH/identity-raw"; then
  echo "[subject] candidate tree changed during the run (now dirty); evidence unattributed" >&2
  rm -rf "$REVERIFY_SCRATCH"
  exit 3
fi
tr -d '\n' < "$REVERIFY_SCRATCH/identity-raw" > "$EVIDENCE/candidate-sha-after"
rm -rf "$REVERIFY_SCRATCH"
if ! cmp -s "$EVIDENCE/candidate-sha" "$EVIDENCE/candidate-sha-after"; then
  echo "[subject] candidate identity moved during the run:" >&2
  echo "  before: $(cat "$EVIDENCE/candidate-sha")" >&2
  echo "  after:  $(cat "$EVIDENCE/candidate-sha-after")" >&2
  exit 3
fi
AFTER_DIGEST="sha256:$(sha256sum "$CANDIDATE/.muse-plugin/plugin.json" | cut -d' ' -f1)"
if [ "$AFTER_DIGEST" != "$(cat "$EVIDENCE/manifest-digest")" ]; then
  echo "[subject] candidate manifest changed during the run: was $(cat "$EVIDENCE/manifest-digest"), now $AFTER_DIGEST" >&2
  exit 3
fi
echo "[subject] provenance re-verified: $(cat "$EVIDENCE/candidate-sha") $(cat "$EVIDENCE/manifest-digest")"
# Remaining provenance the gate requires (flat files, exit-code layout).
# candidate-sha and manifest-digest were recorded before install (and
# re-verified just above) so hooks stamp the installed identity.
muse --version 2>/dev/null | tr -d '\n' > "$EVIDENCE/muse-version"
printf '%s' "$PROVIDER" > "$EVIDENCE/provider"
if [ -n "$MODEL" ]; then printf '%s' "$MODEL" > "$EVIDENCE/model"; fi
# Scenario provenance for direct invocations (validate-candidate.sh sets this
# when driving the full matrix; a bare run-subject.sh call must too, or the
# gate cannot attribute the run to a scenario).
if [ -n "$SCENARIO_DIR" ]; then
  basename "$(realpath "$SCENARIO_DIR")" | tr -d '\n' > "$EVIDENCE/scenario-id"
elif [ -n "$PROMPT_FILE" ]; then
  basename "$(dirname "$(realpath "$PROMPT_FILE")")" | tr -d '\n' > "$EVIDENCE/scenario-id"
fi
if [ ! -s "$EVIDENCE/scenario-id" ]; then printf 'direct' > "$EVIDENCE/scenario-id"; fi
echo "[subject] exit=$code trace=$TRACE"
exit "$code"
