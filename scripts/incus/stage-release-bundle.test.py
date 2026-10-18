"""Focused release inventory and staging boundary tests."""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tarfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).with_name("stage-release-bundle.py")
SPEC = importlib.util.spec_from_file_location("release_bundle", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleaseBundleTests(unittest.TestCase):
    def source_fixture(self, root, version="1.3.14"):
        root.mkdir()
        (root / MODULE.BUN_VERSION).write_text(version + "\n")

    def extract_version_fixture(self, source, target):
        (target / MODULE.BUN_VERSION).write_bytes((source / MODULE.BUN_VERSION).read_bytes())

    def release_fixture(self, root):
        (root / MODULE.BUN_VERSION).write_text("1.3.14\n")
        for relative in MODULE.REQUIRED:
            path = root / relative
            if relative.startswith(("node_modules/", "web/node_modules/")):
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"reviewed release file")
        contract = root / "packages/@ezcorp/extension-contract/dist"
        contract.mkdir(parents=True)
        (contract / "index.js").write_text("export {};\n")
        (contract / "index.d.ts").write_text("export {};\n")
        (root / "bin").mkdir(exist_ok=True)
        (root / "bin/bun").write_bytes(b"pinned bun")
        (root / "bun.lock").write_bytes(b"root lock")
        (root / "web/bun.lock").write_bytes(b"web lock")
        (root / MODULE.RUNTIME_DIR).mkdir(mode=0o755)

    def seal_fixture(self, root):
        manifest = {"schema": 1, "gitSha": "a" * 40, "bunVersion": MODULE.pinned_bun_version(root),
                    "bunSha256": MODULE.sha256(root / "bin/bun"),
                    "locks": {name: MODULE.sha256(root / name)
                              for name in ("bun.lock", "web/bun.lock")},
                    "files": MODULE.inventory(root)}
        (root / MODULE.MANIFEST).write_text(json.dumps(manifest))

    def committed_source_fixture(self, root, version):
        source = root / "source"
        source.mkdir()
        self.release_fixture(source)
        (source / MODULE.BUN_VERSION).write_text(version + "\n")
        (source / "bin/bun").unlink()
        (source / "bin").rmdir()
        (source / MODULE.RUNTIME_DIR).rmdir()
        subprocess.run(["git", "init", "-q"], cwd=source, check=True, capture_output=True, timeout=5)
        self.commit_fixture(source)
        return source

    def commit_fixture(self, source):
        for argv in (["git", "add", "."], ["git", "-c", "core.hooksPath=/dev/null",
                     "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                     "commit", "-qm", "fixture"]):
            subprocess.run(argv, cwd=source, check=True, capture_output=True, timeout=5)

    def bun_version_fixture(self, root, version):
        bun = root / "pinned-bun"
        bun.write_text(f"#!{sys.executable}\nprint({version!r})\n")
        bun.chmod(0o755)
        return bun

    def dependency_build_fixture(self, argv, *, cwd, env):
        work = Path(argv[0]).parent.parent
        prefix = "web/node_modules/" if cwd == work / "web" else "node_modules/"
        for relative in MODULE.REQUIRED:
            if relative.startswith(prefix):
                (work / relative).mkdir(parents=True, exist_ok=True)

    def test_real_stage_and_file_only_verify_accept_candidate_version(self):
        for version in ("1.3.14", "1.4.2"):
            with self.subTest(version=version), tempfile.TemporaryDirectory(dir="/tmp") as directory:
                root = Path(directory)
                source = self.committed_source_fixture(root, version)
                bun = self.bun_version_fixture(root, version)
                output = root / "release"
                # Only dependency/build commands are controlled. Git archive,
                # executable --version, stage, manifest and verify are real.
                with patch.object(MODULE, "run", side_effect=self.dependency_build_fixture) as build:
                    result = MODULE.stage(source, output, bun, MODULE.sha256(bun))
                self.assertTrue(build.called)
                with patch.object(MODULE.subprocess, "check_output",
                                  side_effect=AssertionError("verify must not execute binaries")):
                    manifest = MODULE.verify(output)
                self.assertEqual(manifest["bunVersion"], version)
                self.assertEqual(result["gitSha"], manifest["gitSha"])
                pin = next(row for row in manifest["files"] if row["path"] == MODULE.BUN_VERSION)
                self.assertEqual(pin["type"], "file")
                self.assertEqual(pin["sha256"], MODULE.sha256(output / MODULE.BUN_VERSION))

    def test_real_stage_materializes_tracked_python_pin_links(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            source = self.committed_source_fixture(root, "1.4.2")
            (source / ".python-version").write_text("3.13.6\n")
            links = [f"src/factory/{name}/python/.python-version"
                     for name in ("reference-image", "runner")]
            for name in links:
                path = source / name
                path.parent.mkdir(parents=True)
                path.symlink_to("../../../../.python-version")
            self.commit_fixture(source)
            bun = self.bun_version_fixture(root, "1.4.2")
            output = root / "release"
            with patch.object(MODULE, "run", side_effect=self.dependency_build_fixture):
                MODULE.stage(source, output, bun, MODULE.sha256(bun))
            manifest = MODULE.verify(output)
            for name in links:
                with self.subTest(path=name):
                    path = output / name
                    self.assertFalse(path.is_symlink())
                    self.assertEqual(path.read_bytes(), (output / ".python-version").read_bytes())
                    self.assertEqual(path.stat().st_mode & 0o777,
                                     (output / ".python-version").stat().st_mode & 0o777)
                    row = next(row for row in manifest["files"] if row["path"] == name)
                    self.assertEqual(row["type"], "file")
                    self.assertEqual(row["sha256"], MODULE.sha256(output / ".python-version"))
            self.assertTrue(all((source / name).is_symlink() for name in links))

    def test_extract_uses_archived_bytes_and_modes_not_checkout_targets(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            source = self.committed_source_fixture(root, "1.4.2")
            pin = source / ".python-version"
            pin.write_bytes(b"committed pin\n")
            pin.chmod(0o640)
            (source / "alias").symlink_to(".python-version")
            self.commit_fixture(source)
            pin.write_bytes(b"uncommitted checkout content\n")
            (source / "alias").unlink()
            (source / "alias").symlink_to("untracked-host-file")
            (source / "untracked-host-file").write_bytes(b"host content\n")
            output = root / "extract"
            output.mkdir()
            MODULE.extract_head(source, output)
            self.assertEqual((output / "alias").read_bytes(), b"committed pin\n")
            self.assertFalse((output / "alias").is_symlink())
            self.assertEqual((output / "alias").stat().st_mode & 0o777,
                             (output / ".python-version").stat().st_mode & 0o777)

    def test_archive_rejects_unsafe_links_and_special_entries_before_extraction(self):
        cases = {
            "absolute": [("alias", tarfile.SYMTYPE, "/pin")],
            "escape": [("alias", tarfile.SYMTYPE, "../pin")],
            "nested escape": [("dir", tarfile.DIRTYPE, ""),
                              ("dir/alias", tarfile.SYMTYPE, "../../pin")],
            "dangling": [("alias", tarfile.SYMTYPE, "missing")],
            "missing traversal": [("alias", tarfile.SYMTYPE, "missing/../pin")],
            "file traversal": [("alias", tarfile.SYMTYPE, "pin/../pin")],
            "trailing slash": [("alias", tarfile.SYMTYPE, "pin/")],
            "trailing dot": [("alias", tarfile.SYMTYPE, "pin/.")],
            "cycle": [("a", tarfile.SYMTYPE, "b"), ("b", tarfile.SYMTYPE, "a")],
            "self cycle": [("alias", tarfile.SYMTYPE, "alias")],
            "chain": [("a", tarfile.SYMTYPE, "b"), ("b", tarfile.SYMTYPE, "pin")],
            "directory link": [("dir", tarfile.DIRTYPE, ""),
                               ("alias", tarfile.SYMTYPE, "dir")],
            "link ancestor": [("dir", tarfile.SYMTYPE, "pin"),
                              ("dir/child", tarfile.REGTYPE, "")],
            "regular ancestor": [("pin/child", tarfile.REGTYPE, "")],
            "Bun pin link": [(MODULE.BUN_VERSION, tarfile.SYMTYPE, "pin")],
            "reserved runtime": [(".ezcorp/alias", tarfile.SYMTYPE, "../pin")],
            "archive traversal": [("../outside", tarfile.REGTYPE, "")],
            "archive absolute": [("/outside", tarfile.REGTYPE, "")],
            "duplicate": [("pin", tarfile.REGTYPE, "")],
            "hard link": [("alias", tarfile.LNKTYPE, "pin")],
            "fifo": [("special", tarfile.FIFOTYPE, "")],
            "character device": [("special", tarfile.CHRTYPE, "")],
            "block device": [("special", tarfile.BLKTYPE, "")],
        }
        for label, entries in cases.items():
            with self.subTest(case=label), tempfile.TemporaryDirectory() as directory:
                buffer = io.BytesIO()
                with tarfile.open(fileobj=buffer, mode="w") as archive:
                    for name, kind, link in [("pin", tarfile.REGTYPE, ""), *entries]:
                        item = tarfile.TarInfo(name)
                        item.type, item.linkname, item.mode = kind, link, 0o644
                        data = b"archived pin\n" if item.isfile() else b""
                        item.size = len(data)
                        archive.addfile(item, io.BytesIO(data))
                target = Path(directory)
                with patch.object(MODULE.subprocess, "check_output", return_value=buffer.getvalue()):
                    with self.assertRaises(ValueError):
                        MODULE.extract_head(target, target)
                self.assertEqual(list(target.iterdir()), [])

    def test_stage_refuses_runtime_and_archive_version_mismatch_before_build(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            source = self.committed_source_fixture(root, "1.4.2")
            bun = self.bun_version_fixture(root, "1.3.14")
            output = root / "release"
            with patch.object(MODULE, "run") as build:
                with self.assertRaisesRegex(ValueError, "Bun 1.4.2 is required"):
                    MODULE.stage(source, output, bun, MODULE.sha256(bun))
                build.assert_not_called()
            bun = self.bun_version_fixture(root, "1.4.2")
            extract = MODULE.extract_head

            def altered_archive(source, target):
                extract(source, target)
                (target / MODULE.BUN_VERSION).write_text("1.3.14\n")

            with patch.object(MODULE, "extract_head", side_effect=altered_archive), \
                 patch.object(MODULE, "run") as build:
                with self.assertRaisesRegex(ValueError, "archived Bun version changed"):
                    MODULE.stage(source, output, bun, MODULE.sha256(bun))
                build.assert_not_called()
            self.assertFalse(output.exists())

    def test_stage_refuses_an_untracked_ignored_version_pin(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            source = self.committed_source_fixture(root, "1.4.2")
            (source / ".gitignore").write_text(MODULE.BUN_VERSION + "\n")
            for argv in (["git", "rm", "--cached", MODULE.BUN_VERSION],
                         ["git", "add", ".gitignore"],
                         ["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture",
                          "-c", "user.email=fixture@example.invalid", "commit", "-qm", "ignore pin"]):
                subprocess.run(argv, cwd=source, check=True, capture_output=True, timeout=5)
            bun = self.bun_version_fixture(root, "1.4.2")
            with patch.object(MODULE, "run") as build:
                with self.assertRaisesRegex(ValueError, "regular .bun-version is required"):
                    MODULE.stage(source, root / "release", bun, MODULE.sha256(bun))
                build.assert_not_called()
            self.assertFalse((root / "release").exists())

    def test_verify_refuses_missing_linked_and_malformed_version_pins(self):
        malformed = (b"", b" 1.4.2\n", b"1.4.2 \n", b"1.4.2\r\n",
                     b"1.4.2\n\n", b"v1.4.2\n", b"1.4\n", b"x" * 33)
        for raw in malformed:
            with self.subTest(raw=raw), tempfile.TemporaryDirectory(dir="/tmp") as directory:
                root = Path(directory)
                self.release_fixture(root)
                self.seal_fixture(root)
                (root / MODULE.BUN_VERSION).write_bytes(raw)
                with self.assertRaisesRegex(ValueError, "invalid .bun-version"):
                    MODULE.verify(root)
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.release_fixture(root)
            self.seal_fixture(root)
            pin = root / MODULE.BUN_VERSION
            pin.unlink()
            with self.assertRaisesRegex(ValueError, "regular .bun-version is required"):
                MODULE.verify(root)
            (root / "linked-pin").write_text("1.3.14\n")
            pin.symlink_to(root / "linked-pin")
            with self.assertRaisesRegex(ValueError, "regular .bun-version is required"):
                MODULE.verify(root)

    def test_verify_refuses_forged_version_metadata_and_omitted_pin_inventory(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.release_fixture(root)
            self.seal_fixture(root)
            manifest_path = root / MODULE.MANIFEST
            document = json.loads(manifest_path.read_text())
            document["bunVersion"] = "1.4.2"
            manifest_path.write_text(json.dumps(document))
            with self.assertRaisesRegex(ValueError, "Bun version changed"):
                MODULE.verify(root)
            (root / MODULE.BUN_VERSION).write_text("1.4.2\n")
            with self.assertRaisesRegex(ValueError, "release file inventory changed"):
                MODULE.verify(root)
            self.seal_fixture(root)
            document = json.loads(manifest_path.read_text())
            document["files"] = [row for row in document["files"] if row["path"] != MODULE.BUN_VERSION]
            manifest_path.write_text(json.dumps(document))
            with self.assertRaisesRegex(ValueError, "release file inventory changed"):
                MODULE.verify(root)

    def smoke_fixture(self, root, leave_file=False):
        self.release_fixture(root)
        executable = root / "bin/bun"
        executable.write_text(f'''#!/usr/bin/env python3
import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import UnixStreamServer

if sys.argv[-1].endswith("extension-runner/src/main.ts"):
    signal.signal(signal.SIGTERM, lambda *_args: sys.exit(0))
    class RunnerHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            expected = "Bearer " + Path(os.environ["EZ_EXTENSION_RUNNER_TOKEN_FILE"]).read_text()
            self.send_response(200 if self.headers.get("Authorization") == expected else 401)
            self.end_headers()
            self.wfile.write(json.dumps({{"id": "bundle-smoke", "state": "unknown", "diagnostics": []}}).encode())
        def log_message(self, *_args):
            pass
    UnixStreamServer(os.environ["EZ_EXTENSION_RUNNER_SOCKET"], RunnerHandler).serve_forever()
    sys.exit(0)

runtime = Path(os.environ["EZCORP_PROJECT_ROOT"]) / ".ezcorp/data"
runtime.mkdir(mode=0o700)
if {leave_file!r}:
    (runtime / "state.txt").write_text("retain me")
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
    def log_message(self, *_args):
        pass
HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
''')
        os.chmod(executable, 0o755)
        self.seal_fixture(root)

    def test_verify_excludes_only_top_level_runtime_directory(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.release_fixture(root)
            self.seal_fixture(root)
            MODULE.verify(root)
            (root / ".ezcorp/cache").mkdir(parents=True)
            (root / ".ezcorp/cache/session.json").write_text('{"runtime":true}')
            MODULE.verify(root)
            (root / "web/.ezcorp").mkdir()
            (root / "web/.ezcorp/session.json").write_text('{"runtime":true}')
            with self.assertRaisesRegex(ValueError, "release file inventory changed"):
                MODULE.verify(root)
            (root / "web/.ezcorp/session.json").unlink()
            (root / "web/.ezcorp").rmdir()
            (root / "web/build/index.js").write_bytes(b"changed code")
            with self.assertRaisesRegex(ValueError, "release file inventory changed"):
                MODULE.verify(root)

    def test_verify_rejects_top_level_runtime_symlink_even_inside_release(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.release_fixture(root)
            (root / "runtime").mkdir()
            self.seal_fixture(root)
            (root / ".ezcorp").rmdir()
            (root / ".ezcorp").symlink_to("runtime")
            with self.assertRaisesRegex(ValueError, "runtime directory must not be a symlink"):
                MODULE.verify(root)

    def test_verify_requires_real_mode_0755_runtime_placeholder(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.release_fixture(root)
            self.seal_fixture(root)
            MODULE.verify(root)
            os.chmod(root / MODULE.RUNTIME_DIR, 0o700)
            with self.assertRaisesRegex(ValueError, "runtime directory must have mode 0755"):
                MODULE.verify(root)
            os.chmod(root / MODULE.RUNTIME_DIR, 0o755)
            (root / MODULE.RUNTIME_DIR).rmdir()
            with self.assertRaisesRegex(ValueError, "runtime directory is absent"):
                MODULE.verify(root)

    def test_smoke_restores_empty_runtime_placeholder_after_real_http_health(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.smoke_fixture(root)
            result = MODULE.smoke(root)
            self.assertEqual(result["healthStatus"], 200)
            self.assertEqual(result["runner"], {"authenticatedInspect": True, "state": "unknown"})
            self.assertEqual(list((root / MODULE.RUNTIME_DIR).iterdir()), [])
            MODULE.verify(root)

    def test_smoke_rejects_worker_startup_failure_before_app_health(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.smoke_fixture(root)
            executable = root / "bin/bun"
            source = executable.read_text().replace(
                'if sys.argv[-1].endswith("extension-runner/src/main.ts"):',
                'if sys.argv[-1].endswith("extension-runner/src/main.ts"):\n    sys.exit("Cannot find module @types/bun/package.json")')
            executable.write_text(source)
            self.seal_fixture(root)
            with self.assertRaisesRegex(ValueError, "runner exited before readiness.*@types/bun"):
                MODULE.smoke(root)
            self.assertFalse((root / ".ezcorp/data").exists())
            MODULE.verify(root)

    def test_smoke_rejects_runner_authentication_failure(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.smoke_fixture(root)
            executable = root / "bin/bun"
            source = executable.read_text().replace(
                'self.send_response(200 if self.headers.get("Authorization") == expected else 401)',
                'self.send_response(401)')
            executable.write_text(source)
            self.seal_fixture(root)
            with self.assertRaisesRegex(ValueError, "runner authenticated inspect failed"):
                MODULE.smoke(root)
            self.assertFalse((root / ".ezcorp/data").exists())
            MODULE.verify(root)

    def test_smoke_rejects_malformed_and_oversize_runner_inspection(self):
        for replacement in ('b"not-json"', 'b"x" * 65537'):
            with self.subTest(replacement=replacement), tempfile.TemporaryDirectory(dir="/tmp") as directory:
                root = Path(directory)
                self.smoke_fixture(root)
                executable = root / "bin/bun"
                source = executable.read_text().replace(
                    'json.dumps({"id": "bundle-smoke", "state": "unknown", "diagnostics": []}).encode()',
                    replacement)
                executable.write_text(source)
                self.seal_fixture(root)
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    MODULE.smoke(root)
                self.assertFalse((root / ".ezcorp/data").exists())
                MODULE.verify(root)

    def test_runner_shutdown_timeout_kills_only_its_owned_process_group(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            with MODULE.socket.socket(MODULE.socket.AF_UNIX, MODULE.socket.SOCK_STREAM) as listener:
                listener.bind(str(root / "runner.sock"))
                listener.listen(1)
                process = Mock(pid=12345, returncode=-MODULE.signal.SIGKILL)
                process.poll.return_value = None
                process.wait.side_effect = [subprocess.TimeoutExpired("runner", 10), -MODULE.signal.SIGKILL]
                connection = Mock()
                connection.getresponse.return_value.status = 200
                connection.getresponse.return_value.read.return_value = b'{"id":"bundle-smoke","state":"unknown","diagnostics":[]}'
                connection.close.side_effect = lambda: connection.sock.close()
                def signal_group(_pid, sig):
                    if sig == 0:
                        raise ProcessLookupError()
                with patch.object(MODULE.subprocess, "Popen", return_value=process), \
                     patch.object(MODULE.http.client, "HTTPConnection", return_value=connection), \
                     patch.object(MODULE.os, "killpg", side_effect=signal_group) as kill:
                    with self.assertRaisesRegex(ValueError, "runner shutdown failed"):
                        MODULE.smoke_runner(root, root, {"PATH": os.environ.get("PATH", "")})
                self.assertEqual(kill.call_args_list, [unittest.mock.call(12345, MODULE.signal.SIGTERM),
                                                       unittest.mock.call(12345, MODULE.signal.SIGKILL),
                                                       unittest.mock.call(12345, 0)])
                self.assertEqual(process.wait.call_args_list, [unittest.mock.call(timeout=10), unittest.mock.call(timeout=5)])

    def test_runner_leader_success_with_leftover_descendants_refuses(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            with MODULE.socket.socket(MODULE.socket.AF_UNIX, MODULE.socket.SOCK_STREAM) as listener:
                listener.bind(str(root / "runner.sock"))
                listener.listen(1)
                process = Mock(pid=23456, returncode=0)
                process.poll.return_value = 0
                connection = Mock()
                connection.getresponse.return_value.status = 200
                connection.getresponse.return_value.read.return_value = b'{"id":"bundle-smoke","state":"unknown","diagnostics":[]}'
                connection.close.side_effect = lambda: connection.sock.close()
                with patch.object(MODULE.subprocess, "Popen", return_value=process), \
                     patch.object(MODULE.http.client, "HTTPConnection", return_value=connection), \
                     patch.object(MODULE.os, "killpg") as kill:
                    with self.assertRaisesRegex(ValueError, "left descendant processes"):
                        MODULE.smoke_runner(root, root, {"PATH": os.environ.get("PATH", "")})
                self.assertEqual(kill.call_args_list, [unittest.mock.call(23456, 0),
                                                       unittest.mock.call(23456, MODULE.signal.SIGKILL)])

    def test_smoke_rejects_runtime_files_without_deleting_them(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.smoke_fixture(root, leave_file=True)
            with self.assertRaisesRegex(ValueError, "runtime placeholder must be empty"):
                MODULE.smoke(root)
            self.assertEqual((root / ".ezcorp/data/state.txt").read_text(), "retain me")
            MODULE.verify(root)  # Deployed runtime state remains outside the immutable inventory.

    def test_smoke_rejects_preexisting_runtime_state_before_starting_app(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.smoke_fixture(root)
            (root / ".ezcorp/data").mkdir(mode=0o700)
            MODULE.verify(root)
            with patch.object(MODULE.subprocess, "Popen") as start:
                with self.assertRaisesRegex(ValueError, "runtime placeholder must be empty"):
                    MODULE.smoke(root)
                start.assert_not_called()
            self.assertTrue((root / ".ezcorp/data").is_dir())

    def test_stage_creates_empty_runtime_placeholder_outside_inventory(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            source = Path(directory) / "source"
            self.source_fixture(source)
            bun = source / "bun"
            bun.write_bytes(b"fake bun")
            output = Path(directory) / "release"

            def fake_run(_argv, *, cwd, env):
                if cwd.name == "release" and not (cwd / "bun.lock").exists():
                    self.release_fixture(cwd)
                    (cwd / "bin/bun").write_bytes(bun.read_bytes())
                    (cwd / MODULE.RUNTIME_DIR).rmdir()
                if _argv[1:3] == ["install", "--production"]:
                    self.dependency_build_fixture(_argv, cwd=cwd, env=env)

            with patch.object(MODULE, "git_head", return_value="a" * 40), \
                 patch.object(MODULE, "extract_head", side_effect=self.extract_version_fixture), \
                 patch.object(MODULE, "run", side_effect=fake_run), \
                 patch.object(MODULE.subprocess, "check_output", return_value="1.3.14\n"):
                MODULE.stage(source, output, bun, MODULE.sha256(bun))
            placeholder = output / MODULE.RUNTIME_DIR
            self.assertTrue(placeholder.is_dir())
            self.assertEqual(placeholder.stat().st_mode & 0o777, 0o755)
            self.assertEqual(list(placeholder.iterdir()), [])
            self.assertFalse(any(item["path"].startswith(".ezcorp/")
                                 for item in MODULE.verify(output)["files"]))

    def test_stage_builds_all_workspace_exports_before_web(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            source = Path(directory) / "source"
            self.source_fixture(source)
            bun = source / "bun"
            bun.write_bytes(b"fake bun")
            output = Path(directory) / "release"
            commands = []
            repository = SCRIPT.parents[2]
            transport = Path("packages/@ezcorp/factory-transport")
            transport_manifest = json.loads((repository / transport / "package.json").read_text())
            transport_import = transport / transport_manifest["exports"]["."]["import"]
            self.assertIn('import("@ezcorp/factory-transport")',
                          (repository / "src/factory/installation-startup.ts").read_text())

            def fake_run(argv, *, cwd, env):
                commands.append((tuple(argv[1:]), cwd))
                if cwd.name == "release" and not (cwd / "bun.lock").exists():
                    self.release_fixture(cwd)
                    (cwd / "bin/bun").write_bytes(bun.read_bytes())
                    (cwd / MODULE.RUNTIME_DIR).rmdir()
                    contract = cwd / "packages/@ezcorp/extension-contract/dist"
                    if contract.exists():
                        for path in contract.iterdir():
                            path.unlink()
                if argv[1:] == ["run", "build:packages"]:
                    contract = cwd / "packages/@ezcorp/extension-contract/dist"
                    contract.mkdir(parents=True, exist_ok=True)
                    (contract / "index.js").write_text("export {};\n")
                    (contract / "index.d.ts").write_text("export {};\n")
                    (cwd / transport_import).parent.mkdir(parents=True, exist_ok=True)
                    (cwd / transport_import).write_text("export {};\n")
                if argv[1:3] == ["install", "--production"]:
                    self.dependency_build_fixture(argv, cwd=cwd, env=env)
                if argv[1:] == ["run", "--cwd", "web", "build"]:
                    self.assertTrue((cwd / transport_import).is_file(),
                                    "clean web build cannot resolve factory-transport import export")

            with patch.object(MODULE, "git_head", return_value="a" * 40), \
                 patch.object(MODULE, "extract_head", side_effect=self.extract_version_fixture), \
                 patch.object(MODULE, "run", side_effect=fake_run), \
                 patch.object(MODULE.subprocess, "check_output", return_value="1.3.14\n"):
                MODULE.stage(source, output, bun, MODULE.sha256(bun))
            build_commands = [parts for parts, _cwd in commands if parts and parts[0] == "run"]
            self.assertEqual(build_commands.count(("run", "build:packages")), 1)
            self.assertLess(build_commands.index(("run", "build:packages")),
                            build_commands.index(("run", "build:sandbox-tools")))
            self.assertLess(build_commands.index(("run", "build:packages")),
                            build_commands.index(("run", "--cwd", "web", "build")))
            manifest = MODULE.verify(output)
            files = {entry["path"] for entry in manifest["files"]}
            self.assertIn("packages/@ezcorp/extension-contract/dist/index.d.ts", files)
            self.assertIn(transport_import.as_posix(), files)

    def test_stage_recreates_production_dependency_trees_after_build(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            source = Path(directory) / "source"
            self.source_fixture(source)
            bun = source / "bun"
            bun.write_bytes(b"fake bun")
            output = Path(directory) / "release"
            commands = []
            production_had_old_tree = []

            def fake_run(argv, *, cwd, env):
                parts = tuple(argv[1:])
                commands.append((parts, cwd.name))
                if cwd.name == "release" and not (cwd / "bun.lock").exists():
                    self.release_fixture(cwd)
                    (cwd / "bin/bun").write_bytes(bun.read_bytes())
                    (cwd / MODULE.RUNTIME_DIR).rmdir()
                    workspace = cwd / "packages/@ezcorp/factory-transport"
                    for dependency_root in (cwd, cwd / "web", workspace):
                        modules = dependency_root / "node_modules"
                        compiler = modules / "typescript/bin/tsserver"
                        compiler.parent.mkdir(parents=True)
                        compiler.write_bytes(b"development compiler")
                        (modules / ".bin").mkdir()
                        (modules / ".bin/tsserver").symlink_to("../typescript/bin/tsserver")
                        runtime = modules / "runtime-package/index.js"
                        runtime.parent.mkdir()
                        runtime.write_bytes(b"runtime dependency")
                if parts[:2] == ("install", "--production"):
                    modules = cwd / "node_modules"
                    production_had_old_tree.append(os.path.lexists(modules))
                    self.dependency_build_fixture(argv, cwd=cwd, env=env)
                    # Reproduce the observed install boundary. Keeping the old
                    # tree loses a compiler target but retains its stale bin.
                    shutil.rmtree(modules / "typescript", ignore_errors=True)
                    runtime = modules / "runtime-package/index.js"
                    runtime.parent.mkdir(parents=True, exist_ok=True)
                    runtime.write_bytes(b"runtime dependency")

            with patch.object(MODULE, "git_head", return_value="a" * 40), \
                 patch.object(MODULE, "extract_head", side_effect=self.extract_version_fixture), \
                 patch.object(MODULE, "run", side_effect=fake_run), \
                 patch.object(MODULE.subprocess, "check_output", return_value="1.3.14\n"):
                MODULE.stage(source, output, bun, MODULE.sha256(bun))
            production_positions = [index for index, (parts, _cwd) in enumerate(commands)
                                    if parts[:2] == ("install", "--production")]
            web_build = next(index for index, (parts, _cwd) in enumerate(commands)
                             if parts == ("run", "--cwd", "web", "build"))
            self.assertLess(web_build, min(production_positions))
            self.assertEqual(production_had_old_tree, [False, False])
            self.assertFalse((output / "packages/@ezcorp/factory-transport/node_modules").exists())
            for dependency_root in (output, output / "web"):
                self.assertFalse(os.path.lexists(dependency_root / "node_modules/.bin/tsserver"))
                self.assertEqual((dependency_root / "node_modules/runtime-package/index.js").read_bytes(),
                                 b"runtime dependency")
            self.assertEqual((output / "bun.lock").read_bytes(), b"root lock")
            self.assertEqual((output / "web/bun.lock").read_bytes(), b"web lock")
            self.assertTrue(MODULE.verify(output)["files"])

    def test_dependency_reset_does_not_follow_directory_links(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory) / "release"
            root.mkdir()
            outside = Path(directory) / "outside"
            (outside / "node_modules").mkdir(parents=True)
            preserved = outside / "node_modules/cache-file"
            preserved.write_bytes(b"shared cache bytes")
            (root / "node_modules").symlink_to(outside, target_is_directory=True)
            (root / "linked-source").symlink_to(outside, target_is_directory=True)
            built = root / "dist/compiled.js"
            built.parent.mkdir()
            built.write_bytes(b"compiled output")
            MODULE.clear_dependency_trees(root)
            self.assertFalse(os.path.lexists(root / "node_modules"))
            self.assertEqual(preserved.read_bytes(), b"shared cache bytes")
            self.assertEqual(built.read_bytes(), b"compiled output")

    def test_stage_refuses_a_contract_build_without_published_outputs(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            source = Path(directory) / "source"
            self.source_fixture(source)
            bun = source / "bun"
            bun.write_bytes(b"fake bun")
            output = Path(directory) / "release"

            def fake_run(_argv, *, cwd, env):
                if cwd.name == "release" and not (cwd / "bun.lock").exists():
                    self.release_fixture(cwd)
                    (cwd / "bin/bun").write_bytes(bun.read_bytes())
                    (cwd / MODULE.RUNTIME_DIR).rmdir()
                    (cwd / "packages/@ezcorp/extension-contract/dist/index.d.ts").unlink()

            with patch.object(MODULE, "git_head", return_value="a" * 40), \
                 patch.object(MODULE, "extract_head", side_effect=self.extract_version_fixture), \
                 patch.object(MODULE, "run", side_effect=fake_run), \
                 patch.object(MODULE.subprocess, "check_output", return_value="1.3.14\n"):
                with self.assertRaisesRegex(ValueError, "built extension contract is absent: index.d.ts"):
                    MODULE.stage(source, output, bun, MODULE.sha256(bun))
            self.assertFalse(output.exists())

    def test_stage_normalizes_dependency_modes_without_changing_hardlinked_source(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            source = Path(directory) / "source"
            self.source_fixture(source)
            bun = source / "bun"
            bun.write_bytes(b"fake bun")
            output = Path(directory) / "release"
            cached = source / "cached-license"
            cached.write_bytes(b"license")
            os.chmod(cached, 0o666)

            def fake_run(_argv, *, cwd, env):
                if cwd.name == "release" and not (cwd / "bun.lock").exists():
                    self.release_fixture(cwd)
                    (cwd / "bin/bun").write_bytes(bun.read_bytes())
                    (cwd / MODULE.RUNTIME_DIR).rmdir()
                if _argv[1:3] == ["install", "--production"]:
                    self.dependency_build_fixture(_argv, cwd=cwd, env=env)
                if _argv[1:3] == ["install", "--production"] and cwd.name == "web":
                    package = cwd / "node_modules/fast-uri"
                    package.mkdir(mode=0o777)
                    os.chmod(package, 0o777)
                    os.link(cached, package / "LICENSE")
                    (package / "LICENSE.link").symlink_to("LICENSE")
                    executable = package / "tool"
                    executable.write_bytes(b"tool")
                    os.chmod(executable, 0o777)

            with patch.object(MODULE, "git_head", return_value="a" * 40), \
                 patch.object(MODULE, "extract_head", side_effect=self.extract_version_fixture), \
                 patch.object(MODULE, "run", side_effect=fake_run), \
                 patch.object(MODULE.subprocess, "check_output", return_value="1.3.14\n"):
                MODULE.stage(source, output, bun, MODULE.sha256(bun))
            package = output / "web/node_modules/fast-uri"
            self.assertEqual((package / "LICENSE").stat().st_mode & 0o777, 0o644)
            self.assertEqual((package / "tool").stat().st_mode & 0o777, 0o755)
            self.assertEqual(package.stat().st_mode & 0o777, 0o755)
            self.assertEqual(cached.stat().st_mode & 0o777, 0o666)
            self.assertNotEqual((package / "LICENSE").stat().st_ino, cached.stat().st_ino)
            self.assertTrue((package / "LICENSE.link").is_symlink())
            MODULE.verify(output)

    def test_verify_rejects_writable_file_and_directory_with_matching_manifest(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            self.release_fixture(root)
            dependency = root / "web/node_modules/fast-uri"
            dependency.mkdir()
            license_file = dependency / "LICENSE"
            license_file.write_bytes(b"license")
            os.chmod(license_file, 0o666)
            self.seal_fixture(root)
            with self.assertRaisesRegex(ValueError, "writable release file"):
                MODULE.verify(root)
            os.chmod(license_file, 0o644)
            os.chmod(dependency, 0o777)
            self.seal_fixture(root)
            with self.assertRaisesRegex(ValueError, "writable release directory"):
                MODULE.verify(root)

    def test_archive_rejects_tracked_runtime_directory(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            source = Path(directory) / "source"
            self.source_fixture(source)
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            (source / ".ezcorp").mkdir()
            (source / ".ezcorp/state").write_text("tracked runtime data")
            subprocess.run(["git", "-C", str(source), "add", ".ezcorp/state"], check=True)
            subprocess.run(["git", "-C", str(source), "-c", "user.name=Test",
                            "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
            target = Path(directory) / "target"
            target.mkdir()
            with self.assertRaisesRegex(ValueError, "tracked reserved runtime path"):
                MODULE.extract_head(source, target)
            self.assertEqual(list(target.iterdir()), [])

    def test_inventory_rejects_a_link_outside_release(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory) / "release"
            root.mkdir()
            (root / "outside").symlink_to("/etc/passwd")
            with self.assertRaisesRegex(ValueError, "escapes release"):
                MODULE.inventory(root)

    def test_inventory_accepts_an_internal_dependency_directory_link(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory) / "release"
            (root / "packages/example").mkdir(parents=True)
            (root / "node_modules").mkdir()
            (root / "node_modules/example").symlink_to("../packages/example")
            entries = MODULE.inventory(root)
            self.assertIn({"path": "node_modules/example", "mode": 0o777,
                           "type": "link", "target": "../packages/example"}, entries)

    def test_inventory_has_stable_order_hashes_modes_and_links(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory) / "release"
            root.mkdir()
            (root / "b").write_bytes(b"b")
            (root / "a").write_bytes(b"a")
            os.chmod(root / "a", 0o644)
            (root / "link").symlink_to("a")
            entries = MODULE.inventory(root)
            self.assertEqual([item["path"] for item in entries], ["a", "b", "link"])
            self.assertEqual(entries[0]["sha256"], MODULE.sha256(root / "a"))
            self.assertEqual(entries[0]["mode"], 0o644)
            self.assertEqual(entries[2], {"path": "link", "mode": 0o777,
                                          "type": "link", "target": "a"})

    def test_verify_rejects_tampering_and_missing_runtime_closure(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            root = Path(directory)
            (root / MODULE.BUN_VERSION).write_text("1.3.14\n")
            (root / "bin").mkdir()
            (root / "bin/bun").write_bytes(b"bun")
            (root / "bun.lock").write_bytes(b"root")
            (root / "web").mkdir()
            (root / "web/bun.lock").write_bytes(b"web")
            (root / MODULE.RUNTIME_DIR).mkdir(mode=0o755)
            manifest = {"schema": 1, "gitSha": "a" * 40, "bunVersion": "1.3.14",
                        "bunSha256": MODULE.sha256(root / "bin/bun"),
                        "locks": {name: MODULE.sha256(root / name)
                                  for name in ("bun.lock", "web/bun.lock")},
                        "files": MODULE.inventory(root)}
            (root / MODULE.MANIFEST).write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "required release file"):
                MODULE.verify(root)
            (root / "bin/bun").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "Bun digest changed"):
                MODULE.verify(root)

    def test_stage_rejects_live_destination_before_running_build(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            source = Path(directory)
            bun = source / "bun"
            bun.write_bytes(b"fake")
            with self.assertRaisesRegex(ValueError, "must be under /tmp or /var/tmp"):
                MODULE.stage(source, Path("/opt/ezh-bundle-test-invalid-destination"), bun,
                             MODULE.sha256(bun))


if __name__ == "__main__":
    unittest.main()
