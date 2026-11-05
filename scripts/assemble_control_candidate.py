#!/usr/bin/env python3
"""Create a deterministic, unprivileged snapshot for the root control installer.

The output is not install-eligible until an operator copies it into a
root-owned, non-writable directory and independently approves its manifest
digest. This command never changes ownership or invokes the installer.
"""

from __future__ import annotations

import argparse
import hashlib
import stat
from pathlib import Path


PAYLOADS = (
    "jeverb_control_service.py",
    "jeverb-control.service",
    "org.jeverb.control.policy",
    "verify_installed.py",
)


def assemble(output: Path, source_root: Path) -> str:
    """Write a fresh candidate directory and return SHA256(SHA256SUMS)."""
    source_root = source_root.resolve(strict=True)
    source_dir = source_root / "control-service"
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"candidate output already exists: {output}")

    payload_bytes: dict[str, bytes] = {}
    for name in PAYLOADS:
        source = source_dir / name
        info = source.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"candidate source is not a regular file: {source}")
        payload_bytes[name] = source.read_bytes()

    output.mkdir(mode=0o700, parents=True)
    manifest_lines = []
    for name in sorted(PAYLOADS):
        data = payload_bytes[name]
        target = output / name
        target.write_bytes(data)
        target.chmod(0o444)
        manifest_lines.append(f"{hashlib.sha256(data).hexdigest()}  {name}\n")

    manifest = "".join(manifest_lines).encode("ascii")
    manifest_path = output / "SHA256SUMS"
    manifest_path.write_bytes(manifest)
    manifest_path.chmod(0o444)
    output.chmod(0o755)
    return hashlib.sha256(manifest).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="new output directory")
    args = parser.parse_args()
    source_root = Path(__file__).resolve().parent.parent
    try:
        digest = assemble(args.out, source_root)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"candidate: {args.out.absolute()}")
    print(f"manifest_sha256: {digest}")
    print("candidate is not install-eligible until copied to a reviewed root-owned directory")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
