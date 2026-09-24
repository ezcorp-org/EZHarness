"""The staging contract in the Python runtime, both halves.

The frame builder is driven against a host double that reassembles what it is
sent and refuses a seal it cannot account for, so a correct digest here is
evidence the chunk boundaries were right rather than that three frames were
sent. The channel is driven against real text streams, because the one thing a
reverse call has to get right is sharing the reader with the host's own
requests.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import unittest
from typing import Any

from factory_ijson import canonicalize_json
from factory_materials import (
    DEFAULT_MEDIA_TYPE,
    FactoryGuestMaterialError,
    FactoryGuestStaging,
    checkpoint_object_name,
)
from factory_validation import (
    GUEST_MATERIAL_MAX_CHUNK_BYTES,
    GUEST_MATERIAL_MAX_TOTAL_BYTES,
    base64_bytes,
    valid_media_type,
    valid_object_name,
    validate_factory_guest_material_request,
    validate_factory_guest_material_response,
)
from guest import Guest, GuestError, HostChannel, serve
from tests import load

Json = Any

REQUEST_SCHEMA = load("factory-guest-material-request.schema.json")
RESPONSE_SCHEMA = load("factory-guest-material-response.schema.json")
RUNNER_REQUEST_SCHEMA = load("factory-runner-request.schema.json")
RUNNER_RESULT_SCHEMA = load("factory-runner-result.schema.json")

OPERATION_ID = "run-1:node-1:0:0"


def digest_of(content: bytes) -> str:
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


class HostDouble:
    """A host that stores what it is given and answers from what it stored."""

    def __init__(self) -> None:
        self.frames: list[dict[str, Json]] = []
        self._parts: dict[str, dict[int, bytes]] = {}
        self.refuse: dict[str, Json] | None = None
        self.answer: Json | None = None

    def __call__(self, frame: dict[str, Json]) -> Json:
        self.frames.append(frame)
        if self.answer is not None:
            return self.answer
        identity = {key: frame[key] for key in ("operationId", "operationIndex", "objectName", "version")}
        base = {"schemaVersion": "factory.guest-material-response.v1", **identity}
        if self.refuse is not None:
            return {**base, "status": "refused", "refusal": self.refuse}
        key = f"{frame['objectName']}:{frame['version']}"
        kind = frame["schemaVersion"]
        if kind == "factory.guest-material-begin.v1":
            self._parts[key] = {}
            return {**base, "status": "begun", "totalBytes": frame["totalBytes"], "chunkCount": frame["chunkCount"]}
        if kind == "factory.guest-material-chunk.v1":
            self._parts.setdefault(key, {})[frame["index"]] = base64.b64decode(frame["contentBase64"])
            return {**base, "status": "stored", "index": frame["index"], "digest": frame["digest"]}
        held = self._parts.get(key, {})
        assembled = b"".join(held[index] for index in sorted(held))
        if digest_of(assembled) != frame["digest"]:
            return {
                **base,
                "status": "refused",
                "refusal": {"code": "digest_mismatch", "message": "the assembled bytes disagree"},
            }
        reference = {"artifactId": "factory-artifact-1", "digest": digest_of(assembled), "encodedBytes": len(assembled)}
        if kind == "factory.guest-material-seal.v1":
            return {**base, "status": "sealed", "material": reference}
        return {**base, "status": "output", "output": reference, "resultDigest": hashlib.sha256(assembled).hexdigest()}


def staging(host: HostDouble) -> FactoryGuestStaging:
    return FactoryGuestStaging(host, OPERATION_ID, 0, REQUEST_SCHEMA, RESPONSE_SCHEMA)


class BoundsTest(unittest.TestCase):
    def test_a_chunk_is_one_recorded_page_and_the_total_fits_the_lifetime_budget(self) -> None:
        # Both runtimes chunk at the same bound, so a material staged in Python
        # and one staged in Bun produce the same chunk plan for the same bytes.
        self.assertEqual(GUEST_MATERIAL_MAX_CHUNK_BYTES, 32 * 1024)
        # Base64 costs a third more, and the framed channel counts every byte
        # this process writes for the life of the worker against one mebibyte.
        self.assertLess(-(-GUEST_MATERIAL_MAX_TOTAL_BYTES // 3) * 4, 1024 * 1024)

    def test_the_grammar_helpers_refuse_what_the_material_service_refuses(self) -> None:
        for value in ("application/json", "application/vnd.ez+json"):
            self.assertTrue(valid_media_type(value), value)
        rejected_media: tuple[Json, ...] = (
            "",
            "application",
            "application/json/extra",
            "/json",
            "Application/json",
            7,
            "a" * 65 + "/json",
        )
        for value in rejected_media:
            self.assertFalse(valid_media_type(value), repr(value))
        for value in ("report.json", "nested/report.json"):
            self.assertTrue(valid_object_name(value), value)
        rejected_names: tuple[Json, ...] = (
            "",
            "/absolute",
            "../escape",
            "a//b",
            "./here",
            "with\\\\backslash",
            "with:colon",
            "a\x00b",
            3,
            "x" * 513,
        )
        for value in rejected_names:
            self.assertFalse(valid_object_name(value), repr(value))
        self.assertEqual(base64_bytes("aGVsbG8="), 5)
        self.assertEqual(base64_bytes("aGVsbA=="), 4)
        rejected_base64: tuple[Json, ...] = ("", "AAA", "A$==", "A===", "=AAA", "AA=A", 5)
        for value in rejected_base64:
            self.assertEqual(base64_bytes(value), -1, repr(value))


class StagingTest(unittest.TestCase):
    def test_one_material_is_planned_chunked_sealed_and_returned(self) -> None:
        host = HostDouble()
        content = b"a staged python report"
        staged = staging(host).stage_output("report.bin", content)
        self.assertEqual(staged["digest"], digest_of(content))
        self.assertEqual(staged["totalBytes"], len(content))
        self.assertEqual(staged["version"], 1)
        self.assertEqual(
            [frame["schemaVersion"] for frame in host.frames],
            [
                "factory.guest-material-begin.v1",
                "factory.guest-material-chunk.v1",
                "factory.guest-material-seal.v1",
            ],
        )
        self.assertEqual(host.frames[0]["mediaType"], DEFAULT_MEDIA_TYPE)

    def test_a_material_past_one_page_is_split_into_chunks_that_reassemble(self) -> None:
        host = HostDouble()
        content = bytes((index * 7) % 251 for index in range(GUEST_MATERIAL_MAX_CHUNK_BYTES * 2 + 11))
        staged = staging(host).stage_output("big.bin", content)
        # The host double refuses a seal it cannot reassemble.
        self.assertEqual(staged["digest"], digest_of(content))
        chunks = [frame for frame in host.frames if frame["schemaVersion"] == "factory.guest-material-chunk.v1"]
        self.assertEqual([frame["index"] for frame in chunks], [0, 1, 2])
        self.assertEqual(
            [frame["encodedBytes"] for frame in chunks],
            [GUEST_MATERIAL_MAX_CHUNK_BYTES, GUEST_MATERIAL_MAX_CHUNK_BYTES, 11],
        )

    def test_a_sequence_is_drained_before_the_plan_is_committed(self) -> None:
        host = HostDouble()
        staged = staging(host).stage_output("stream.bin", iter([b"first ", b"second"]))
        self.assertEqual(staged["digest"], digest_of(b"first second"))
        # One chunk, because the plan comes from the assembled length rather
        # than from the producer's block sizes.
        self.assertEqual(len([f for f in host.frames if f["schemaVersion"].endswith("chunk.v1")]), 1)

    def test_a_sequence_past_the_total_bound_is_refused_before_a_frame_is_sent(self) -> None:
        host = HostDouble()
        blocks = iter([bytes(GUEST_MATERIAL_MAX_TOTAL_BYTES), b"x"])
        with self.assertRaises(FactoryGuestMaterialError) as raised:
            staging(host).stage_output("huge.bin", blocks)
        self.assertEqual(raised.exception.code, "oversize")
        self.assertEqual(host.frames, [])

    def test_a_frame_this_guest_built_wrong_never_reaches_the_host(self) -> None:
        host = HostDouble()
        with self.assertRaises(FactoryGuestMaterialError) as raised:
            staging(host).stage_output("../escape", b"x")
        self.assertEqual(raised.exception.code, "guest_frame_invalid")
        self.assertEqual(host.frames, [])

    def test_a_host_refusal_reaches_the_caller_under_the_hosts_own_name(self) -> None:
        host = HostDouble()
        host.refuse = {"code": "stale_epoch", "message": "the attempt fence moved"}
        with self.assertRaises(FactoryGuestMaterialError) as raised:
            staging(host).stage_output("late.bin", b"x")
        self.assertEqual(raised.exception.code, "stale_epoch")
        self.assertEqual(str(raised.exception), "the attempt fence moved")

    def test_an_answer_that_is_not_a_staging_response_is_a_protocol_failure(self) -> None:
        host = HostDouble()
        host.answer = {"ok": True}
        with self.assertRaises(FactoryGuestMaterialError) as raised:
            staging(host).stage_output("report.bin", b"x")
        self.assertEqual(raised.exception.code, "guest_response_invalid")

    def test_a_seal_or_a_promotion_answered_with_the_wrong_status_is_refused(self) -> None:
        host = HostDouble()
        client = staging(host)
        identity = {"operationId": OPERATION_ID, "operationIndex": 0, "objectName": "report.bin", "version": 1}
        begun = {
            "schemaVersion": "factory.guest-material-response.v1",
            **identity,
            "status": "begun",
            "totalBytes": 1,
            "chunkCount": 1,
        }

        def always_begun(frame: dict[str, Json]) -> Json:
            host.frames.append(frame)
            return begun

        wrong = FactoryGuestStaging(always_begun, OPERATION_ID, 0, REQUEST_SCHEMA, RESPONSE_SCHEMA)
        with self.assertRaises(FactoryGuestMaterialError) as sealed:
            wrong.stage_output("report.bin", b"x")
        self.assertEqual(sealed.exception.code, "guest_response_invalid")
        self.assertIn("A seal was answered with 'begun'", str(sealed.exception))

        with self.assertRaises(FactoryGuestMaterialError) as promoted:
            wrong.promote_output("report.bin", digest_of(b"x"))
        self.assertIn("A promotion was answered with 'begun'", str(promoted.exception))
        # The control: the real double promotes.
        client.stage_output("report.bin", b"x")
        self.assertEqual(client.promote_output("report.bin")["resultDigest"], hashlib.sha256(b"x").hexdigest())

    def test_a_json_result_is_staged_canonically_and_promoted(self) -> None:
        host = HostDouble()
        value = {"zeta": 1, "alpha": {"nested": [3, 2]}}
        canonical = canonicalize_json(value).encode("utf-8")
        promoted = staging(host).stage_result("result.json", value)
        self.assertEqual(promoted["resultDigest"], hashlib.sha256(canonical).hexdigest())
        self.assertEqual(promoted["output"]["digest"], digest_of(canonical))
        self.assertEqual(host.frames[0]["mediaType"], "application/json")
        self.assertEqual(host.frames[-1]["schemaVersion"], "factory.guest-material-output.v1")

    def test_staging_one_name_twice_advances_its_version(self) -> None:
        host = HostDouble()
        client = staging(host)
        client.stage_output("report.bin", b"one")
        client.stage_output("report.bin", b"two")
        plans = [f["version"] for f in host.frames if f["schemaVersion"].endswith("begin.v1")]
        self.assertEqual(plans, [1, 2])
        self.assertEqual(client.promote_output("report.bin")["resultDigest"], hashlib.sha256(b"two").hexdigest())
        self.assertEqual(host.frames[-1]["version"], 2)
        # An earlier version, named explicitly.
        self.assertEqual(
            client.promote_output("report.bin", digest_of(b"one"), 1)["resultDigest"],
            hashlib.sha256(b"one").hexdigest(),
        )
        self.assertEqual(host.frames[-1]["version"], 1)

    def test_a_promotion_with_nothing_staged_and_no_digest_is_refused_here(self) -> None:
        host = HostDouble()
        with self.assertRaises(FactoryGuestMaterialError) as raised:
            staging(host).promote_output("never-staged.json")
        self.assertEqual(raised.exception.code, "guest_frame_invalid")
        self.assertEqual(host.frames, [])

    def test_a_checkpoint_is_a_real_material_named_by_its_cursor(self) -> None:
        host = HostDouble()
        client = staging(host)
        attempt = client.stage_checkpoint({"transcript": []}, -1)
        self.assertEqual(attempt["journalCursor"], -1)
        self.assertEqual(host.frames[0]["objectName"], "workspace/attempt.json")
        operation = client.stage_checkpoint({"transcript": ["one"]}, 4)
        self.assertEqual(operation["journalCursor"], 4)
        self.assertEqual(host.frames[-1]["objectName"], "workspace/operation-4.json")
        self.assertEqual(checkpoint_object_name(0), "workspace/operation-0.json")
        cursors: tuple[Json, ...] = (-2, True, "0")
        for cursor in cursors:
            with self.assertRaises(FactoryGuestMaterialError):
                checkpoint_object_name(cursor)


class ParityTest(unittest.TestCase):
    def test_the_validators_refuse_the_same_frames_the_bun_runtime_refuses(self) -> None:
        content = b"a staged conformance material"
        identity = {"operationId": OPERATION_ID, "operationIndex": 0, "objectName": "report.json", "version": 1}
        begin = {
            "schemaVersion": "factory.guest-material-begin.v1",
            **identity,
            "mediaType": "application/json",
            "totalBytes": len(content),
            "chunkCount": 1,
        }
        chunk = {
            "schemaVersion": "factory.guest-material-chunk.v1",
            **identity,
            "index": 0,
            "digest": digest_of(content),
            "encodedBytes": len(content),
            "contentBase64": base64.b64encode(content).decode(),
        }
        for frame in (
            begin,
            chunk,
            {"schemaVersion": "factory.guest-material-seal.v1", **identity, "digest": digest_of(content)},
        ):
            self.assertIsNone(
                validate_factory_guest_material_request(frame, REQUEST_SCHEMA).issue, frame["schemaVersion"]
            )
        requests: tuple[tuple[Json, str], ...] = (
            (None, "GUEST_MATERIAL_SCHEMA"),
            ({**begin, "operationId": "run-1:node-1:0:9"}, "GUEST_MATERIAL_OPERATION"),
            ({**begin, "objectName": "../escape"}, "GUEST_MATERIAL_NAME"),
            ({**begin, "version": 0}, "GUEST_MATERIAL_VERSION"),
            ({**begin, "mediaType": "application"}, "GUEST_MATERIAL_MEDIA_TYPE"),
            ({**begin, "totalBytes": 99_999_999}, "GUEST_MATERIAL_BYTES"),
            ({**begin, "chunkCount": 65}, "GUEST_MATERIAL_CHUNK_COUNT"),
            ({**begin, "chunkCount": 40}, "GUEST_MATERIAL_CHUNK_COUNT"),
            ({**chunk, "index": 64}, "GUEST_MATERIAL_CHUNK_INDEX"),
            ({**chunk, "digest": hashlib.sha256(content).hexdigest()}, "GUEST_MATERIAL_DIGEST"),
            ({**chunk, "encodedBytes": 32_769}, "GUEST_MATERIAL_CHUNK_BYTES"),
            ({**chunk, "encodedBytes": 4}, "GUEST_MATERIAL_CHUNK_CONTENT"),
            (
                {"schemaVersion": "factory.guest-material-seal.v1", **identity, "digest": "sha256:zz"},
                "GUEST_MATERIAL_DIGEST",
            ),
        )
        for value, code in requests:
            issue = validate_factory_guest_material_request(value, REQUEST_SCHEMA).issue
            self.assertIsNotNone(issue, repr(value)[:80])
            assert issue is not None
            self.assertEqual(issue.code, code, repr(value)[:80])

    def test_every_response_variant_validates_and_each_wrong_field_is_named(self) -> None:
        identity = {"operationId": OPERATION_ID, "operationIndex": 0, "objectName": "report.json", "version": 1}
        base = {"schemaVersion": "factory.guest-material-response.v1", **identity}
        reference = {"artifactId": "object-1", "digest": digest_of(b"x"), "encodedBytes": 1}
        begun = {**base, "status": "begun", "totalBytes": 1, "chunkCount": 1}
        stored = {**base, "status": "stored", "index": 0, "digest": digest_of(b"x")}
        sealed = {**base, "status": "sealed", "material": reference}
        output = {**base, "status": "output", "output": reference, "resultDigest": hashlib.sha256(b"x").hexdigest()}
        refused = {**base, "status": "refused", "refusal": {"code": "stale_epoch", "message": "moved"}}
        for value in (begun, stored, sealed, output, refused):
            self.assertIsNone(validate_factory_guest_material_response(value, RESPONSE_SCHEMA).issue, value["status"])
        responses: tuple[tuple[Json, str], ...] = (
            (None, "GUEST_MATERIAL_SCHEMA"),
            ({**refused, "refusal": {"code": "not_a_name", "message": "x"}}, "GUEST_MATERIAL_SCHEMA"),
            ({**begun, "operationId": "other:9"}, "GUEST_MATERIAL_OPERATION"),
            ({**refused, "refusal": {"code": "stale_epoch", "message": ""}}, "GUEST_MATERIAL_REFUSAL"),
            ({**begun, "totalBytes": 0}, "GUEST_MATERIAL_BYTES"),
            ({**stored, "index": -1}, "GUEST_MATERIAL_CHUNK_INDEX"),
            ({**stored, "digest": "sha256:zz"}, "GUEST_MATERIAL_DIGEST"),
            ({**sealed, "material": {**reference, "artifactId": "a/b"}}, "RUNNER_ARTIFACT_ID"),
            ({**output, "output": {**reference, "digest": "nope"}}, "RUNNER_DIGEST"),
            ({**output, "resultDigest": digest_of(b"x")}, "GUEST_MATERIAL_DIGEST"),
        )
        for value, code in responses:
            issue = validate_factory_guest_material_response(value, RESPONSE_SCHEMA).issue
            self.assertIsNotNone(issue, repr(value)[:80])
            assert issue is not None
            self.assertEqual(issue.code, code, repr(value)[:80])


def frames(text: str) -> list[dict[str, Json]]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


class HostChannelTest(unittest.TestCase):
    def test_a_reverse_call_writes_its_request_and_returns_the_hosts_result(self) -> None:
        sink = io.StringIO()
        channel = HostChannel(
            io.StringIO(json.dumps({"jsonrpc": "2.0", "id": "guest-1", "result": {"ok": True}}) + "\n"), sink
        )
        self.assertEqual(channel.call("factory.broker", {"input": 1}), {"ok": True})
        self.assertEqual(
            frames(sink.getvalue()),
            [{"jsonrpc": "2.0", "id": "guest-1", "method": "factory.broker", "params": {"input": 1}}],
        )

    def test_a_host_error_is_raised_rather_than_returned(self) -> None:
        channel = HostChannel(
            io.StringIO(
                json.dumps(
                    {"jsonrpc": "2.0", "id": "guest-1", "error": {"code": -32000, "message": "refused by the host"}}
                )
                + "\n"
            ),
            io.StringIO(),
        )
        with self.assertRaises(GuestError) as raised:
            channel.call("factory.broker", {})
        self.assertEqual(str(raised.exception), "refused by the host")

    def test_a_closed_channel_is_an_error_rather_than_a_silent_none(self) -> None:
        channel = HostChannel(io.StringIO(""), io.StringIO())
        with self.assertRaises(GuestError) as raised:
            channel.call("factory.broker", {})
        self.assertIn("closed the control channel", str(raised.exception))

    def test_a_host_request_arriving_mid_call_is_answered_rather_than_dropped(self) -> None:
        sink = io.StringIO()
        source = io.StringIO(
            json.dumps({"jsonrpc": "2.0", "id": 7, "method": "extension/discover"})
            + "\n"
            + json.dumps({"jsonrpc": "2.0", "id": "guest-1", "result": {"ok": True}})
            + "\n"
        )
        channel = HostChannel(source, sink)
        self.assertEqual(channel.call("factory.broker", {}), {"ok": True})
        answered = frames(sink.getvalue())
        # The interleaved request is answered, and with a refusal rather than a
        # result: a guest in the middle of its own reverse call cannot also be
        # dispatching one.
        self.assertEqual(answered[1]["id"], 7)
        self.assertIn("cannot take another request", answered[1]["error"]["message"])

    def test_the_reader_answers_malformed_frames_and_keeps_serving(self) -> None:
        sink = io.StringIO()
        source = io.StringIO(
            "\n"
            + "x" * (1024 * 1024 + 1)
            + "\n"
            + "{not json\n"
            + json.dumps(["not", "an", "object"])
            + "\n"
            + json.dumps({"jsonrpc": "2.0", "id": 1, "params": {}})
            + "\n"
            + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "extension/cancel"})
            + "\n"
        )
        guest = Guest(RUNNER_REQUEST_SCHEMA, RUNNER_RESULT_SCHEMA)
        self.assertEqual(HostChannel(source, sink).serve(guest), 0)
        answered = frames(sink.getvalue())
        self.assertEqual(
            [answer.get("error", {}).get("code") for answer in answered[:4]], [-32600, -32700, -32600, -32600]
        )
        self.assertEqual(answered[-1], {"jsonrpc": "2.0", "id": 2, "result": {"cancelled": True}})


class StageExportTest(unittest.TestCase):
    def guest(self) -> Guest:
        return Guest(RUNNER_REQUEST_SCHEMA, RUNNER_RESULT_SCHEMA, None, None, REQUEST_SCHEMA, RESPONSE_SCHEMA)

    def test_a_guest_with_no_channel_or_no_schemas_refuses_to_stage(self) -> None:
        with self.assertRaises(GuestError) as raised:
            self.guest().staging({}, OPERATION_ID, 0)
        self.assertIn("no control channel", str(raised.exception))
        bare = Guest(RUNNER_REQUEST_SCHEMA, RUNNER_RESULT_SCHEMA)
        bare.attach(HostChannel(io.StringIO(""), io.StringIO()))
        with self.assertRaises(GuestError) as missing:
            bare.staging({}, OPERATION_ID, 0)
        self.assertIn("guest material schemas", str(missing.exception))

    def test_the_stage_export_refuses_a_payload_it_cannot_act_on(self) -> None:
        guest = self.guest()
        guest.attach(HostChannel(io.StringIO(""), io.StringIO()))
        payloads: tuple[Json, ...] = (
            None,
            {"operationId": OPERATION_ID},
            {"operationId": OPERATION_ID, "operationIndex": 0, "journalCursor": "x"},
        )
        for payload in payloads:
            with self.assertRaises(GuestError):
                guest.invoke({"name": "stage", "input": payload, "context": {}})

    def test_the_stage_export_names_the_refusal_that_stopped_it(self) -> None:
        # The host answers every frame with a refusal, which is what a
        # superseded attempt does.
        refusal = {"code": "stale_epoch", "message": "the attempt fence moved"}

        def answers(count: int) -> str:
            return "".join(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": f"guest-{index + 1}",
                        "result": {
                            "schemaVersion": "factory.guest-material-response.v1",
                            "operationId": OPERATION_ID,
                            "operationIndex": 0,
                            "objectName": "result.json",
                            "version": 1,
                            "status": "refused",
                            "refusal": refusal,
                        },
                    }
                )
                + "\n"
                for index in range(count)
            )

        guest = self.guest()
        guest.attach(HostChannel(io.StringIO(answers(1)), io.StringIO()))
        with self.assertRaises(GuestError) as raised:
            guest.invoke(
                {
                    "name": "stage",
                    "input": {"operationId": OPERATION_ID, "operationIndex": 0, "value": {"a": 1}},
                    "context": {},
                }
            )
        self.assertIn("staging refused: stale_epoch", str(raised.exception))

    def test_the_stage_export_answers_with_a_valid_completed_result(self) -> None:
        # A scripted host that behaves exactly as the real broker does for this
        # sequence: begin, chunk, seal, promote, then the checkpoint's three.
        value = {"python": "staged"}
        canonical = canonicalize_json(value).encode("utf-8")
        checkpoint_bytes = canonicalize_json({"cursor": -1}).encode("utf-8")
        host = HostDouble()
        sink = io.StringIO()

        class Scripted(HostChannel):
            def call(self, method: str, params: Json) -> Json:
                return host(params["input"])

        guest = self.guest()
        guest.attach(Scripted(io.StringIO(""), sink))
        result = guest.invoke(
            {
                "name": "stage",
                "input": {"operationId": OPERATION_ID, "operationIndex": 0, "value": value},
                "context": {"workerId": "w"},
            }
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["journalCursor"], -1)
        self.assertEqual(result["resultDigest"], hashlib.sha256(canonical).hexdigest())
        self.assertEqual(result["output"]["digest"], digest_of(canonical))
        self.assertEqual(result["workspaceCheckpoint"]["journalCursor"], -1)
        self.assertEqual(result["workspaceCheckpoint"]["digest"], digest_of(checkpoint_bytes))
        # The result the host will receive passes the shared contract, which is
        # the check a guest owes before its answer crosses the wire.
        self.assertIsNone(Guest(RUNNER_REQUEST_SCHEMA, RUNNER_RESULT_SCHEMA).verdict("result", result).get("code"))
        self.assertEqual(host.frames[0]["objectName"], "result.json")
        self.assertEqual(host.frames[-1]["objectName"], "workspace/attempt.json")

    def test_serve_attaches_the_channel_so_a_served_guest_can_stage(self) -> None:
        sink = io.StringIO()
        source = io.StringIO(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "extension/discover"}) + "\n")
        guest = self.guest()
        self.assertEqual(serve(guest, source, sink), 0)
        # `attach` ran, so `staging` now reports a missing schema or builds a
        # client rather than reporting a missing channel.
        client = guest.staging({}, OPERATION_ID, 0)
        self.assertIsInstance(client, FactoryGuestStaging)


if __name__ == "__main__":
    unittest.main()
