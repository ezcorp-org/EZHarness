import importlib.util
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("final_flow", Path(__file__).with_name("final-flow-cycle.py"))
flow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(flow)


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
print(json.dumps(receipt))
''')

    def config(self, mode="normal", cycles=1):
        command = [sys.executable, str(self.hook), mode, json.dumps(flow.CHECKS)]
        return {"sequenceId": "fixture-only", "sourceCommit": "fixture-source", "bundleSha256": "fixture-bundle",
                "cycles": cycles, "timeoutSeconds": 1, "hooks": {phase: command for phase in flow.PHASES}}

    def test_ten_serial_distinct_cycles(self):
        result = flow.run(self.config(cycles=10), self.base / "run")
        self.assertEqual(result["state"], "SUCCEEDED")
        self.assertEqual(len(result["steps"]), 10 * len(flow.PHASES))
        self.assertEqual(len({step["requestId"] for step in result["steps"]}), len(result["steps"]))
        self.assertEqual([(step["cycle"], step["phase"]) for step in result["steps"]],
                         [(cycle, phase) for cycle in range(1, 11) for phase in flow.PHASES])
        guests = [json.loads((self.base / "run" / f"{cycle:02d}-create.stdout").read_text())["identity"] for cycle in range(1, 11)]
        for key in flow.IDENTITY:
            self.assertEqual(len({guest[key] for guest in guests}), 10)

    def test_unproved_step_blocks_without_next_effect_or_replay(self):
        for mode in ("unknown", "mismatch", "identity", "hash", "missing", "false", "empty", "incomplete",
                     "artifact", "extra", "fail", "timeout", "malformed", "oversize"):
            with self.subTest(mode=mode):
                root = self.base / mode
                with self.assertRaises(Exception):
                    flow.run(self.config("checkout:" + mode, cycles=10), root)
                journal = json.loads((root / "journal.json").read_text())
                self.assertEqual(journal["state"], "BLOCKED")
                self.assertEqual(journal["steps"][-1]["phase"], "checkout")
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
        self.assertEqual(len(journal["steps"]), len(flow.PHASES))
        self.assertFalse((root / "02-preflight-request.json").exists())

    def test_crash_before_admission_never_invokes_hook(self):
        root = self.base / "before"
        original = flow.publish
        def failed_publish(path, value):
            if path.name.endswith("request.json"):
                raise OSError("fixture crash")
            original(path, value)
        with patch.object(flow, "publish", failed_publish), patch.object(flow.subprocess, "run") as invoke:
            with self.assertRaises(OSError):
                flow.run(self.config(), root)
            invoke.assert_not_called()
        self.assertEqual(json.loads((root / "journal.json").read_text())["steps"], [])

    def test_crash_after_admission_preserves_request(self):
        root = self.base / "after"
        with patch.object(flow.subprocess, "run", side_effect=OSError("fixture crash")):
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


if __name__ == "__main__":
    unittest.main()
