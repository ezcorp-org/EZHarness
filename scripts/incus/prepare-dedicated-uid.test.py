import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import types
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
                 mock.patch.object(MODULE, "no_old_clients"), \
                 mock.patch.object(MODULE, "no_dedicated_clients"), \
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
                 mock.patch.object(MODULE, "no_old_clients"), \
                 mock.patch.object(MODULE, "no_dedicated_clients"), \
                 mock.patch.object(MODULE, "no_open_database_files",
                                   side_effect=ValueError("late client")), \
                 mock.patch.object(MODULE.os, "chown"):
                with self.assertRaisesRegex(ValueError, "late client"):
                    MODULE.stage({"oldUid": 1001, "oldGid": 100})
            self.assertFalse(source.exists())
            self.assertEqual(stat.S_IMODE(quarantine.stat().st_mode), 0o700)
            self.assertFalse((base / "target").exists())

    def test_stage_rechecks_dedicated_runner_after_atomic_rename(self):
        with tempfile.TemporaryDirectory() as temp:
            base = pathlib.Path(temp)
            source = base / "source"
            quarantine = base / "quarantine"
            source.mkdir()
            with mock.patch.object(MODULE, "check", return_value=(source, quarantine, base / "target",
                                                                    base / "backup")), \
                 mock.patch.object(MODULE, "no_old_clients"), \
                 mock.patch.object(MODULE, "no_dedicated_clients",
                                   side_effect=ValueError("late runner")), \
                 mock.patch.object(MODULE.os, "chown"):
                with self.assertRaisesRegex(ValueError, "late runner"):
                    MODULE.stage({"oldUid": 1001, "oldGid": 100,
                                  "newUid": 62040, "newGid": 62040})
            self.assertFalse(source.exists())
            self.assertTrue(quarantine.exists())
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

    def test_missing_new_unit_rejected(self):
        value = {key: "/reviewed/path" for key in MODULE.FIELDS}
        value.update({"oldUid": 1001, "oldGid": 100, "newUid": 62040,
                      "newGid": 62040, "runnerUid": 62041, "socketGid": 62042,
                      "oldProcessIds": [1234], "runnerProcessIds": [2345],
                      "oldAppUnit": None, "runnerUnit": None,
                      "supervisorUnit": None})
        source = mock.Mock()
        source.read_text.return_value = json.dumps(value)
        with mock.patch.object(MODULE, "private_file", return_value=source):
            with self.assertRaisesRegex(ValueError, "exact reviewed service required"):
                MODULE.config("/reviewed/manifest.json")
            value["runnerUnit"] = "ezharness-qual-runner.service"
            source.read_text.return_value = json.dumps(value)
            with self.assertRaisesRegex(ValueError, "exact reviewed service required"):
                MODULE.config("/reviewed/manifest.json")
            value["supervisorUnit"] = "ezharness-qual-supervisor.service"
            source.read_text.return_value = json.dumps(value)
            self.assertEqual(MODULE.config("/reviewed/manifest.json"), value)

    def test_new_units_must_be_loaded_and_inactive(self):
        not_loaded = subprocess.CompletedProcess([], 0, stdout="not-found\n")
        with mock.patch.object(MODULE.subprocess, "run", return_value=not_loaded):
            with self.assertRaisesRegex(ValueError, "not loaded"):
                MODULE.inactive("ezharness-qual-runner.service")

    def test_dedicated_runner_uid_process_blocks_stage(self):
        process = mock.Mock()
        process.name = "4567"
        proc = mock.Mock()
        proc.iterdir.return_value = [process]
        for uid in (62040, 62041):
            with self.subTest(uid=uid):
                process.stat.return_value = types.SimpleNamespace(st_uid=uid)
                with self.assertRaisesRegex(ValueError, "dedicated app or runner UID"):
                    MODULE.no_dedicated_clients({"newUid": 62040, "runnerUid": 62041}, proc)

    def test_dedicated_uid_cannot_traverse_private_dev_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            private = pathlib.Path(temp) / "private"
            private.mkdir(mode=0o700)
            built = private / "index.js"
            built.write_text("export {}")
            with self.assertRaisesRegex(ValueError, "cannot access"):
                MODULE.accessible_to(built, 62040, {62040, 62042}, read_file=True)

    def test_socket_group_is_static_and_app_supplementary_only(self):
        app = types.SimpleNamespace(pw_uid=62040, pw_gid=62040, pw_name="ezharness-qual")
        runner = types.SimpleNamespace(pw_uid=62041, pw_gid=62041,
                                       pw_name="ezharness-qual-runner")
        value = {"newUid": 62040, "newGid": 62040,
                 "runnerUid": 62041, "socketGid": 62042}
        with mock.patch.object(MODULE.pwd, "getpwuid", side_effect={62040: app,
                                                                    62041: runner}.get), \
             mock.patch.object(MODULE.grp, "getgrgid",
                               side_effect=lambda gid: types.SimpleNamespace(gr_gid=gid)), \
             mock.patch.object(MODULE.os, "getgrouplist",
                               side_effect=lambda name, primary: ([62040, 62042] if name == app.pw_name
                                                                    else [62041, 62042])) as groups:
            self.assertEqual(MODULE.app_groups(value), {62040, 62042})
            self.assertEqual(groups.call_count, 2)
            groups.side_effect = lambda name, primary: [62040] if name == app.pw_name else [62041]
            with self.assertRaisesRegex(ValueError, "not a member"):
                MODULE.app_groups(value)
            groups.side_effect = lambda name, primary: ([62040, 62042] if name == app.pw_name
                                                        else [62040, 62041, 62042])
            with self.assertRaisesRegex(ValueError, "runner can read"):
                MODULE.app_groups(value)

    def test_socket_group_permissions_use_supplementary_gid(self):
        with tempfile.TemporaryDirectory() as temp:
            token = pathlib.Path(temp) / "token"
            pathlib.Path(temp).chmod(0o755)
            token.write_bytes(b"x" * 32)
            actual_lstat = pathlib.Path.lstat

            def socket_gid_stat(path):
                if path == token:
                    return types.SimpleNamespace(st_mode=stat.S_IFREG | 0o640,
                                                 st_uid=62041, st_gid=62042, st_size=32)
                return actual_lstat(path)

            with mock.patch.object(pathlib.Path, "lstat", socket_gid_stat), \
                 mock.patch.object(MODULE, "protected_runner_path"):
                MODULE.runner_token(token, runner_uid=62041,
                                    socket_gid=62042, old_uid=1001)
                MODULE.accessible_to(token, 62040, {62040, 62042}, read_file=True)
                with self.assertRaisesRegex(ValueError, "not private and app-readable"):
                    MODULE.runner_token(token, runner_uid=62041,
                                        socket_gid=62040, old_uid=1001)
                with self.assertRaisesRegex(ValueError, "cannot access"):
                    MODULE.accessible_to(token, 62040, {62040}, read_file=True)

    def test_shared_uid_source_parent_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            source = pathlib.Path(temp) / "db"
            source.mkdir()
            with self.assertRaisesRegex(ValueError, "source parent must be root-owned"):
                MODULE.sealed_source_parent(source)

    def test_reviewed_old_pid_must_be_gone(self):
        with self.assertRaisesRegex(ValueError, "reviewed old process still runs"):
            MODULE.no_old_clients({"oldProcessIds": [os.getpid()],
                                   "runnerProcessIds": [99999999],
                                   "runnerSocket": "/run/old/runner.sock"},
                                  pathlib.Path("/tmp/old-db"))

    def test_kernel_thread_without_environment_does_not_block_old_client_scan(self):
        with tempfile.TemporaryDirectory() as temp:
            proc = pathlib.Path(temp)
            for pid in ("2", "3"):
                (proc / pid).mkdir()
                (proc / pid / "environ").write_bytes(b"")
                (proc / pid / "cmdline").write_bytes(b"")
            original_read = pathlib.Path.read_bytes

            def read_process_file(path):
                if path.parent.name == "2" and path.name == "environ":
                    raise ProcessLookupError("kernel thread has no environment")
                return original_read(path)

            value = {"oldProcessIds": [], "runnerProcessIds": [],
                     "runnerSocket": "/run/old/runner.sock"}
            with mock.patch.object(pathlib.Path, "read_bytes", read_process_file):
                MODULE.no_old_clients(value, proc / "old-db", proc)

    def test_runner_token_rejects_shared_old_uid_owner(self):
        with tempfile.TemporaryDirectory() as temp:
            token = pathlib.Path(temp) / "token"
            token.write_bytes(b"x" * 32)
            token.chmod(0o640)
            with self.assertRaisesRegex(ValueError, "runner token owner"):
                MODULE.runner_token(token, runner_uid=62041,
                                    socket_gid=os.getgid(), old_uid=os.getuid())

    def test_old_uid_owned_runner_parents_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            parent = pathlib.Path(temp) / "runner"
            parent.mkdir(mode=0o750)
            for name in ("token", "runner.sock"):
                with self.assertRaisesRegex(ValueError, "runner path parent is mutable"):
                    MODULE.protected_runner_path(parent / name, runner_uid=62041,
                                                 old_uid=os.getuid())
        MODULE.protected_runner_path(pathlib.Path("/run/reviewed-runner-token"),
                                     runner_uid=62041, old_uid=os.getuid())

    def test_unreadable_process_descriptors_block_stage(self):
        process = mock.MagicMock()
        process.name = "12345"
        directory = mock.MagicMock()
        directory.iterdir.side_effect = PermissionError("denied")
        process.__truediv__.return_value = directory
        proc = mock.MagicMock()
        proc.iterdir.return_value = [process]
        with mock.patch.object(MODULE, "Path", return_value=proc):
            with self.assertRaisesRegex(ValueError, "cannot inspect process"):
                MODULE.no_open_database_files(pathlib.Path("/tmp/old-db"))

    def test_live_parent_directory_handle_blocks_stage(self):
        with tempfile.TemporaryDirectory() as temp:
            parent = pathlib.Path(temp) / "private"
            parent.mkdir()
            source = parent / "db"
            source.mkdir()
            child = subprocess.Popen([sys.executable, "-c",
                                      "import os,sys,time; fd=os.open(sys.argv[1], os.O_RDONLY|os.O_DIRECTORY); "
                                      "print('ready', flush=True); time.sleep(20)", str(parent)],
                                     stdout=subprocess.PIPE, text=True, start_new_session=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), "ready")
                proc = mock.MagicMock()
                proc.iterdir.return_value = [pathlib.Path(f"/proc/{child.pid}")]
                with mock.patch.object(MODULE, "Path", return_value=proc):
                    with self.assertRaisesRegex(ValueError, "still holds the database"):
                        MODULE.no_open_database_files(source)
            finally:
                child.terminate()
                child.wait(timeout=5)
                child.stdout.close()

    def test_recursive_owner_restore_includes_nested_wal(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp) / "pglite"
            wal = root / "pg_wal"
            wal.mkdir(parents=True)
            file = wal / "0001"
            file.write_bytes(b"saved transaction")
            with mock.patch.object(MODULE.os, "chown") as change_owner:
                MODULE.chown_tree(root, 1001, 100)
            changed = {pathlib.Path(call.args[0]) for call in change_owner.call_args_list}
            self.assertEqual(changed, {root, wal, file})


if __name__ == "__main__":
    unittest.main()
