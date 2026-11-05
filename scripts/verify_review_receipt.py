#!/usr/bin/env python3
"""Deterministic review-receipt check. Node remains the runtime implementation."""
import json
import sys

BLOCKING = {"BLOCK", "SECURITY REVIEW"}


def main() -> int:
    try:
        receipt = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(f"invalid JSON: {exc}", file=sys.stderr)
        return 2
    if receipt.get("schema") != 1:
        print("invalid receipt schema", file=sys.stderr)
        return 2
    lane = receipt.get("lane")
    if lane in BLOCKING:
        print(f"review rejected: {lane}", file=sys.stderr)
        return 1
    if lane not in {"NITS", "MERGE"}:
        print("review unavailable or malformed", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
