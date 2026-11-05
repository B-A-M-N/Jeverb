import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("verify_installed.py")
PAYLOADS = (
    ("jeverb_control_service.py", "usr/lib/jeverb/control-service/jeverb_control_service.py"),
    ("org.jeverb.control.policy", "usr/share/polkit-1/actions/org.jeverb.control.policy"),
    ("jeverb-control.service", "etc/systemd/system/jeverb-control.service"),
)


class VerifyInstalledTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="jeverb-install-verify-")
        self.root = Path(self.temp.name)
        self.stage = self.root / "stage"
        self.install_root = self.root / "install-root"
        self.stage.mkdir()
        self.install_root.mkdir()
        for index, (staged_name, destination) in enumerate(PAYLOADS):
            content = f"verified payload {index}\n".encode()
            staged = self.stage / staged_name
            installed = self.install_root / destination
            staged.parent.mkdir(parents=True, exist_ok=True)
            installed.parent.mkdir(parents=True, exist_ok=True)
            staged.write_bytes(content)
            installed.write_bytes(content)

    def tearDown(self):
        self.temp.cleanup()

    def run_verifier(self):
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.stage), str(self.install_root)],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_accepts_exact_installed_copy(self):
        result = self.run_verifier()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("match verified stage", result.stdout)

    def test_rejects_changed_installed_bytes(self):
        installed = self.install_root / PAYLOADS[0][1]
        installed.write_bytes(b"substituted payload\n")
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertIn("installed bytes differ", result.stderr)

    def test_rejects_missing_installed_file(self):
        (self.install_root / PAYLOADS[1][1]).unlink()
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot verify", result.stderr)

    def test_rejects_symlinked_installed_file(self):
        installed = self.install_root / PAYLOADS[2][1]
        installed.unlink()
        installed.symlink_to(self.stage / PAYLOADS[2][0])
        result = self.run_verifier()
        self.assertEqual(result.returncode, 1)
        self.assertIn("not a regular file", result.stderr)


if __name__ == "__main__":
    unittest.main()
