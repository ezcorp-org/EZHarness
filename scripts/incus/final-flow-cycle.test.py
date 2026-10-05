import importlib.util
import dis
import json
import os
from pathlib import Path
import runpy
import select
import signal
import subprocess
import sys
import tempfile
import trace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("final_flow", Path(__file__).with_name("final-flow-cycle.py"))
flow = importlib.util.module_from_spec(SPEC)
TRACE = trace.Trace(count=True, trace=False)
TRACE.runfunc(SPEC.loader.exec_module, flow)


class CycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.hook = self.base / "hook.py"
        # A subprocess fixture, not a live provider or a fake live receipt.
        self.hook.write_text('''import hashlib, json, pathlib, sys, time
request = json.loads(pathlib.Path(sys.argv[-1]).read_text())
phase = request['phase']
mode = sys.argv[1]
artifact = pathlib.Path(sys.argv[-1]).with_suffix('.artifact')
artifact.write_text(json.dumps(request))
checks = json.loads(sys.argv[2])[phase]
identity = {} if phase in ('preflight', 'denied_credentials') else {key: f'{key}-{request["cycle"]}' for key in ('projectId', 'bindingId', 'workspaceId', 'instanceName')}
receipt = dict(requestId=request['requestId'], cycle=request['cycle'], phase=phase, state='SUCCEEDED', identity=identity, checks={key: True for key in checks}, artifacts=[dict(path=str(artifact), sha256=hashlib.sha256(artifact.read_bytes()).hexdigest())])
if mode == phase + ':unknown': receipt['state'] = 'OUTCOME_UNKNOWN'
if mode == phase + ':mismatch': receipt['requestId'] = 'another-request'
if mode == phase + ':identity': receipt['identity']['bindingId'] = 'another-binding'
if mode == phase + ':hash': receipt['artifacts'][0]['sha256'] = '0' * 64
if mode == phase + ':missing': receipt['checks'].pop(next(iter(receipt['checks'])))
if mode == phase + ':false': receipt['checks'][next(iter(receipt['checks']))] = False
if mode == phase + ':empty': receipt['artifacts'] = []
if mode == phase + ':preidentity': receipt['identity'] = {'bindingId': 'wrong'}
if mode == phase + ':incomplete': receipt['identity'] = {}
if mode == phase + ':artifact': receipt['artifacts'] = [{'path': str(artifact), 'extra': True}]
if mode == phase + ':extra': receipt['secret'] = 'must-not-project'
if mode == phase + ':fail': sys.exit(3)
if mode == phase + ':timeout': time.sleep(5)
if mode == phase + ':malformed': print('not-json'); sys.exit(0)
if mode == phase + ':oversize': print('x' * 65537); sys.exit(0)
if mode == phase + ':reuse': receipt['identity'] = {key: key+'-1' for key in identity}
print(json.dumps(receipt))
''')

    def config(self, mode="normal", cycles=1):
        command = [sys.executable, str(self.hook), mode, json.dumps(flow.CHECKS)]
        return {"sequenceId": "fixture-only", "sourceCommit": "fixture-source", "bundleSha256": "fixture-bundle",
                "cycles": cycles, "timeoutSeconds": 1, "faultCycles": [cycles] if cycles > 1 else [],
                "hooks": {phase: command for phase in flow.PHASES}}

    def test_ten_serial_distinct_cycles(self):
        def scripted_receipt(command, output, _error, _timeout):
            request = json.loads(Path(command[-1]).read_text())
            artifact = Path(command[-1]).with_suffix(".artifact")
            artifact.write_text(json.dumps(request))
            phase = request["phase"]
            identity = {} if phase in ("preflight", "denied_credentials") else {key: f"{key}-{request['cycle']}" for key in flow.IDENTITY}
            receipt = {"requestId": request["requestId"], "cycle": request["cycle"], "phase": phase,
                       "state": "SUCCEEDED", "identity": identity,
                       "checks": {key: True for key in flow.CHECKS[phase]},
                       "artifacts": [{"path": str(artifact), "sha256": flow.hashlib.sha256(artifact.read_bytes()).hexdigest()}]}
            output.write(json.dumps(receipt).encode())
            return 0
        with patch.object(flow, "supervise", scripted_receipt):
            result = flow.run(self.config(cycles=10), self.base / "run")
        self.assertEqual(result["state"], "SUCCEEDED")
        self.assertEqual(len(result["steps"]), sum(len(flow.phases_for(self.config(cycles=10), cycle)) for cycle in range(1, 11)))
        self.assertEqual(len({step["requestId"] for step in result["steps"]}), len(result["steps"]))
        self.assertEqual([(step["cycle"], step["phase"]) for step in result["steps"]],
                         [(cycle, phase) for cycle in range(1, 11) for phase in flow.phases_for(self.config(cycles=10), cycle)])
        self.assertEqual([step["cycle"] for step in result["steps"] if step["phase"] == "destroy"], list(range(1, 10)))
        self.assertEqual([step["cycle"] for step in result["steps"] if step["phase"] == "cleanup_fault"], [10])
        guests = [json.loads((self.base / "run" / f"{cycle:02d}-create.stdout").read_text())["identity"] for cycle in range(1, 11)]
        for key in flow.IDENTITY:
            self.assertEqual(len({guest[key] for guest in guests}), 10)

    def test_unproved_step_blocks_without_next_effect_or_replay(self):
        for mode in ("unknown", "mismatch", "identity", "hash", "missing", "false", "empty", "incomplete",
                     "artifact", "extra", "fail", "timeout", "malformed", "oversize"):
            with self.subTest(mode=mode):
                root = self.base / mode
                phase = "checkout" if mode in ("identity", "incomplete") else "create" if mode == "unknown" else "preflight"
                with self.assertRaises(Exception):
                    flow.run(self.config(phase + ":" + mode, cycles=10), root)
                journal = json.loads((root / "journal.json").read_text())
                self.assertEqual(journal["state"], "BLOCKED")
                self.assertEqual(journal["steps"][-1]["phase"], phase)
                self.assertEqual(journal["steps"][-1]["state"], "ADMITTED")
                before = (root / "journal.json").read_bytes()
                with self.assertRaises(FileExistsError):
                    flow.run(self.config(), root)
                self.assertEqual((root / "journal.json").read_bytes(), before)
                self.assertFalse((root / "01-native_work-request.json").exists())

    def test_precreate_identity_is_rejected(self):
        with self.assertRaises(ValueError):
            flow.run(self.config("preflight:preidentity"), self.base / "preidentity")

    def test_final_accounting_failure_prevents_next_guest(self):
        root = self.base / "accounting"
        with self.assertRaises(ValueError):
            flow.run(self.config("accounting:false", cycles=10), root)
        journal = json.loads((root / "journal.json").read_text())
        self.assertEqual(len(journal["steps"]), len(flow.phases_for(self.config(cycles=10), 1)))
        self.assertFalse((root / "02-preflight-request.json").exists())

    def test_crash_before_admission_never_invokes_hook(self):
        root = self.base / "before"
        original = flow.publish
        def failed_publish(path, value):
            if path.name.endswith("request.json"):
                raise OSError("fixture crash")
            original(path, value)
        with patch.object(flow, "publish", failed_publish), patch.object(flow, "supervise") as invoke:
            with self.assertRaises(OSError):
                flow.run(self.config(), root)
            invoke.assert_not_called()
        self.assertEqual(json.loads((root / "journal.json").read_text())["steps"], [])

    def test_crash_after_admission_preserves_request(self):
        root = self.base / "after"
        with patch.object(flow, "supervise", side_effect=OSError("fixture crash")):
            with self.assertRaises(OSError):
                flow.run(self.config(), root)
        journal = json.loads((root / "journal.json").read_text())
        request = json.loads((root / "01-preflight-request.json").read_text())
        self.assertEqual(journal["steps"][-1]["requestId"], request["requestId"])
        self.assertEqual(journal["steps"][-1]["state"], "ADMITTED")

    def test_config_rejects_unbounded_or_missing_hooks(self):
        variants = [{"cycles": 0}, {"cycles": 11}, {"cycles": True}, {"timeoutSeconds": 0},
                    {"timeoutSeconds": 1801}, {"timeoutSeconds": True}, {"sourceCommit": ""},
                    {"hooks": {}}, {"hooks": {phase: [] for phase in flow.PHASES}},
                    {"hooks": {phase: ["relative-hook"] for phase in flow.PHASES}}, {"extra": True}]
        variants += [{"faultCycles": [1]}, {"faultCycles": [2]}, {"faultCycles": [True]}, {"faultCycles": [2, 2]}]
        variants += [{"cycles": 10, "faultCycles": []}]
        for variant in variants:
            with self.subTest(variant=variant):
                with self.assertRaises(ValueError):
                    flow.validate_config({**self.config(), **variant})

    def test_cli_reports_sanitized_success_and_failure(self):
        config_path = self.base / "config.json"
        config_path.write_text(json.dumps(self.config()))
        with patch.object(sys, "argv", ["driver", "--config", str(config_path), "--output", str(self.base / "cli")]):
            self.assertEqual(flow.main(), 0)
            self.assertEqual(flow.main(), 2)

    def test_publish_failure_removes_unpublished_temporary_file(self):
        with patch.object(flow.os, "replace", side_effect=OSError("fixture crash")):
            with self.assertRaises(OSError):
                flow.publish(self.base / "journal.json", {"state": "fixture"})
        self.assertEqual(list(self.base.glob(".journal-*")), [])
        self.assertFalse((self.base / "journal.json").exists())

    def test_script_entrypoint_has_sanitized_failure_exit(self):
        with patch.object(sys, "argv", ["driver", "--config", str(self.base / "absent.json"), "--output", str(self.base / "entrypoint")]):
            with self.assertRaises(SystemExit) as exited:
                runpy.run_path(str(Path(flow.__file__)), run_name="__main__")
        self.assertEqual(exited.exception.code, 2)

    def test_reused_guest_is_not_credited_twice(self):
        root = self.base / "reuse"
        with self.assertRaises(ValueError):
            flow.run(self.config("create:reuse", cycles=2), root)
        journal = json.loads((root / "journal.json").read_text())
        self.assertEqual((journal["steps"][-1]["cycle"], journal["steps"][-1]["phase"]), (2, "create"))
        self.assertFalse((root / "02-checkout-request.json").exists())

    def test_artifacts_reject_escape_symlinks_special_files_and_large_files(self):
        root = self.base / "artifacts"
        root.mkdir()
        outside = self.base / "outside"
        outside.write_text("private")
        (root / "link").symlink_to(outside)
        (root / "directory-link").symlink_to(self.base, target_is_directory=True)
        os.mkfifo(root / "fifo")
        large = root / "large"
        with large.open("wb") as output:
            output.truncate(16 * 1024 * 1024 + 1)
        for name in (str(outside), "../outside", "link", "directory-link/outside", "fifo", "large", "."):
            with self.subTest(name=name):
                with self.assertRaises((ValueError, OSError)):
                    flow.artifact_digest(root, name)
        (root / "valid").write_text("bounded")
        self.assertEqual(flow.artifact_digest(root, "valid"), flow.hashlib.sha256(b"bounded").hexdigest())
        (root / "nested").mkdir()
        (root / "nested" / "valid").write_text("bounded")
        self.assertEqual(flow.artifact_digest(root, "nested/valid"), flow.hashlib.sha256(b"bounded").hexdigest())
        with patch.object(flow.os, "read", return_value=b"grew-past-bound"):
            with self.assertRaises(ValueError):
                flow.artifact_digest(root, "valid", maximum=7)

    def test_directory_sync_occurs_before_dispatch(self):
        events = []
        original = flow.sync_directory
        def synced(path):
            events.append(("sync", path))
            original(path)
        def failed_hook(*_args):
            events.append(("hook", None))
            raise OSError("fixture stop")
        root = self.base / "sync"
        with patch.object(flow, "sync_directory", synced), patch.object(flow, "supervise", failed_hook):
            with self.assertRaises(OSError):
                flow.run(self.config(), root)
        hook_index = events.index(("hook", None))
        self.assertEqual(events[0], ("sync", root.parent))
        self.assertGreaterEqual(events[:hook_index].count(("sync", root)), 3)

    def test_actual_grandchild_is_killed_on_timeout_and_normal_exit(self):
        launcher = self.base / "children.py"
        launcher.write_text('''import os, pathlib, signal, subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', 'import time; print("ready", flush=True); time.sleep(120)'], stdout=subprocess.PIPE)
assert child.stdout.readline() == b'ready\\n'
pathlib.Path(sys.argv[1]).write_text(str(child.pid))
if sys.argv[2] == 'interrupt': os.kill(os.getppid(), signal.SIGTERM); time.sleep(120)
if sys.argv[2] == 'wait': time.sleep(120)
''')
        for mode in ("wait", "exit", "interrupt"):
            pid_file = self.base / (mode + ".pid")
            with tempfile.TemporaryFile() as output:
                if mode == "wait":
                    with self.assertRaises(subprocess.TimeoutExpired):
                        flow.supervise([sys.executable, str(launcher), str(pid_file), mode], output, output, 1)
                elif mode == "exit":
                    self.assertEqual(flow.supervise([sys.executable, str(launcher), str(pid_file), mode], output, output, 5), 0)
                else:
                    with self.assertRaises(KeyboardInterrupt):
                        flow.supervise([sys.executable, str(launcher), str(pid_file), mode], output, output, 5)
            child_pid = int(pid_file.read_text())
            try:
                descriptor = os.pidfd_open(child_pid)
            except ProcessLookupError:
                descriptor = None
            if descriptor is not None:
                try:
                    self.assertTrue(select.select([descriptor], [], [], 5)[0], "grandchild did not exit")
                finally:
                    os.close(descriptor)

    def test_interrupt_handler_reaps_child_and_restores_signal_handler(self):
        handlers = []
        previous = signal.getsignal(signal.SIGTERM)
        original = signal.signal
        def install(number, handler):
            handlers.append(handler)
            return original(number, handler)
        with tempfile.TemporaryFile() as output, patch.object(flow.signal, "signal", install), patch.object(flow.os, "killpg") as kill, patch.object(flow.subprocess, "Popen") as spawn:
            child = spawn.return_value
            child.pid = 12345
            child.wait.side_effect = [lambda: None, None]
            def waited(**_arguments):
                child.wait.side_effect = None
                handlers[0](signal.SIGTERM, None)
            child.wait.side_effect = waited
            with self.assertRaises(KeyboardInterrupt):
                flow.supervise(["fixture"], output, output, 1)
            kill.assert_called_once_with(12345, signal.SIGKILL)
            self.assertEqual(child.wait.call_count, 2)
        self.assertIs(signal.getsignal(signal.SIGTERM), previous)


if __name__ == "__main__":
    result = TRACE.runfunc(unittest.TextTestRunner().run, unittest.defaultTestLoader.loadTestsFromTestCase(CycleTests))
    source = str(Path(flow.__file__).resolve())
    code = compile(Path(source).read_text(), source, "exec")
    def executable_lines(compiled):
        lines = {line for _, line in dis.findlinestarts(compiled) if line is not None and line > 0}
        for constant in compiled.co_consts:
            if isinstance(constant, type(compiled)):
                lines.update(executable_lines(constant))
        return lines
    measured = executable_lines(code)
    hit = {line for (filename, line), count in TRACE.results().counts.items() if filename == source and count > 0}
    missing = measured - hit
    print(f"Driver statement coverage: {len(measured - missing)}/{len(measured)}; missing: {sorted(missing)}", file=sys.stderr)
    raise SystemExit(0 if result.wasSuccessful() and not missing else 1)
