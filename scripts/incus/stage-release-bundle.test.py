"""Focused release inventory and staging boundary tests."""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("stage-release-bundle.py")
SPEC = importlib.util.spec_from_file_location("release_bundle", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleaseBundleTests(unittest.TestCase):
    def test_inventory_rejects_a_link_outside_release(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory) / "release"
            root.mkdir()
            (root / "outside").symlink_to("/etc/passwd")
            with self.assertRaisesRegex(ValueError, "escapes release"):
                MODULE.inventory(root)

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


if __name__ == "__main__":
    unittest.main()
