#!/usr/bin/env python3
"""Disposable checks for sealed candidate preparation; values are fake."""

import base64
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).with_name("prepare-qualification-settings.py")
SPEC = importlib.util.spec_from_file_location("prepare_qualification_settings", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def fixture(root, pid=1, start=1):
    return {
        "sourcePid": pid, "sourceStartTicks": start,
        "sourceBootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "oldUid": os.getuid(),
        "newUid": 62040, "runnerUid": 62041,
        "sourceDb": str(root / "old-db"),
        "sourceProjectRoot": str(root / "old-projects"),
        "targetDb": str(root / "new-db"),
        "targetProjectRoot": str(root / "new-projects"),
        "stageDir": str(root / "stage"),
        "holdReceipt": str(root / "hold.json"),
        "port": 4301, "origin": "http://127.0.0.1:4301",
        "publicUrl": "http://127.0.0.1:4301",
        "runnerSocket": "/run/ezharness-qual-runner/runner.sock",
        "runnerTokenRuntime": "/run/ezharness-qual-runner/token",
        "runnerStore": "/var/lib/ezharness-qual-runner/store",
        "supervisorSocket": "/run/ezharness-incus-control/control.sock",
        "controlProbeRoot": "/var/lib/ezharness-qual-control",
        "qualificationProjectId": "fixture-project",
        "composeFixtureImageRef": "example.invalid/image@sha256:" + "a" * 64,
        "setupSshMode": "reviewed-envelope-v1",
        "setupSshTarget": "setup@fixture.invalid",
        "setupSshIdentityFile": "/etc/ezharness/incus-setup-identity",
        "setupSshKnownHostsFile": "/etc/ezharness/incus-setup-known-hosts",
        "setupSshHostKeySha256": "SHA256:" + "a" * 43,
        "setupEndpoint": "https://fixture.invalid:8443",
        "setupRecipeFile": "/opt/ezharness/scripts/incus/recipe.json",
        "supervisorPublicKeyFile": str(root / "supervisor-public.pem"),
    }


def fake_public_key():
    der = bytes.fromhex("302a300506032b6570032100") + b"a" * 32
    return (b"-----BEGIN PUBLIC KEY-----\n" + base64.b64encode(der)
            + b"\n-----END PUBLIC KEY-----\n")


def old_environment(value):
    return {
        "EZCORP_ENCRYPTION_SECRET": "fake-secret-" + "a" * 32,
        "EZCORP_ENCRYPTION_SALT": "fake-salt-" + "b" * 32,
        "EZCORP_JWT_SECRET": "fake-jwt-" + "c" * 32,
        "EZCORP_DB_PATH": value["sourceDb"],
        "EZCORP_PROJECT_ROOT": value["sourceProjectRoot"],
        "EZCORP_PORT": str(value["port"]),
        "ORIGIN": value["origin"],
        "EZCORP_PUBLIC_URL": value["publicUrl"],
        "EZCORP_EXTENSION_RUNNER_SOCKET": "/tmp/old-runner.sock",
        "EZCORP_EXTENSION_RUNNER_TOKEN_FILE": "/tmp/old-runner-token",
        "EZCORP_INCUS_SETUP_SSH_TARGET": "old@fixture.invalid",
        "EZCORP_INCUS_SETUP_SSH_IDENTITY_FILE": "/tmp/old-key",
        "EZCORP_INCUS_SETUP_SSH_KNOWN_HOSTS_FILE": "/tmp/old-known",
        "EZCORP_INCUS_SETUP_SSH_HOST_KEY_SHA256": "SHA256:" + "b" * 43,
        "EZCORP_INCUS_SETUP_ENDPOINT": "https://fixture.invalid:8443",
        "EZCORP_INCUS_SETUP_RECIPE_FILE": "/tmp/old-recipe",
    }


class QualificationSettingsTests(unittest.TestCase):
    def test_real_process_capture_and_private_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage = root / "stage"
            stage.mkdir()
            (root / "supervisor-public.pem").write_bytes(fake_public_key())
            initial = fixture(root)
            child = subprocess.Popen(
                [shutil.which("sleep") or "sleep", "20"],
                env={**old_environment(initial), "PATH": "/usr/bin"})
            try:
                start = MODULE.process_start_ticks(
                    (Path("/proc") / str(child.pid) / "stat").read_bytes())
                value = fixture(root, child.pid, start)
                with self.assertRaises(ValueError):
                    MODULE.read_old_process({**value, "sourceStartTicks": start + 1})
                hold = {
                    "sourcePid": child.pid, "sourceStartTicks": start,
                    "sourceBootId": value["sourceBootId"],
                    "sourceDb": value["sourceDb"], "trafficHeld": True,
                }
                (root / "hold.json").write_text(json.dumps(hold))
                with patch.object(MODULE, "private_stage", return_value=stage), \
                        patch.object(MODULE, "private_file", side_effect=lambda path: Path(path)), \
                        patch.object(MODULE.os, "geteuid", return_value=0):
                    with patch("builtins.print"):
                        MODULE.prepare(value)
                    for name in MODULE.FILES:
                        self.assertEqual((stage / name).stat().st_mode & 0o777, 0o600)
                    app = MODULE.parse_env_file((stage / MODULE.FILES[1]).read_bytes())
                    old = MODULE.parse_env_file((stage / MODULE.FILES[0]).read_bytes())
                    runner = MODULE.parse_env_file((stage / MODULE.FILES[2]).read_bytes())
                    self.assertTrue(all(app[key] == old[key] for key in MODULE.CRYPTO))
                    self.assertEqual(app["EZCORP_DB_PATH"], value["targetDb"])
                    self.assertEqual(app["EZCORP_PROJECT_ROOT"], value["targetProjectRoot"])
                    self.assertEqual(app["HOST"], "127.0.0.1")
                    self.assertEqual(app["PORT"], str(value["port"]))
                    self.assertEqual(base64.b64decode(
                        app["EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64"], validate=True),
                        fake_public_key())
                    self.assertEqual(runner["EZ_EXTENSION_APP_UID"], "62040")
                    self.assertNotIn("DATABASE_URL", app)
                    with patch("builtins.print"):
                        MODULE.check(value)
                        MODULE.check_live_source(value)
                    with patch.object(MODULE, "read_old_process",
                                      return_value={**old_environment(value),
                                                    "EZCORP_JWT_SECRET": "changed-fake-jwt"}):
                        with self.assertRaises(ValueError):
                            MODULE.check_live_source(value)
                    child.terminate()
                    child.wait(timeout=5)
                    with patch("builtins.print"):
                        MODULE.check(value)
                    with self.assertRaises(FileNotFoundError):
                        MODULE.check_live_source(value)
                    with self.assertRaises(ValueError):
                        MODULE.prepare(value)
                    (stage / MODULE.FILES[1]).write_bytes(
                        (stage / MODULE.FILES[1]).read_bytes() + b"EZCORP_DB_PATH=/wrong\n")
                    with self.assertRaises(ValueError):
                        MODULE.check(value)
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=5)

    def test_rejects_extra_keys_database_url_and_duplicate_values(self):
        with tempfile.TemporaryDirectory() as directory:
            value = fixture(Path(directory))
            old = old_environment(value)
            raw = b"\0".join(f"{key}={val}".encode() for key, val in old.items()) + b"\0"
            self.assertEqual(MODULE.parse_environ(raw), old)
            for suffix in (b"DATABASE_URL=postgres://fake\0",
                           b"EZCORP_UNKNOWN=fake\0",
                           b"EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY=fake\0",
                           b"EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64=fake\0",
                           b"EZCORP_DB_PATH=other\0"):
                with self.assertRaises(ValueError):
                    MODULE.parse_environ(raw + suffix)

    def test_rejects_secret_expansion_and_changed_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value = fixture(root)
            old = old_environment(value)
            with self.assertRaises(ValueError):
                MODULE.candidates({**old, "EZCORP_JWT_SECRET": "$(cmd)"}, value,
                                  b"token\n", fake_public_key())
            result = MODULE.candidates(old, value, b"a" * 64 + b"\n", fake_public_key())
            app = MODULE.parse_env_file(result[MODULE.FILES[1]])
            self.assertEqual(app["EZCORP_EXTENSION_RUNNER_SOCKET"], value["runnerSocket"])
            self.assertEqual(app["EZCORP_EXTENSION_RUNNER_TOKEN_FILE"],
                             value["runnerTokenRuntime"])
            self.assertEqual(app["EZCORP_INCUS_SUPERVISOR_SOCKET"],
                             value["supervisorSocket"])
            self.assertEqual(app["HOST"], "127.0.0.1")
            self.assertEqual(app["PORT"], "4301")

    def test_rejects_non_ed25519_or_changed_public_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "public.pem"
            with patch.object(MODULE, "private_file", return_value=path):
                path.write_bytes(fake_public_key())
                self.assertEqual(MODULE.reviewed_public_key(path), fake_public_key())
                path.write_bytes(b"-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n")
                with self.assertRaises(ValueError):
                    MODULE.reviewed_public_key(path)

    def test_missing_hold_and_mutable_stage_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            value = fixture(root)
            with self.assertRaises((FileNotFoundError, ValueError)):
                MODULE.hold_receipt(value)
            (root / "stage").mkdir(mode=0o777)
            with self.assertRaises(ValueError):
                MODULE.private_stage(root / "stage")

    def test_manifest_rejects_extra_keys_and_unreviewed_ssh(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "manifest.json"
            value = fixture(root)
            with patch.object(MODULE, "private_file", return_value=path):
                path.write_text(json.dumps({**value, "DATABASE_URL": "postgres://fake"}))
                with self.assertRaises(ValueError):
                    MODULE.manifest(path)
                path.write_text(json.dumps({**value, "setupSshMode": "legacy-command-v1"}))
                with self.assertRaises(ValueError):
                    MODULE.manifest(path)


if __name__ == "__main__":
    unittest.main()
