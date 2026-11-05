"""Regression tests for the free-only relay's on-disk request diagnostics."""

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


RELAY_PATH = Path(__file__).with_name("freeonly-relay.py")
STUB_RELAY_PATH = Path(__file__).with_name("stub-relay.py")
SUBJECT_CONFIG_PATH = Path(__file__).with_name("subject_config.py")
SUBJECT_SECRETS_PATH = Path(__file__).with_name("subject-secrets.sh")


class SubjectConfigTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("jeverb_subject_config", SUBJECT_CONFIG_PATH)
        self.assertIsNotNone(spec)
        self.module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(self.module)

    def test_bare_openrouter_roots_receive_api_path_and_relay_approval(self):
        for root in ("http://127.0.0.1:18789", "http://127.0.0.1:18789/"):
            with self.subTest(root=root):
                config, warnings = self.module.subject_hook_config({
                    "JEV_BACKEND": "openrouter",
                    "OPENROUTER_BASE_URL": root,
                })
                self.assertEqual(config["base_url"], root.rstrip("/") + "/api/v1")
                self.assertTrue(config["allow_custom_relay"])
                self.assertEqual(warnings, [])

    def test_explicit_provider_path_is_preserved_and_default_is_not_approved_as_custom(self):
        config, warnings = self.module.subject_hook_config({
            "JEV_BACKEND": "openrouter",
            "OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1/",
        })
        self.assertEqual(config["base_url"], "https://openrouter.ai/api/v1/")
        self.assertNotIn("allow_custom_relay", config)
        self.assertEqual(warnings, [])

    def test_invalid_base_and_timeout_are_reported_without_fabricating_config(self):
        with self.assertRaises(ValueError):
            self.module.subject_hook_config({"JEV_BACKEND": "openrouter", "OPENROUTER_BASE_URL": "relay.local"})
        with self.assertRaisesRegex(ValueError, "credentials must not be embedded"):
            self.module.subject_hook_config({"JEV_BACKEND": "openrouter", "OPENROUTER_BASE_URL": "https://user:secret@relay.local"})
        config, warnings = self.module.subject_hook_config({"JEV_HOOK_TIMEOUT_MS": "fast"})
        self.assertEqual(config, {})
        self.assertEqual(len(warnings), 1)

    def test_exit_cleanup_never_targets_root_credentials_before_data_dir_exists(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            evidence = root / "evidence"
            removed_log = root / "rm-args.log"
            env = {**os.environ, "RM_LOG": str(removed_log)}
            home_credential = evidence / "subject-home/.config/jeverb/credentials"
            muse_auth = evidence / "subject-home/config/muse/auth.json"
            home_credential.parent.mkdir(parents=True)
            muse_auth.parent.mkdir(parents=True)
            home_credential.write_text("test-only", encoding="utf-8")
            muse_auth.write_text("test-only", encoding="utf-8")
            command = 'rm() { printf "%s\\n" "$@" >> "$RM_LOG"; command rm "$@"; }; source "$1"; EVIDENCE="$2"; unset PLUGIN_DATA_DIR; cleanup_subject_secrets'
            subprocess.run(["bash", "-c", command, "subject-secrets-test", str(SUBJECT_SECRETS_PATH), str(evidence)], env=env, check=True)
            removed = removed_log.read_text(encoding="utf-8")
            self.assertNotIn("/credentials", removed.splitlines())
            self.assertIn(str(home_credential), removed)
            self.assertIn(str(muse_auth), removed)
            self.assertFalse(home_credential.exists())
            self.assertFalse(muse_auth.exists())


class SanitizedHeadersTests(unittest.TestCase):
    def test_credentials_are_redacted_and_safe_diagnostics_remain(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            key_file = Path(temp_dir) / "key"
            key_file.write_text("test-only-key", encoding="utf-8")
            previous = os.environ.get("OR_KEY_FILE")
            os.environ["OR_KEY_FILE"] = str(key_file)
            try:
                spec = importlib.util.spec_from_file_location("freeonly_relay_test", RELAY_PATH)
                self.assertIsNotNone(spec)
                module = importlib.util.module_from_spec(spec)
                assert spec.loader is not None
                spec.loader.exec_module(module)
            finally:
                if previous is None:
                    os.environ.pop("OR_KEY_FILE", None)
                else:
                    os.environ["OR_KEY_FILE"] = previous

        result = module.sanitized_headers(
            {
                "Authorization": "Bearer secret-value",
                "X-Session-Token": "session-secret",
                "Cookie": "session=secret",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://example.invalid",
            }
        )
        self.assertEqual(result["Authorization"], "[REDACTED]")
        self.assertEqual(result["X-Session-Token"], "[REDACTED]")
        self.assertEqual(result["Cookie"], "[REDACTED]")
        self.assertEqual(result["Content-Type"], "application/json")
        self.assertEqual(result["HTTP-Referer"], "https://example.invalid")
        self.assertNotIn("secret-value", repr(result))
        self.assertNotIn("session-secret", repr(result))


class StubRelayAnswerTests(unittest.TestCase):
    def test_choice_probabilities_are_normalized_for_large_option_sets(self):
        spec = importlib.util.spec_from_file_location("jev_stub_relay_test", STUB_RELAY_PATH)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)

        schema = '"kind": {"pick": one of ["question", "small", "medium", "large", "other"]}'
        answers = module.answers_for(schema, "benign")
        probabilities = answers["kind"]["probabilities"]
        self.assertAlmostEqual(sum(probabilities.values()), 1.0)
        self.assertEqual(answers["kind"]["pick"], "question")
        self.assertGreaterEqual(probabilities["question"], 0.94)


if __name__ == "__main__":
    unittest.main()
