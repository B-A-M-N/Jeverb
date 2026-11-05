#!/usr/bin/env bash
# Validate ONE frozen candidate against every harness scenario.
#
# For each scenario: copy the seed workspace to a disposable dir, run the
# optional setup.sh, execute the subject, gate the evidence. Prints one
# verdict line per scenario and exits non-zero if any scenario fails.
#
# Usage:
#   harness/validate-candidate.sh --candidate DIR [--provider echo|meta]
#     [--model ID] [--max-steps N] [--evidence-root DIR]
#
# The gate (not any model's opinion) decides pass/fail. A gate failure means
# "triage needed": it may be a candidate defect OR the subject model refusing
# to attempt the gated action — see harness/README.md.

set -u
CANDIDATE=""
PROVIDER="echo"
MODEL=""
MAX_STEPS="30"
EVIDENCE_ROOT=""
HARNESS_DIR="$(cd "$(dirname "$0")" && pwd)"
# Scenario fixture paths in expects.json are repo-relative.
REPO_ROOT="$(dirname "$HARNESS_DIR")"

while [ $# -gt 0 ]; do
  case "$1" in
    --candidate) CANDIDATE="$2"; shift 2;;
    --provider) PROVIDER="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --max-steps) MAX_STEPS="$2"; shift 2;;
    --evidence-root) EVIDENCE_ROOT="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$CANDIDATE" ] || { echo "missing --candidate" >&2; exit 2; }
[ -d "$CANDIDATE" ] || { echo "candidate dir not found: $CANDIDATE" >&2; exit 2; }

if [ -z "$EVIDENCE_ROOT" ]; then
  EVIDENCE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jeverb-validation-XXXXXX")"
fi
mkdir -p "$EVIDENCE_ROOT"

PLUMBING=""
if [ "$PROVIDER" = "echo" ]; then PLUMBING="--plumbing-only"; fi

MODEL_ARG=""
if [ -n "$MODEL" ]; then MODEL_ARG="--model $MODEL"; fi

overall=0
for scenario in "$HARNESS_DIR"/scenarios/*/; do
  # Static enforcement proof first: if the candidate cannot deny the gated
  # action in a deterministic fixture test, skip its live run entirely.
  precheck="$(python3 -c "import json; print(json.load(open('$scenario/expects.json')).get('hook_precheck', ''))" 2>/dev/null)"
  if [ -n "$precheck" ] && [ "$precheck" != "None" ]; then
    fixture="$(python3 -c "import json; print(json.load(open('$scenario/expects.json'))['hook_precheck']['fixture'])")"
    hook="$(python3 -c "import json; print(json.load(open('$scenario/expects.json'))['hook_precheck']['hook'])")"
    expect="$(python3 -c "import json; print(json.load(open('$scenario/expects.json'))['hook_precheck']['expect'])")"
    name="$(basename "$scenario")"
    if ! bash "$HARNESS_DIR/hook-precheck.sh" --candidate "$CANDIDATE" \
        --store-dir "$EVIDENCE_ROOT/precheck-store" --fixture "$REPO_ROOT/$fixture" \
        --hook "$hook" --expect "$expect" > "$EVIDENCE_ROOT/$name-precheck.log" 2>&1; then
      echo "FAIL $name (hook precheck; live run skipped — see $EVIDENCE_ROOT/$name-precheck.log)"
      overall=1
      continue
    fi
    echo "precheck $name: $(cat "$EVIDENCE_ROOT/$name-precheck.log")"
  fi
  name="$(basename "$scenario")"
  ev="$EVIDENCE_ROOT/$name"
  ws="$ev/workspace"
  mkdir -p "$ws"
  printf '%s' "$name" > "$ev/scenario-id"
  if [ -d "$scenario/workspace" ]; then cp -r "$scenario/workspace/." "$ws/"; fi
  if [ -x "$scenario/setup.sh" ]; then "$scenario/setup.sh" "$ws" || { echo "FAIL $name (setup)"; overall=1; continue; }; fi
  # shellcheck disable=SC2086
  if ! bash "$HARNESS_DIR/run-subject.sh" --candidate "$CANDIDATE" \
      --workspace "$ws" --prompt-file "$scenario/prompt.md" \
      --evidence-dir "$ev" --max-steps "$MAX_STEPS" \
      --provider "$PROVIDER" $MODEL_ARG > "$ev/run.log" 2>&1; then
    echo "FAIL $name (subject exit non-zero; see $ev/run.log)"
    overall=1
    continue
  fi
  # shellcheck disable=SC2086
  if python3 "$HARNESS_DIR/gate.py" --evidence-dir "$ev" \
      --scenario-dir "$scenario" $PLUMBING > "$ev/verdict.json" 2>"$ev/gate.err"; then
    echo "PASS $name (evidence: $ev)"
  else
    echo "FAIL $name (gate; see $ev/verdict.json)"
    overall=1
  fi
done
echo "evidence root: $EVIDENCE_ROOT"
exit "$overall"
