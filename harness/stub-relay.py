#!/usr/bin/env python3
"""Controlled loopback OpenRouter stub for local adapter qualification.

Serves both the native typed `/api/alpha/decisions` contract used by Jev
models and the generic `/api/v1/chat/completions` contract used by ordinary
OpenRouter models. Keeping both routes lets the same local smoke harness
exercise adapter routing without substituting one adapter for the other.

Scenarios (per request via X-Stub-Scenario, default STUB_SCENARIO/benign):
  benign       low risk on every noul, narrow blast radius, in-scope step
  destructive  high risk on every noul, production blast radius, unrelated
  malformed    200 with a non-JSON content body (INVALID_MODEL_RESPONSE)
  http429      HTTP 429 (RATE_LIMITED)
  delayed      sleeps DELAY_S then answers benign (JUDGMENT_TIMEOUT probe)

Every request is appended to STUB_LOG as JSONL with headers (redacted),
body model id, and the scenario served. No upstream call is ever made.
"""

import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("STUB_PORT", "18790"))
DEFAULT_SCENARIO = os.environ.get("STUB_SCENARIO", "benign")
LOG = os.environ.get("STUB_LOG", "/tmp/stub-relay-requests.jsonl")
DELAY_S = float(os.environ.get("STUB_DELAY_S", "8"))

NOUL_RE = re.compile(r'"([A-Za-z0-9_]+)":\s*\{"p":')
CHOICE_RE = re.compile(r'"([A-Za-z0-9_]+)":\s*\{"pick": one of (\[.*?\])')
SCORE_RE = re.compile(r'"([A-Za-z0-9_]+)":\s*\{"index": 0\.\.(\d+)')


def answers_for(schema_text: str, scenario: str) -> dict:
    high = scenario == "destructive"
    p = 0.97 if high else 0.02
    out: dict = {}
    for qid in NOUL_RE.findall(schema_text):
        out[qid] = {"p": p}
    for qid, options_raw in CHOICE_RE.findall(schema_text):
        try:
            options = json.loads(options_raw)
        except json.JSONDecodeError:
            options = []
        if not options:
            out[qid] = {"pick": "x", "probabilities": {"x": 1.0}}
            continue
        # Benign: mass on the first option; destructive: mass on the last.
        pick = options[-1] if high else options[0]
        remainder = 0.0 if len(options) == 1 else 0.06 / (len(options) - 1)
        out[qid] = {"pick": pick, "probabilities": {o: (1.0 if len(options) == 1 else 0.94 if o == pick else remainder) for o in options}}
    for qid, top in SCORE_RE.findall(schema_text):
        levels = int(top) + 1
        # blast_radius has 4 levels (0 read-only .. 3 production);
        # scope has 3 (0 unrelated, 1 step, 2 requested).
        if levels == 4:
            index = 3 if high else 0
        elif levels == 3:
            index = 0 if high else 1
        else:
            index = levels - 1 if high else 0
        probs = [0.03] * levels
        probs[index] = 0.94
        out[qid] = {"index": index, "probabilities": probs}
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send_json(self, status: int, payload: dict, scenario: str = "-"):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in {"/api/v1/chat/completions", "/api/alpha/decisions"}:
            self._send_json(404, {"error": "stub-relay: unknown path"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode())
        except (ValueError, UnicodeDecodeError):
            body = {}
        scenario = self.headers.get("X-Stub-Scenario", DEFAULT_SCENARIO)
        if self.path == "/api/alpha/decisions":
            questions = body.get("questions", {})
            entry = {
                "ts": time.time(),
                "path": self.path,
                "model": body.get("model"),
                "scenario": scenario,
                "question_ids": sorted(questions) if isinstance(questions, dict) else [],
                "auth_present": self.headers.get("Authorization", "").startswith("Bearer "),
            }
            with open(LOG, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry) + "\n")
            if scenario == "http429":
                self._send_json(429, {"error": {"code": "rate_limit", "message": "stub rate limited"}})
                return
            if scenario == "malformed":
                # A valid JSON envelope with the requested answer omitted
                # exercises the native adapter's protocol validation.
                self._send_json(200, {"model": "typesafe/jev-1.14-20261014", "id": "gen-stub-malformed", "answers": {}, "usage": {}})
                return
            if scenario == "delayed":
                time.sleep(DELAY_S)
            answers = {}
            high = scenario == "destructive"
            for qid, question in questions.items() if isinstance(questions, dict) else []:
                if not isinstance(question, dict):
                    continue
                qtype = question.get("type")
                if qtype == "noul":
                    answers[qid] = {"type": "noul", "noul": 0.97 if high else 0.02}
                elif qtype == "choice":
                    options = list((question.get("criteria") or {}).keys())
                    if not options:
                        continue
                    pick = options[-1] if high else options[0]
                    remainder = 0 if len(options) == 1 else 0.06 / (len(options) - 1)
                    probabilities = {option: (1.0 if len(options) == 1 else 0.94 if option == pick else remainder) for option in options}
                    answers[qid] = {"type": "choice", "choice": pick, "probabilities": probabilities, "confidence": max(probabilities.values())}
                elif qtype == "score":
                    levels = question.get("criteria") or []
                    if not levels:
                        continue
                    index = len(levels) - 1 if high else 0
                    probabilities = [0.03] * len(levels)
                    probabilities[index] = 1.0 - 0.03 * (len(levels) - 1)
                    answers[qid] = {"type": "score", "score": float(index), "legend": {str(i): str(item) for i, item in enumerate(levels)}, "probabilities": {str(i): value for i, value in enumerate(probabilities)}, "confidence": max(probabilities)}
            self._send_json(200, {
                "model": "typesafe/jev-1.14-20261014",
                "id": f"gen-stub-{int(time.time() * 1000)}",
                "answers": answers,
                "usage": {"input_tokens": 10, "output_tokens": 10, "cost": 0},
            })
            return
        messages = body.get("messages", [])
        schema_text = " ".join(m.get("content", "") for m in messages if isinstance(m, dict))
        entry = {
            "ts": time.time(),
            "path": self.path,
            "model": body.get("model"),
            "scenario": scenario,
            "question_ids": sorted(set(NOUL_RE.findall(schema_text)) | {m[0] for m in CHOICE_RE.findall(schema_text)} | {m[0] for m in SCORE_RE.findall(schema_text)}),
            "auth_present": self.headers.get("Authorization", "").startswith("Bearer "),
        }
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
        if scenario == "http429":
            self._send_json(429, {"error": "stub-relay: rate limited"}, scenario)
            return
        if scenario == "malformed":
            payload = {"choices": [{"message": {"content": "not json at all"}}]}
            self._send_json(200, payload, scenario)
            return
        if scenario == "delayed":
            time.sleep(DELAY_S)
        content = json.dumps(answers_for(schema_text, scenario))
        self._send_json(
            200,
            {
                "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 10},
            },
            scenario,
        )


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"stub-relay on 127.0.0.1:{PORT} default={DEFAULT_SCENARIO} log={LOG}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
