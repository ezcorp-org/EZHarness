import importlib.util
import os
import pathlib
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
