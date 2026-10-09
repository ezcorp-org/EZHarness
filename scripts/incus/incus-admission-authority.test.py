"""Local file/bundle tests; requires Linux user namespaces and subordinate IDs."""
import importlib.util
import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
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

    def test_fresh_snapshot_preserves_all_paths_metadata_and_deadline(self):
        authority = self.authority()
        expected = {str(path.relative_to(self.root)): AUTHORITY.signature(path.lstat())
                    for path in authority.verifier.immutable_paths(self.root)}
        with mock.patch.object(Path, "lstat", wraps=None) as direct_stat:
            direct_stat.side_effect = AssertionError("duplicate per-path lstat")
            # scandir supplies every child status; only the root requires Path.lstat.
            direct_stat.side_effect = lambda: self.root.stat(follow_symlinks=False)
            self.assertEqual(authority.snapshot(), expected)
            self.assertEqual(direct_stat.call_count, 1)
        self.assertEqual(authority.snapshot(time.monotonic()+10), expected)
        with self.assertRaises(TimeoutError):
            authority.observe(time.monotonic())
        with mock.patch.object(AUTHORITY, "file_digest", side_effect=lambda *_args: "x"), \
                mock.patch.object(AUTHORITY.time, "monotonic", side_effect=[1, *([1]*len(expected)), 12]):
            authority.launch_service_digest = "x"
            with self.assertRaises(TimeoutError):
                authority.observe(11)

    def test_fresh_snapshot_rejects_membership_type_root_and_same_size_content_drift(self):
        mutations = [lambda: (self.root / "added").write_text("new"),
                     lambda: (self.root / "web/build/index.js").unlink(),
                     lambda: self.root.chmod(0o700),
                     lambda: (self.root / "web/build/index.js").write_bytes(b"x" * (self.root / "web/build/index.js").stat().st_size),
                     lambda: self.replace_directory_with_link()]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                authority = self.authority()
                mutate()
                with self.assertRaisesRegex(ValueError, "loaded app closure changed"):
                    authority.observe()
                self.tearDown()
                self.setUp()

    def test_snapshot_bounds_enumeration_even_with_duplicate_paths(self):
        authority = self.authority()
        status = self.root.lstat()
        with mock.patch.object(authority.verifier, "immutable_entries", return_value=iter([(self.root, status)]*2)):
            with self.assertRaisesRegex(ValueError, "enumeration repeated a path"):
                authority.snapshot()
        entries = ((self.root / str(index), status) for index in range(120001))
        with mock.patch.object(authority.verifier, "immutable_entries", return_value=entries):
            with self.assertRaisesRegex(ValueError, "closure too large"):
                authority.snapshot()

    def replace_directory_with_link(self):
        directory = self.root / "web/build"
        directory.rename(self.root / "moved-build")
        directory.symlink_to(self.root / "moved-build", target_is_directory=True)

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
        for source in (None, 1):
            with self.assertRaisesRegex(ValueError, "explicit runtime source required"):
                AUTHORITY.AdmissionAuthority({**self.config, "runtimeSource": source},
                                             self.command, self.owner)
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


class MountedRuntimeTests(unittest.TestCase):
    def test_real_mount_and_supervisor_child_startup(self):
        result = subprocess.run(["unshare", "--user", "--map-root-user", "--map-auto",
                                 "--mount", sys.executable, str(Path(__file__).resolve()),
                                 "--mounted-runtime-worker"],
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0,
            "Linux unshare, newuidmap/newgidmap and subordinate UID/GID ranges are required.\n"
            + result.stdout + result.stderr)
        self.assertIn("mounted supervisor startup and negative cases passed", result.stdout)


def mounted_runtime_worker():
    """Use a private root and real mounts; no host service or root privilege."""
    supervisor_module = load("incus-qualification-supervisor.py")
    interpreter = str(Path(sys.executable).resolve())
    scripts = {name: Path(__file__).with_name(name).read_bytes() for name in
               ("stage-release-bundle.py", "incus-admission-authority.py",
                "incus-qualification-supervisor.py")}
    libc = ctypes.CDLL(None, use_errno=True)
    def mount(source, target, recursive=False):
        flags = 4096 | (16384 if recursive else 0)  # MS_BIND | MS_REC
        if libc.mount(os.fsencode(source), os.fsencode(target), None, flags, None) != 0:
            raise OSError(ctypes.get_errno(), f"bind mount failed: {source} -> {target}")
    def unmount(target, recursive=False):
        if libc.umount2(os.fsencode(target), 2 if recursive else 0) != 0:
            raise OSError(ctypes.get_errno(), f"unmount failed: {target}")
    case = unittest.TestCase()
    with tempfile.TemporaryDirectory(prefix=".incus-mounted-authority-", dir=ROOT) as temporary:
        jail = Path(temporary)
        jail.chmod(0o755)
        runtime_mounts = []
        for name in ("proc", "nix/store", "usr", "bin", "lib", "lib64"):
            host_path = Path("/" + name)
            if not host_path.exists():
                continue
            destination = jail / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            if host_path.is_symlink():
                destination.symlink_to(os.readlink(host_path))
            else:
                destination.mkdir()
                mount(host_path, destination, recursive=True)
                runtime_mounts.append(destination)
        previous_root = os.open("/", os.O_RDONLY)
        child = None
        bound = False
        try:
            os.chroot(jail)
            os.chdir("/")
            root = Path("/bundle")
            root.mkdir()
            fixture = BUNDLE_TEST.ReleaseBundleTests()
            fixture.release_fixture(root)
            for name, payload in scripts.items():
                (root / "scripts/incus" / name).write_bytes(payload)
            (root / "bin/bun").write_text(
                f"#!{interpreter}\nimport os,sys\nos.execv(sys.executable,[sys.executable,sys.argv[1]])\n")
            (root / "bin/bun").chmod(0o755)
            (root / "web/build/index.js").write_text(
                "import json,os,time\nfrom pathlib import Path\n"
                "Path('/bundle/.ezcorp/ready').write_text(json.dumps([os.getuid(),os.getgid()]))\n"
                "time.sleep(60)\n")
            fixture.seal_fixture(root)
            for name in ("etc", "config", "run", "data"):
                Path("/" + name).mkdir()
            Path("/etc/passwd").write_text("root:x:0:0::/:/bin/sh\napp:x:62040:62040::/data:/bin/sh\n")
            Path("/etc/group").write_text("root:x:0:\napp:x:62040:\n")
            Path("/etc/nsswitch.conf").write_text("passwd: files\ngroup: files\n")
            Path("/config/key").write_text("test private signing key")
            Path("/config/key").chmod(0o600)
            Path("/config/service").write_text("protected service")
            Path("/config/policy").write_text("protected policy")
            os.chown("/data", 0, 62040)
            Path("/data").chmod(0o730)
            source = Path("/data/runtime")
            source.mkdir(mode=0o700)
            os.chown(source, 62040, 62040)
            target = root / ".ezcorp"
            config = {"bundleRoot": str(root), "serviceFiles": ["/config/service"],
                      "policyFiles": ["/config/policy"], "runtimeSource": str(source)}
            command = [str(root / "bin/bun"), str(root / "web/build/index.js")]
            supervisor_module.__file__ = str(root / "scripts/incus/incus-qualification-supervisor.py")
            supervisor = supervisor_module.Supervisor("/run/control.sock", command,
                62040, 62040, "/config/key", ["unused"], ["unused"])
            supervisor.admission_authority_config = config
            def rejected(pattern):
                with case.assertRaisesRegex(ValueError, pattern):
                    supervisor.start_child()
                case.assertIsNone(supervisor.child)
                case.assertFalse((source / "ready").exists())

            BUNDLE_TEST.MODULE.verify(root)  # Strict staging remains valid before binding.
            rejected("unsafe bound runtime directory")  # No mount must fail before child creation.
            mount(source, target)
            bound = True
            with case.assertRaisesRegex(ValueError, "mode 0755"):
                BUNDLE_TEST.MODULE.verify(root)
            supervisor.admission_authority_config = {key: value for key, value in config.items()
                                                      if key != "runtimeSource"}
            rejected("mode 0755")
            supervisor.admission_authority_config = config
            source.chmod(0o755)
            rejected("unsafe bound runtime directory")
            source.chmod(0o700)
            os.chown(source, 0, 62040)
            rejected("unsafe bound runtime directory")
            os.chown(source, 62040, 0)
            rejected("unsafe bound runtime directory")
            os.chown(source, 62040, 62040)
            Path("/data").chmod(0o770)
            rejected("unsafe bound runtime directory")
            Path("/data").chmod(0o730)
            os.chown("/data", 62040, 62040)
            rejected("unsafe bound runtime directory")
            os.chown("/data", 0, 62040)
            for invalid in ("", "relative", "/data//runtime", "/data/../data/runtime", "/bundle/.ezcorp"):
                supervisor.admission_authority_config = {**config, "runtimeSource": invalid}
                rejected("explicit bound runtime|canonical and outside release")
            supervisor.admission_authority_config = config
            for uid, gid in ((None, 62040), (0, 62040), (62040, None), (62040, 0)):
                with case.assertRaisesRegex(ValueError, "explicit bound runtime"):
                    AUTHORITY.AdmissionAuthority(config, command, app_uid=uid, app_gid=gid)
            Path("/data/alias").symlink_to(source)
            supervisor.admission_authority_config = {**config, "runtimeSource": "/data/alias"}
            rejected("canonical and outside release")
            supervisor.admission_authority_config = config
            Path("/insecure/data").mkdir(parents=True)
            os.chown("/insecure/data", 0, 62040)
            Path("/insecure/data").chmod(0o730)
            Path("/insecure/data/runtime").mkdir(mode=0o700)
            Path("/insecure").chmod(0o777)
            supervisor.admission_authority_config = {**config, "runtimeSource": "/insecure/data/runtime"}
            rejected("unsafe bound runtime ancestor")
            supervisor.admission_authority_config = config
            wrong_source = Path("/data/other")
            wrong_source.mkdir(mode=0o700)
            os.chown(wrong_source, 62040, 62040)
            unmount(target)
            mount(wrong_source, target)
            rejected("configured runtime bind mount is missing or changed")
            unmount(target)
            bound = False
            target.rmdir()
            target.symlink_to(source)
            rejected("unsafe bound runtime directory")
            target.unlink()
            target.mkdir(mode=0o700)
            target.chmod(0o700)
            os.chown(target, 62040, 62040)
            rejected("configured runtime bind mount is missing or changed")
            os.chown(target, 0, 0)
            target.chmod(0o755)
            escaped_mount = Path("/mount space\ttab\nline\\slash")
            escaped_mount.mkdir()
            mount(source, escaped_mount)
            case.assertTrue(BUNDLE_TEST.MODULE.is_exact_mountpoint(escaped_mount))
            unmount(escaped_mount)
            case.assertFalse(BUNDLE_TEST.MODULE.is_exact_mountpoint(escaped_mount))
            mount(source, target)
            bound = True
            supervisor.start_child()  # Actual consumer, privilege drop, and child process.
            child = supervisor.child
            deadline = time.monotonic() + 5
            while not (source / "ready").exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            case.assertIsNone(child.poll())
            case.assertEqual(json.loads((source / "ready").read_text()), [62040, 62040])
            authority = supervisor.admission_authority
            before = authority.observe()
            (source / "session").write_text("private mutable state")
            case.assertEqual(authority.observe(), before)
            source.chmod(0o755)
            with case.assertRaisesRegex(ValueError, "unsafe bound runtime directory"):
                authority.observe()
            source.chmod(0o700)
            unmount(target)
            mount(wrong_source, target)
            with case.assertRaisesRegex(ValueError, "configured runtime bind mount is missing or changed"):
                authority.observe()
            unmount(target)
            source.rename("/data/original-runtime")
            wrong_source.rename(source)
            mount(source, target)
            with case.assertRaisesRegex(ValueError, "runtime binding changed; restart required"):
                authority.observe()
            print("mounted supervisor startup and negative cases passed")
        finally:
            if child is not None:
                child.terminate()
                child.wait(timeout=5)
            if bound:
                unmount("/bundle/.ezcorp")
            os.fchdir(previous_root)
            os.chroot(".")
            os.close(previous_root)
            for destination in reversed(runtime_mounts):
                unmount(destination, recursive=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["--mounted-runtime-worker"]:
        mounted_runtime_worker()
    else:
        unittest.main()
