import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone


source = pathlib.Path(__file__).with_name("ssh-gate.py")
spec = importlib.util.spec_from_file_location("incus_ssh_gate", source)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ReviewedCommandGateTest(unittest.TestCase):
    def setUp(self):
        issued = datetime.now(timezone.utc)
        self.policy = {"version": 1, "planDigest": "a" * 64,
                       "issuedAt": issued.isoformat().replace("+00:00", "Z"),
                       "writeExpiresAt": (issued + timedelta(minutes=15)).isoformat().replace("+00:00", "Z"),
                       "commands": [
            {"argv": ["incus", "query", "/1.0/projects/ezharness"]},
            {"argv": ["incus", "project", "create", "ezharness", "--config", "restricted=true"], "write": True},
        ]}
        gate.validate_policy(self.policy)

    def allow(self, argv, original="ezh-incus-operator-v1", now=None, **extra):
        return gate.authorize(self.policy, original, {"version": 1, "argv": argv, **extra}, now=now)

    def test_exact_reviewed_read_and_write(self):
        self.assertEqual(self.allow(["incus", "query", "/1.0/projects/ezharness"])[0][0], "incus")
        self.assertEqual(self.allow(["incus", "project", "create", "ezharness", "--config", "restricted=true"], planDigest="a" * 64)[0][1], "project")

    def test_policy_digest_blocks_old_policy_before_shared_write(self):
        shared_write = ["incus", "project", "create", "ezharness", "--config", "restricted=true"]
        with self.assertRaisesRegex(gate.Denied, "does not match reviewed plan digest"):
            self.allow(shared_write, planDigest="b" * 64)
        with self.assertRaisesRegex(gate.Denied, "required for server writes"):
            self.allow(shared_write)
        with self.assertRaisesRegex(gate.Denied, "does not match reviewed plan digest"):
            self.allow(["incus", "query", "/1.0/projects/ezharness"], planDigest="b" * 64)

    def test_shell_scp_and_wrong_original_command_are_denied(self):
        for command in ("sh", "bash -c id", "scp -t /tmp/x", "", "ezh-incus-operator-v1;id"):
            with self.subTest(command=command), self.assertRaises(gate.Denied):
                self.allow(["incus", "query", "/1.0/projects/ezharness"], command)
        for argv in (["sh", "-c", "id"], ["scp", "-t", "/tmp/x"], ["incus", "exec", "guest", "--", "sh"]):
            with self.subTest(argv=argv), self.assertRaises(gate.Denied):
                self.allow(argv)

    def test_cross_project_flags_and_privileged_settings_are_denied(self):
        commands = [
            ["incus", "query", "/1.0/projects/other"],
            ["incus", "project", "create", "other", "--config", "restricted=true"],
            ["incus", "project", "create", "ezharness", "--config", "restricted=false"],
            ["incus", "project", "create", "ezharness", "--config", "restricted=true", "--project=other"],
            ["incus", "profile", "set", "ezharness", "security.privileged=true", "--project", "ezharness"],
            ["incus", "config", "trust", "add-certificate", "-", "--name", "admin"],
        ]
        for argv in commands:
            with self.subTest(argv=argv), self.assertRaises(gate.Denied):
                self.allow(argv)

    def test_input_is_bound_to_approved_digest(self):
        import hashlib
        certificate = "approved certificate\n"
        self.policy["commands"].append({"argv": ["incus", "config", "trust", "add-certificate", "-", "--name", "engine", "--projects", "ezharness", "--restricted"],
                                        "stdinSha256": hashlib.sha256(certificate.encode()).hexdigest(), "write": True})
        argv = self.policy["commands"][-1]["argv"]
        self.assertEqual(self.allow(argv, stdin=certificate, planDigest="a" * 64)[1], certificate.encode())
        with self.assertRaises(gate.Denied):
            self.allow(argv, stdin="different certificate", planDigest="a" * 64)
        with self.assertRaises(gate.Denied):
            self.allow(argv)

    def test_expired_policy_denies_trust_add_but_keeps_reads(self):
        import hashlib
        certificate = "approved certificate\n"
        trust = {"argv": ["incus", "config", "trust", "add-certificate", "-", "--name", "engine", "--projects", "ezharness", "--restricted"],
                 "stdinSha256": hashlib.sha256(certificate.encode()).hexdigest(), "write": True}
        self.policy["commands"].append(trust)
        expired = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.policy["issuedAt"] = (expired - timedelta(minutes=15)).isoformat().replace("+00:00", "Z")
        self.policy["writeExpiresAt"] = expired.isoformat().replace("+00:00", "Z")
        gate.validate_policy(self.policy)
        with self.assertRaisesRegex(gate.Denied, "expired"):
            self.allow(trust["argv"], stdin=certificate, planDigest="a" * 64)
        self.assertEqual(self.allow(["incus", "query", "/1.0/projects/ezharness"])[0][0], "incus")
        readonly = {"version": 1, "planDigest": "c" * 64,
                    "commands": [{"argv": ["incus", "query", "/1.0/projects/ezharness"]}]}
        gate.validate_policy(readonly)
        with self.assertRaises(gate.Denied):
            gate.authorize(readonly, gate.ORIGINAL_COMMAND,
                           {"version": 1, "argv": trust["argv"], "stdin": certificate, "planDigest": "c" * 64})

    def test_policy_cannot_extend_write_window(self):
        issued = datetime.fromisoformat(self.policy["issuedAt"].replace("Z", "+00:00"))
        self.policy["writeExpiresAt"] = (issued + timedelta(minutes=21)).isoformat().replace("+00:00", "Z")
        with self.assertRaisesRegex(gate.Denied, "lifetime exceeds"):
            gate.validate_policy(self.policy)

    def test_unclassified_writes_cannot_hide_in_read_only_policy(self):
        for argv in (
            ["incus", "config", "set", "core.https_address=0.0.0.0:8443"],
            ["incus", "config", "trust", "add-certificate", "-", "--name", "admin"],
            ["incus", "project", "create", "other"],
            ["incus", "profile", "set", "compose", "security.privileged=true", "--project", "ezharness"],
            ["cat", "/etc/shadow"],
            ["incus", "query", "/1.0/projects/ezharness", "-X", "DELETE"],
            ["incus", "profile", "get", "compose", "limits.cpu", "--project"],
        ):
            with self.subTest(argv=argv):
                unclassified = {"version": 1, "planDigest": "b" * 64, "commands": [{"argv": argv}]}
                with self.assertRaisesRegex(gate.Denied, "cannot be classified as read-only"):
                    gate.validate_policy(unclassified)
                with self.assertRaisesRegex(gate.Denied, "cannot be classified as read-only"):
                    gate.authorize(unclassified, gate.ORIGINAL_COMMAND, {"version": 1, "argv": argv})

    def test_policy_cannot_authorize_shell_or_unbounded_arguments(self):
        self.policy["commands"].append({"argv": ["sh", "-c", "id"]})
        with self.assertRaises(gate.Denied):
            gate.validate_policy(self.policy)
        self.policy["commands"].pop()
        self.policy["commands"].append({"argv": ["incus", "query", "/1.0\n"]})
        with self.assertRaises(gate.Denied):
            gate.validate_policy(self.policy)

    def test_policy_file_rejects_symlinks_and_non_root_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = pathlib.Path(directory) / "policy.json"
            policy.write_text('{"version":1}')
            link = pathlib.Path(directory) / "linked.json"
            link.symlink_to(policy)
            with self.assertRaises(OSError):
                gate.read_policy(link)
            if os.geteuid() != 0:
                with self.assertRaises(gate.Denied):
                    gate.read_policy(policy)


class NoEffectObservationGateTest(unittest.TestCase):
    def setUp(self):
        self.policy = {"version": 2, "purpose": "noeffect-readback", "project": "ezharness",
                       "instance": "ezh-expected", "oldCertificateSha256": "a" * 64}

    def observe(self, instances=None, operations=None, certificates=None, policy=None, raw=b"",
                original=gate.OBSERVE_COMMAND, operation_output=None):
        outputs = [instances if instances is not None else [],
                   operations if operations is not None else [],
                   certificates if certificates is not None else []]
        calls = []

        def execute(argv, input_bytes, timeout=gate.TIMEOUT):
            calls.append(argv)
            if len(calls) == 2 and operation_output is not None:
                return 0, operation_output, b""
            return 0, __import__("json").dumps(outputs[len(calls) - 1]).encode(), b""

        with patch.object(gate, "execute", side_effect=execute):
            result = gate.observe_noeffect(policy or self.policy, original, raw)
        self.assertEqual(calls, [
            ["incus", "list", "--project=ezharness", "--format=json"],
            ["incus", "operation", "list", "--project=ezharness", "--format=json"],
            ["incus", "config", "trust", "list", "--format=json"],
        ])
        return result

    def test_exact_absence_empty_operations_and_revoked_old_certificate(self):
        result = self.observe(instances=[{"name": "other"}], operations=[],
                              certificates=[{"fingerprint": "b" * 64}])
        self.assertTrue(result["absent"] and result["oldCertificateRevoked"])

    def test_present_instance_active_operation_or_trusted_old_certificate_denied(self):
        for values in ({"instances": [{"name": "ezh-expected"}]},
                       {"operations": [{"id": "123", "status": "Running"}]},
                       {"certificates": [{"fingerprint": "a" * 64}]}):
            with self.subTest(values=values), self.assertRaises(gate.Denied):
                self.observe(**values)

    def test_write_policy_request_command_and_malformed_inventory_denied(self):
        write_policy = {"version": 1, "planDigest": "b" * 64,
                        "commands": [{"argv": ["incus", "project", "create", "other"], "write": True}]}
        for kwargs in ({"policy": write_policy}, {"raw": b'{}'}, {"original": gate.ORIGINAL_COMMAND},
                       {"operations": {"running": []}}, {"operations": ["bad"]},
                       {"operation_output": b""}, {"certificates": [{}]},
                       {"instances": [{"unexpected": True}]}):
            with self.subTest(kwargs=kwargs), self.assertRaises(gate.Denied):
                self.observe(**kwargs)


class ExecuteEnvironmentTest(unittest.TestCase):
    def test_read_only_incus_call_uses_private_config_and_removes_it(self):
        argv = ["incus", "query", "/1.0/projects/ezharness"]
        self.assertTrue(gate.is_read_only_argv(argv))
        real_popen = subprocess.Popen
        observed = {}

        def launch(_argv, **kwargs):
            env = kwargs["env"]
            config = pathlib.Path(env["INCUS_CONF"])
            observed["config"] = config
            self.assertTrue(config.is_dir())
            self.assertEqual(config.stat().st_mode & 0o777, 0o700)
            self.assertEqual(config.parent, pathlib.Path("/tmp"))
            self.assertEqual(env["HOME"], "/var/empty")
            self.assertEqual(set(env), {"PATH", "HOME", "LC_ALL", "INCUS_CONF"})
            return real_popen([sys.executable, "-c",
                "import os, pathlib; pathlib.Path(os.environ['INCUS_CONF'], 'client').write_text('ok'); print('[]')"],
                **kwargs)

        with patch.object(gate.subprocess, "Popen", side_effect=launch):
            code, stdout, stderr = gate.execute(argv, b"", timeout=5)
        self.assertEqual((code, stdout, stderr), (0, b"[]\n", b""))
        self.assertFalse(observed["config"].exists())

    def test_incus_config_is_removed_if_process_cannot_start(self):
        observed = {}

        def fail(_argv, **kwargs):
            observed["config"] = pathlib.Path(kwargs["env"]["INCUS_CONF"])
            self.assertTrue(observed["config"].is_dir())
            raise OSError("cannot start")

        with patch.object(gate.subprocess, "Popen", side_effect=fail):
            with self.assertRaisesRegex(OSError, "cannot start"):
                gate.execute(["incus", "version"], b"")
        self.assertFalse(observed["config"].exists())

    def test_non_incus_call_has_no_client_config(self):
        def fail(_argv, **kwargs):
            self.assertNotIn("INCUS_CONF", kwargs["env"])
            raise OSError("cannot start")

        with patch.object(gate.subprocess, "Popen", side_effect=fail):
            with self.assertRaisesRegex(OSError, "cannot start"):
                gate.execute(["uname", "-m"], b"")


if __name__ == "__main__":
    unittest.main()
