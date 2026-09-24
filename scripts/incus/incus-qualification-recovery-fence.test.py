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

    def test_runner_must_be_masked_stopped_and_have_empty_cgroup(self):
        base = b"LoadState=masked\nActiveState=inactive\nSubState=dead\nMainPID=0\n"
        unit = config()["runnerUnit"]
        with tempfile.TemporaryDirectory() as temporary:
            cgroup = pathlib.Path(temporary) / "system.slice" / unit
            cgroup.mkdir(parents=True)
            (cgroup / "cgroup.procs").write_text("")
            good = subprocess.CompletedProcess([], 0, base +
                f"ControlGroup=/system.slice/{unit}\nUnitFileState=masked-runtime\n".encode())
            with mock.patch.object(FENCE.subprocess, "run", return_value=good):
                FENCE.runner_unit_quiesced(unit, pathlib.Path(temporary))
                (cgroup / "cgroup.procs").write_text("100\n")
                with self.assertRaisesRegex(ValueError, "still has clients"):
                    FENCE.runner_unit_quiesced(unit, pathlib.Path(temporary))
            unmasked = subprocess.CompletedProcess([], 0, base.replace(b"LoadState=masked", b"LoadState=loaded") +
                b"ControlGroup=\nUnitFileState=enabled\n")
            with mock.patch.object(FENCE.subprocess, "run", return_value=unmasked):
                with self.assertRaisesRegex(ValueError, "not masked and stopped"):
                    FENCE.runner_unit_quiesced(unit, pathlib.Path(temporary))

    def test_positive_local_fence_returns_only_supervisor_contract(self):
        with mock.patch.object(FENCE, "app_and_runner_absent"), \
             mock.patch.object(FENCE, "runner_unit_quiesced"):
            self.assertEqual(FENCE.verify(config(), message()),
                             {"fenced": True, "evidence": "reviewed exact client hold"})


if __name__ == "__main__":
    unittest.main()
