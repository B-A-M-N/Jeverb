import json
import hashlib
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from jeverb_control_service import ControlError, ControlService, _process_start_ticks, main, polkit_authorize


class ControlServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="jeverb-control-test-")
        self.state = Path(self.tmp.name) / "control-state.json"
        self.authorizations = []
        self.service = ControlService(
            self.state,
            require_root=False,
            authorizer=lambda pid, uid, start, action: self.authorizations.append((pid, uid, start, action)) or True,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def direct_handle(self, payload, service=None):
        class MemoryConnection:
            def __init__(self, raw):
                self.raw = raw
                self.response = b""

            def settimeout(self, _timeout):
                pass

            def recv(self, size):
                part, self.raw = self.raw[:size], self.raw[size:]
                return part

            def sendall(self, raw):
                self.response += raw

        connection = MemoryConnection(json.dumps(payload).encode() + b"\n")
        service = service or self.service
        service.handle(connection, (os.getpid(), os.getuid(), os.getgid()))
        return json.loads(connection.response)

    def exchange(self, payload, service=None, peer=None):
        service = service or self.service
        server, client = socket.socketpair()
        credentials = peer or (os.getpid(), os.getuid(), os.getgid())

        def serve_once():
            try:
                service.handle(server, credentials)
            finally:
                server.close()

        thread = threading.Thread(target=serve_once)
        thread.start()
        client.sendall(json.dumps(payload).encode() + b"\n")
        client.shutdown(socket.SHUT_WR)
        response = b""
        while True:
            data = client.recv(4096)
            if not data:
                break
            response += data
        client.close()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        return json.loads(response)

    def exchange_kernel_peer(self, payload):
        server, client = socket.socketpair()
        thread = threading.Thread(target=self.service._serve_connection, args=(server,))
        thread.start()
        client.sendall(json.dumps(payload).encode() + b"\n")
        client.shutdown(socket.SHUT_WR)
        response = b""
        while True:
            data = client.recv(4096)
            if not data:
                break
            response += data
        client.close()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        return json.loads(response)

    def begin_exchange(self, payload, service=None):
        service = service or self.service
        server, client = socket.socketpair()
        peer = (os.getpid(), os.getuid(), os.getgid())

        def serve_once():
            try:
                service.handle(server, peer)
            finally:
                server.close()

        thread = threading.Thread(target=serve_once)
        thread.start()
        client.sendall(json.dumps(payload).encode() + b"\n")
        client.shutdown(socket.SHUT_WR)
        return client, thread

    def begin_admitted_exchange(self, payload, service=None):
        service = service or self.service
        server, client = socket.socketpair()
        peer = (os.getpid(), os.getuid(), os.getgid())
        if not service._admit_connection(peer[1]):
            raise AssertionError("service refused a test connection before request handling")
        thread = threading.Thread(target=service._serve_connection, args=(server, peer, True))
        thread.start()
        client.sendall(json.dumps(payload).encode() + b"\n")
        client.shutdown(socket.SHUT_WR)
        return client, thread

    @staticmethod
    def finish_exchange(client, thread):
        response = b""
        while True:
            data = client.recv(4096)
            if not data:
                break
            response += data
        client.close()
        thread.join(timeout=3)
        if thread.is_alive():
            raise AssertionError("request handler did not finish")
        return json.loads(response)

    def status(self):
        return self.exchange({"op": "STATUS"})

    def transition(self, op, generation, request_id):
        return self.exchange({"op": op, "generation": generation, "request_id": request_id})

    def test_first_start_and_reconstruction_fail_closed_off(self):
        self.assertEqual(self.status()["effective"], "OFF")
        restarted = ControlService(self.state, require_root=False, authorizer=lambda *_: True)
        self.assertEqual(self.exchange({"op": "STATUS"}, restarted)["effective"], "OFF")

    def test_status_is_observation_and_has_no_identity_or_auth_claim(self):
        response = self.status()
        self.assertEqual(response["desired"], "OFF")
        self.assertEqual(self.authorizations, [])

    def test_connection_peer_identity_comes_from_kernel_socket_credentials(self):
        response = self.exchange_kernel_peer({"op": "SET_ON", "generation": self.status()["generation"], "request_id": "9" * 32})
        self.assertTrue(response["ok"])
        self.assertEqual(self.authorizations[0][:2], (os.getpid(), os.getuid()))

    def test_pkcheck_receives_complete_kernel_process_identity_tuple(self):
        start = _process_start_ticks(os.getpid())
        with patch("jeverb_control_service.subprocess.run") as run:
            run.return_value.returncode = 0
            self.assertTrue(polkit_authorize(os.getpid(), os.getuid(), start, "org.jeverb.control.set-on"))
        command = run.call_args.args[0]
        process_arg = command[command.index("--process") + 1]
        self.assertEqual(process_arg, f"{os.getpid()},{start},{os.getuid()}")

    def test_status_and_recovery_remain_available_during_incomplete_connections(self):
        self.service.initial_request_timeout = 0.15
        incomplete = []
        peer = (os.getpid(), os.getuid(), os.getgid())
        for _ in range(7):
            server, client = socket.socketpair()
            self.assertTrue(self.service._admit_connection(peer[1]))
            thread = threading.Thread(target=self.service._serve_connection, args=(server, peer, True))
            thread.start()
            incomplete.append((client, thread))

        status_client, status_thread = self.begin_admitted_exchange({"op": "STATUS"})
        status = self.finish_exchange(status_client, status_thread)
        self.assertTrue(status["ok"])
        started = time.monotonic()
        on_client, on_thread = self.begin_admitted_exchange({
            "op": "SET_ON", "generation": status["generation"], "request_id": "8" * 32,
        })
        turned_on = self.finish_exchange(on_client, on_thread)
        self.assertTrue(turned_on["ok"])
        self.assertLess(time.monotonic() - started, 0.5)

        for client, thread in incomplete:
            thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
            self.assertTrue(client.recv(4096))
            client.close()

    def test_full_incomplete_connection_quota_expires_and_restores_operator_admission(self):
        self.service.initial_request_timeout = 0.05
        peer = (os.getpid(), os.getuid(), os.getgid())
        incomplete = []
        for _ in range(8):
            server, client = socket.socketpair()
            self.assertTrue(self.service._admit_connection(peer[1]))
            thread = threading.Thread(target=self.service._serve_connection, args=(server, peer, True))
            thread.start()
            incomplete.append((client, thread))
        self.assertFalse(self.service._admit_connection(peer[1]))

        for client, thread in incomplete:
            thread.join(timeout=1)
            self.assertFalse(thread.is_alive())
            client.recv(4096)
            client.close()
        self.assertTrue(self.service._admit_connection(peer[1]))
        # Release the admission slot just acquired by the assertion above.
        with self.service._connection_counts_lock:
            self.service._connection_counts.pop(peer[1], None)
        self.service._connection_slots.release()

    def test_authentication_is_single_flight_and_status_does_not_wait_for_it(self):
        entered = threading.Event()
        release = threading.Event()

        def delayed_authorizer(*_args):
            entered.set()
            return release.wait(timeout=2)

        service = ControlService(self.state, require_root=False, authorizer=delayed_authorizer)
        status = self.exchange({"op": "STATUS"}, service)
        first, first_thread = self.begin_exchange(
            {"op": "SET_ON", "generation": status["generation"], "request_id": "4" * 32}, service
        )
        self.assertTrue(entered.wait(timeout=1))

        busy = self.exchange(
            {"op": "SET_OFF", "generation": status["generation"], "request_id": "5" * 32}, service
        )
        self.assertEqual(busy["error"], "authorization_busy")
        responsive = self.exchange({"op": "STATUS"}, service)
        self.assertTrue(responsive["ok"])
        release.set()
        self.assertTrue(self.finish_exchange(first, first_thread)["ok"])

    def test_set_on_and_off_use_action_specific_authorization(self):
        off = self.status()
        turned_on = self.transition("SET_ON", off["generation"], "a" * 32)
        self.assertTrue(turned_on["ok"])
        self.assertEqual(turned_on["desired"], "ON")
        turned_off = self.transition("SET_OFF", turned_on["generation"], "b" * 32)
        self.assertTrue(turned_off["ok"])
        self.assertEqual(turned_off["desired"], "OFF")
        self.assertEqual([entry[3] for entry in self.authorizations], [
            "org.jeverb.control.set-on",
            "org.jeverb.control.set-off",
        ])

    def test_agent_initiated_request_without_polkit_approval_is_denied(self):
        status = self.status()
        denied = ControlService(self.state, require_root=False, authorizer=lambda *_: False)
        response = self.transition("SET_ON", status["generation"], "c" * 32) if denied is self.service else self.exchange(
            {"op": "SET_ON", "generation": status["generation"], "request_id": "c" * 32}, denied
        )
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"], "not_authorized")
        self.assertEqual(self.status()["desired"], "OFF")

    def test_replay_is_rejected_before_reauthorization(self):
        status = self.status()
        payload = {"op": "SET_ON", "generation": status["generation"], "request_id": "d" * 32}
        self.assertTrue(self.exchange(payload)["ok"])
        count = len(self.authorizations)
        self.assertEqual(self.exchange(payload)["error"], "replayed_request")
        self.assertEqual(len(self.authorizations), count)

    def test_stale_generation_cannot_overwrite_a_concurrent_transition(self):
        status = self.status()
        first = self.transition("SET_ON", status["generation"], "e" * 32)
        self.assertTrue(first["ok"])
        stale = self.transition("SET_OFF", status["generation"], "f" * 32)
        self.assertEqual(stale["error"], "stale_generation")
        self.assertEqual(self.status()["desired"], "ON")

    def test_emergency_off_persists_off_and_preserves_request_history(self):
        before = self.status()
        turned_on = self.transition("SET_ON", before["generation"], "7" * 32)
        self.assertTrue(turned_on["ok"])

        recovered = ControlService.recover_emergency_off(self.state, require_root=False)

        self.assertEqual(recovered["desired"], "OFF")
        self.assertIn("7" * 32, recovered["used_request_ids"])
        self.assertEqual(self.status()["effective"], "OFF")

    def test_emergency_off_quarantines_corrupt_regular_state_and_reads_back_off(self):
        corrupt = b"preserve this broken control-state evidence\n"
        self.state.write_bytes(corrupt)

        recovered = ControlService.recover_emergency_off(self.state, require_root=False)

        quarantined = list(self.state.parent.glob("control-state.json.corrupt.*"))
        self.assertEqual(len(quarantined), 1)
        self.assertEqual(quarantined[0].read_bytes(), corrupt)
        self.assertEqual(recovered["desired"], "OFF")
        self.assertEqual(self.service._read_state()["generation"], recovered["generation"])

    def test_emergency_off_recovers_missing_state(self):
        self.state.unlink()

        recovered = ControlService.recover_emergency_off(self.state, require_root=False)

        self.assertEqual(recovered["desired"], "OFF")
        self.assertEqual(self.service._read_state()["desired"], "OFF")

    def test_emergency_off_refuses_symlinked_state_without_touching_target(self):
        target = self.state.with_name("operator-owned-state.json")
        target.write_text("preserve", encoding="utf-8")
        self.state.unlink()
        self.state.symlink_to(target)

        with self.assertRaises(ControlError):
            ControlService.recover_emergency_off(self.state, require_root=False)

        self.assertTrue(self.state.is_symlink())
        self.assertEqual(target.read_text(encoding="utf-8"), "preserve")

    def test_emergency_off_fences_request_waiting_for_authorization(self):
        authorization_started = threading.Event()
        finish_authorization = threading.Event()

        def delayed_authorizer(*_):
            authorization_started.set()
            if not finish_authorization.wait(timeout=3):
                return False
            return True

        service = ControlService(self.state, require_root=False, authorizer=delayed_authorizer)
        generation = service._read_state()["generation"]
        client, thread = self.begin_exchange(
            {"op": "SET_ON", "generation": generation, "request_id": "8" * 32}, service
        )
        self.assertTrue(authorization_started.wait(timeout=2))
        recovered = service.emergency_off()
        finish_authorization.set()

        response = self.finish_exchange(client, thread)
        self.assertEqual(recovered["desired"], "OFF")
        self.assertEqual(response["error"], "stale_generation")
        self.assertEqual(service._read_state()["desired"], "OFF")

    def test_emergency_off_returns_bounded_failure_when_state_lock_is_held(self):
        before = self.status()
        self.assertTrue(self.transition("SET_ON", before["generation"], "9" * 32)["ok"])
        held_lock = self.service._lock()
        finished = threading.Event()
        outcome = []

        def recover():
            try:
                outcome.append(ControlService.recover_emergency_off(self.state, require_root=False))
            except Exception as error:
                outcome.append(error)
            finally:
                finished.set()

        worker = threading.Thread(target=recover)
        try:
            with patch("jeverb_control_service.STATE_LOCK_TIMEOUT_SECONDS", 0.05):
                worker.start()
                returned_before_unlock = finished.wait(timeout=0.5)
        finally:
            os.close(held_lock)
            worker.join(timeout=2)

        self.assertFalse(worker.is_alive())
        self.assertTrue(returned_before_unlock, "emergency recovery blocked indefinitely on the state lock")
        self.assertEqual(len(outcome), 1)
        self.assertIsInstance(outcome[0], ControlError)
        self.assertEqual(outcome[0].code, "lock_timeout")
        self.assertEqual(self.service._read_state()["desired"], "ON")

    def test_emergency_cli_rejects_non_root_before_opening_state(self):
        with patch("jeverb_control_service.os.geteuid", return_value=1000):
            with self.assertRaisesRegex(SystemExit, "must run as root"):
                main(["--emergency-off"])

    def test_emergency_cli_reports_lock_timeout_without_claiming_off(self):
        with patch("jeverb_control_service.os.geteuid", return_value=0):
            with patch.object(ControlService, "recover_emergency_off", side_effect=ControlError("lock_timeout", "state lock busy")):
                with self.assertRaisesRegex(SystemExit, "lock_timeout"):
                    main(["--emergency-off"])

    def test_concurrent_conflicting_transitions_allow_only_one_generation_winner(self):
        status = self.status()
        old = status["generation"]
        outputs = []
        errors = []

        def call(op, request_id):
            try:
                outputs.append(self.transition(op, old, request_id))
            except Exception as error:  # pragma: no cover - assertion captures unexpected thread failures
                errors.append(error)

        a = threading.Thread(target=call, args=("SET_ON", "1" * 32))
        b = threading.Thread(target=call, args=("SET_OFF", "2" * 32))
        a.start()
        b.start()
        a.join(timeout=4)
        b.join(timeout=4)
        self.assertFalse(a.is_alive() or b.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(sum(1 for item in outputs if item.get("ok")), 1)
        rejected = [item.get("error") for item in outputs if not item.get("ok")]
        # The single-flight PolicyKit admission can reject the second caller
        # before it reaches the generation check. Both outcomes are safe; a
        # caller that retries after STATUS will observe the winning generation.
        self.assertEqual(len(rejected), 1)
        self.assertIn(rejected[0], ("stale_generation", "authorization_busy"))
        self.assertIn(self.status()["desired"], ("ON", "OFF"))

    def test_extra_fields_forged_origins_and_session_tokens_are_rejected(self):
        status = self.status()
        response = self.exchange({
            "op": "SET_OFF",
            "generation": status["generation"],
            "request_id": "3" * 32,
            "origin": "operator",
            "approved": True,
            "session_id": "agent-session",
        })
        self.assertEqual(response["error"], "invalid_request")
        self.assertEqual(self.authorizations, [])

    def test_corrupt_state_reinitializes_off_and_unknown_file_is_not_trusted(self):
        self.state.write_text("corrupt", encoding="utf-8")
        recovered = ControlService(self.state, require_root=False, authorizer=lambda *_: True)
        self.assertEqual(self.exchange({"op": "STATUS"}, recovered)["effective"], "OFF")

    def test_same_uid_file_replacement_is_rejected_in_root_protected_mode(self):
        # This test cannot create root-owned files in an unprivileged test
        # environment. It verifies the production reader rejects an agent-owned
        # substitute instead of treating it as authoritative.
        protected = ControlService(self.state, require_root=False, authorizer=lambda *_: True)
        protected.require_root = True
        response = self.exchange({"op": "STATUS"}, protected)
        self.assertFalse(response["ok"])

    def test_unknown_operations_are_rejected(self):
        self.assertEqual(self.exchange({"op": "SHUTDOWN"})["error"], "invalid_request")

    def proof_plan(self):
        return {
            "schema": "jeverb-host-proof-plan/1",
            "mission_id": "a" * 32,
            "mission_revision": "b" * 64,
            "objective_sha256": "c" * 64,
            "workspace_root": str(Path(self.tmp.name).resolve()),
            "criteria": [{
                "criterion_id": "criterion-01",
                "requirement_sha256": "d" * 64,
                "test_command_sha256": "e" * 64,
                "producers": [{"run_id": "run-01", "node_id": "verify", "attempt_id": "verify/1"}],
                "code_files": ["src/discount.ts"],
            }],
        }

    def test_host_proof_plan_requires_polkit_and_persists_bound_provenance(self):
        status = self.direct_handle({"op": "PROOF_PLAN_STATUS", "mission_id": "a" * 32})
        response = self.direct_handle({
            "op": "PROOF_PLAN_SET",
            "generation": status["generation"],
            "request_id": "5" * 32,
            "plan": self.proof_plan(),
        })
        self.assertTrue(response["ok"])
        self.assertEqual(self.authorizations[-1][3], "org.jeverb.control.proof-plan")
        self.assertEqual(response["plan"]["receipt_correlation_id"], "5" * 32)
        self.assertEqual(response["plan"]["approved_by_uid"], os.getuid())
        self.assertEqual(self.direct_handle({"op": "PROOF_PLAN_STATUS", "mission_id": "a" * 32})["plan"], response["plan"])

    def test_host_proof_plan_rejects_unbound_or_unsafe_inputs_before_authorization(self):
        status = self.direct_handle({"op": "PROOF_PLAN_STATUS", "mission_id": "a" * 32})
        plan = self.proof_plan()
        plan["criteria"][0]["code_files"] = ["../outside.ts"]
        response = self.direct_handle({
            "op": "PROOF_PLAN_SET",
            "generation": status["generation"],
            "request_id": "6" * 32,
            "plan": plan,
        })
        self.assertEqual(response["error"], "invalid_request")
        self.assertEqual(self.authorizations, [])

    def test_host_proof_plan_stale_generation_does_not_replace_approved_plan(self):
        status = self.direct_handle({"op": "PROOF_PLAN_STATUS", "mission_id": "a" * 32})
        first = self.direct_handle({
            "op": "PROOF_PLAN_SET", "generation": status["generation"],
            "request_id": "7" * 32, "plan": self.proof_plan(),
        })
        changed = self.proof_plan()
        changed["criteria"][0]["code_files"] = ["src/other.ts"]
        stale = self.direct_handle({
            "op": "PROOF_PLAN_SET", "generation": status["generation"],
            "request_id": "8" * 32, "plan": changed,
        })
        self.assertEqual(stale["error"], "stale_generation")
        current = self.direct_handle({"op": "PROOF_PLAN_STATUS", "mission_id": "a" * 32})
        self.assertEqual(current["plan"]["plan_digest"], first["plan"]["plan_digest"])

    def test_v2_host_proof_plan_remains_readable_with_its_original_probe_contract(self):
        plan = self.proof_plan()
        plan["schema"] = "jeverb-host-proof-plan/2"
        command = "node tests/access-probe.cjs"
        plan["criteria"][0]["probe_actions"] = [{
            "id": "revoked-membership",
            "description": "Exercise revoked membership access",
            "command": command,
            "command_sha256": hashlib.sha256(command.encode("utf-8")).hexdigest(),
            "node_id": "probe-revoked",
            "max_executions": 2,
        }]
        self.assertTrue(self.service._valid_proof_plan(plan))
        bad_hash = json.loads(json.dumps(plan))
        bad_hash["criteria"][0]["probe_actions"][0]["command"] = "node tests/other.cjs"
        self.assertFalse(self.service._valid_proof_plan(bad_hash))
        bad_budget = json.loads(json.dumps(plan))
        bad_budget["criteria"][0]["probe_actions"][0]["max_executions"] = 4
        self.assertFalse(self.service._valid_proof_plan(bad_budget))
        bad_command = json.loads(json.dumps(plan))
        bad_command["criteria"][0]["probe_actions"][0]["command"] = "node probe.cjs\nsudo rm -rf /"
        self.assertFalse(self.service._valid_proof_plan(bad_command))
        status = self.direct_handle({"op": "PROOF_PLAN_STATUS", "mission_id": "a" * 32})
        response = self.direct_handle({
            "op": "PROOF_PLAN_SET", "generation": status["generation"],
            "request_id": "9" * 32, "plan": plan,
        })
        self.assertTrue(response["ok"])
        self.assertEqual(response["plan"]["plan"]["criteria"][0]["probe_actions"][0]["command"], command)
        self.assertEqual(self.authorizations[-1][3], "org.jeverb.control.proof-plan")

    def test_v3_probe_approval_binds_exact_graph_producers(self):
        plan = self.proof_plan()
        plan["schema"] = "jeverb-host-proof-plan/3"
        plan["workspace_root"] = "/tmp"
        command = "node tests/access-probe.cjs"
        plan["criteria"][0]["probe_actions"] = [{
            "id": "revoked-membership", "description": "Exercise revoked membership access",
            "command": command, "command_sha256": hashlib.sha256(command.encode("utf-8")).hexdigest(),
            "producers": [{"run_id": "run-01", "node_id": "verify", "attempt_id": "verify/1"}],
            "node_id": "probe-revoked", "max_executions": 2,
        }]
        self.assertTrue(self.service._valid_proof_plan(plan))
        unrelated = json.loads(json.dumps(plan))
        unrelated["criteria"][0]["probe_actions"][0]["producers"][0]["run_id"] = "other-run"
        self.assertFalse(self.service._valid_proof_plan(unrelated))
        missing_attempt = json.loads(json.dumps(plan))
        missing_attempt["criteria"][0]["probe_actions"][0]["producers"][0].pop("attempt_id")
        self.assertFalse(self.service._valid_proof_plan(missing_attempt))
        status = self.direct_handle({"op": "PROOF_PLAN_STATUS", "mission_id": "a" * 32})
        response = self.direct_handle({
            "op": "PROOF_PLAN_SET", "generation": status["generation"],
            "request_id": "a" * 32, "plan": plan,
        })
        self.assertTrue(response["ok"])
        canonical = json.dumps(plan, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        self.assertEqual(digest, "8aa45f51836f581957675e58559b2118d0d68f535bbf8ae4be77af5227d5bb23")
        self.assertEqual(response["plan"]["plan_digest"], digest)
        self.assertEqual(response["plan"]["plan"]["criteria"][0]["probe_actions"][0]["producers"],
                         plan["criteria"][0]["probe_actions"][0]["producers"])

    def test_v4_repair_plan_bounds_commands_producers_and_single_execution(self):
        plan = self.proof_plan()
        plan["schema"] = "jeverb-host-proof-plan/4"
        plan["workspace_root"] = "/tmp"
        test_command = "npm test -- access.test.ts"
        plan["criteria"][0]["test_command"] = test_command
        plan["criteria"][0]["test_command_sha256"] = hashlib.sha256(test_command.encode("utf-8")).hexdigest()
        plan["criteria"][0]["probe_actions"] = [{
            "id": "revoked-membership", "description": "Check revoked membership",
            "command": "npm test -- access.test.ts -t revoked",
            "command_sha256": hashlib.sha256(b"npm test -- access.test.ts -t revoked").hexdigest(),
            "producers": [{"run_id": "run-01", "node_id": "verify", "attempt_id": "verify/1"}],
            "node_id": "probe-revoked", "max_executions": 1,
        }]
        repair_command = "node repair.mjs"
        plan["criteria"][0]["repair_actions"] = [{
            "id": "repair-revoked", "description": "Apply one bounded repair",
            "command": repair_command,
            "command_sha256": hashlib.sha256(repair_command.encode("utf-8")).hexdigest(),
            "producers": [{"run_id": "run-01", "node_id": "verify", "attempt_id": "verify/1"}],
            "node_id": "repair-revoked", "max_executions": 1,
        }]
        self.assertTrue(self.service._valid_proof_plan(plan))
        for mutate in (
            lambda value: value["criteria"][0].update(test_command="node other.mjs"),
            lambda value: value["criteria"][0]["repair_actions"][0].update(command="node other.mjs"),
            lambda value: value["criteria"][0]["repair_actions"][0].update(max_executions=2),
            lambda value: value["criteria"][0]["repair_actions"][0]["producers"][0].update(run_id="other-run"),
        ):
            bad = json.loads(json.dumps(plan))
            mutate(bad)
            self.assertFalse(self.service._valid_proof_plan(bad))
        status = self.direct_handle({"op": "PROOF_PLAN_STATUS", "mission_id": "a" * 32})
        response = self.direct_handle({
            "op": "PROOF_PLAN_SET", "generation": status["generation"],
            "request_id": "c" * 32, "plan": plan,
        })
        self.assertTrue(response["ok"])
        stored = response["plan"]["plan"]["criteria"][0]
        self.assertEqual(stored["test_command"], test_command)
        self.assertEqual(stored["repair_actions"], plan["criteria"][0]["repair_actions"])


class ControlAttestationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="jeverb-attest-test-")
        self.state = Path(self.tmp.name) / "control-state.json"
        self.authorizations = []
        self.service = ControlService(
            self.state,
            require_root=False,
            authorizer=lambda pid, uid, start, action: self.authorizations.append((pid, uid, start, action)) or True,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_attestation_lock_wait_is_bounded(self):
        held_lock = self.service._attest_lock()
        started = time.monotonic()
        try:
            with patch("jeverb_control_service.STATE_LOCK_TIMEOUT_SECONDS", 0.05):
                with self.assertRaises(ControlError) as raised:
                    self.service._attest_lock()
        finally:
            os.close(held_lock)
        self.assertEqual(raised.exception.code, "lock_timeout")
        self.assertLess(time.monotonic() - started, 0.5)

    def exchange(self, payload, service=None):
        service = service or self.service
        server, client = socket.socketpair()
        peer = (os.getpid(), os.getuid(), os.getgid())

        def serve_once():
            try:
                service.handle(server, peer)
            finally:
                server.close()

        thread = threading.Thread(target=serve_once)
        thread.start()
        client.sendall(json.dumps(payload).encode() + b"\n")
        client.shutdown(socket.SHUT_WR)
        response = b""
        while True:
            data = client.recv(4096)
            if not data:
                break
            response += data
        client.close()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        return json.loads(response)

    def status(self, mission_id):
        return self.exchange({"op": "ATTEST_STATUS", "mission_id": mission_id})

    def attest(self, op, generation, request_id, mission_id="a" * 32, mission_revision="b" * 64,
               evidence_revision="c" * 64, candidate="d" * 64):
        return self.exchange({
            "op": op, "generation": generation, "request_id": request_id,
            "mission_id": mission_id, "mission_revision": mission_revision,
            "evidence_revision": evidence_revision, "candidate": candidate,
        })

    def test_attest_status_starts_empty(self):
        response = self.status("a" * 32)
        self.assertTrue(response["ok"])
        self.assertEqual(response["attestations"], [])
        self.assertEqual(self.authorizations, [])

    def test_attest_pass_persists_and_reads_back(self):
        generation = self.status("a" * 32)["generation"]
        recorded = self.attest("ATTEST_PASS", generation, "1" * 32)
        self.assertTrue(recorded["ok"], recorded)
        self.assertEqual(recorded["receipt_correlation_id"], "1" * 32)
        self.assertEqual(recorded["result"], "pass")
        self.assertEqual(self.authorizations[-1][3], "org.jeverb.control.attest-pass")
        listed = self.status("a" * 32)["attestations"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["mission_id"], "a" * 32)
        self.assertEqual(listed[0]["evidence_revision"], "c" * 64)
        self.assertEqual(listed[0]["candidate"], "d" * 64)
        self.assertEqual(listed[0]["result"], "pass")
        self.assertEqual(listed[0]["receipt_correlation_id"], "1" * 32)

    def test_attest_fail_uses_distinct_action(self):
        generation = self.status("a" * 32)["generation"]
        recorded = self.attest("ATTEST_FAIL", generation, "2" * 32)
        self.assertTrue(recorded["ok"], recorded)
        self.assertEqual(self.authorizations[-1][3], "org.jeverb.control.attest-fail")
        self.assertEqual(self.status("a" * 32)["attestations"][0]["result"], "fail")

    def test_attest_rejects_replayed_request_id(self):
        generation = self.status("a" * 32)["generation"]
        self.assertTrue(self.attest("ATTEST_PASS", generation, "3" * 32)["ok"])
        replay = self.attest("ATTEST_PASS", generation, "3" * 32)
        self.assertFalse(replay["ok"])
        self.assertEqual(replay["error"], "replayed_request")

    def test_attest_rejects_stale_generation(self):
        fresh = self.status("a" * 32)
        stale = self.attest("ATTEST_PASS", "0" * 32, "4" * 32)
        self.assertFalse(stale["ok"])
        self.assertEqual(stale["error"], "stale_generation")
        self.assertEqual(self.status("a" * 32)["attestations"], [])
        self.assertTrue(fresh["ok"])

    def test_attest_rejects_malformed_fields(self):
        generation = self.status("a" * 32)["generation"]
        base = {"op": "ATTEST_PASS", "generation": generation, "request_id": "5" * 32,
                "mission_id": "a" * 32, "mission_revision": "b" * 64,
                "evidence_revision": "c" * 64, "candidate": "d" * 64}
        for field, bad in (("mission_id", "short"), ("mission_revision", "b" * 63),
                            ("evidence_revision", ""), ("candidate", "has space"),
                            ("request_id", "zz"), ("generation", "nope")):
            mutated = dict(base, **{field: bad})
            response = self.exchange(mutated)
            self.assertFalse(response["ok"], (field, bad, response))
            self.assertEqual(response["error"], "invalid_request", (field, bad))
        extra = dict(base, smuggled="x")
        self.assertEqual(self.exchange(extra)["error"], "invalid_request")

    def test_attest_requires_authorization(self):
        denied = ControlService(
            self.state, require_root=False, authorizer=lambda *_: False)
        generation = self.exchange({"op": "ATTEST_STATUS", "mission_id": "a" * 32}, denied)["generation"]
        auths = []
        denying = ControlService(
            self.state, require_root=False,
            authorizer=lambda pid, uid, start, action: auths.append(action) or False)
        response = self.exchange({
            "op": "ATTEST_PASS", "generation": generation, "request_id": "6" * 32,
            "mission_id": "a" * 32, "mission_revision": "b" * 64,
            "evidence_revision": "c" * 64, "candidate": "d" * 64}, denying)
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"], "not_authorized")
        self.assertEqual(auths, ["org.jeverb.control.attest-pass"])

    def test_attest_replaces_same_candidate_revision(self):
        first = self.status("a" * 32)["generation"]
        self.assertTrue(self.attest("ATTEST_FAIL", first, "7" * 32)["ok"])
        # A later verdict for the same mission/evidence/candidate supersedes.
        self.assertTrue(self.attest("ATTEST_PASS", first, "8" * 32)["ok"])
        listed = self.status("a" * 32)["attestations"]
        self.assertEqual([entry["result"] for entry in listed], ["pass"])

    def test_attest_status_filters_by_mission(self):
        generation = self.status("a" * 32)["generation"]
        self.assertTrue(self.attest("ATTEST_PASS", generation, "9" * 32)["ok"])
        other = self.status("e" * 32)
        self.assertTrue(other["ok"])
        self.assertEqual(other["attestations"], [])

    def test_corrupt_attestations_reinitialize_empty(self):
        generation = self.status("a" * 32)["generation"]
        self.assertTrue(self.attest("ATTEST_PASS", generation, "f" * 32)["ok"])
        attest_path = self.state.parent / "control-attestations.json"
        attest_path.write_text("corrupt", encoding="utf-8")
        recovered = ControlService(self.state, require_root=False, authorizer=lambda *_: True)
        response = self.exchange({"op": "ATTEST_STATUS", "mission_id": "a" * 32}, recovered)
        self.assertTrue(response["ok"])
        self.assertEqual(response["attestations"], [])

    def test_attest_status_requires_mission_scope(self):
        self.assertEqual(self.exchange({"op": "ATTEST_STATUS"})["error"], "invalid_request")
        self.assertEqual(self.exchange({"op": "ATTEST_STATUS", "mission_id": "not-hex"})["error"], "invalid_request")


if __name__ == "__main__":
    unittest.main()
