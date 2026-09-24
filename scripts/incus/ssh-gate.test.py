import importlib.util
import os
import pathlib
import tempfile
import unittest


source = pathlib.Path(__file__).with_name("ssh-gate.py")
spec = importlib.util.spec_from_file_location("incus_ssh_gate", source)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ReviewedCommandGateTest(unittest.TestCase):
    def setUp(self):
        self.policy = {"version": 1, "planDigest": "a" * 64, "commands": [
            {"argv": ["incus", "query", "/1.0/projects/ezharness"]},
            {"argv": ["incus", "project", "create", "ezharness", "--config", "restricted=true"]},
        ]}
        gate.validate_policy(self.policy)

    def allow(self, argv, original="ezh-incus-operator-v1", **extra):
        return gate.authorize(self.policy, original, {"version": 1, "argv": argv, **extra})

    def test_exact_reviewed_read_and_write(self):
        self.assertEqual(self.allow(["incus", "query", "/1.0/projects/ezharness"])[0][0], "incus")
        self.assertEqual(self.allow(["incus", "project", "create", "ezharness", "--config", "restricted=true"])[0][1], "project")

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
                                        "stdinSha256": hashlib.sha256(certificate.encode()).hexdigest()})
        argv = self.policy["commands"][-1]["argv"]
        self.assertEqual(self.allow(argv, stdin=certificate)[1], certificate.encode())
        with self.assertRaises(gate.Denied):
            self.allow(argv, stdin="different certificate")
        with self.assertRaises(gate.Denied):
            self.allow(argv)

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
