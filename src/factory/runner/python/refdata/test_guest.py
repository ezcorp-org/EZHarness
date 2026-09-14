"""The four pinned exports, answered as real C02 attempts.

Every case drives ``DataGuest.run`` with a real ``FactoryRunnerRequest`` and
checks the ``FactoryRunnerResult`` the shared contract would admit, because a
guest that returns a shape the host must reject has not answered the attempt.
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

import pyarrow.parquet as pq

from guest import GuestError, load_schema
from refdata import guest as data_guest
from refdata.guest import MANIFEST, DataGuest, main

Json = Any

REPOSITORY = Path(__file__).resolve().parents[4].parent
SCHEMAS = REPOSITORY / "packages/@ezcorp/factory-sdk/src"
HEADER = "record_id,category,amount_cents"
GOLDEN = f"{HEADER}\na,alpha,100\nb,beta,250\nc,alpha,50\n"


def digest(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def request(command: dict[str, Json], export: str) -> dict[str, Json]:
    return {
        "schemaVersion": "factory.runner.request.v1",
        "authority": {
            "attemptId": "attempt-1",
            "tenantId": "tenant-1",
            "projectId": "project-1",
            "runId": "run-1",
            "nodeInstanceId": "node-1",
            "candidateGeneration": 0,
            "attemptNumber": 0,
            "grantRevision": 0,
            "reservationGeneration": 0,
            "executionEpoch": 0,
            "cancellationEpoch": 0,
            "deadlineAtMs": 4_000_000_000_000,
            "nextOperationIndex": 0,
        },
        "runner": {
            "package": "@ezcorp/reference-data",
            "version": "1.0.0",
            "digest": f"sha256:{'a' * 64}",
            "export": export,
        },
        "input": {"kind": "inline", "value": command},
        "grants": [],
        "resources": {},
        "tools": [],
        "broker": {"attemptToken": "token", "audience": "gateway"},
    }


class GuestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.materials = Path(self.directory.name)
        (self.materials / "in").mkdir()
        (self.materials / "out").mkdir()
        # The guest mounts its material directory at a fixed absolute path, so a
        # host-side case points that constant at a temporary directory instead.
        mount = patch.object(data_guest, "MATERIALS", self.materials)
        mount.start()
        self.addCleanup(mount.stop)
        self.guest = DataGuest(
            load_schema(SCHEMAS / "factory-runner-request.schema.json"),
            load_schema(SCHEMAS / "factory-runner-result.schema.json"),
        )
        self.addCleanup(self.directory.cleanup)

    def stage(self, name: str, text: str) -> bytes:
        data = text.encode("utf-8")
        (self.materials / name).write_bytes(data)
        return data

    def invoke(self, export: str, command: dict[str, Json]) -> dict[str, Json]:
        return cast("dict[str, Json]", self.guest.invoke({"name": export, "input": request(command, export)}))

    def report(self, result: dict[str, Json]) -> dict[str, Json]:
        self.assertEqual(result["status"], "completed", result.get("error"))
        payload = json.loads((self.materials / "out" / result["output"]["artifactId"]).read_text(encoding="utf-8"))
        self.assertIsInstance(payload, dict)
        return cast("dict[str, Json]", payload)


class Discovery(GuestCase):
    def test_declares_exactly_the_four_pinned_exports(self) -> None:
        self.assertEqual(MANIFEST["name"], "@ezcorp/reference-data")
        self.assertEqual(
            [tool["name"] for tool in MANIFEST["tools"]],
            ["snapshotCsv", "parseCsv", "transformPartition", "orderedReduce"],
        )
        self.assertEqual(self.guest.dispatch("extension/discover", None), MANIFEST)
        self.assertEqual(self.guest.dispatch("extension/cancel", None), {"cancelled": True})

    def test_refuses_a_method_and_an_export_it_does_not_declare(self) -> None:
        for method in ("extension/unknown", "tools/call"):
            with self.subTest(method=method), self.assertRaises(GuestError):
                self.guest.dispatch(method, None)
        with self.assertRaises(GuestError):
            self.guest.invoke({"name": "renderImage", "input": {}})
        with self.assertRaises(GuestError):
            self.guest.invoke("not-an-object")


class Snapshot(GuestCase):
    def test_records_the_identity_of_the_input_before_any_expansion(self) -> None:
        data = self.stage("in/source.csv", GOLDEN)
        report = self.report(
            self.invoke(
                "snapshotCsv",
                {"kind": "snapshotCsv", "input": "in/source.csv", "sourceVersion": "v1", "report": "out/snapshot.json"},
            )
        )
        self.assertEqual(report["digest"], digest(data))
        self.assertEqual(report["totalBytes"], len(data))
        self.assertTrue(report["headerMatches"])
        self.assertEqual(report["sourceVersion"], "v1")

    def test_snapshots_an_input_it_would_later_reject(self) -> None:
        # C10 wants the rejected input recorded too, so the snapshot validates nothing.
        self.stage("in/source.csv", f"{HEADER}\na,alpha,-5\n")
        report = self.report(
            self.invoke(
                "snapshotCsv",
                {"kind": "snapshotCsv", "input": "in/source.csv", "sourceVersion": "v1", "report": "out/snapshot.json"},
            )
        )
        self.assertTrue(report["headerMatches"])
        self.assertGreater(report["totalBytes"], 0)

    def test_reports_a_header_that_does_not_match(self) -> None:
        self.stage("in/source.csv", "a,b,c\n1,2,3\n")
        report = self.report(
            self.invoke(
                "snapshotCsv",
                {"kind": "snapshotCsv", "input": "in/source.csv", "sourceVersion": "v1", "report": "out/snapshot.json"},
            )
        )
        self.assertFalse(report["headerMatches"])


class Parse(GuestCase):
    def parse(self, text: str, prefix: str = "out/") -> dict[str, Json]:
        data = self.stage("in/source.csv", text)
        return self.invoke(
            "parseCsv",
            {
                "kind": "parseCsv",
                "input": "in/source.csv",
                "outputPrefix": prefix,
                "snapshotDigest": digest(data),
                "report": "out/partitions.json",
            },
        )

    def test_cuts_the_golden_input_into_one_ordered_partition(self) -> None:
        report = self.report(self.parse(GOLDEN))
        self.assertEqual(report["rowCount"], 3)
        self.assertEqual(len(report["partitions"]), 1)
        partition = report["partitions"][0]
        self.assertEqual(partition["index"], 0)
        self.assertEqual(partition["firstRowIndex"], 0)
        self.assertEqual(partition["rowCount"], 3)
        staged = (self.materials / partition["name"]).read_bytes()
        self.assertEqual(digest(staged), partition["digest"])
        self.assertEqual(staged.decode("utf-8"), GOLDEN)

    def test_cuts_on_the_ten_thousand_row_boundary_in_order(self) -> None:
        body = "\n".join(f"id{index},c{index % 3},{index}" for index in range(25_000))
        report = self.report(self.parse(f"{HEADER}\n{body}\n"))
        self.assertEqual(report["rowCount"], 25_000)
        self.assertEqual([entry["rowCount"] for entry in report["partitions"]], [10_000, 10_000, 5_000])
        self.assertEqual([entry["index"] for entry in report["partitions"]], [0, 1, 2])
        self.assertEqual([entry["firstRowIndex"] for entry in report["partitions"]], [0, 10_000, 20_000])

    def test_refuses_input_that_is_not_the_snapshot_it_was_dispatched_with(self) -> None:
        self.stage("in/source.csv", GOLDEN)
        result = self.invoke(
            "parseCsv",
            {
                "kind": "parseCsv",
                "input": "in/source.csv",
                "outputPrefix": "out/",
                "snapshotDigest": f"sha256:{'0' * 64}",
                "report": "out/partitions.json",
            },
        )
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_refuses_every_negative_fixture_by_name(self) -> None:
        for text, code in (
            (f"{HEADER}\na,alpha,1\na,beta,2\n", "record_id_duplicate"),
            (f"{HEADER}\na,alpha,{2**63}\n", "amount_overflow"),
            (f"{HEADER}\na,alpha\n", "row_field_count"),
            ("record_id,category,amount\na,alpha,1\n", "header_mismatch"),
            (f"{HEADER}\n", "row_empty"),
        ):
            with self.subTest(code=code):
                result = self.parse(text)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"]["code"], code)

    def test_refuses_a_duplicate_that_spans_two_partitions(self) -> None:
        rows = [f"id{index},alpha,{index}" for index in range(10_000)]
        rows.append("id0,beta,1")
        result = self.parse(f"{HEADER}\n" + "\n".join(rows) + "\n")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "record_id_duplicate")

    def test_refuses_a_material_name_that_leaves_the_mount(self) -> None:
        for prefix in ("../", "/absolute/", ""):
            with self.subTest(prefix=prefix):
                result = self.parse(GOLDEN, prefix=prefix)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"]["code"], "reference_data_command_invalid")


class Transform(GuestCase):
    def transform(self, text: str, *, digest_override: str | None = None) -> dict[str, Json]:
        data = self.stage("in/partition-00000.csv", text)
        return self.invoke(
            "transformPartition",
            {
                "kind": "transformPartition",
                "input": "in/partition-00000.csv",
                "output": "out/part-00000.parquet",
                "partitionIndex": 0,
                "firstRowIndex": 0,
                "partitionDigest": digest_override or digest(data),
                "report": "out/part-00000.summary.json",
            },
        )

    def test_writes_the_golden_partition_as_parquet_in_input_order(self) -> None:
        report = self.report(self.transform(GOLDEN))
        self.assertEqual(report["rowCount"], 3)
        self.assertEqual(report["totalAmountCents"], "400")
        parquet = (self.materials / "out/part-00000.parquet").read_bytes()
        self.assertEqual(digest(parquet), report["file"]["digest"])
        table = pq.read_table(io.BytesIO(parquet))
        self.assertEqual(table.column("record_id").to_pylist(), ["a", "b", "c"])
        self.assertEqual(table.column("amount_cents").to_pylist(), [100, 250, 50])

    def test_refuses_a_partition_that_is_not_the_one_it_was_dispatched_with(self) -> None:
        result = self.transform(GOLDEN, digest_override=f"sha256:{'1' * 64}")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")
        self.assertFalse((self.materials / "out/part-00000.parquet").exists())

    def test_refuses_an_overflowing_amount_without_writing_anything(self) -> None:
        result = self.transform(f"{HEADER}\na,alpha,{2**63}\n")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "amount_overflow")
        self.assertFalse((self.materials / "out/part-00000.parquet").exists())

    def test_refuses_a_missing_material(self) -> None:
        result = self.invoke(
            "transformPartition",
            {
                "kind": "transformPartition",
                "input": "in/absent.csv",
                "output": "out/part-00000.parquet",
                "partitionIndex": 0,
                "firstRowIndex": 0,
                "partitionDigest": f"sha256:{'2' * 64}",
                "report": "out/part-00000.summary.json",
            },
        )
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")


class Reduce(GuestCase):
    def partitions(self, count: int) -> list[dict[str, Json]]:
        entries: list[dict[str, Json]] = []
        for index in range(count):
            entries.append(
                {
                    "index": index,
                    "rowCount": 2,
                    "firstRowIndex": index * 2,
                    "totalAmountCents": "30",
                    "categories": [{"category": "alpha", "count": 2, "sumCents": "30"}],
                    "file": {"name": f"out/part-{index:05d}.parquet", "digest": digest(b"x"), "encodedBytes": 1},
                }
            )
        return entries

    def reduce(self, entries: list[Json]) -> dict[str, Json]:
        return self.invoke(
            "orderedReduce",
            {
                "kind": "orderedReduce",
                "partitions": entries,
                "snapshotDigest": digest(GOLDEN.encode()),
                "snapshotBytes": len(GOLDEN),
                "output": "out/manifest.json",
                "report": "out/dataset.json",
            },
        )

    def test_assembles_the_manifest_in_partition_order(self) -> None:
        report = self.report(self.reduce(self.partitions(3)))
        manifest = report["manifest"]
        self.assertEqual(manifest["rowCount"], 6)
        self.assertEqual(manifest["totalAmountCents"], "90")
        self.assertEqual(manifest["categories"], [{"category": "alpha", "count": 6, "sumCents": "90"}])
        expected = [f"out/part-{index:05d}.parquet" for index in range(3)]
        self.assertEqual([entry["name"] for entry in manifest["files"]], expected)
        written = json.loads((self.materials / "out/manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(written, manifest)

    def test_refuses_a_missing_partition_rather_than_closing_the_gap(self) -> None:
        entries = self.partitions(3)
        del entries[1]
        result = self.reduce(entries)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_refuses_partitions_presented_out_of_order(self) -> None:
        entries = self.partitions(3)
        entries[0], entries[1] = entries[1], entries[0]
        result = self.reduce(entries)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_refuses_a_row_offset_that_does_not_follow_the_previous_partition(self) -> None:
        entries = self.partitions(2)
        entries[1]["firstRowIndex"] = 7
        result = self.reduce(entries)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_refuses_an_empty_and_a_malformed_partition_list(self) -> None:
        malformed: list[list[Json]] = [[], ["not-an-object"], [{"index": 0, "rowCount": 1, "firstRowIndex": 0}]]
        for entries in malformed:
            with self.subTest(entries=entries):
                result = self.reduce(entries)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_keeps_exact_integer_sums_across_partitions(self) -> None:
        limit = 2**63 - 1
        entries = self.partitions(2)
        entries[0]["totalAmountCents"] = str(limit)
        entries[0]["categories"] = [{"category": "alpha", "count": 2, "sumCents": str(limit)}]
        entries[1]["totalAmountCents"] = "1"
        entries[1]["categories"] = [{"category": "alpha", "count": 2, "sumCents": "1"}]
        manifest = self.report(self.reduce(entries))["manifest"]
        self.assertEqual(manifest["totalAmountCents"], str(limit + 1))


class Contract(GuestCase):
    def test_refuses_a_request_the_shared_contract_refuses(self) -> None:
        broken = request({"kind": "snapshotCsv"}, "snapshotCsv")
        del broken["authority"]["attemptId"]
        result = self.guest.run(broken)
        self.assertEqual(result["status"], "failed")
        self.assertTrue(result["error"]["code"].startswith("RUNNER_"))
        self.assertFalse(result["error"]["retryable"])

    def test_refuses_a_command_that_is_not_inline(self) -> None:
        broken = request({"kind": "snapshotCsv"}, "snapshotCsv")
        artifact = {"artifactId": "a", "digest": f"sha256:{'b' * 64}", "encodedBytes": 1}
        broken["input"] = {"kind": "artifact", "artifact": artifact}
        result = self.guest.run(broken)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_refuses_a_command_that_names_no_export(self) -> None:
        result = self.guest.run(request({"report": "out/x.json"}, "snapshotCsv"))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_refuses_malformed_command_fields(self) -> None:
        for command in (
            {"kind": "snapshotCsv", "input": "", "sourceVersion": "v", "report": "out/x.json"},
            {"kind": "snapshotCsv", "input": "in/a", "sourceVersion": "v", "report": 5},
            {"kind": "transformPartition", "input": "in/a", "output": "out/a", "partitionIndex": -1,
             "firstRowIndex": 0, "partitionDigest": "d", "report": "out/x.json"},
            {"kind": "transformPartition", "input": "in/a", "output": "out/a", "partitionIndex": True,
             "firstRowIndex": 0, "partitionDigest": "d", "report": "out/x.json"},
        ):
            with self.subTest(command=command):
                result = self.guest.run(request(command, "snapshotCsv"))
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_every_result_it_emits_passes_the_shared_contract(self) -> None:
        self.stage("in/source.csv", GOLDEN)
        completed = self.invoke(
            "snapshotCsv",
            {"kind": "snapshotCsv", "input": "in/source.csv", "sourceVersion": "v1", "report": "out/snapshot.json"},
        )
        self.assertIsNone(self.guest.validate_result(completed))
        failed = self.guest.run(request({"report": "out/x.json"}, "snapshotCsv"))
        self.assertIsNone(self.guest.validate_result(failed))

    def test_refuses_a_request_that_is_not_an_object(self) -> None:
        result = self.guest.run("not-a-request")
        self.assertEqual(result["status"], "failed")

    def test_raises_when_it_would_have_emitted_an_invalid_result(self) -> None:
        incomplete = {"schemaVersion": "factory.runner.result.v1", "status": "completed"}
        with self.assertRaises(GuestError):
            self.guest.checked(incomplete)


class Launcher(GuestCase):
    def test_main_serves_frames_from_its_own_stdio(self) -> None:
        frames = io.StringIO('{"jsonrpc":"2.0","id":"1","method":"extension/discover"}\n')
        sink = io.StringIO()
        with patch.object(sys, "stdin", frames), patch.object(sys, "stdout", sink):
            self.assertEqual(main(SCHEMAS), 0)
        answered = json.loads(sink.getvalue().strip())
        self.assertEqual(answered["result"]["name"], "@ezcorp/reference-data")



class MaterialBoundary(GuestCase):
    """The guest opens only what is inside its own per-attempt directory."""

    def test_refuses_a_name_that_escapes_through_a_symbolic_link(self) -> None:
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: outside.rmdir())
        (self.materials / "out" / "escape").symlink_to(outside)
        with self.assertRaises(GuestError) as caught:
            data_guest._member("out/escape/stolen.parquet")
        self.assertIn("leaves the material directory", str(caught.exception))

    def test_refuses_an_unbounded_name(self) -> None:
        for name in ("", "/etc/passwd", "../outside", "out/../../outside"):
            with self.subTest(name=name), self.assertRaises(GuestError):
                data_guest._member(name)

    def test_refuses_a_write_whose_parent_is_a_file(self) -> None:
        (self.materials / "out" / "blocked").write_bytes(b"x")
        with self.assertRaises(GuestError) as caught:
            data_guest._write("out/blocked/child.json", b"{}")
        self.assertIn("unwritable", str(caught.exception))

    def test_refuses_a_command_envelope_that_is_not_an_object(self) -> None:
        for envelope in ("not-a-request", 5, [1], None):
            with self.subTest(envelope=envelope), self.assertRaises(GuestError):
                data_guest._command(envelope)

    def test_refuses_an_inline_value_that_is_not_an_object(self) -> None:
        broken = request({}, "snapshotCsv")
        broken["input"] = {"kind": "inline", "value": 5}
        result = self.guest.run(broken)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_refuses_a_non_integer_row_offset(self) -> None:
        data = self.stage("in/partition-00000.csv", GOLDEN)
        result = self.invoke(
            "transformPartition",
            {
                "kind": "transformPartition",
                "input": "in/partition-00000.csv",
                "output": "out/part-00000.parquet",
                "partitionIndex": 0,
                "firstRowIndex": "zero",
                "partitionDigest": digest(data),
                "report": "out/part-00000.summary.json",
            },
        )
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_refuses_to_overwrite_a_report_that_already_exists(self) -> None:
        self.stage("in/source.csv", GOLDEN)
        command = {
            "kind": "snapshotCsv",
            "input": "in/source.csv",
            "sourceVersion": "v1",
            "report": "out/snapshot.json",
        }
        self.assertEqual(self.invoke("snapshotCsv", command)["status"], "completed")
        repeated = self.invoke("snapshotCsv", command)
        self.assertEqual(repeated["status"], "failed")
        self.assertIn("written once", repeated["error"]["message"])

    def test_reports_an_unreadable_input_as_a_failed_attempt(self) -> None:
        result = self.invoke(
            "snapshotCsv",
            {"kind": "snapshotCsv", "input": "in/absent.csv", "sourceVersion": "v1", "report": "out/s.json"},
        )
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_hashes_an_input_larger_than_one_read_block(self) -> None:
        rows = "\n".join(f"id{index},alpha,{index}" for index in range(60_000))
        data = self.stage("in/large.csv", f"{HEADER}\n{rows}\n")
        self.assertGreater(len(data), 1024 * 1024)
        report = self.report(
            self.invoke(
                "snapshotCsv",
                {"kind": "snapshotCsv", "input": "in/large.csv", "sourceVersion": "v1", "report": "out/s.json"},
            )
        )
        self.assertEqual(report["digest"], digest(data))
        self.assertEqual(report["totalBytes"], len(data))

    def test_refuses_an_empty_input_at_the_parse_step(self) -> None:
        data = self.stage("in/source.csv", "")
        result = self.invoke(
            "parseCsv",
            {
                "kind": "parseCsv",
                "input": "in/source.csv",
                "outputPrefix": "out/",
                "snapshotDigest": digest(data),
                "report": "out/partitions.json",
            },
        )
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "reference_data_command_invalid")

    def test_refuses_more_partitions_than_the_declared_bound(self) -> None:
        rows = "\n".join(f"id{index},alpha,{index}" for index in range(3))
        data = self.stage("in/source.csv", f"{HEADER}\n{rows}\n")
        # The real bound is a hundred partitions of ten thousand rows; narrowing
        # both proves the refusal without a million-row fixture.
        with patch.object(data_guest, "MAX_PARTITIONS", 1), patch.object(data_guest, "PARTITION_ROWS", 2):
            result = self.invoke(
                "parseCsv",
                {
                    "kind": "parseCsv",
                    "input": "in/source.csv",
                    "outputPrefix": "out/",
                    "snapshotDigest": digest(data),
                    "report": "out/partitions.json",
                },
            )
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "row_limit")

    def test_dispatches_an_invoke_through_the_frame_method(self) -> None:
        self.stage("in/source.csv", GOLDEN)
        command = {
            "kind": "snapshotCsv",
            "input": "in/source.csv",
            "sourceVersion": "v1",
            "report": "out/snapshot.json",
        }
        frame = {"name": "snapshotCsv", "input": request(command, "snapshotCsv")}
        answered = self.guest.dispatch("extension/invoke", frame)
        self.assertEqual(cast("dict[str, Json]", answered)["status"], "completed")

    def test_parses_an_input_that_does_not_end_with_a_newline(self) -> None:
        data = self.stage("in/source.csv", GOLDEN.rstrip("\n"))
        report = self.report(
            self.invoke(
                "parseCsv",
                {
                    "kind": "parseCsv",
                    "input": "in/source.csv",
                    "outputPrefix": "out/",
                    "snapshotDigest": digest(data),
                    "report": "out/partitions.json",
                },
            )
        )
        self.assertEqual(report["rowCount"], 3)


if __name__ == "__main__":  # pragma: no cover - the lane runs discovery, not this module
    unittest.main()
