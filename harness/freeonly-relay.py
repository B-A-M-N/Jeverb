#!/usr/bin/env python3
"""Free-only OpenRouter relay for Muse Code subjects.

Muse Code fetches its model catalog from ``{base_url}/muse-code/models``.
When the endpoint is pinned to OpenRouter that path 404s (OpenRouter has no
such route) and every launch fails. This relay serves a filtered,
free-models-only catalog at that path and proxies everything else to
OpenRouter with hard free-only enforcement:

- request ``model`` must be in ``ALLOWLIST`` (by exact id), else HTTP 403
  and nothing is forwarded — no paid fallback, no auto-routing;
- ``provider.max_price`` prompt/completion are forced to zero upstream;
- the upstream API key lives only in this process (``OR_KEY_FILE``);
  subjects authenticate to the relay with any bearer or none (localhost);
- every upstream call is appended to ``OR_USAGE_LOG`` as JSONL with the
  served model, token usage and reported cost. Any nonzero cost is a
  qualification failure.

Usage:
  OR_KEY_FILE=/path/to/key OR_PORT=18789 OR_USAGE_LOG=/path/to/usage.jsonl \\
      python3 harness/freeonly-relay.py
"""
import http.client
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

UPSTREAM_HOST = "openrouter.ai"
UPSTREAM_BASE = "/api/v1"

# Exact model ids verified zero-price (prompt == completion == "0") via
# GET /api/v1/models at relay build time. Tight on purpose: coding subject,
# supervisor, and Jev-backend candidates only.
ALLOWLIST = {
    "poolside/laguna-s-2.1:free",
    "cohere/north-mini-code:free",
    "google/gemma-4-26b-a4b-it:free",
    "google/gemma-4-12b-a4b-it:free",
}

# Display rows for the Muse catalog. The shape mirrors a real captured
# Meta catalog exactly (schema_version 2 plus background_agent_model,
# reasoning_effort_variants, supports_image_generation, supports_video);
# an earlier schema_version-1 draft without those fields was rejected as
# malformed. Cost reflects the verified zero price of each row.
EFFORT_VARIANTS = [
    {"tier": "high", "description": None},
    {"tier": "low", "description": None},
    {"tier": "max", "description": None},
    {"tier": "medium", "description": None},
    {"tier": "minimal", "description": None},
    {"tier": "xhigh", "description": None},
]

FREE_COST = {"input": "0", "output": "0", "cached": "0", "currency": "USD"}

SENSITIVE_HEADER_NAMES = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
}


def sanitized_headers(headers) -> dict:
    """Keep request diagnostics useful without copying credentials to disk."""
    safe = {}
    for name, value in headers.items():
        if name.lower() in SENSITIVE_HEADER_NAMES or any(
            marker in name.lower() for marker in ("token", "secret", "credential", "api-key")
        ):
            safe[name] = "[REDACTED]"
        else:
            safe[name] = value
    return safe


def _real_catalog():
    """Debug only: serve a byte-identical captured Meta catalog to isolate
    wire-shape issues. No inference is involved; the proxy allowlist still
    403s any non-free model, so this cannot route a paid call."""
    path = os.environ.get("OR_DEBUG_CATALOG", "")
    if not path:
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _row(model_id, label, order, ctx, out, default=False):
    return {
        "model_id": model_id,
        "display_label": label,
        "provider_id": "meta",
        "profile_id": "tbh",
        "visibility": "visible",
        "release_date": None,
        "display_order": order,
        "is_current": True,
        "is_default": default,
        "roles": [],
        "context_limit": ctx,
        "output_limit": out,
        "description": None,
        "cost": dict(FREE_COST),
        "background_agent_model": model_id,
        "reasoning_effort_variants": [dict(v) for v in EFFORT_VARIANTS],
        "supports_image_generation": False,
        "supports_video": False,
    }


CATALOG_ROWS = [
    _row("poolside/laguna-s-2.1:free", "Poolside: Laguna S 2.1 (free)", 1, 262144, 32768, default=True),
    _row("cohere/north-mini-code:free", "Cohere: North Mini Code (free)", 2, 256000, 32768),
    _row("google/gemma-4-26b-a4b-it:free", "Google: Gemma 4 26B (free)", 3, 131072, 32768),
    _row("google/gemma-4-12b-a4b-it:free", "Google: Gemma 4 12B (free)", 4, 131072, 32768),
]

CATALOG_ENVELOPE = {
    "schema_version": 2,
    "provider_id": "meta",
    "profile_id": "tbh",
    "source": "provider_catalog",
}


def load_key() -> str:
    path = os.environ.get("OR_KEY_FILE", "")
    if not path:
        sys.exit("OR_KEY_FILE is required")
    with open(path, encoding="utf-8") as fh:
        return fh.read().strip()


API_KEY = load_key()
USAGE_LOG = os.environ.get("OR_USAGE_LOG", "/tmp/freeonly-usage.jsonl")


def log_usage(entry: dict) -> None:
    entry = {"ts": __import__("time").time(), **entry}
    with open(USAGE_LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\n")


class Relay(BaseHTTPRequestHandler):
    server_version = "FreeOnlyRelay/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep stderr clean; usage log is the record
        pass

    def _send_json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self) -> None:
        path = urlsplit(self.path).path
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        with open(os.environ.get("OR_REQUEST_LOG", "/tmp/freeonly-requests.log"), "a", encoding="utf-8") as fh:
            fh.write(f"{self.command} {self.path} headers={sanitized_headers(self.headers)}\n")

        if self.command == "GET" and path.rstrip("/") == "/muse-code/models":
            raw = os.environ.get("OR_DEBUG_CATALOG_RAW", "")
            if raw:
                with open(raw, "rb") as fh:
                    blob = fh.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(blob)))
                self.end_headers()
                self.wfile.write(blob)
                return
            # Wire shape experiment (OR_CATALOG_SHAPE): the on-disk cache
            # shape is rejected, so the wire response must differ. Known
            # candidates: openrouter-style {"data": [...]} vs bare array.
            shape = os.environ.get("OR_CATALOG_SHAPE", "cache")
            if shape == "data":
                self._send_json(200, {"data": CATALOG_ROWS})
            elif shape == "array":
                self._send_json(200, CATALOG_ROWS)
            else:
                self._send_json(200, {**CATALOG_ENVELOPE, "rows": CATALOG_ROWS})
            return

        # Proxy path: enforce the allowlist before anything leaves localhost.
        model = None
        payload = None
        if body:
            try:
                payload = json.loads(body)
                model = payload.get("model")
            except Exception:
                self._send_json(400, {"error": "freeonly-relay: body is not JSON"})
                return
        if model not in ALLOWLIST:
            self._send_json(403, {"error": f"freeonly-relay: model {model!r} is not allowlisted"})
            return
        if isinstance(payload, dict):
            provider = payload.get("provider") or {}
            if not isinstance(provider, dict):
                provider = {}
            provider["max_price"] = {"prompt": 0, "completion": 0}
            payload["provider"] = provider
            body = json.dumps(payload).encode()

        upstream_path = UPSTREAM_BASE + path[len("/api/v1"):] if path.startswith("/api/v1") else UPSTREAM_BASE + path
        conn = http.client.HTTPSConnection(UPSTREAM_HOST, timeout=120)
        headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
        for key in ("HTTP-Referer", "Referer", "X-Title"):
            if self.headers.get(key):
                headers[key] = self.headers[key]
        conn.request(self.command, upstream_path, body=body or None, headers=headers)
        try:
            resp = conn.getresponse()
        except Exception as exc:  # fail closed: never fake an upstream reply
            self._send_json(502, {"error": f"freeonly-relay: upstream unreachable: {exc}"})
            return

        # Stream the reply (SSE for chat/completions) without buffering.
        self.send_response(resp.status)
        ctype = resp.getheader("Content-Type", "application/json")
        self.send_header("Content-Type", ctype)
        if resp.getheader("Content-Length") and "text/event-stream" not in ctype:
            self.send_header("Content-Length", resp.getheader("Content-Length"))
        self.end_headers()
        chunks = []
        total = 0
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            try:
                self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                break
        raw = b"".join(chunks)
        usage = {"model_requested": model, "served_model": None, "http_status": resp.status,
                 "bytes": total, "cost": None, "tokens": None, "streamed": "text/event-stream" in ctype}
        if "text/event-stream" not in ctype and raw:
            try:
                data = json.loads(raw)
                usage["served_model"] = data.get("model")
                usage["tokens"] = data.get("usage")
                if isinstance(data.get("usage"), dict):
                    usage["cost"] = data["usage"].get("cost")
            except Exception:
                pass
        log_usage(usage)

    do_GET = do_POST = do_PUT = do_DELETE = _handle


if __name__ == "__main__":
    port = int(os.environ.get("OR_PORT", "18789"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Relay)
    print(f"freeonly-relay on 127.0.0.1:{port} allowlist={sorted(ALLOWLIST)}", flush=True)
    server.serve_forever()
