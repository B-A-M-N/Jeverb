#!/usr/bin/env python3
"""Compare installed control-service files with the verified staging copy."""

from __future__ import annotations

import stat
import sys
from pathlib import Path


PAYLOADS = (
    ("jeverb_control_service.py", "usr/lib/jeverb/control-service/jeverb_control_service.py"),
    ("org.jeverb.control.policy", "usr/share/polkit-1/actions/org.jeverb.control.policy"),
    ("jeverb-control.service", "etc/systemd/system/jeverb-control.service"),
)


def verify(stage_root: Path, install_root: Path) -> list[str]:
    """Return a list of missing, unsafe, or byte-mismatched destinations."""
    errors: list[str] = []
    stage_root = stage_root.resolve(strict=True)
    install_root = install_root.resolve(strict=True)
    for staged_name, destination in PAYLOADS:
        staged = stage_root / staged_name
        installed = install_root / destination
        try:
            staged_stat = staged.lstat()
            installed_stat = installed.lstat()
            if not stat.S_ISREG(staged_stat.st_mode) or not stat.S_ISREG(installed_stat.st_mode):
                errors.append(f"not a regular file: {destination}")
                continue
            if staged.read_bytes() != installed.read_bytes():
                errors.append(f"installed bytes differ from verified stage: {destination}")
        except OSError as error:
            errors.append(f"cannot verify {destination}: {error.strerror or error}")
    return errors


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: verify_installed.py STAGE_ROOT INSTALL_ROOT", file=sys.stderr)
        return 2
    try:
        errors = verify(Path(argv[1]), Path(argv[2]))
    except OSError as error:
        print(f"verification root unavailable: {error.strerror or error}", file=sys.stderr)
        return 2
    if errors:
        for error in errors:
            print(f"install verification failed: {error}", file=sys.stderr)
        return 1
    print("installed control-service bytes match verified stage")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
