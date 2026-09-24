"""Focused release inventory and staging boundary tests."""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("stage-release-bundle.py")
SPEC = importlib.util.spec_from_file_location("release_bundle", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleaseBundleTests(unittest.TestCase):
    def release_fixture(self, root):
        for relative in MODULE.REQUIRED:
            path = root / relative
            if relative.startswith(("node_modules/", "web/node_modules/")):
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"reviewed release file")
        (root / "bin").mkdir(exist_ok=True)
        (root / "bin/bun").write_bytes(b"pinned bun")
        (root / "bun.lock").write_bytes(b"root lock")
        (root / "web/bun.lock").write_bytes(b"web lock")

    def seal_fixture(self, root):
        manifest = {"schema": 1, "gitSha": "a" * 40, "bunVersion": "1.3.14",
                    "bunSha256": MODULE.sha256(root / "bin/bun"),
                    "locks": {name: MODULE.sha256(root / name)
                              for name in ("bun.lock", "web/bun.lock")},
                    "files": MODULE.inventory(root)}
        (root / MODULE.MANIFEST).write_text(json.dumps(manifest))

    def test_verify_excludes_only_top_level_runtime_directory(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.release_fixture(root)
            self.seal_fixture(root)
            MODULE.verify(root)
            (root / ".ezcorp/cache").mkdir(parents=True)
            os.chmod(root / ".ezcorp", 0o700)
            (root / ".ezcorp/cache/session.json").write_text('{"runtime":true}')
            MODULE.verify(root)
            (root / "web/.ezcorp").mkdir()
            (root / "web/.ezcorp/session.json").write_text('{"runtime":true}')
            with self.assertRaisesRegex(ValueError, "release file inventory changed"):
                MODULE.verify(root)
            (root / "web/.ezcorp/session.json").unlink()
            (root / "web/.ezcorp").rmdir()
            (root / "web/build/index.js").write_bytes(b"changed code")
            with self.assertRaisesRegex(ValueError, "release file inventory changed"):
                MODULE.verify(root)

    def test_verify_rejects_top_level_runtime_symlink_even_inside_release(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.release_fixture(root)
            (root / "runtime").mkdir()
            self.seal_fixture(root)
            (root / ".ezcorp").symlink_to("runtime")
            with self.assertRaisesRegex(ValueError, "runtime directory must not be a symlink"):
                MODULE.verify(root)

    def test_archive_rejects_tracked_runtime_directory(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            source = Path(directory) / "source"
            source.mkdir()
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            (source / ".ezcorp").mkdir()
            (source / ".ezcorp/state").write_text("tracked runtime data")
            subprocess.run(["git", "-C", str(source), "add", ".ezcorp/state"], check=True)
            subprocess.run(["git", "-C", str(source), "-c", "user.name=Test",
                            "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
            target = Path(directory) / "target"
            target.mkdir()
            with self.assertRaisesRegex(ValueError, "tracked reserved runtime path"):
                MODULE.extract_head(source, target)
            self.assertEqual(list(target.iterdir()), [])

    def test_inventory_rejects_a_link_outside_release(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory) / "release"
            root.mkdir()
            (root / "outside").symlink_to("/etc/passwd")
            with self.assertRaisesRegex(ValueError, "escapes release"):
                MODULE.inventory(root)

    def test_inventory_accepts_an_internal_dependency_directory_link(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory) / "release"
            (root / "packages/example").mkdir(parents=True)
            (root / "node_modules").mkdir()
            (root / "node_modules/example").symlink_to("../packages/example")
            entries = MODULE.inventory(root)
            self.assertIn({"path": "node_modules/example", "mode": 0o777,
                           "type": "link", "target": "../packages/example"}, entries)

    def test_inventory_has_stable_order_hashes_modes_and_links(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory) / "release"
            root.mkdir()
            (root / "b").write_bytes(b"b")
            (root / "a").write_bytes(b"a")
            os.chmod(root / "a", 0o644)
            (root / "link").symlink_to("a")
            entries = MODULE.inventory(root)
            self.assertEqual([item["path"] for item in entries], ["a", "b", "link"])
            self.assertEqual(entries[0]["sha256"], MODULE.sha256(root / "a"))
            self.assertEqual(entries[0]["mode"], 0o644)
            self.assertEqual(entries[2], {"path": "link", "mode": 0o777,
                                          "type": "link", "target": "a"})

    def test_verify_rejects_tampering_and_missing_runtime_closure(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            (root / "bin").mkdir()
            (root / "bin/bun").write_bytes(b"bun")
            (root / "bun.lock").write_bytes(b"root")
            (root / "web").mkdir()
            (root / "web/bun.lock").write_bytes(b"web")
            manifest = {"schema": 1, "gitSha": "a" * 40, "bunVersion": "1.3.14",
                        "bunSha256": MODULE.sha256(root / "bin/bun"),
                        "locks": {name: MODULE.sha256(root / name)
                                  for name in ("bun.lock", "web/bun.lock")},
                        "files": MODULE.inventory(root)}
            (root / MODULE.MANIFEST).write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "required release file"):
                MODULE.verify(root)
            (root / "bin/bun").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "Bun digest changed"):
                MODULE.verify(root)

    def test_stage_rejects_live_destination_before_running_build(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            source = Path(directory)
            bun = source / "bun"
            bun.write_bytes(b"fake")
            with self.assertRaisesRegex(ValueError, "must be under /tmp or /var/tmp"):
                MODULE.stage(source, Path("/opt/ezh-bundle-test-invalid-destination"), bun,
                             MODULE.sha256(bun))


if __name__ == "__main__":
    unittest.main()
