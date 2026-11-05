#!/usr/bin/env python3
"""Drive the built MCP stdio server sequentially and verify graph→observation correlation."""
import json
import os
from pathlib import Path
import subprocess
import stat
import sys


bundle, data_dir, port, switch_path = sys.argv[1:]
env = {
    "PATH": os.environ.get("PATH", ""),
    "HOME": os.environ.get("HOME", "/tmp"),
    "MUSE_PLUGIN_DATA_DIR": data_dir,
    "JEV_TEST_CONTROL_STATE_PATH": switch_path,
}
data = Path(data_dir)
(data / "config.json").write_text(json.dumps({
    "backend": "openrouter",
    "base_url": f"http://127.0.0.1:{port}/api/v1",
    "model": "typesafe/jev-router",
    "allow_custom_relay": True,
    "timeout_ms": 5_000,
    "max_retries": 0,
}), encoding="utf-8")
credentials = data / "credentials"
credentials.write_text(json.dumps({"OPENROUTER_API_KEY": "synthetic-smoke-key"}), encoding="utf-8")
credentials.chmod(stat.S_IRUSR | stat.S_IWUSR)
proc = subprocess.Popen(
    ["node", bundle], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.PIPE, text=True, env=env, bufsize=1,
)
request_id = 0


def send(message):
    proc.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
    proc.stdin.flush()


def receive(expected_id):
    while True:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("MCP server exited before responding: " + proc.stderr.read())
        response = json.loads(line)
        if response.get("id") == expected_id:
            return response


def call(name, arguments):
    global request_id
    request_id += 1
    call_id = request_id
    send({"jsonrpc": "2.0", "id": call_id, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
    response = receive(call_id)
    result = response["result"]
    assert not result.get("isError"), result
    return result["structuredContent"]


try:
    send({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "jeverb-local-stub-smoke", "version": "1.0"}},
    })
    initialized = receive(1)
    assert initialized["result"]["serverInfo"]["name"] == "jevwire", initialized
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    decision = call("jev_evaluate", {
        "state": {"probe": "current built MCP candidate", "effect": "local stub only"},
        "questions": {"benign": {"type": "noul", "instructions": "Is this synthetic smoke probe benign?"}},
    })
    answer = decision["answers"]["benign"]
    assert answer["noul"] == 0.02 and answer["verdict"] == "no" and answer["gate"] == "auto", answer
    # Request config is the alias; the adapter preserves the concrete serving
    # identity returned by OpenRouter.
    assert decision["model"] == "typesafe/jev-1.14-20261014", decision

    graph = call("jev_execute_graph", {
        "source": "local-stub-smoke",
        "graph": {"version": 1, "nodes": [
            {"id": "classify", "kind": "jev", "questions": {
                "route": {"type": "choice", "instructions": "Choose a route for this synthetic request", "criteria": {"local": None, "remote": None}},
                "risk": {"type": "score", "instructions": "Rate the synthetic request risk", "criteria": ["low", "medium", "high"]},
            }},
            {"id": "follow", "kind": "jev", "question": "Does the chosen route meet the follow-up requirement?",
             "dependsOn": ["classify"], "condition": {"node": "classify", "field": "decision.choice", "question": "route", "equals": "local", "minConfidence": 0.7}},
        ]},
    })
    classification = next(node for node in graph["results"] if node["nodeId"] == "classify")
    assert classification["jev"]["provider"] == "openrouter", classification
    assert classification["jev"]["calibrated"] is False, classification
    assert classification["jev"]["answers"]["route"]["choice"] == "local", classification
    assert classification["jev"]["answers"]["risk"]["type"] == "score", classification
    assert next(node for node in graph["results"] if node["nodeId"] == "follow")["status"] == "succeeded", graph
    assert graph["evidenceReceipts"]["status"] == "persisted" and graph["evidenceReceipts"]["correlationIds"], graph

    observations = call("jev_observations", {"operationId": graph["runId"], "limit": 50})
    assert observations["status"] == "ok" and observations["observations"], observations
    correlations = set(graph["evidenceReceipts"]["correlationIds"])
    matched = [
        row for row in observations["observations"]
        if row["operationId"] == graph["runId"] and row["correlationId"] in correlations
    ]
    assert matched, (graph, observations)
    assert all(row["outputDigest"] for row in matched), matched
    assert all(row["executionStatus"] in {"succeeded", "failed", "skipped", "blocked", "cancelled", "outcome_unknown"} for row in matched), matched
    print("ORX-style MCP submit → Jeverb durable graph receipts → Veyrict observations: PASS (run, receipt correlation, output digest, and status matched)")
finally:
    proc.stdin.close()
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
