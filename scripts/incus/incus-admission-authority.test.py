"""Actual local file/bundle tests; no live host or network access."""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def load(name):
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

AUTHORITY = load("incus-admission-authority.py")
BUNDLE_TEST = load("stage-release-bundle.test.py")

class AdmissionAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".incus-authority-test-", dir=ROOT)
        self.root = Path(self.temporary.name)
        fixture = BUNDLE_TEST.ReleaseBundleTests()
        fixture.release_fixture(self.root)
        shutil.copyfile(Path(__file__).with_name("stage-release-bundle.py"), self.root / "scripts/incus/stage-release-bundle.py")
        fixture.seal_fixture(self.root)
        self.service = self.root.parent / (self.root.name + "-service.json")
        self.service.write_text(json.dumps({"appCommand": ["fixed"], "appUid": 1000,
            "terminalClaimHandoffPath": "/run/transient", "terminalClaimHandoffRunId": "run", "terminalClaimHandoffSha256": "a" * 64}))
        self.policy = self.root.parent / (self.root.name + "-policy")
        self.policy.write_text("protected-policy")
        self.config = {"bundleRoot": str(self.root), "serviceFiles": [str(self.service)], "policyFiles": [str(self.policy)]}
        self.command = [str(self.root / "bin/bun"), str(self.root / "web/build/index.js")]
        self.owner = os.geteuid()

    def tearDown(self):
        self.temporary.cleanup()
        self.service.unlink(missing_ok=True)
        self.policy.unlink(missing_ok=True)

    def authority(self):
        return AUTHORITY.AdmissionAuthority(self.config, self.command, self.owner, str(self.service))

    def test_verified_actual_bundle_survives_runtime_files_and_reconstruction(self):
        authority = self.authority()
        before = authority.observe()
        (self.root / ".ezcorp/session").write_text("runtime mutable data")
        self.assertEqual(authority.observe(), before)
        self.assertEqual(self.authority().observe(), before)
        self.assertFalse((self.root / "scripts/incus/__pycache__").exists())

    def test_actual_loaded_source_replacement_cannot_reuse_launch_identity(self):
        authority = self.authority()
        (self.root / "web/build/index.js").write_text("changed security source")
        with self.assertRaisesRegex(ValueError, "loaded app closure changed"):
            authority.observe()
        with self.assertRaisesRegex(ValueError, "release file inventory changed"):
            self.authority()

    def test_service_controls_drift_and_only_exact_terminal_fields_are_transient(self):
        authority = self.authority()
        before = authority.observe()
        config = json.loads(self.service.read_text())
        for key in ("terminalClaimHandoffPath", "terminalClaimHandoffRunId", "terminalClaimHandoffSha256"):
            config.pop(key)
        self.service.write_text(json.dumps(config))
        self.assertEqual(authority.observe(), before)
        for key in ("appCommand", "appUid", "appGid", "authorityCommand", "receiptAuthorityCommand", "key", "socket"):
            changed = {**config, key: "changed"}
            self.service.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError, "loaded service changed"):
                authority.observe()
        self.service.write_text(json.dumps(config))
        self.policy.write_text("changed-policy")
        self.assertNotEqual(authority.observe()["hostPolicyDigest"], before["hostPolicyDigest"])

    def test_missing_or_mutable_authority_and_wrong_launch_command_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "managed app command differs"):
            AUTHORITY.AdmissionAuthority(self.config, ["unverified-app"], self.owner)
        with self.assertRaisesRegex(ValueError, "configuration incomplete"):
            AUTHORITY.AdmissionAuthority({}, self.command, self.owner)
        with self.assertRaisesRegex(ValueError, "supervisor configuration missing"):
            AUTHORITY.AdmissionAuthority(self.config, self.command, self.owner, "/missing/supervisor.json")
        self.policy.chmod(0o666)
        with self.assertRaisesRegex(ValueError, "protected owner or mode changed"):
            self.authority().observe()
        self.policy.chmod(0o644)
        for paths in ([], [str(self.policy)] * 2, [str(self.policy)] * 33):
            with self.assertRaisesRegex(ValueError, "bounded exact file list"):
                AUTHORITY.file_digest(paths, self.owner)
        with self.assertRaisesRegex(ValueError, "absolute path required"):
            AUTHORITY.protected_path("relative", self.owner)
        self.policy.unlink()
        with self.assertRaises(FileNotFoundError):
            self.authority().observe()

if __name__ == "__main__":
    unittest.main()
