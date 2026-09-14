"""Behaviour tests for the framed Python guest and the host-Python wire gate."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

import c02_runner
from factory_validation import validate_factory_runner_result
from guest import MANIFEST, Guest, GuestError, load_schema, main, read_control, serve
from tests.fixtures import (
    REQUEST_SCHEMA,
    RESULT_SCHEMA,
    at,
    request,
    result,
    schema_path,
)

Json = Any


def guest() -> Guest:
    return Guest(REQUEST_SCHEMA, RESULT_SCHEMA)


def frames(*bodies: str) -> tuple[list[Json], str]:
    sink = io.StringIO()
    serve(guest(), io.StringIO("".join(f"{body}\n" for body in bodies)), sink)
    lines = [json.loads(line) for line in sink.getvalue().splitlines() if line]
    return lines, sink.getvalue()


class SchemaLoadingTest(unittest.TestCase):
    def test_the_committed_generated_schema_loads(self) -> None:
        document = load_schema(schema_path("factory-runner-request.schema.json"))
        self.assertEqual(document["$id"], "urn:ezcorp:factory:runner-request:v1")

    def test_a_document_that_is_not_the_generated_draft_seven_schema_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "schema.json"
            path.write_text(json.dumps({"type": "object"}), encoding="utf-8")
            with self.assertRaises(GuestError):
                load_schema(path)
            path.write_text(json.dumps(["not an object"]), encoding="utf-8")
            with self.assertRaises(GuestError):
                load_schema(path)


class VerdictTest(unittest.TestCase):
    def test_a_valid_request_and_result_are_both_admitted_with_their_schema_identity(self) -> None:
        admitted = guest().verdict("request", request())
        self.assertEqual(admitted["ok"], True)
        self.assertEqual(admitted["schemaId"], "urn:ezcorp:factory:runner-request:v1")
        self.assertEqual(admitted["runtime"], "factory.python-guest.v1")
        self.assertNotIn("code", admitted)
        self.assertEqual(guest().verdict("result", result())["schemaId"], "urn:ezcorp:factory:runner-result:v1")

    def test_a_rejection_carries_its_issue_code_and_path(self) -> None:
        refused = guest().verdict("request", at(request(), ["runner", "version"], "latest"))
        self.assertEqual((refused["ok"], refused["code"], refused["path"]), (False, "RUNNER_PIN", ["runner"]))

    def test_an_unknown_envelope_kind_is_refused(self) -> None:
        with self.assertRaises(GuestError):
            guest().verdict("checkpoint", {})


class RunExportTest(unittest.TestCase):
    def test_a_valid_request_becomes_a_completed_result_the_contract_admits(self) -> None:
        answer = guest().run(request())
        self.assertEqual(answer["status"], "completed")
        self.assertTrue(validate_factory_runner_result(answer, RESULT_SCHEMA).ok)
        self.assertEqual(answer["output"]["digest"], f"sha256:{answer['resultDigest']}")

    def test_the_same_request_always_produces_the_same_result_digest(self) -> None:
        self.assertEqual(guest().run(request())["resultDigest"], guest().run(request())["resultDigest"])
        other = at(request(), ["input", "value"], {"prompt": "other"})
        self.assertNotEqual(guest().run(request())["resultDigest"], guest().run(other)["resultDigest"])

    def test_a_refused_request_becomes_a_failed_result_carrying_the_issue_code(self) -> None:
        answer = guest().run(at(request(), ["runner", "version"], "latest"))
        self.assertEqual(answer["status"], "failed")
        self.assertEqual(answer["error"]["code"], "RUNNER_PIN")
        self.assertEqual(answer["error"]["retryable"], False)
        self.assertTrue(validate_factory_runner_result(answer, RESULT_SCHEMA).ok)

    def test_a_request_that_is_not_an_object_is_refused_rather_than_answered(self) -> None:
        answer = guest().run(["not a request"])
        self.assertEqual(answer["error"]["code"], "RUNNER_REQUEST_SCHEMA")

    def test_a_result_the_contract_would_reject_never_leaves_the_guest(self) -> None:
        # Controlled fault: a result schema that admits nothing must make the
        # guest refuse rather than emit an unvalidatable result.
        broken = Guest(REQUEST_SCHEMA, {**RESULT_SCHEMA, "$ref": "#/definitions/Absent"})
        with self.assertRaises(GuestError) as raised:
            broken.run(request())
        self.assertIn("invalid result", str(raised.exception))


class DispatchTest(unittest.TestCase):
    def test_discovery_returns_the_declared_manifest(self) -> None:
        self.assertEqual(guest().dispatch("extension/discover", None), MANIFEST)
        self.assertEqual([tool["name"] for tool in MANIFEST["tools"]], ["validate", "run", "controls"])

    def test_cancel_is_acknowledged(self) -> None:
        self.assertEqual(guest().dispatch("extension/cancel", None), {"cancelled": True})

    def test_the_validate_export_answers_an_envelope(self) -> None:
        answer = guest().dispatch(
            "extension/invoke", {"name": "validate", "input": {"kind": "request", "value": request()}}
        )
        self.assertEqual(answer["ok"], True)

    def test_the_run_export_answers_a_request(self) -> None:
        answer = guest().dispatch("extension/invoke", {"name": "run", "input": request()})
        self.assertEqual(answer["status"], "completed")

    def test_an_unknown_method_export_or_malformed_parameters_are_refused(self) -> None:
        cases: list[tuple[str, Json]] = [
            ("extension/unknown", None),
            ("extension/invoke", "not an object"),
            ("extension/invoke", {"name": "elsewhere", "input": {}}),
            ("extension/invoke", {"name": "validate", "input": {"kind": "request"}}),
            ("extension/invoke", {"name": "validate", "input": "envelope"}),
        ]
        for method, params in cases:
            with self.assertRaises(GuestError):
                guest().dispatch(method, params)


class ServeTest(unittest.TestCase):
    def test_one_request_frame_produces_one_response_frame_bound_to_its_id(self) -> None:
        lines, _ = frames(json.dumps({"jsonrpc": "2.0", "id": "host-1", "method": "extension/discover"}))
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["id"], "host-1")
        self.assertEqual(lines[0]["result"], MANIFEST)

    def test_blank_lines_are_ignored_rather_than_answered(self) -> None:
        lines, _ = frames("", "   ", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "extension/cancel"}))
        self.assertEqual(len(lines), 1)

    def test_invalid_protocol_data_is_answered_and_the_loop_continues(self) -> None:
        lines, _ = frames(
            "{not json",
            json.dumps(["array"]),
            json.dumps({"jsonrpc": "1.0", "method": "extension/discover"}),
            json.dumps({"jsonrpc": "2.0", "method": 7}),
            json.dumps({"jsonrpc": "2.0", "id": "host-9", "method": "extension/cancel"}),
        )
        self.assertEqual([line["error"]["code"] for line in lines[:4]], [-32700, -32600, -32600, -32600])
        self.assertEqual(lines[4]["id"], "host-9")

    def test_a_frame_beyond_the_policy_limit_is_refused_without_being_parsed(self) -> None:
        lines, _ = frames(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "x" * 1_100_000}))
        self.assertEqual(lines[0]["error"]["message"], "Control frame exceeds policy")

    def test_a_refused_dispatch_answers_the_frame_that_caused_it(self) -> None:
        lines, _ = frames(json.dumps({"jsonrpc": "2.0", "id": "host-2", "method": "extension/unknown"}))
        self.assertEqual(lines[0]["id"], "host-2")
        self.assertEqual(lines[0]["error"]["code"], -32000)

    def test_every_frame_is_written_as_one_line(self) -> None:
        _, raw = frames(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "extension/cancel"}))
        self.assertTrue(raw.endswith("\n"))
        self.assertEqual(raw.count("\n"), 1)


class ControlsTest(unittest.TestCase):
    def test_the_report_names_every_control_the_host_also_verifies(self) -> None:
        report = guest().controls()
        self.assertEqual(
            sorted(report),
            [
                "capabilities",
                "cpuMax",
                "devices",
                "distributions",
                "environment",
                "gid",
                "gpuDevices",
                "ipv6Routes",
                "memoryMax",
                "noNewPrivileges",
                "pidsMax",
                "python",
                "routes",
                "runtime",
                "seccomp",
                "swapMax",
                "uid",
                "writableRoot",
            ],
        )
        self.assertEqual(report["runtime"], "factory.python-guest.v1")
        self.assertEqual(report["python"], f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")
        self.assertIsInstance(report["uid"], int)

    def test_a_control_the_guest_cannot_read_reports_unavailable_rather_than_crashing(self) -> None:
        # "unavailable" can never satisfy the host's exact comparison, so a
        # control the kernel did not apply still fails closed.
        self.assertEqual(read_control("/nonexistent/control"), "unavailable")
        self.assertTrue(read_control("/proc/self/status").startswith("Name:"))

    def test_a_status_field_is_read_by_its_exact_label(self) -> None:
        status = "Name:\tpython\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\nSeccomp:\t2\n"
        report = guest().controls(read=lambda path: status if path.endswith("status") else "value")
        self.assertEqual(report["capabilities"], "0000000000000000")
        self.assertEqual(report["noNewPrivileges"], "1")
        self.assertEqual(report["seccomp"], "2")

    def test_a_status_without_the_named_field_reports_an_empty_value(self) -> None:
        report = guest().controls(read=lambda path: "Name python\nOther:\t1" if path.endswith("status") else "v")
        self.assertEqual(report["capabilities"], "")

    def test_the_controls_export_is_reachable_through_dispatch(self) -> None:
        answer = guest().dispatch("extension/invoke", {"name": "controls", "input": {}})
        self.assertEqual(answer["runtime"], "factory.python-guest.v1")


class MainTest(unittest.TestCase):
    def test_the_guest_entry_point_serves_frames_over_the_staged_schemas(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staged = Path(directory)
            for name in ("factory-runner-request.schema.json", "factory-runner-result.schema.json"):
                (staged / name).write_text(schema_path(name).read_text(encoding="utf-8"), encoding="utf-8")
            stdout = io.StringIO()
            frame = json.dumps({"jsonrpc": "2.0", "id": "host-1", "method": "extension/discover"})
            with (
                mock.patch.object(sys, "stdin", io.StringIO(f"{frame}\n")),
                mock.patch.object(sys, "stdout", stdout),
            ):
                self.assertEqual(main(staged), 0)
            self.assertEqual(json.loads(stdout.getvalue())["result"], MANIFEST)


class C02RunnerTest(unittest.TestCase):
    def run_main(self, envelope: str) -> tuple[int, Json]:
        argv = [
            "c02_runner.py",
            "--request-schema",
            str(schema_path("factory-runner-request.schema.json")),
            "--result-schema",
            str(schema_path("factory-runner-result.schema.json")),
        ]
        stdout = io.StringIO()
        with (
            mock.patch.object(sys, "argv", argv),
            mock.patch.object(sys, "stdin", io.StringIO(envelope)),
            mock.patch.object(sys, "stdout", stdout),
        ):
            code = c02_runner.main()
        return code, json.loads(stdout.getvalue())

    def test_a_request_and_a_result_the_contract_admits_both_exit_zero(self) -> None:
        code, payload = self.run_main(json.dumps({"kind": "request", "value": request()}))
        self.assertEqual((code, payload["ok"]), (0, True))
        self.assertEqual(payload["schemaId"], "urn:ezcorp:factory:runner-request:v1")
        code, payload = self.run_main(json.dumps({"kind": "result", "value": result()}))
        self.assertEqual((code, payload["schemaId"]), (0, "urn:ezcorp:factory:runner-result:v1"))

    def test_a_rejection_exits_one_and_reports_its_issue_code(self) -> None:
        code, payload = self.run_main(
            json.dumps({"kind": "request", "value": at(request(), ["runner", "version"], "latest")})
        )
        self.assertEqual(
            (code, payload["ok"], payload["error"], payload["code"]), (1, False, "RUNNER_PIN", "RUNNER_PIN")
        )

    def test_a_malformed_envelope_is_refused(self) -> None:
        for envelope in (
            '["request"]',
            json.dumps({"kind": "checkpoint", "value": {}}),
            json.dumps({"kind": "request"}),
        ):
            code, payload = self.run_main(envelope)
            self.assertEqual((code, payload["error"]), (1, "envelope must contain kind and value"))

    def test_stdin_that_is_not_json_is_refused(self) -> None:
        code, payload = self.run_main("{not json")
        self.assertEqual(code, 1)
        self.assertIn("Expecting", payload["error"])

    def test_a_missing_schema_file_is_refused_rather_than_skipped(self) -> None:
        argv = ["c02_runner.py", "--request-schema", "/nonexistent", "--result-schema", "/nonexistent"]
        stdout = io.StringIO()
        with (
            mock.patch.object(sys, "argv", argv),
            mock.patch.object(sys, "stdin", io.StringIO(json.dumps({"kind": "request", "value": {}}))),
            mock.patch.object(sys, "stdout", stdout),
        ):
            code = c02_runner.main()
        self.assertEqual(code, 1)
        self.assertIn("No such file", json.loads(stdout.getvalue())["error"])


if __name__ == "__main__":
    unittest.main()
