import hashlib
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from assemble_control_candidate import PAYLOADS, assemble


class AssembleControlCandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="jeverb-candidate-build-")
        self.root = Path(self.temp.name)
        self.source_root = self.root / "source"
        self.source_dir = self.source_root / "control-service"
        self.source_dir.mkdir(parents=True)
        for name in PAYLOADS:
            (self.source_dir / name).write_text(f"source:{name}\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_creates_exact_manifested_snapshot_with_installer_digest(self):
        output = self.root / "candidate"
        digest = assemble(output, self.source_root)
        files = sorted(path.name for path in output.iterdir())
        self.assertEqual(files, ["SHA256SUMS", *sorted(PAYLOADS)])
        manifest = (output / "SHA256SUMS").read_bytes()
        self.assertEqual(digest, hashlib.sha256(manifest).hexdigest())
        self.assertEqual(output.stat().st_mode & 0o777, 0o755)
        for name in PAYLOADS:
            self.assertEqual((output / name).read_bytes(), (self.source_dir / name).read_bytes())
            self.assertEqual((output / name).stat().st_mode & 0o777, 0o444)

    def test_snapshot_is_independent_of_later_checkout_changes(self):
        output = self.root / "candidate"
        assemble(output, self.source_root)
        before = (output / PAYLOADS[0]).read_bytes()
        (self.source_dir / PAYLOADS[0]).write_text("later source edit\n", encoding="utf-8")
        self.assertEqual((output / PAYLOADS[0]).read_bytes(), before)

    def test_refuses_to_overwrite_existing_output(self):
        output = self.root / "candidate"
        output.mkdir()
        with self.assertRaises(FileExistsError):
            assemble(output, self.source_root)

    def test_refuses_symlinked_source_payload(self):
        source = self.source_dir / PAYLOADS[0]
        source.unlink()
        source.symlink_to(self.source_dir / PAYLOADS[1])
        with self.assertRaises(ValueError):
            assemble(self.root / "candidate", self.source_root)


if __name__ == "__main__":
    unittest.main()
