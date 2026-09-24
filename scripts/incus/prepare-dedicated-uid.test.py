import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import tempfile
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).with_name("prepare-dedicated-uid.py")
SPEC = importlib.util.spec_from_file_location("prepare_dedicated_uid", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DedicatedUidStageTest(unittest.TestCase):
    def test_stage_copies_twice_and_retains_quarantined_source(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            source, quarantine, target, rollback = (base / "source", base / "quarantine",
                                                   base / "target" / "db", base / "backup" / "db")
            source.mkdir()
            target.parent.mkdir()
            rollback.parent.mkdir()
            (source / "pg_wal").mkdir()
            (source / "pg_wal" / "0001").write_bytes(b"saved transaction")
            value = {"oldUid": os.getuid(), "oldGid": os.getgid(),
                     "newUid": 62040, "newGid": 62040}
            with mock.patch.object(MODULE, "check", return_value=(source, quarantine, target, rollback)), \
                 mock.patch.object(MODULE, "no_open_database_files"), \
                 mock.patch.object(MODULE, "chown_tree"), \
                 mock.patch.object(MODULE.os, "chown"):
                receipt = MODULE.stage(value)
            self.assertFalse(source.exists())
            self.assertEqual((quarantine / "pg_wal" / "0001").read_bytes(), b"saved transaction")
            self.assertEqual((target / "pg_wal" / "0001").read_bytes(), b"saved transaction")
            self.assertEqual((rollback / "pg_wal" / "0001").read_bytes(), b"saved transaction")
            self.assertEqual(MODULE.tree_digest(quarantine), MODULE.tree_digest(target))
            self.assertEqual(json.loads(receipt.read_text())["sha256"], MODULE.tree_digest(quarantine))
            self.assertEqual(stat.S_IMODE(quarantine.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)

    def test_stage_keeps_source_quarantined_after_late_client(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            source = base / "source"
            quarantine = base / "quarantine"
            source.mkdir()
            with mock.patch.object(MODULE, "check", return_value=(source, quarantine, base / "target",
                                                                    base / "backup")), \
                 mock.patch.object(MODULE, "no_open_database_files",
                                   side_effect=ValueError("late client")), \
                 mock.patch.object(MODULE.os, "chown"):
                with self.assertRaisesRegex(ValueError, "late client"):
                    MODULE.stage({"oldUid": 1001, "oldGid": 100})
            self.assertFalse(source.exists())
            self.assertEqual(stat.S_IMODE(quarantine.stat().st_mode), 0o700)
            self.assertFalse((base / "target").exists())

    def test_source_tree_rejects_symlink_and_wrong_owner(self):
        with tempfile.TemporaryDirectory() as temp:
            source = pathlib.Path(temp) / "source"
            source.mkdir()
            (source / "link").symlink_to("/etc/passwd")
            with self.assertRaisesRegex(ValueError, "unexpected owner or file type"):
                MODULE.owned_tree(source, os.getuid(), os.getgid())
            (source / "link").unlink()
            with self.assertRaisesRegex(ValueError, "unexpected owner or file type"):
                MODULE.owned_tree(source, 62040, 62040)

    def test_active_unit_rejected(self):
        responses = [subprocess.CompletedProcess([], 0, stdout="loaded\n"),
                     subprocess.CompletedProcess([], 0, stdout="active\n")]
        with mock.patch.object(MODULE.subprocess, "run", side_effect=responses):
            with self.assertRaisesRegex(ValueError, "must be inactive"):
                MODULE.inactive("app.service")

    def test_dedicated_uid_cannot_traverse_private_dev_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            private = pathlib.Path(temp) / "private"
            private.mkdir(mode=0o700)
            built = private / "index.js"
            built.write_text("export {}")
            with self.assertRaisesRegex(ValueError, "cannot access"):
                MODULE.accessible_to(built, 62040, 62040, read_file=True)

    def test_shared_uid_source_parent_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            source = pathlib.Path(temp) / "db"
            source.mkdir()
            with self.assertRaisesRegex(ValueError, "source parent must be root-owned"):
                MODULE.sealed_source_parent(source)


if __name__ == "__main__":
    unittest.main()
