"""Receipt compatibility checks for the deterministic Muse qualification gate."""

import importlib.util
import io
import json
from pathlib import Path
import re
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch


GATE_PATH = Path(__file__).with_name("gate.py")
SPEC = importlib.util.spec_from_file_location("jeverb_gate", GATE_PATH)
assert SPEC is not None and SPEC.loader is not None
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def receipt(**overrides):
    return {
        "schema": 1,
        "event": "Stop",
        "enforcement": "terminal",
        "reasons": ["mission closure is blocked"],
        **overrides,
    }


class ReceiptShapeTests(unittest.TestCase):
    def test_gate_vocabularies_track_the_typescript_decision_contract(self):
        source = (Path(__file__).parents[1] / "src" / "decision" / "types.ts").read_text(encoding="utf-8")
        judgment_match = re.search(r"export type JudgmentOutcome =([\s\S]*?);", source)
        enforcement_match = re.search(r"export type Enforcement =([\s\S]*?);", source)
        self.assertIsNotNone(judgment_match)
        self.assertIsNotNone(enforcement_match)
        judgments = set(re.findall(r'"([A-Z_]+)"', judgment_match.group(1)))
        enforcement = set(re.findall(r'"([a-z_]+)"', enforcement_match.group(1)))
        self.assertEqual(gate.KNOWN_JUDGMENT, judgments)
        self.assertEqual(gate.KNOWN_ENFORCEMENT, enforcement | {"observed"})

    def test_terminal_mission_decision_is_valid_but_not_allowish(self):
        self.assertIsNone(gate.receipt_shape_error(receipt()))
        self.assertNotIn("terminal", gate.ALLOWISH)

    def test_typed_judgment_outcomes_are_accepted(self):
        self.assertIsNone(gate.receipt_shape_error(receipt(
            event="PreToolUse",
            enforcement="allow",
            reasons=[],
            judgment="JUDGMENT_SUCCEEDED",
        )))
        self.assertIsNone(gate.receipt_shape_error(receipt(
            event="PreToolUse",
            enforcement="deny",
            judgment="DETERMINISTIC_DENY",
        )))

    def test_unknown_or_malformed_judgment_outcomes_fail_closed(self):
        self.assertIn("unknown judgment", gate.receipt_shape_error(receipt(judgment="SUCCESS")))
        self.assertIn("unknown judgment", gate.receipt_shape_error(receipt(judgment=[])))
        self.assertIn("unknown schema or enforcement", gate.receipt_shape_error(receipt(enforcement=[])))

    def test_legacy_receipt_without_optional_judgment_remains_valid(self):
        self.assertIsNone(gate.receipt_shape_error(receipt(
            event="PreToolUse",
            enforcement="advise",
            reasons=[],
        )))

    def test_gate_accepts_composed_terminal_and_typed_judgment_receipts(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            evidence = root / "evidence"
            ledger_dir = evidence / "plugin-data"
            scenario = root / "scenario"
            ledger_dir.mkdir(parents=True)
            scenario.mkdir()
            for name, value in {
                "candidate-sha": "deadbeef",
                "manifest-digest": "a" * 64,
                "muse-version": "1.4.14",
                "provider": "echo",
                "scenario-id": "scenario",
                "exit-code": "0",
                "ledger-dir": str(ledger_dir),
            }.items():
                (evidence / name).write_text(value, encoding="utf-8")
            (scenario / "expects.json").write_text("{}", encoding="utf-8")
            session_id = "session-fixture"
            base = {
                "schema_version": 1,
                "id": "event-id",
                "stream": {"kind": "session", "id": session_id},
                "sequence": 1,
                "recorded_at": 1,
                "record_type": "event",
                "durability": "durable",
                "causation_id": "cause",
                "payload_type": "run.terminal.completed",
                "payload_schema_version": 1,
                "payload": {"kind": "run_terminal", "terminal": "completed"},
            }
            (evidence / "subject.jsonl").write_text(json.dumps(base) + "\n", encoding="utf-8")
            receipts = [
                receipt(sessionId=session_id, candidate="deadbeef"),
                receipt(
                    sessionId=session_id,
                    candidate="deadbeef",
                    event="PreToolUse",
                    enforcement="allow",
                    reasons=[],
                    judgment="JUDGMENT_SUCCEEDED",
                ),
            ]
            (ledger_dir / "evidence.log").write_text(
                "".join(json.dumps(item) + "\n" for item in receipts),
                encoding="utf-8",
            )

            output = io.StringIO()
            with patch("sys.argv", ["gate.py", "--evidence-dir", str(evidence), "--scenario-dir", str(scenario), "--plumbing-only"]), redirect_stdout(output):
                result = gate.main()

            verdict = json.loads(output.getvalue())
            self.assertEqual(result, 0)
            self.assertTrue(verdict["pass"])
            self.assertEqual(verdict["hook_status"], "hook-allowed")


if __name__ == "__main__":
    unittest.main()
