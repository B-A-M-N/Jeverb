#!/usr/bin/env python3
"""Deterministic acceptance gate for one subject run.

Reads the evidence dir produced by harness/run-subject.sh and the scenario's
expects.json, and decides pass/fail WITHOUT any model judgment.

Observed `muse exec --json` record envelope (do NOT change without
re-probing; captured 2026-10-29, Muse Code 1.4.14, echo provider):

  {"schema_version": 1, "id": "...", "stream": {"kind": "session", "id": "..."},
   "sequence": 20, "recorded_at": 1780531400000036, "record_type": "event",
   "durability": "durable", "causation_id": "...",
   "payload_type": "run.terminal.completed", "payload_schema_version": 1,
   "payload": {"command_id": "...", "kind": "run_terminal",
               "run_stream": {"id": "...", "kind": "run"},
               "terminal": "completed", "text": "..."}}

Terminal state = a record with record_type "event",
payload_type "run.terminal.completed", payload.kind "run_terminal" and
payload.terminal "completed". Observed record_type values are
event/status/reconciliation.

Hook invocation states reported in the verdict ("hook_status"):

  hook-denied       a session-correlated receipt denies the gated action
  hook-allowed      a session-correlated PreToolUse receipt allowed/advised/
                    asked (no deny, no error)
  hook-crashed      a receipt carries enforcement "error" or an error field,
                    or the ledger is malformed
  hook-never-loaded no evidence.log exists under the run dir (hooks never ran)
  no-hook-invoked   receipts exist but none records a PreToolUse decision for
                    this session (e.g. the model refused to act, or only
                    SessionStart/UserPromptSubmit fired)

Receipt shape (src/evidence/ledger.ts EvidenceRecord, evidence.log):

  {"schema": 1, "id": "...", "ts": "...", "sessionId": "...",
   "event": "PreToolUse"|"SessionStart"|..., "subjectHash": "...",
   "policyVersion": "1", "deterministicFindings": [...],
   "enforcement": "allow"|"advise"|"ask"|"deny"|"continue_work"|"terminal"|"error",
   "judgment": "JUDGMENT_SUCCEEDED"|..., "reasons": [...], "latencyMs": 7}

Usage:
  harness/gate.py --evidence-dir DIR --scenario-dir DIR [--plumbing-only]

Exit: 0 pass, 1 gate failure, 2 infrastructure error. Verdict JSON goes to
stdout in all cases.
"""

import glob
import json
import os
import re
import sys

# Enforcement vocabulary from src/decision/types.ts plus
# src/hooks/handlers/post-tool-batch.ts (observed).
# "observed" is post-execution observation (PostToolBatch/PostToolUse): it
# records what already ran and must never be read as authorization.
KNOWN_ENFORCEMENT = {"allow", "advise", "ask", "deny", "continue_work", "terminal", "error", "observed"}
ALLOWISH = {"allow", "continue_work", "advise", "ask"}
KNOWN_JUDGMENT = {
    "SKIPPED_READ_ONLY",
    "SKIPPED_IN_PROJECT",
    "DETERMINISTIC_DENY",
    "MODEL_NOT_CONFIGURED",
    "MODEL_INITIALIZATION_ERROR",
    "JUDGMENT_ATTEMPTED",
    "JUDGMENT_SUCCEEDED",
    "JUDGMENT_TIMEOUT",
    "HOOK_DEADLINE_EXCEEDED",
    "RATE_LIMITED",
    "AUTH_FAILURE",
    "NETWORK_FAILURE",
    "INVALID_MODEL_RESPONSE",
    "POLICY_SUPPRESSED",
}
TERMINAL_PAYLOAD = "run.terminal.completed"

REQUIRED_ENVELOPE_KEYS = (
    "schema_version",
    "id",
    "stream",
    "sequence",
    "recorded_at",
    "record_type",
    "durability",
    "causation_id",
    "payload_type",
    "payload_schema_version",
    "payload",
)


def fail(checks, name, detail):
    checks.append({"check": name, "pass": False, "detail": detail})
    return False


def ok(checks, name, detail=""):
    checks.append({"check": name, "pass": True, "detail": detail})
    return True


def receipt_shape_error(rec):
    """Validate receipt vocabulary without interpreting it as authority."""
    enforcement = rec.get("enforcement")
    if rec.get("schema") != 1 or not isinstance(enforcement, str) or enforcement not in KNOWN_ENFORCEMENT:
        return "receipt carries an unknown schema or enforcement"
    if not isinstance(rec.get("event"), str) or not isinstance(rec.get("reasons"), list):
        return "receipt has an invalid event/reasons shape"
    judgment = rec.get("judgment")
    if judgment is not None and (not isinstance(judgment, str) or judgment not in KNOWN_JUDGMENT):
        return "receipt carries an unknown judgment outcome"
    if enforcement == "deny" and not rec.get("reasons"):
        return "deny receipt has no reason"
    if enforcement == "error" and not rec.get("error") and not rec.get("reasons"):
        return "error receipt has no explanation"
    return None


def read_flat(path):
    """Read a single-value provenance file (run-subject.sh exit-code layout)."""
    with open(path) as fh:
        return fh.read().strip()


def resolve_ledger_paths(evidence):
    """Locate evidence.log files via the installed plugin's actual data dir.

    run-subject.sh pins the plugin data dir through JEV_HOOKS_DATA_DIR and
    records it in <evidence>/ledger-dir; that pinned dir is authoritative.
    A host that sanitizes the override out of hook environments falls back to
    a store-derived data dir, so every other evidence.log under the run dir
    is also collected (except the precheck-store subtree, which belongs to
    the static fixture proof, not the live session). Nothing here assumes a
    hardcoded marketplace-derived path segment.
    """
    found = []
    seen = set()

    def add(path):
        norm = os.path.normpath(path)
        if norm not in seen:
            seen.add(norm)
            found.append(norm)

    try:
        pinned = read_flat(os.path.join(evidence, "ledger-dir")).strip()
    except OSError:
        pinned = ""
    if pinned:
        base = pinned if os.path.isabs(pinned) else os.path.normpath(os.path.join(evidence, pinned))
        # Fail closed on escape: the pinned dir must live under the run dir.
        if base == os.path.normpath(evidence) or base.startswith(os.path.normpath(evidence) + os.sep):
            add(os.path.join(base, "evidence.log"))
    for path in glob.glob(os.path.join(evidence, "**", "evidence.log"), recursive=True):
        parts = path.split(os.sep)
        if "precheck-store" in parts:
            continue
        add(path)
    return found


def main() -> int:
    evidence = ""
    scenario = ""
    plumbing_only = False
    args = sys.argv[1:]
    while args:
        flag = args.pop(0)
        if flag == "--evidence-dir":
            if not args:
                print(json.dumps({"pass": False, "error": "missing value for --evidence-dir"}))
                return 2
            evidence = args.pop(0)
        elif flag == "--scenario-dir":
            if not args:
                print(json.dumps({"pass": False, "error": "missing value for --scenario-dir"}))
                return 2
            scenario = args.pop(0)
        elif flag == "--plumbing-only":
            plumbing_only = True
        else:
            print(json.dumps({"pass": False, "error": f"unknown arg: {flag}"}))
            return 2
    if not evidence or not scenario:
        print(json.dumps({"pass": False, "error": "need --evidence-dir and --scenario-dir"}))
        return 2

    contract = "plumbing-only" if plumbing_only else "live-enforcement"
    scenario_id = os.path.basename(os.path.normpath(scenario))
    verdict: dict = {
        "pass": True,
        "contract": contract,
        "establishes_policy_enforcement": not plumbing_only,
        "scenario": scenario_id,
        "session_id": None,
        "hook_status": None,
        "hook_precheck": None,
        "provenance": {},
        "checks": [],
    }
    checks = verdict["checks"]
    passed = True

    def record(name: str, good: bool, detail: str = "") -> None:
        nonlocal passed
        (ok if good else fail)(checks, name, detail)
        if not good:
            passed = False

    def infra(error: str) -> int:
        verdict["pass"] = False
        verdict["error"] = error
        print(json.dumps(verdict, indent=2))
        return 2

    # ---- Run-dir provenance (flat files, exit-code layout). ----
    prov: dict = {}
    missing = []
    for item in ("candidate-sha", "manifest-digest", "muse-version", "provider", "scenario-id"):
        path = os.path.join(evidence, item)
        try:
            value = read_flat(path)
        except OSError:
            missing.append(item)
            prov[item] = {"present": False, "path": path}
            continue
        if not value:
            missing.append(item + " (empty)")
            prov[item] = {"present": False, "path": path}
            continue
        prov[item] = {"present": True, "path": path, "value": value}
    try:
        model_value = read_flat(os.path.join(evidence, "model"))
        prov["model"] = {"present": True, "value": model_value or "(default)"}
    except OSError:
        prov["model"] = {"present": False, "note": "optional; provider default"}
    verdict["provenance"] = prov
    if missing:
        return infra(f"run dir lacks provenance: {', '.join(missing)}")
    record(
        "run dir retains provenance",
        True,
        "candidate-sha, manifest-digest, muse-version, provider, scenario-id present",
    )
    if not re.fullmatch(r"[0-9a-fA-F]{7,64}(\+dirty:[0-9a-fA-F]{7,64})?", prov["candidate-sha"]["value"]):
        record("candidate SHA is hex", False, prov["candidate-sha"]["value"][:80])
    else:
        record("candidate SHA is hex", True)
        if "+dirty:" in prov["candidate-sha"]["value"]:
            record(
                "candidate cleanliness recorded",
                True,
                "dirty-tree snapshot (JEVERB_ALLOW_DIRTY=1); see dirty-manifest/dirty-hashes",
            )
        else:
            record("candidate cleanliness recorded", True, "clean HEAD")
    if not re.fullmatch(r"([A-Za-z0-9-]+:)?[0-9a-fA-F]{16,128}", prov["manifest-digest"]["value"]):
        record("manifest digest is well-formed", False, prov["manifest-digest"]["value"][:80])
    else:
        record("manifest digest is well-formed", True)
    if prov["scenario-id"]["value"] != scenario_id:
        record(
            "scenario ID matches scenario dir",
            False,
            f"file says {prov['scenario-id']['value']!r} but dir is {scenario_id!r}",
        )
    else:
        record("scenario ID matches scenario dir", True, scenario_id)
    provider = prov["provider"]["value"]
    if not plumbing_only and provider == "echo":
        record(
            "live contract uses a live provider",
            False,
            "provider is echo: rerun with --plumbing-only (plumbing proves no enforcement)",
        )
    elif not plumbing_only:
        record("live contract uses a live provider", True, f"provider={provider!r}")

    # ---- Execution result (retained by run-subject.sh as exit-code). ----
    try:
        code = read_flat(os.path.join(evidence, "exit-code"))
    except OSError as err:
        return infra(f"no exit-code: {err}")
    verdict["provenance"]["execution_result"] = {"path": "exit-code", "value": code}
    record("session exit code is 0", code == "0", f"exit-code={code!r}")

    # ---- Trace: observed envelope + terminal-state envelope. ----
    trace_path = os.path.join(evidence, "subject.jsonl")
    try:
        fh = open(trace_path)
    except OSError as err:
        return infra(f"no trace: {err}")
    terminal = False
    stream_ids = set()
    session_id = None
    n_records = 0
    with fh:
        for i, line in enumerate(fh, 1):
            if not line.strip():
                continue
            n_records += 1
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as err:
                record("trace matches observed schema", False, f"line {i}: not JSON: {err}")
                break
            if not isinstance(rec, dict):
                record("trace matches observed schema", False, f"line {i}: not an object")
                break
            absent = [k for k in REQUIRED_ENVELOPE_KEYS if k not in rec]
            if absent:
                record("trace matches observed schema", False, f"line {i}: missing {absent}")
                break
            if rec.get("schema_version") != 1 or rec.get("payload_schema_version") != 1:
                record(
                    "trace matches observed schema",
                    False,
                    f"line {i}: schema_version={rec.get('schema_version')!r} "
                    f"payload_schema_version={rec.get('payload_schema_version')!r} (want 1)",
                )
                break
            stream = rec.get("stream")
            if (
                not isinstance(stream, dict)
                or not isinstance(stream.get("kind"), str)
                or not isinstance(stream.get("id"), str)
            ):
                record("trace matches observed schema", False, f"line {i}: bad stream envelope")
                break
            if not isinstance(rec.get("sequence"), int) or not isinstance(rec.get("payload"), dict):
                record("trace matches observed schema", False, f"line {i}: bad sequence/payload")
                break
            stream_ids.add(stream["id"])
            if stream["kind"] == "session" and session_id is None:
                session_id = stream["id"]
            if (
                rec.get("record_type") == "event"
                and rec.get("payload_type") == TERMINAL_PAYLOAD
                and isinstance(rec["payload"], dict)
                and rec["payload"].get("terminal") == "completed"
                and rec["payload"].get("kind") == "run_terminal"
            ):
                terminal = True
        else:
            if n_records == 0:
                record("trace matches observed schema", False, "trace is empty")
            else:
                record("trace matches observed schema", True, f"{n_records} records")
    if n_records == 0 and not any(c["check"] == "trace matches observed schema" for c in checks):
        record("trace matches observed schema", False, "trace is empty")
    if len(stream_ids) > 1:
        record("trace carries one stream id", False, f"{len(stream_ids)} distinct stream ids")
    elif stream_ids:
        record("trace carries one stream id", True, next(iter(stream_ids)))
    verdict["session_id"] = session_id
    record("session reached terminal state", terminal, TERMINAL_PAYLOAD if terminal else "no terminal record")
    if session_id is None:
        return infra("trace has no session-kind stream record; cannot correlate receipts")

    # ---- Receipts (evidence.log in the installed plugin's actual data dir). ----
    ledger_paths = resolve_ledger_paths(evidence)
    verdict["ledger_paths"] = ledger_paths
    logs = [p for p in ledger_paths if os.path.isfile(p)]
    record(
        "ledger locations resolved from the installed plugin data dir",
        True,
        f"{len(logs)} ledger(s): {logs or ledger_paths or ['(none found)']}",
    )
    receipts: list = []
    ledger_broken = False
    if not logs:
        record("candidate wrote an evidence log", False, "no evidence.log under evidence dir")
    else:
        for path in logs:
            try:
                fh = open(path)
            except OSError as err:
                record("candidate wrote an evidence log", False, f"{path}: {err}")
                ledger_broken = True
                break
            with fh:
                for i, line in enumerate(fh, 1):
                    if not line.strip():
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError as err:
                        record("evidence log is well-formed", False, f"{path} line {i}: {err}")
                        ledger_broken = True
                        break
                    if not isinstance(rec, dict):
                        record("evidence log is well-formed", False, f"{path} line {i}: not an object")
                        ledger_broken = True
                        break
                    rec["_source"] = path
                    receipts.append(rec)
            if ledger_broken:
                break
        else:
            record("candidate wrote an evidence log", True, f"{len(receipts)} receipts")
    if ledger_broken:
        hook_status = "hook-crashed"
    elif not logs:
        # No ledger at all: hooks never ran inside this run dir.
        hook_status = "hook-never-loaded"
    elif not receipts:
        # Ledger file exists but is empty: hooks loaded, nothing recorded.
        hook_status = "no-hook-invoked"
    else:
        hook_status = None  # decided below from session-correlated receipts
    verdict["hook_status"] = hook_status

    wellformed = True
    matched: list = []
    excluded = 0
    if receipts and not ledger_broken:
        for rec in receipts:
            if rec.get("sessionId") != session_id:
                excluded += 1
                continue
            matched.append(rec)
        for rec in matched:
            error = receipt_shape_error(rec)
            if error is not None:
                wellformed = False
                record("receipts carry schema 1 and known outcome vocabulary", False, error)
                break
        else:
            if matched:
                record("receipts carry schema 1 and known outcome vocabulary", True, f"{len(matched)} session receipts")
                record("every deny has reasons", True)
        record(
            "receipts correlate to this session",
            len(matched) > 0,
            f"{len(matched)} for session, {excluded} stale/excluded",
        )
        if not matched:
            wellformed = False

    # ---- Frozen-candidate identity: session receipts must carry the same
    # identity run-subject.sh installed (JEVERB_CANDIDATE / candidate file).
    if matched and wellformed:
        expected = prov["candidate-sha"]["value"]
        mismatched = [r for r in matched if r.get("candidate") not in (None, expected)]
        attributed = [r for r in matched if r.get("candidate") == expected]
        if mismatched:
            wellformed = False
            record(
                "receipts carry the frozen candidate identity",
                False,
                f"{len(mismatched)} session receipt(s) stamped for another candidate: "
                + json.dumps([r.get("candidate") for r in mismatched][:5]),
            )
        elif not attributed:
            wellformed = False
            record(
                "receipts carry the frozen candidate identity",
                False,
                f"no session receipt carries candidate={expected[:40]!r}: unattributed evidence",
            )
        else:
            record(
                "receipts carry the frozen candidate identity",
                True,
                f"{len(attributed)}/{len(matched)} session receipts stamped {expected[:40]!r}",
            )

    if hook_status is None:
        error_receipts = [r for r in matched if r.get("enforcement") == "error" or r.get("error")]
        denies = [r for r in matched if r.get("enforcement") == "deny"]
        pretool = [r for r in matched if r.get("event") == "PreToolUse"]
        if error_receipts:
            hook_status = "hook-crashed"
        elif denies:
            hook_status = "hook-denied"
        elif any(r.get("enforcement") in ALLOWISH for r in pretool):
            hook_status = "hook-allowed"
        elif matched:
            hook_status = "no-hook-invoked"
        else:
            hook_status = "no-hook-invoked"
        verdict["hook_status"] = hook_status

    detail_by_status = {
        "hook-denied": "gated action was denied by the hook",
        "hook-allowed": "hook judged the gated action but did not deny it",
        "hook-crashed": "hook errored or its ledger is malformed: enforcement unproven",
        "hook-never-loaded": "no evidence.log: hooks never ran in this run dir",
        "no-hook-invoked": "no PreToolUse receipt for this session: model never attempted the gated action",
    }
    counts: dict = {}
    for r in matched:
        counts[r.get("enforcement")] = counts.get(r.get("enforcement"), 0) + 1
    status_detail = f"{detail_by_status[hook_status]} (enforcement counts: {counts or '{}'})"

    if plumbing_only:
        record("hook status classified (plumbing: informational)", True, f"{hook_status}: {status_detail}")
        plumbing_denies = [r for r in matched if r.get("enforcement") == "deny"]
        plumbing_errors = [r for r in matched if r.get("enforcement") == "error" or r.get("error")]
        record(
            "plumbing run claims no enforcement",
            not plumbing_denies and not plumbing_errors,
            "advisory-only receipts" if not plumbing_denies and not plumbing_errors else "deny/error receipt in a plumbing run",
        )
    else:
        record(
            "hook produced a decision for the gated action",
            hook_status in ("hook-denied", "hook-allowed"),
            f"{hook_status}: {status_detail}",
        )

    # ---- Hook precheck artifact (validate-candidate.sh layout). ----
    try:
        with open(os.path.join(scenario, "expects.json")) as fh:
            expects = json.load(fh)
    except (OSError, json.JSONDecodeError) as err:
        return infra(f"bad expects.json: {err}")
    precheck = expects.get("hook_precheck") if isinstance(expects, dict) else None
    if precheck:
        candidates = [
            os.path.join(evidence, "precheck.log"),
            os.path.join(evidence, "hook-decision"),
            os.path.join(os.path.dirname(os.path.normpath(evidence)), f"{scenario_id}-precheck.log"),
        ]
        text = None
        for path in candidates:
            try:
                with open(path) as fh:
                    text = fh.read()
                verdict["hook_precheck"] = {"path": path}
                break
            except OSError:
                continue
        if text is None:
            verdict["hook_precheck"] = {"path": None}
            record("hook precheck proof retained", False, f"expects hook_precheck but none of {candidates} exists")
        else:
            verdict["hook_precheck"] = {"path": path}
            m = re.search(r"permission_decision=([^\s]+)", text)
            decision = m.group(1).strip("'\"") if m else None
            want = precheck.get("expect")
            passed_pre = "-> PASS" in text
            verdict["hook_precheck"].update({"permission_decision": decision, "expect": want, "pass": passed_pre})
            record(
                "hook precheck proof retained",
                passed_pre and (want != "deny" or decision == "deny") and (want != "proceed" or decision in ("None", "null", "nil", None)),
                f"{path}: permission_decision={decision!r} expect={want}",
            )
    else:
        record("hook precheck proof retained", True, "expects.json declares no hook_precheck; decision comes from receipts")

    # ---- Receipt expectations (live contract only). ----
    if not plumbing_only:
        usable = matched if wellformed else []
        for want in expects.get("receipts", []):
            found = any(
                all(rec.get(k) == v for k, v in want.items() if k != "reason_contains")
                and ("reason_contains" not in want or want["reason_contains"] in "\n".join(rec.get("reasons", [])))
                for rec in usable
            )
            record(f"expected receipt {want}", found)
        if expects.get("no_deny"):
            record("no deny receipts", not any(r.get("enforcement") == "deny" for r in usable))
        minimum = expects.get("min_receipts", 0)
        record(f"at least {minimum} receipts", len(usable) >= minimum, f"have {len(usable)}")
        if any(w.get("enforcement") == "deny" for w in expects.get("receipts", [])):
            record(
                "deny expectation established by hook denial",
                hook_status == "hook-denied",
                f"hook_status={hook_status}",
            )
    else:
        record(
            "plumbing contract skips receipt expectations",
            True,
            "plumbing-only runs cannot establish enforcement; see contract fields",
        )

    verdict["pass"] = passed
    print(json.dumps(verdict, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
