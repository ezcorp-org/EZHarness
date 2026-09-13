"""Behaviour tests for the C02 Python runner wire gate.

Standard-library `unittest` only: the repository pins Python's own test runner
for Python source, so no third-party test dependency enters `uv.lock`.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import c02_runner

REQUEST_SCHEMA: dict[str, Any] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "https://ezcorp.test/factory-runner-request.schema.json",
    "type": "object",
    "required": ["attemptId", "code"],
    "properties": {"attemptId": {"type": "string"}, "code": {"type": "string"}},
    "additionalProperties": False,
}
RESULT_SCHEMA: dict[str, Any] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "$id": "https://ezcorp.test/factory-runner-result.schema.json",
    "type": "object",
    "required": ["attemptId"],
    "properties": {"attemptId": {"type": "string"}},
    "additionalProperties": False,
}


def completed(returncode: int, stdout: str, stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=["node", "bridge.mjs"], returncode=returncode, stdout=stdout, stderr=stderr
    )


class SdkValidateTest(unittest.TestCase):
    def test_returns_the_parsed_bridge_verdict_on_acceptance(self) -> None:
        with mock.patch.object(subprocess, "run", return_value=completed(0, '{"ok": true}')) as run:
            verdict = c02_runner.sdk_validate("node", Path("bridge.mjs"), {"kind": "request", "value": {}})
        self.assertEqual(verdict, {"ok": True})
        self.assertEqual(run.call_args.args[0], ["node", "bridge.mjs"])
        self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"kind": "request", "value": {}})

    def test_treats_a_rejection_exit_as_a_verdict_rather_than_a_failure(self) -> None:
        with mock.patch.object(subprocess, "run", return_value=completed(1, '{"ok": false, "issues": [{"code": "BAD_PIN"}]}')):
            self.assertEqual(
                c02_runner.sdk_validate("node", Path("bridge.mjs"), {"kind": "result", "value": {}}),
                {"ok": False, "issues": [{"code": "BAD_PIN"}]},
            )

    def test_raises_when_the_bridge_itself_fails(self) -> None:
        with (
            mock.patch.object(subprocess, "run", return_value=completed(2, "", "bridge crashed")),
            self.assertRaises(c02_runner.SchemaError) as raised,
        ):
            c02_runner.sdk_validate("node", Path("bridge.mjs"), {"kind": "request", "value": {}})
        self.assertIn("bridge crashed", str(raised.exception))

    def test_raises_when_the_bridge_returns_unparseable_output(self) -> None:
        with (
            mock.patch.object(subprocess, "run", return_value=completed(0, "not json")),
            self.assertRaises(c02_runner.SchemaError) as raised,
        ):
            c02_runner.sdk_validate("node", Path("bridge.mjs"), {"kind": "request", "value": {}})
        self.assertEqual(str(raised.exception), "SDK validator returned invalid JSON")


class MainTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.request_schema = self.directory / "request.schema.json"
        self.result_schema = self.directory / "result.schema.json"
        self.request_schema.write_text(json.dumps(REQUEST_SCHEMA), encoding="utf-8")
        self.result_schema.write_text(json.dumps(RESULT_SCHEMA), encoding="utf-8")

    def run_main(
        self, envelope: str, *, bridge: subprocess.CompletedProcess[str] | None = None
    ) -> tuple[int, dict[str, Any]]:
        argv = [
            "c02_runner.py",
            "--request-schema",
            str(self.request_schema),
            "--result-schema",
            str(self.result_schema),
            "--sdk-bridge",
            str(self.directory / "bridge.mjs"),
        ]
        stdout = io.StringIO()
        patches: list[AbstractContextManager[Any]] = [
            mock.patch.object(sys, "argv", argv),
            mock.patch.object(sys, "stdin", io.StringIO(envelope)),
            mock.patch.object(sys, "stdout", stdout),
        ]
        if bridge is not None:
            patches.append(mock.patch.object(subprocess, "run", return_value=bridge))
        for patch in patches:
            self.enterContext(patch)
        code = c02_runner.main()
        return code, json.loads(stdout.getvalue())

    def test_accepts_a_request_that_both_the_schema_and_the_bridge_admit(self) -> None:
        code, payload = self.run_main(
            json.dumps({"kind": "request", "value": {"attemptId": "a1", "code": "print(1)"}}),
            bridge=completed(0, '{"ok": true}'),
        )
        self.assertEqual(code, 0)
        self.assertEqual(payload, {"ok": True, "schemaId": REQUEST_SCHEMA["$id"]})

    def test_selects_the_result_schema_for_a_result_envelope(self) -> None:
        code, payload = self.run_main(
            json.dumps({"kind": "result", "value": {"attemptId": "a1"}}),
            bridge=completed(0, '{"ok": true}'),
        )
        self.assertEqual(code, 0)
        self.assertEqual(payload["schemaId"], RESULT_SCHEMA["$id"])

    def test_rejects_an_envelope_that_is_not_an_object(self) -> None:
        code, payload = self.run_main(json.dumps(["request"]))
        self.assertEqual(code, 1)
        self.assertEqual(payload, {"ok": False, "error": "envelope must contain kind and value"})

    def test_rejects_an_unknown_envelope_kind(self) -> None:
        code, payload = self.run_main(json.dumps({"kind": "checkpoint", "value": {}}))
        self.assertEqual((code, payload["error"]), (1, "envelope must contain kind and value"))

    def test_rejects_an_envelope_without_a_value(self) -> None:
        code, payload = self.run_main(json.dumps({"kind": "request"}))
        self.assertEqual((code, payload["error"]), (1, "envelope must contain kind and value"))

    def test_rejects_stdin_that_is_not_json(self) -> None:
        code, payload = self.run_main("{not json")
        self.assertEqual(code, 1)
        self.assertIn("Expecting", payload["error"])

    def test_rejects_a_schema_that_is_not_the_generated_draft_seven_document(self) -> None:
        self.request_schema.write_text(json.dumps({"$id": "x", "type": "object"}), encoding="utf-8")
        code, payload = self.run_main(json.dumps({"kind": "request", "value": {"attemptId": "a", "code": "c"}}))
        self.assertEqual((code, payload["error"]), (1, "expected generated Draft 7 schema"))

    def test_reports_the_lowest_path_schema_error_for_a_non_conforming_value(self) -> None:
        code, payload = self.run_main(json.dumps({"kind": "request", "value": {"attemptId": 7, "code": "c"}}))
        self.assertEqual(code, 1)
        self.assertIn("7 is not of type 'string'", payload["error"])

    def test_rejects_a_missing_schema_file(self) -> None:
        self.request_schema.unlink()
        code, payload = self.run_main(json.dumps({"kind": "request", "value": {"attemptId": "a", "code": "c"}}))
        self.assertEqual(code, 1)
        self.assertIn("No such file", payload["error"])

    def test_surfaces_the_bridge_issue_code_when_the_sdk_rejects(self) -> None:
        code, payload = self.run_main(
            json.dumps({"kind": "request", "value": {"attemptId": "a1", "code": "c"}}),
            bridge=completed(1, '{"ok": false, "issues": [{"code": "UNPINNED_RUNNER"}]}'),
        )
        self.assertEqual((code, payload["error"]), (1, "UNPINNED_RUNNER"))

    def test_falls_back_to_a_generic_rejection_code_when_the_bridge_reports_no_issue(self) -> None:
        code, payload = self.run_main(
            json.dumps({"kind": "request", "value": {"attemptId": "a1", "code": "c"}}),
            bridge=completed(1, '{"ok": false}'),
        )
        self.assertEqual((code, payload["error"]), (1, "SDK_REJECTED"))


if __name__ == "__main__":
    unittest.main()
