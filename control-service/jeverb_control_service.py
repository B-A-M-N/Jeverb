#!/usr/bin/python3
"""Small root-owned switch broker for Jeverb.

The service accepts only STATUS, SET_ON, and SET_OFF over one Unix socket.
Caller identity comes from SO_PEERCRED; state changes require an action-specific
PolicyKit check for the complete process identity tuple. The Muse/plugin processes never receive write
access to the persistent state file.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable


SOCKET_PATH = Path("/run/jeverb-control/control.sock")
STATE_PATH = Path("/var/lib/jeverb/control-state.json")
MAX_REQUEST_BYTES = 12_288
MAX_USED_REQUESTS = 512
INITIAL_REQUEST_TIMEOUT_SECONDS = 2
AUTHORIZATION_TIMEOUT_SECONDS = 180
MAX_CONNECTIONS = 32
MAX_CONNECTIONS_PER_UID = 8
STATE_LOCK_TIMEOUT_SECONDS = 5.0
LOCK_POLL_INTERVAL_SECONDS = 0.05
GENERATION_RE = re.compile(r"^[0-9a-f]{32}$")
REQUEST_ID_RE = re.compile(r"^[0-9a-f]{32}$")
OPERATIONS = {
    "SET_ON": ("ON", "org.jeverb.control.set-on"),
    "SET_OFF": ("OFF", "org.jeverb.control.set-off"),
}
# Operator-signed independent verification attestations. Separate from the
# on/off switch: each attestation binds one mission revision and evidence
# revision to one candidate digest, witnessed by a fresh PolicyKit check.
ATTEST_OPERATIONS = {
    "ATTEST_PASS": ("pass", "org.jeverb.control.attest-pass"),
    "ATTEST_FAIL": ("fail", "org.jeverb.control.attest-fail"),
}
ATTEST_STATE_NAME = "control-attestations.json"
ATTEST_LOCK_SUFFIX = ".attest.lock"
MAX_ATTESTATIONS = 128
MAX_ATTESTATIONS_PER_MISSION = 8
MISSION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
REVISION_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_TOKEN_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,128}$")
SAFE_ATTEMPT_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,128}/[1-9][0-9]{0,8}$")
ATTEST_VERIFIER_ID = "operator-control-service"
PROOF_PLAN_ACTION = "org.jeverb.control.proof-plan"
PROOF_PLAN_STATE_NAME = "control-proof-plans.json"
PROOF_PLAN_LOCK_SUFFIX = ".proof-plan.lock"
MAX_PROOF_PLANS = 32
MAX_PROOF_PLAN_BYTES = 10_000
MAX_PLAN_CRITERIA = 32
MAX_PLAN_PRODUCERS = 8
MAX_PLAN_CODE_FILES = 16
PLAN_PATH_RE = re.compile(r"^(?!/)(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9_.\-/]{1,512}\.(?:ts|tsx|mts|cts)$")
HEX_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")


class ControlError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _pairs_no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def _process_start_ticks(pid: int) -> int:
    raw = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    # The comm field is parenthesized and may itself contain spaces or ')'.
    fields = raw[raw.rfind(")") + 2 :].split()
    return int(fields[19])  # stat field 22, counting from field 3 at index 0


def polkit_authorize(pid: int, uid: int, start_ticks: int, action_id: str) -> bool:
    """Ask polkit for this caller and this exact transition; never cache it."""
    try:
        proc_uid = os.stat(f"/proc/{pid}").st_uid
        if proc_uid != uid or _process_start_ticks(pid) != start_ticks:
            return False
        result = subprocess.run(
            ["/usr/bin/pkcheck", "--action-id", action_id, "--process", f"{pid},{start_ticks},{uid}", "--allow-user-interaction"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=AUTHORIZATION_TIMEOUT_SECONDS,
            check=False,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        )
        return result.returncode == 0 and _process_start_ticks(pid) == start_ticks
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return False


class ControlService:
    def __init__(
        self,
        state_path: Path = STATE_PATH,
        *,
        authorizer: Callable[[int, int, int, str], bool] = polkit_authorize,
        require_root: bool = True,
    ) -> None:
        self.state_path = state_path
        self.lock_path = state_path.with_suffix(".lock")
        self.attest_path = state_path.parent / ATTEST_STATE_NAME
        self.attest_lock_path = state_path.parent / (ATTEST_STATE_NAME + ATTEST_LOCK_SUFFIX)
        self.proof_plan_path = state_path.parent / PROOF_PLAN_STATE_NAME
        self.proof_plan_lock_path = state_path.parent / (PROOF_PLAN_STATE_NAME + PROOF_PLAN_LOCK_SUFFIX)
        self.authorizer = authorizer
        self.require_root = require_root
        self.initial_request_timeout = INITIAL_REQUEST_TIMEOUT_SECONDS
        self.authorization_timeout = AUTHORIZATION_TIMEOUT_SECONDS
        # One active PolicyKit dialog avoids queued prompts. Other callers get
        # a bounded, explicit retry result instead of waiting behind it.
        self._authorization_lock = threading.Lock()
        self._connection_slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self._connection_counts_lock = threading.Lock()
        self._connection_counts: dict[int, int] = {}
        self._prepare_state()
        self._prepare_attestations()
        self._prepare_proof_plans()

    @classmethod
    def recover_emergency_off(cls, state_path: Path = STATE_PATH, *, require_root: bool = True) -> dict[str, Any]:
        """Run recovery without service-start initialization or side effects."""
        service = cls.__new__(cls)
        service.state_path = state_path
        service.lock_path = state_path.with_suffix(".lock")
        service.require_root = require_root
        return service.emergency_off()

    def _check_storage(self) -> None:
        parent = self.state_path.parent
        parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        parent_info = parent.lstat()
        if not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode):
            raise ControlError("unsafe_state_directory", "control state directory is not a real directory")
        if self.require_root and (parent_info.st_uid != 0 or parent_info.st_mode & 0o022):
            raise ControlError("unsafe_state_directory", "control state directory is not root-owned and protected")

    def _prepare_state(self) -> None:
        self._check_storage()
        try:
            self._read_state()
        except FileNotFoundError:
            self._write_state(self._new_state("OFF"))
        except (ControlError, ValueError, OSError):
            # Corrupt or untrusted state must never imply ON. Quarantine it and
            # initialize OFF; recovery to ON then requires a fresh polkit check.
            try:
                os.replace(self.state_path, self.state_path.with_name(f"control-state.corrupt.{int(time.time())}"))
            except FileNotFoundError:
                pass
            self._write_state(self._new_state("OFF"))

    @staticmethod
    def _new_state(desired: str) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "desired": desired,
            "generation": uuid.uuid4().hex,
            "updated_at": int(time.time()),
            "used_request_ids": [],
        }

    def _read_state(self) -> dict[str, Any]:
        info = self.state_path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ControlError("invalid_state", "control state is not a regular file")
        if self.require_root and (info.st_uid != 0 or info.st_mode & 0o022):
            raise ControlError("untrusted_state", "control state is not root-owned and read-only to agents")
        raw = self.state_path.read_text(encoding="utf-8")
        value = json.loads(raw, object_pairs_hook=_pairs_no_duplicates)
        if (
            not isinstance(value, dict)
            or set(value) != {"schema_version", "desired", "generation", "updated_at", "used_request_ids"}
            or value["schema_version"] != 1
            or value["desired"] not in ("ON", "OFF")
            or not isinstance(value["generation"], str)
            or not GENERATION_RE.fullmatch(value["generation"])
            or not isinstance(value["updated_at"], int)
            or not isinstance(value["used_request_ids"], list)
            or len(value["used_request_ids"]) > MAX_USED_REQUESTS
            or any(not isinstance(item, str) or not REQUEST_ID_RE.fullmatch(item) for item in value["used_request_ids"])
        ):
            raise ControlError("invalid_state", "control state contents are invalid")
        return value

    def _write_state(self, value: dict[str, Any]) -> None:
        self._check_storage()
        fd, temporary = tempfile.mkstemp(prefix=".control-state.", dir=self.state_path.parent)
        try:
            os.fchmod(fd, 0o644)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                output.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
                output.flush()
                os.fsync(output.fileno())
            if self.require_root and os.stat(temporary).st_uid != 0:
                raise ControlError("untrusted_state", "state writer is not root")
            os.replace(temporary, self.state_path)
            directory_fd = os.open(self.state_path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _lock(self) -> int:
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.lock_path, flags, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or (self.require_root and (info.st_uid != 0 or info.st_mode & 0o077)):
            os.close(fd)
            raise ControlError("unsafe_lock", "state lock is not a regular, root-owned private file")
        try:
            self._acquire_lock(fd, "state")
        except BaseException:
            os.close(fd)
            raise
        return fd

    @staticmethod
    def _acquire_lock(fd: int, label: str) -> None:
        deadline = time.monotonic() + STATE_LOCK_TIMEOUT_SECONDS
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ControlError("lock_timeout", f"{label} lock remained busy for {STATE_LOCK_TIMEOUT_SECONDS:g}s")
                time.sleep(min(LOCK_POLL_INTERVAL_SECONDS, remaining))
            except InterruptedError:
                if time.monotonic() >= deadline:
                    raise ControlError("lock_timeout", f"{label} lock acquisition was interrupted until timeout")

    def emergency_off(self) -> dict[str, Any]:
        """Persist OFF from a root shell, independent of the service socket.

        Rotating the generation while holding the same lock fences any request
        that was authorized against the prior state but has not committed yet.
        Corrupt regular state is preserved under a unique quarantine name.
        """
        if self.require_root and os.geteuid() != 0:
            raise ControlError("root_required", "emergency OFF recovery must run as root")
        self._check_storage()
        fd = self._lock()
        try:
            try:
                state = self._read_state()
            except FileNotFoundError:
                state = self._new_state("OFF")
            except (ControlError, ValueError) as error:
                # _read_state uses invalid_state only after verifying that the
                # path is a trusted regular file. Unsafe ownership, symlinks,
                # and storage failures must remain operator-visible failures.
                if isinstance(error, ControlError) and error.code != "invalid_state":
                    raise
                info = self.state_path.lstat()
                if not stat.S_ISREG(info.st_mode) or (self.require_root and (info.st_uid != 0 or info.st_mode & 0o022)):
                    raise ControlError("untrusted_state", "corrupt state is not a trusted regular file") from error
                quarantine = self.state_path.with_name(
                    f"{self.state_path.name}.corrupt.{int(time.time())}.{uuid.uuid4().hex}"
                )
                os.replace(self.state_path, quarantine)
                directory_fd = os.open(self.state_path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
                state = self._new_state("OFF")

            state.update({"desired": "OFF", "generation": uuid.uuid4().hex, "updated_at": int(time.time())})
            self._write_state(state)
            verified = self._read_state()
            if verified["desired"] != "OFF" or verified["generation"] != state["generation"]:
                raise ControlError("recovery_verification_failed", "trusted state readback did not confirm OFF")
            return verified
        finally:
            os.close(fd)

    @staticmethod
    def _new_attest_state() -> dict[str, Any]:
        return {
            "schema_version": 1,
            "generation": uuid.uuid4().hex,
            "updated_at": int(time.time()),
            "used_request_ids": [],
            "attestations": [],
        }

    def _prepare_attestations(self) -> None:
        try:
            self._read_attestations()
        except FileNotFoundError:
            self._write_attestations(self._new_attest_state())
        except (ControlError, ValueError, OSError):
            # Corrupt or untrusted attestation history authorizes nothing.
            # Quarantine it and start empty; re-attestation needs fresh auth.
            try:
                os.replace(self.attest_path, self.attest_path.with_name(f"control-attestations.corrupt.{int(time.time())}"))
            except FileNotFoundError:
                pass
            self._write_attestations(self._new_attest_state())

    def _check_attest_storage(self, path: Path) -> None:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ControlError("invalid_state", "attestation state is not a regular file")
        if self.require_root and (info.st_uid != 0 or info.st_mode & 0o022):
            raise ControlError("untrusted_state", "attestation state is not root-owned and read-only to agents")

    @staticmethod
    def _valid_attestation(entry: Any) -> bool:
        if not isinstance(entry, dict):
            return False
        if set(entry) != {"mission_id", "mission_revision", "evidence_revision", "candidate", "result", "receipt_correlation_id", "verified_at", "verifier_uid"}:
            return False
        return (
            isinstance(entry["mission_id"], str) and MISSION_ID_RE.fullmatch(entry["mission_id"]) is not None
            and isinstance(entry["mission_revision"], str) and REVISION_RE.fullmatch(entry["mission_revision"]) is not None
            and isinstance(entry["evidence_revision"], str) and SAFE_TOKEN_RE.fullmatch(entry["evidence_revision"]) is not None
            and isinstance(entry["candidate"], str) and SAFE_TOKEN_RE.fullmatch(entry["candidate"]) is not None
            and entry["result"] in ("pass", "fail")
            and isinstance(entry["receipt_correlation_id"], str) and REQUEST_ID_RE.fullmatch(entry["receipt_correlation_id"]) is not None
            and isinstance(entry["verified_at"], int)
            and isinstance(entry["verifier_uid"], int)
        )

    def _read_attestations(self) -> dict[str, Any]:
        self._check_attest_storage(self.attest_path)
        raw = self.attest_path.read_text(encoding="utf-8")
        value = json.loads(raw, object_pairs_hook=_pairs_no_duplicates)
        if (
            not isinstance(value, dict)
            or set(value) != {"schema_version", "generation", "updated_at", "used_request_ids", "attestations"}
            or value["schema_version"] != 1
            or not isinstance(value["generation"], str)
            or GENERATION_RE.fullmatch(value["generation"]) is None
            or not isinstance(value["updated_at"], int)
            or not isinstance(value["used_request_ids"], list)
            or len(value["used_request_ids"]) > MAX_USED_REQUESTS
            or any(not isinstance(item, str) or REQUEST_ID_RE.fullmatch(item) is None for item in value["used_request_ids"])
            or not isinstance(value["attestations"], list)
            or len(value["attestations"]) > MAX_ATTESTATIONS
            or any(not self._valid_attestation(item) for item in value["attestations"])
        ):
            raise ControlError("invalid_state", "attestation state contents are invalid")
        return value

    def _write_attestations(self, value: dict[str, Any]) -> None:
        self._check_storage()
        fd, temporary = tempfile.mkstemp(prefix=".control-attestations.", dir=self.state_path.parent)
        try:
            os.fchmod(fd, 0o644)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                output.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
                output.flush()
                os.fsync(output.fileno())
            if self.require_root and os.stat(temporary).st_uid != 0:
                raise ControlError("untrusted_state", "state writer is not root")
            os.replace(temporary, self.attest_path)
            directory_fd = os.open(self.state_path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _attest_lock(self) -> int:
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.attest_lock_path, flags, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or (self.require_root and (info.st_uid != 0 or info.st_mode & 0o077)):
            os.close(fd)
            raise ControlError("unsafe_lock", "attestation lock is not a regular, root-owned private file")
        try:
            self._acquire_lock(fd, "attestation")
        except BaseException:
            os.close(fd)
            raise
        return fd

    @staticmethod
    def _new_proof_plan_state() -> dict[str, Any]:
        return {
            "schema_version": 1,
            "generation": uuid.uuid4().hex,
            "updated_at": int(time.time()),
            "used_request_ids": [],
            "plans": [],
        }

    def _check_proof_plan_storage(self) -> None:
        info = self.proof_plan_path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ControlError("invalid_state", "proof-plan state is not a regular file")
        if self.require_root and (info.st_uid != 0 or info.st_mode & 0o022):
            raise ControlError("untrusted_state", "proof-plan state is not root-owned and read-only to agents")

    @staticmethod
    def _valid_proof_plan(plan: Any) -> bool:
        if not isinstance(plan, dict) or set(plan) != {
            "schema", "mission_id", "mission_revision", "objective_sha256", "workspace_root", "criteria",
        }:
            return False
        if (
            plan["schema"] not in {"jeverb-host-proof-plan/1", "jeverb-host-proof-plan/2", "jeverb-host-proof-plan/3", "jeverb-host-proof-plan/4"}
            or not isinstance(plan["mission_id"], str) or MISSION_ID_RE.fullmatch(plan["mission_id"]) is None
            or not isinstance(plan["mission_revision"], str) or REVISION_RE.fullmatch(plan["mission_revision"]) is None
            or not isinstance(plan["objective_sha256"], str) or HEX_DIGEST_RE.fullmatch(plan["objective_sha256"]) is None
            or not isinstance(plan["workspace_root"], str) or not os.path.isabs(plan["workspace_root"])
            or "\x00" in plan["workspace_root"] or len(plan["workspace_root"]) > 1024
            or not isinstance(plan["criteria"], list) or not 1 <= len(plan["criteria"]) <= MAX_PLAN_CRITERIA
        ):
            return False
        if len(json.dumps(plan, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")) > MAX_PROOF_PLAN_BYTES:
            return False
        seen: set[str] = set()
        for criterion in plan["criteria"]:
            v4 = plan["schema"] == "jeverb-host-proof-plan/4"
            v3 = plan["schema"] in {"jeverb-host-proof-plan/3", "jeverb-host-proof-plan/4"}
            v2 = plan["schema"] in {"jeverb-host-proof-plan/2", "jeverb-host-proof-plan/3", "jeverb-host-proof-plan/4"}
            expected_fields = {"criterion_id", "requirement_sha256", "test_command_sha256", "producers", "code_files"}
            if v2:
                expected_fields.add("probe_actions")
            if v4:
                expected_fields.update({"test_command", "repair_actions"})
            if not isinstance(criterion, dict) or set(criterion) != expected_fields:
                return False
            criterion_id = criterion["criterion_id"]
            if (
                not isinstance(criterion_id, str) or SAFE_TOKEN_RE.fullmatch(criterion_id) is None
                or criterion_id in seen
                or not isinstance(criterion["requirement_sha256"], str)
                or HEX_DIGEST_RE.fullmatch(criterion["requirement_sha256"]) is None
                or not isinstance(criterion["test_command_sha256"], str)
                or HEX_DIGEST_RE.fullmatch(criterion["test_command_sha256"]) is None
            ):
                return False
            if v4:
                command = criterion["test_command"]
                if not isinstance(command, str) or not command.strip() or len(command) > 512 or any(char in command for char in "\r\n\x00") or hashlib.sha256(command.encode("utf-8")).hexdigest() != criterion["test_command_sha256"]:
                    return False
            seen.add(criterion_id)
            producers = criterion["producers"]
            files = criterion["code_files"]
            if not isinstance(producers, list) or not 1 <= len(producers) <= MAX_PLAN_PRODUCERS:
                return False
            if not isinstance(files, list) or not 1 <= len(files) <= MAX_PLAN_CODE_FILES:
                return False
            producer_ids: set[tuple[str, str, str]] = set()
            for producer in producers:
                if not isinstance(producer, dict) or set(producer) - {"run_id", "node_id", "attempt_id"} or not {"run_id", "node_id"} <= set(producer):
                    return False
                if any(not isinstance(producer[key], str) or SAFE_TOKEN_RE.fullmatch(producer[key]) is None for key in ("run_id", "node_id")):
                    return False
                attempt = producer.get("attempt_id", "")
                if attempt != "" and (not isinstance(attempt, str) or SAFE_ATTEMPT_RE.fullmatch(attempt) is None):
                    return False
                key = (producer["run_id"], producer["node_id"], attempt)
                if key in producer_ids:
                    return False
                producer_ids.add(key)
            if any(not isinstance(path, str) or PLAN_PATH_RE.fullmatch(path) is None for path in files):
                return False
            if len(set(files)) != len(files):
                return False
            if v2:
                probes = criterion["probe_actions"]
                if not isinstance(probes, list) or len(probes) > 8:
                    return False
                probe_ids: set[str] = set()
                probe_nodes: set[str] = set()
                for probe in probes:
                    probe_fields = {"id", "description", "command", "command_sha256", "node_id", "max_executions"}
                    if v3:
                        probe_fields.add("producers")
                    if not isinstance(probe, dict) or set(probe) != probe_fields:
                        return False
                    probe_id = probe["id"]
                    description = probe["description"]
                    command = probe["command"]
                    node_id = probe["node_id"]
                    max_executions = probe["max_executions"]
                    if (
                        not isinstance(probe_id, str) or re.fullmatch(r"^[a-z][a-z0-9-]{0,47}$", probe_id) is None
                        or probe_id in probe_ids
                        or not isinstance(description, str) or not description.strip() or len(description) > 300
                        or not isinstance(command, str) or not command.strip() or len(command) > 512
                        or any(char in command for char in "\r\n\x00")
                        or not isinstance(probe["command_sha256"], str)
                        or probe["command_sha256"] != hashlib.sha256(command.encode("utf-8")).hexdigest()
                        or (v3 and (not isinstance(probe["producers"], list) or not 1 <= len(probe["producers"]) <= MAX_PLAN_PRODUCERS))
                        or not isinstance(node_id, str) or SAFE_TOKEN_RE.fullmatch(node_id) is None or node_id in probe_nodes
                        or node_id in {producer["node_id"] for producer in producers}
                        or type(max_executions) is not int or not 1 <= max_executions <= 3
                    ):
                        return False
                    if v3:
                        probe_producer_ids: set[tuple[str, str, str]] = set()
                        for producer in probe["producers"]:
                            if not isinstance(producer, dict) or set(producer) != {"run_id", "node_id", "attempt_id"}:
                                return False
                            if any(not isinstance(producer[key], str) or SAFE_TOKEN_RE.fullmatch(producer[key]) is None for key in ("run_id", "node_id")):
                                return False
                            attempt_id = producer["attempt_id"]
                            if not isinstance(attempt_id, str) or SAFE_ATTEMPT_RE.fullmatch(attempt_id) is None:
                                return False
                            identity = (producer["run_id"], producer["node_id"], attempt_id)
                            if identity not in producer_ids or identity in probe_producer_ids:
                                return False
                            probe_producer_ids.add(identity)
                    probe_ids.add(probe_id)
                    probe_nodes.add(node_id)
            if v4:
                repairs = criterion["repair_actions"]
                if not isinstance(repairs, list) or len(repairs) > 1:
                    return False
                for repair in repairs:
                    repair_fields = {"id", "description", "command", "command_sha256", "producers", "node_id", "max_executions"}
                    if not isinstance(repair, dict) or set(repair) != repair_fields:
                        return False
                    command = repair["command"]
                    node_id = repair["node_id"]
                    if (
                        not isinstance(repair["id"], str) or re.fullmatch(r"^[a-z][a-z0-9-]{0,47}$", repair["id"]) is None
                        or not isinstance(repair["description"], str) or not repair["description"].strip() or len(repair["description"]) > 300
                        or not isinstance(command, str) or not command.strip() or len(command) > 512 or any(char in command for char in "\r\n\x00")
                        or not isinstance(repair["command_sha256"], str) or hashlib.sha256(command.encode("utf-8")).hexdigest() != repair["command_sha256"]
                        or not isinstance(node_id, str) or SAFE_TOKEN_RE.fullmatch(node_id) is None
                        or node_id in probe_nodes or node_id in {producer["node_id"] for producer in producers}
                        or type(repair["max_executions"]) is not int or repair["max_executions"] != 1
                        or not isinstance(repair["producers"], list) or not 1 <= len(repair["producers"]) <= MAX_PLAN_PRODUCERS
                    ):
                        return False
                    seen_repair_producers: set[tuple[str, str, str]] = set()
                    for producer in repair["producers"]:
                        if not isinstance(producer, dict) or set(producer) != {"run_id", "node_id", "attempt_id"}:
                            return False
                        identity = (producer["run_id"], producer["node_id"], producer["attempt_id"])
                        if identity not in producer_ids or identity in seen_repair_producers:
                            return False
                        seen_repair_producers.add(identity)
        return len(seen) == len(plan["criteria"])

    def _prepare_proof_plans(self) -> None:
        try:
            self._read_proof_plans()
        except FileNotFoundError:
            self._write_proof_plans(self._new_proof_plan_state())
        except (ControlError, ValueError, OSError):
            try:
                os.replace(self.proof_plan_path, self.proof_plan_path.with_name(f"control-proof-plans.corrupt.{int(time.time())}"))
            except FileNotFoundError:
                pass
            self._write_proof_plans(self._new_proof_plan_state())

    def _read_proof_plans(self) -> dict[str, Any]:
        self._check_proof_plan_storage()
        value = json.loads(self.proof_plan_path.read_text(encoding="utf-8"), object_pairs_hook=_pairs_no_duplicates)
        if (
            not isinstance(value, dict)
            or set(value) != {"schema_version", "generation", "updated_at", "used_request_ids", "plans"}
            or value["schema_version"] != 1
            or not isinstance(value["generation"], str) or GENERATION_RE.fullmatch(value["generation"]) is None
            or not isinstance(value["updated_at"], int)
            or not isinstance(value["used_request_ids"], list) or len(value["used_request_ids"]) > MAX_USED_REQUESTS
            or any(not isinstance(item, str) or REQUEST_ID_RE.fullmatch(item) is None for item in value["used_request_ids"])
            or not isinstance(value["plans"], list) or len(value["plans"]) > MAX_PROOF_PLANS
        ):
            raise ControlError("invalid_state", "proof-plan state contents are invalid")
        seen: set[str] = set()
        for entry in value["plans"]:
            if not isinstance(entry, dict) or set(entry) != {
                "plan", "plan_digest", "receipt_correlation_id", "approved_at", "approved_by_uid",
            }:
                raise ControlError("invalid_state", "proof-plan entry is invalid")
            if (
                not self._valid_proof_plan(entry["plan"])
                or not isinstance(entry["plan_digest"], str) or HEX_DIGEST_RE.fullmatch(entry["plan_digest"]) is None
                or not isinstance(entry["receipt_correlation_id"], str) or REQUEST_ID_RE.fullmatch(entry["receipt_correlation_id"]) is None
                or not isinstance(entry["approved_at"], int) or entry["approved_at"] < 0
                or not isinstance(entry["approved_by_uid"], int) or entry["approved_by_uid"] < 0
            ):
                raise ControlError("invalid_state", "proof-plan entry fields are invalid")
            canonical = json.dumps(entry["plan"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            if hashlib.sha256(canonical.encode("utf-8")).hexdigest() != entry["plan_digest"]:
                raise ControlError("invalid_state", "proof-plan digest does not match its content")
            mission_id = entry["plan"]["mission_id"]
            if mission_id in seen:
                raise ControlError("invalid_state", "duplicate mission proof plan")
            seen.add(mission_id)
        return value

    def _write_proof_plans(self, value: dict[str, Any]) -> None:
        self._check_storage()
        fd, temporary = tempfile.mkstemp(prefix=".control-proof-plans.", dir=self.state_path.parent)
        try:
            os.fchmod(fd, 0o644)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                output.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
                output.flush()
                os.fsync(output.fileno())
            if self.require_root and os.stat(temporary).st_uid != 0:
                raise ControlError("untrusted_state", "proof-plan writer is not root")
            os.replace(temporary, self.proof_plan_path)
            directory_fd = os.open(self.state_path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _proof_plan_lock(self) -> int:
        fd = os.open(self.proof_plan_lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or (self.require_root and (info.st_uid != 0 or info.st_mode & 0o077)):
            os.close(fd)
            raise ControlError("unsafe_lock", "proof-plan lock is not a regular, root-owned private file")
        try:
            self._acquire_lock(fd, "proof-plan")
        except BaseException:
            os.close(fd)
            raise
        return fd

    @staticmethod
    def _reply(value: dict[str, Any]) -> bytes:
        return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")

    def handle(self, connection: socket.socket, peer: tuple[int, int, int]) -> None:
        pid, uid, _gid = peer
        connection.settimeout(self.initial_request_timeout)
        try:
            payload = bytearray()
            while len(payload) <= MAX_REQUEST_BYTES:
                part = connection.recv(min(1024, MAX_REQUEST_BYTES + 1 - len(payload)))
                if not part:
                    break
                payload.extend(part)
                if b"\n" in part:
                    break
            if len(payload) > MAX_REQUEST_BYTES or payload.count(b"\n") != 1 or not payload.endswith(b"\n"):
                raise ControlError("invalid_request", "request must be one bounded JSON line")
            request = json.loads(payload, object_pairs_hook=_pairs_no_duplicates)
            if not isinstance(request, dict) or not isinstance(request.get("op"), str):
                raise ControlError("invalid_request", "operation is required")
            if request["op"] == "STATUS" and set(request) == {"op"}:
                state = self._read_state()
                response = {"ok": True, "desired": state["desired"], "effective": state["desired"], "generation": state["generation"], "updated_at": state["updated_at"]}
            elif request["op"] == "PROOF_PLAN_STATUS" and set(request) == {"op", "mission_id"}:
                mission_id = request["mission_id"]
                if not isinstance(mission_id, str) or MISSION_ID_RE.fullmatch(mission_id) is None:
                    raise ControlError("invalid_request", "mission id is invalid")
                state = self._read_proof_plans()
                matching = next((entry for entry in state["plans"] if entry["plan"]["mission_id"] == mission_id), None)
                response = {"ok": True, "generation": state["generation"], "plan": matching}
            elif request["op"] == "PROOF_PLAN_SET" and set(request) == {"op", "generation", "request_id", "plan"}:
                connection.settimeout(self.authorization_timeout)
                generation = request["generation"]
                request_id = request["request_id"]
                plan = request["plan"]
                if not isinstance(generation, str) or GENERATION_RE.fullmatch(generation) is None:
                    raise ControlError("invalid_request", "expected generation is invalid")
                if not isinstance(request_id, str) or REQUEST_ID_RE.fullmatch(request_id) is None:
                    raise ControlError("invalid_request", "request id is invalid")
                if not self._valid_proof_plan(plan):
                    raise ControlError("invalid_request", "proof plan is malformed or exceeds policy bounds")
                start_ticks = _process_start_ticks(pid)
                if os.stat(f"/proc/{pid}").st_uid != uid:
                    raise ControlError("caller_changed", "kernel caller identity no longer matches process")
                if not self._authorization_lock.acquire(blocking=False):
                    raise ControlError("authorization_busy", "another operator authorization is pending; retry after it completes")
                try:
                    if not self.authorizer(pid, uid, start_ticks, PROOF_PLAN_ACTION):
                        raise ControlError("not_authorized", "operator authorization was denied or unavailable")
                    if os.stat(f"/proc/{pid}").st_uid != uid or _process_start_ticks(pid) != start_ticks:
                        raise ControlError("caller_changed", "kernel caller identity changed during authorization")
                finally:
                    self._authorization_lock.release()
                fd = self._proof_plan_lock()
                try:
                    state = self._read_proof_plans()
                    if request_id in state["used_request_ids"]:
                        raise ControlError("replayed_request", "request id has already been consumed")
                    used_ids = [*state["used_request_ids"], request_id][-MAX_USED_REQUESTS:]
                    if state["generation"] != generation:
                        state["used_request_ids"] = used_ids
                        self._write_proof_plans(state)
                        raise ControlError("stale_generation", "proof plans changed after confirmation; review status and retry")
                    canonical = json.dumps(plan, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
                    entry = {
                        "plan": plan,
                        "plan_digest": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
                        "receipt_correlation_id": request_id,
                        "approved_at": int(time.time()),
                        "approved_by_uid": uid,
                    }
                    plans = [item for item in state["plans"] if item["plan"]["mission_id"] != plan["mission_id"]]
                    plans.append(entry)
                    if len(plans) > MAX_PROOF_PLANS:
                        raise ControlError("plan_limit", "proof plan store is full; revoke an obsolete plan first")
                    state.update({"generation": uuid.uuid4().hex, "updated_at": int(time.time()), "used_request_ids": used_ids, "plans": plans})
                    self._write_proof_plans(state)
                    response = {"ok": True, "generation": state["generation"], "plan": entry}
                finally:
                    os.close(fd)
            elif request["op"] in OPERATIONS and set(request) == {"op", "generation", "request_id"}:
                connection.settimeout(self.authorization_timeout)
                desired, action_id = OPERATIONS[request["op"]]
                generation = request["generation"]
                request_id = request["request_id"]
                if not isinstance(generation, str) or not GENERATION_RE.fullmatch(generation):
                    raise ControlError("invalid_request", "expected generation is invalid")
                if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
                    raise ControlError("invalid_request", "request id is invalid")
                observed = self._read_state()
                if request_id in observed["used_request_ids"]:
                    raise ControlError("replayed_request", "request id has already been consumed")
                if observed["generation"] != generation:
                    raise ControlError("stale_generation", "state changed after confirmation; review status and retry")
                start_ticks = _process_start_ticks(pid)
                if os.stat(f"/proc/{pid}").st_uid != uid:
                    raise ControlError("caller_changed", "kernel caller identity no longer matches process")
                if not self._authorization_lock.acquire(blocking=False):
                    raise ControlError("authorization_busy", "another operator authorization is pending; retry after it completes")
                try:
                    if not self.authorizer(pid, uid, start_ticks, action_id):
                        raise ControlError("not_authorized", "operator authorization was denied or unavailable")
                    try:
                        if os.stat(f"/proc/{pid}").st_uid != uid or _process_start_ticks(pid) != start_ticks:
                            raise ControlError("caller_changed", "kernel caller identity changed during authorization")
                    except (OSError, ValueError) as error:
                        raise ControlError("caller_changed", "kernel caller disappeared during authorization") from error
                finally:
                    self._authorization_lock.release()
                fd = self._lock()
                try:
                    state = self._read_state()
                    if request_id in state["used_request_ids"]:
                        raise ControlError("replayed_request", "request id has already been consumed")
                    used_ids = [*state["used_request_ids"], request_id][-MAX_USED_REQUESTS:]
                    if state["generation"] != generation:
                        state["used_request_ids"] = used_ids
                        self._write_state(state)
                        raise ControlError("stale_generation", "state changed after confirmation; review status and retry")
                    state.update({"desired": desired, "generation": uuid.uuid4().hex, "updated_at": int(time.time()), "used_request_ids": used_ids})
                    self._write_state(state)
                    response = {"ok": True, "desired": desired, "effective": desired, "generation": state["generation"], "updated_at": state["updated_at"]}
                finally:
                    os.close(fd)
            elif request["op"] == "ATTEST_STATUS" and set(request) == {"op", "mission_id"}:
                mission_id = request["mission_id"]
                if not isinstance(mission_id, str) or MISSION_ID_RE.fullmatch(mission_id) is None:
                    raise ControlError("invalid_request", "mission id is invalid")
                state = self._read_attestations()
                matching = [entry for entry in state["attestations"] if entry["mission_id"] == mission_id][-MAX_ATTESTATIONS_PER_MISSION:]
                response = {"ok": True, "generation": state["generation"], "attestations": matching}
            elif request["op"] in ATTEST_OPERATIONS and set(request) == {"op", "generation", "request_id", "mission_id", "mission_revision", "evidence_revision", "candidate"}:
                connection.settimeout(self.authorization_timeout)
                result, action_id = ATTEST_OPERATIONS[request["op"]]
                generation = request["generation"]
                request_id = request["request_id"]
                mission_id = request["mission_id"]
                mission_revision = request["mission_revision"]
                evidence_revision = request["evidence_revision"]
                candidate = request["candidate"]
                if not isinstance(generation, str) or not GENERATION_RE.fullmatch(generation):
                    raise ControlError("invalid_request", "expected generation is invalid")
                if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
                    raise ControlError("invalid_request", "request id is invalid")
                if not isinstance(mission_id, str) or MISSION_ID_RE.fullmatch(mission_id) is None:
                    raise ControlError("invalid_request", "mission id is invalid")
                if not isinstance(mission_revision, str) or REVISION_RE.fullmatch(mission_revision) is None:
                    raise ControlError("invalid_request", "mission revision is invalid")
                if not isinstance(evidence_revision, str) or SAFE_TOKEN_RE.fullmatch(evidence_revision) is None:
                    raise ControlError("invalid_request", "evidence revision is invalid")
                if not isinstance(candidate, str) or SAFE_TOKEN_RE.fullmatch(candidate) is None:
                    raise ControlError("invalid_request", "candidate digest is invalid")
                observed = self._read_attestations()
                if request_id in observed["used_request_ids"]:
                    raise ControlError("replayed_request", "request id has already been consumed")
                if observed["generation"] != generation:
                    raise ControlError("stale_generation", "state changed after confirmation; review status and retry")
                start_ticks = _process_start_ticks(pid)
                if os.stat(f"/proc/{pid}").st_uid != uid:
                    raise ControlError("caller_changed", "kernel caller identity no longer matches process")
                if not self._authorization_lock.acquire(blocking=False):
                    raise ControlError("authorization_busy", "another operator authorization is pending; retry after it completes")
                try:
                    if not self.authorizer(pid, uid, start_ticks, action_id):
                        raise ControlError("not_authorized", "operator authorization was denied or unavailable")
                    try:
                        if os.stat(f"/proc/{pid}").st_uid != uid or _process_start_ticks(pid) != start_ticks:
                            raise ControlError("caller_changed", "kernel caller identity changed during authorization")
                    except (OSError, ValueError) as error:
                        raise ControlError("caller_changed", "kernel caller disappeared during authorization") from error
                finally:
                    self._authorization_lock.release()
                fd = self._attest_lock()
                try:
                    state = self._read_attestations()
                    if request_id in state["used_request_ids"]:
                        raise ControlError("replayed_request", "request id has already been consumed")
                    used_ids = [*state["used_request_ids"], request_id][-MAX_USED_REQUESTS:]
                    if state["generation"] != generation:
                        state["used_request_ids"] = used_ids
                        self._write_attestations(state)
                        raise ControlError("stale_generation", "state changed after confirmation; review status and retry")
                    entry = {
                        "mission_id": mission_id,
                        "mission_revision": mission_revision,
                        "evidence_revision": evidence_revision,
                        "candidate": candidate,
                        "result": result,
                        "receipt_correlation_id": request_id,
                        "verified_at": int(time.time()),
                        "verifier_uid": uid,
                    }
                    kept = [
                        existing for existing in state["attestations"]
                        if not (existing["mission_id"] == mission_id and existing["evidence_revision"] == evidence_revision and existing["candidate"] == candidate)
                    ]
                    kept.append(entry)
                    state.update({"updated_at": int(time.time()), "used_request_ids": used_ids, "attestations": kept[-MAX_ATTESTATIONS:]})
                    self._write_attestations(state)
                    response = {"ok": True, "receipt_correlation_id": request_id, "result": result, "generation": state["generation"], "updated_at": state["updated_at"]}
                finally:
                    os.close(fd)
            else:
                raise ControlError("invalid_request", "unsupported operation or fields")
        except ControlError as error:
            response = {"ok": False, "error": error.code, "message": str(error)}
        except (OSError, ValueError, json.JSONDecodeError) as error:
            response = {"ok": False, "error": "service_unavailable", "message": str(error)}
        except Exception:
            response = {"ok": False, "error": "service_error", "message": "control request failed closed"}
        try:
            connection.sendall(self._reply(response))
        except OSError:
            pass

    def serve_forever(self, socket_path: Path = SOCKET_PATH) -> None:
        if os.geteuid() != 0:
            raise RuntimeError("jeverb-control service must run as root")
        directory = socket_path.parent
        directory.mkdir(mode=0o755, parents=True, exist_ok=True)
        directory_info = directory.lstat()
        if directory_info.st_uid != 0 or directory_info.st_mode & 0o022 or not stat.S_ISDIR(directory_info.st_mode):
            raise RuntimeError("control socket directory must be root-owned and protected")
        try:
            socket_path.unlink()
        except FileNotFoundError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(socket_path))
        os.chmod(socket_path, 0o666)
        os.chown(socket_path, 0, 0)
        server.listen(32)
        while True:
            connection, _ = server.accept()
            try:
                credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
                peer = struct.unpack("3i", credentials)
            except OSError:
                connection.close()
                continue
            pid, uid, _gid = peer
            if not self._admit_connection(uid):
                try:
                    connection.sendall(self._reply({"ok": False, "error": "busy", "message": "control service is busy"}))
                except OSError:
                    pass
                connection.close()
                continue
            threading.Thread(target=self._serve_connection, args=(connection, peer, True), daemon=True).start()

    def _admit_connection(self, uid: int) -> bool:
        with self._connection_counts_lock:
            if self._connection_counts.get(uid, 0) >= MAX_CONNECTIONS_PER_UID:
                return False
            if not self._connection_slots.acquire(blocking=False):
                return False
            self._connection_counts[uid] = self._connection_counts.get(uid, 0) + 1
            return True

    def _serve_connection(
        self,
        connection: socket.socket,
        peer: tuple[int, int, int] | None = None,
        owns_slot: bool = False,
    ) -> None:
        try:
            if peer is None:
                credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
                peer = struct.unpack("3i", credentials)
            self.handle(connection, peer)
        except OSError:
            pass
        finally:
            connection.close()
            if owns_slot:
                uid = peer[1] if peer is not None else -1
                with self._connection_counts_lock:
                    count = self._connection_counts.get(uid, 0) - 1
                    if count > 0:
                        self._connection_counts[uid] = count
                    else:
                        self._connection_counts.pop(uid, None)
                self._connection_slots.release()


def main(argv: list[str] | None = None) -> None:
    arguments = sys.argv[1:] if argv is None else argv
    if arguments == ["--emergency-off"]:
        if os.geteuid() != 0:
            raise SystemExit("jeverb-control emergency OFF recovery must run as root")
        try:
            state = ControlService.recover_emergency_off()
        except ControlError as error:
            raise SystemExit(f"emergency OFF failed ({error.code}): {error}") from None
        print(f"verified desired=OFF generation={state['generation']} updated_at={state['updated_at']}")
        return
    if arguments:
        raise SystemExit("usage: jeverb_control_service.py [--emergency-off]")
    if os.geteuid() != 0:
        raise SystemExit("jeverb-control service must run as root")
    ControlService().serve_forever()


if __name__ == "__main__":
    main()
