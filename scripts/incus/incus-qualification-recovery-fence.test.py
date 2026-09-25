import importlib.util
import os
import pathlib
import stat
import subprocess
import tempfile
import time
import types
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).with_name("incus-qualification-recovery-fence.py")
SPEC = importlib.util.spec_from_file_location("recovery_fence", SCRIPT)
FENCE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FENCE)

TARGET = {"scope": {"installationId": "installation", "releaseId": "release",
                    "connectionId": "connection", "presetId": "incus-compose-v1"},
          "fixtureOperationId": "fixture", "bindingId": "binding",
          "operationId": "create", "generation": 1, "connectionRevision": 1}


def config():
    return {"target": TARGET, "appUid": 62040, "runnerUid": 62041,
            "runnerUnit": "ezharness-qual-runner.service",
            "observerConfig": "/etc/ezharness/noeffect.json",
            "project": "ezharness", "instance": FENCE.resource_name(TARGET),
            "oldCertificateSha256": "a" * 64}


def message():
    return {"request": {**TARGET, "action": "recover-noeffect", "allClientsFenced": True,
                        "fenceEvidence": "reviewed exact client hold",
                        "deadlineMs": int(time.time() * 1000) + 60000},
            "oldProcess": {"pid": 123, "startTicks": "456"}}


class RecoveryFenceTest(unittest.TestCase):
    def test_private_config_rejects_symlink_or_writable_parent_before_open(self):
        path = "/etc/ezharness/noeffect-fence.json"
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFDIR | 0o777):
            with self.subTest(mode=mode), \
                 mock.patch.object(FENCE.Path, "lstat", autospec=True, side_effect=lambda parent:
                     types.SimpleNamespace(st_mode=mode if str(parent) == "/etc/ezharness"
                                           else stat.S_IFDIR | 0o755, st_uid=0)), \
                 mock.patch.object(FENCE.os, "open") as opened:
                with self.assertRaisesRegex(ValueError, "private file parent is mutable"):
                    FENCE.private_root_file(path)
                opened.assert_not_called()

    def test_observer_must_pin_exact_instance_and_old_certificate(self):
        expected = {"observation": {"instance": FENCE.resource_name(TARGET),
                                    "project": "ezharness", "oldCertificateSha256": "a" * 64}}
        with mock.patch.dict(os.environ, EZCORP_INCUS_NOEFFECT_CONFIG=config()["observerConfig"]), \
             mock.patch.object(FENCE, "private_root_file", side_effect=[config(), expected]):
            self.assertEqual(FENCE.load_config("/etc/ezharness/fence.json"), config())
        for changed in ({"instance": "ezh-other"}, {"oldCertificateSha256": "b" * 64}):
            observer = {"observation": {**expected["observation"], **changed}}
            with mock.patch.dict(os.environ, EZCORP_INCUS_NOEFFECT_CONFIG=config()["observerConfig"]), \
                 mock.patch.object(FENCE, "private_root_file", side_effect=[config(), observer]):
                with self.assertRaisesRegex(ValueError, "observer does not pin"):
                    FENCE.load_config("/etc/ezharness/fence.json")

    def test_exact_create_required_before_local_probe(self):
        request = message()
        request["request"]["bindingId"] = "other"
        with mock.patch.object(FENCE, "app_and_runner_absent") as local:
            with self.assertRaisesRegex(ValueError, "saved CREATE target"):
                FENCE.verify(config(), request)
            local.assert_not_called()

    def test_old_process_group_and_both_dedicated_uids_block(self):
        old = message()["oldProcess"]
        for process in ((123, 500, 900, "456"), (999, 500, 123, "999"),
                        (999, 62040, 900, "999"), (999, 62041, 900, "999")):
            with self.subTest(process=process), self.assertRaisesRegex(ValueError, "client remains"):
                FENCE.app_and_runner_absent(config(), old, [process])
        FENCE.app_and_runner_absent(config(), old, [(999, 1001, 900, "999")])

    def test_runner_must_be_stopped_and_have_empty_cgroup(self):
        base = b"LoadState=masked\nActiveState=inactive\nSubState=dead\nMainPID=0\n"
        unit = config()["runnerUnit"]
        with tempfile.TemporaryDirectory() as temporary:
            cgroup = pathlib.Path(temporary) / "system.slice" / unit
            cgroup.mkdir(parents=True)
            (cgroup / "cgroup.procs").write_text("")
            good = subprocess.CompletedProcess([], 0, base +
                f"ControlGroup=/system.slice/{unit}\nUnitFileState=masked-runtime\n".encode() +
                b"DropInPaths=\nNeedDaemonReload=no\n")
            with mock.patch.object(FENCE.subprocess, "run", return_value=good):
                FENCE.runner_unit_quiesced(unit, pathlib.Path(temporary))
                (cgroup / "cgroup.procs").write_text("100\n")
                with self.assertRaisesRegex(ValueError, "still has clients"):
                    FENCE.runner_unit_quiesced(unit, pathlib.Path(temporary))
            active = subprocess.CompletedProcess([], 0, base.replace(b"ActiveState=inactive", b"ActiveState=active") +
                b"ControlGroup=\nUnitFileState=masked-runtime\nDropInPaths=\nNeedDaemonReload=no\n")
            with mock.patch.object(FENCE.subprocess, "run", return_value=active):
                with self.assertRaisesRegex(ValueError, "not stopped"):
                    FENCE.runner_unit_quiesced(unit, pathlib.Path(temporary))

    def test_runtime_assertion_must_be_loaded_exact_and_block_start(self):
        unit = config()["runnerUnit"]
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            gate = root / (unit + ".d") / "hold.conf"
            gate.parent.mkdir()
            gate.write_bytes(FENCE.RUNTIME_ASSERT_CONTENT)
            allow = root / "allow-start"
            state = {"DropInPaths": str(gate), "NeedDaemonReload": "no"}
            original_fstat = os.fstat
            original_lstat = pathlib.Path.lstat

            def root_file(fd):
                entry = original_fstat(fd)
                return types.SimpleNamespace(st_mode=entry.st_mode, st_uid=0,
                                             st_size=entry.st_size)

            def root_parent(path):
                entry = original_lstat(path)
                if path == allow:
                    return entry
                return types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)

            with mock.patch.object(FENCE.os, "fstat", side_effect=root_file), \
                 mock.patch.object(FENCE.Path, "lstat", autospec=True,
                                   side_effect=root_parent):
                FENCE.runtime_assert_gate(unit, state, root, allow)
                allow.write_text("")
                with self.assertRaisesRegex(ValueError, "start permission path exists"):
                    FENCE.runtime_assert_gate(unit, state, root, allow)
                allow.unlink()
                for changed in ({"DropInPaths": str(gate) + " /run/override.conf"},
                                {"NeedDaemonReload": "yes"}):
                    with self.subTest(changed=changed), \
                         self.assertRaisesRegex(ValueError, "not the loaded"):
                        FENCE.runtime_assert_gate(unit, {**state, **changed}, root, allow)
                gate.write_text("[Unit]\nAssertPathExists=/wrong\n")
                with self.assertRaisesRegex(ValueError, "differs from reviewed"):
                    FENCE.runtime_assert_gate(unit, state, root, allow)
            gate.write_bytes(FENCE.RUNTIME_ASSERT_CONTENT)
            with mock.patch.object(FENCE.Path, "lstat", autospec=True,
                                   side_effect=root_parent):
                with self.assertRaisesRegex(ValueError, "differs from reviewed"):
                    FENCE.runtime_assert_gate(unit, state, root, allow)

            def mutable_parent(path):
                if path == gate.parent:
                    return types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o777, st_uid=0)
                return root_parent(path)

            with mock.patch.object(FENCE.Path, "lstat", autospec=True,
                                   side_effect=mutable_parent):
                with self.assertRaisesRegex(ValueError, "parent is mutable"):
                    FENCE.runtime_assert_gate(unit, state, root, allow)
            gate.unlink()
            gate.symlink_to(root / "other.conf")
            with mock.patch.object(FENCE.Path, "lstat", autospec=True,
                                   side_effect=root_parent):
                with self.assertRaises(OSError):
                    FENCE.runtime_assert_gate(unit, state, root, allow)

    def test_loaded_runner_requires_exact_runtime_assertion(self):
        unit = config()["runnerUnit"]
        base = (b"LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n"
                b"ControlGroup=\nUnitFileState=enabled-runtime\n"
                b"DropInPaths=/run/systemd/system/ezharness-qual-runner.service.d/hold.conf\n"
                b"NeedDaemonReload=no\n")
        result = subprocess.CompletedProcess([], 0, base)
        with tempfile.TemporaryDirectory() as temporary, \
             mock.patch.object(FENCE.subprocess, "run", return_value=result), \
             mock.patch.object(FENCE, "runtime_assert_gate") as assertion:
            FENCE.runner_unit_quiesced(unit, pathlib.Path(temporary))
            assertion.assert_called_once()
            assertion.reset_mock()
            stale = subprocess.CompletedProcess([], 0, base.replace(
                b"NeedDaemonReload=no", b"NeedDaemonReload=yes"))
            with mock.patch.object(FENCE.subprocess, "run", return_value=stale):
                # The integration call must delegate validation; a stale unit is rejected there.
                assertion.side_effect = ValueError("runner assertion is not the loaded unit configuration")
                with self.assertRaisesRegex(ValueError, "not the loaded"):
                    FENCE.runner_unit_quiesced(unit, pathlib.Path(temporary))

    def test_positive_local_fence_returns_only_supervisor_contract(self):
        with mock.patch.object(FENCE, "app_and_runner_absent"), \
             mock.patch.object(FENCE, "runner_unit_quiesced"):
            self.assertEqual(FENCE.verify(config(), message()),
                             {"fenced": True, "evidence": "reviewed exact client hold"})


if __name__ == "__main__":
    unittest.main()
