"""The guest protocol: what it answers, what it refuses, and how bytes move."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import subprocess
import sys
import types
import unittest
from typing import Any
from unittest import mock

import image_guest
from image_guest import (
    CHUNK_BYTES,
    MANIFEST,
    Guest,
    GuestError,
    digest_of,
    encode_pillow_png,
    main,
    run_tesseract,
    serve,
)
from reference_image.ocr_report import OcrError
from reference_image.png_format import parse_png
from reference_image.png_normalize import decode_scanlines, normalize_png
from reference_image.sdxl import load_pipeline

from . import make_png, text_chunk, tsv

CLAIM_INPUT = {
    "width": 4,
    "height": 3,
    "colourModes": ["RGB"],
    "bitDepth": 8,
    "maximumBytes": 10 * 1024 * 1024,
    "allowedChunks": ["IHDR", "PLTE", "IDAT", "IEND"],
    "language": "eng",
    "pageSegmentationMode": 11,
    "engineMode": 3,
    "minimumWordConfidence": 60,
}


def fixed_clock() -> float:
    return 1.5


class TransferTest(unittest.TestCase):
    def test_a_sealed_upload_is_addressed_by_the_digest_of_its_bytes(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        data = make_png(4, 3)
        first = guest.put({"name": "v", "data": base64.b64encode(data[:10]).decode()})
        self.assertEqual(first, {"name": "v", "received": 10, "sealed": False})
        sealed = guest.put({"name": "v", "data": base64.b64encode(data[10:]).decode(), "final": True})
        self.assertEqual(sealed["digest"], digest_of(data))
        self.assertEqual(sealed["bytes"], len(data))
        self.assertEqual(guest.held[digest_of(data)], data)

    def test_a_partial_upload_is_discarded_once_sealed_so_a_name_can_be_reused(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        guest.put({"name": "v", "data": base64.b64encode(b"abc").decode(), "final": True})
        again = guest.put({"name": "v", "data": base64.b64encode(b"z").decode()})
        self.assertEqual(again["received"], 1)

    def test_fetching_walks_the_whole_image_in_pieces_that_reassemble_exactly(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        data = bytes(range(256)) * 4096
        identity = digest_of(data)
        guest.held[identity] = data
        pieces: list[bytes] = []
        offset = 0
        while True:
            answer = guest.fetch({"digest": identity, "offset": offset})
            pieces.append(base64.b64decode(answer["data"]))
            offset += int(answer["length"])
            if int(answer["remaining"]) == 0:
                break
        self.assertEqual(b"".join(pieces), data)
        self.assertGreater(len(pieces), 1)

    def test_the_caller_can_ask_for_a_smaller_piece(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        data = bytes(range(256)) * 8
        guest.held[digest_of(data)] = data
        answer = guest.fetch({"digest": digest_of(data), "offset": 0, "maximum": 100})
        self.assertEqual(answer["length"], 100)
        self.assertEqual(answer["remaining"], len(data) - 100)

    def test_a_piece_size_above_the_ceiling_is_clamped_rather_than_honoured(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        data = bytes(CHUNK_BYTES * 2)
        guest.held[digest_of(data)] = data
        answer = guest.fetch({"digest": digest_of(data), "offset": 0, "maximum": CHUNK_BYTES * 4})
        self.assertEqual(answer["length"], CHUNK_BYTES)

    def test_a_piece_size_below_one_byte_is_refused(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        guest.held[digest_of(b"abc")] = b"abc"
        with self.assertRaises(GuestError):
            guest.fetch({"digest": digest_of(b"abc"), "offset": 0, "maximum": 0})

    def test_a_piece_never_exceeds_the_transfer_size(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        data = bytes(CHUNK_BYTES * 2 + 7)
        guest.held[digest_of(data)] = data
        answer = guest.fetch({"digest": digest_of(data), "offset": 0})
        self.assertEqual(answer["length"], CHUNK_BYTES)

    def test_fetching_at_the_end_returns_nothing_left(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        guest.held[digest_of(b"abc")] = b"abc"
        answer = guest.fetch({"digest": digest_of(b"abc"), "offset": 3})
        self.assertEqual((answer["length"], answer["remaining"]), (0, 0))

    def test_fetching_an_unheld_image_is_refused(self) -> None:
        with self.assertRaises(GuestError):
            Guest("/opt/model", fixed_clock).fetch({"digest": "sha256:" + "0" * 64, "offset": 0})

    def test_an_offset_outside_the_image_is_refused(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        guest.held[digest_of(b"abc")] = b"abc"
        for offset in (-1, 4):
            with self.subTest(offset=offset), self.assertRaises(GuestError):
                guest.fetch({"digest": digest_of(b"abc"), "offset": offset})


class NormalizeToolTest(unittest.TestCase):
    def test_normalizing_holds_the_rewritten_bytes_under_their_own_digest(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        source = make_png(4, 3, extra_chunks=(text_chunk(),))
        guest.held[digest_of(source)] = source
        answer = guest.normalize({"digest": digest_of(source), "compressLevel": 6})
        expected = normalize_png(source, 6)
        self.assertEqual(answer["digest"], digest_of(expected))
        self.assertEqual(guest.held[str(answer["digest"])], expected)
        self.assertEqual(answer["sourceBytes"], len(source))

    def test_an_unreadable_source_reports_an_error_rather_than_raising(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        guest.held[digest_of(b"junk")] = b"junk"
        answer = guest.normalize({"digest": digest_of(b"junk"), "compressLevel": 6})
        self.assertEqual(answer["error"], {"code": "png_signature_missing", "message": mock.ANY})
        self.assertNotIn("digest", answer)

    def test_normalizing_an_unheld_image_is_refused(self) -> None:
        with self.assertRaises(GuestError):
            Guest("/opt/model", fixed_clock).normalize({"digest": "sha256:" + "0" * 64, "compressLevel": 6})


class ClaimsToolTest(unittest.TestCase):
    def _guest_with(self, data: bytes) -> tuple[Guest, str]:
        guest = Guest("/opt/model", fixed_clock)
        guest.held[digest_of(data)] = data
        return guest, digest_of(data)

    def test_reports_all_five_claims_with_the_frozen_clock(self) -> None:
        guest, identity = self._guest_with(normalize_png(make_png(4, 3), 6))
        with mock.patch.object(image_guest, "run_tesseract", return_value=(tsv((("10", "smudge"),)), ("tesseract",))):
            report = guest.claims({"digest": identity, **CLAIM_INPUT})
        self.assertEqual(report["schemaVersion"], "factory.validator-claims.v1")
        self.assertEqual([claim["id"] for claim in report["claims"]], [
            "png-single-frame",
            "png-dimensions-color",
            "png-size",
            "png-no-extra-payload",
            "ocr-no-text",
        ])
        self.assertEqual({claim["measuredAtMs"] for claim in report["claims"]}, {1500})
        self.assertEqual({claim["verdict"] for claim in report["claims"]}, {"PASS"})

    def test_a_caption_fails_only_the_text_claim(self) -> None:
        guest, identity = self._guest_with(normalize_png(make_png(4, 3), 6))
        with mock.patch.object(image_guest, "run_tesseract", return_value=(tsv((("93", "SALE"),)), ("tesseract",))):
            report = guest.claims({"digest": identity, **CLAIM_INPUT})
        failed = [claim["id"] for claim in report["claims"] if claim["verdict"] == "FAIL"]
        self.assertEqual(failed, ["ocr-no-text"])

    def test_an_engine_failure_leaves_the_text_claim_unmeasured(self) -> None:
        guest, identity = self._guest_with(normalize_png(make_png(4, 3), 6))
        error = OcrError("ocr_engine_unavailable", "no binary")
        with mock.patch.object(image_guest, "run_tesseract", side_effect=error):
            report = guest.claims({"digest": identity, **CLAIM_INPUT})
        text = next(claim for claim in report["claims"] if claim["id"] == "ocr-no-text")
        self.assertEqual(text["verdict"], "VALIDATOR_ERROR")

    def test_claiming_an_unheld_image_is_refused(self) -> None:
        with self.assertRaises(GuestError):
            Guest("/opt/model", fixed_clock).claims({"digest": "sha256:" + "0" * 64, **CLAIM_INPUT})


class GenerateToolTest(unittest.TestCase):
    def _pipeline_modules(self) -> dict[str, Any]:
        class Image:
            size = (4, 3)

            def convert(self, mode: str) -> Image:
                assert mode == "RGB"
                return self

            def tobytes(self) -> bytes:
                return bytes([7, 8, 9]) * 12

        class Pipe:
            def to(self, device: str) -> Pipe:
                return self

            def __call__(self, **kwargs: Any) -> Any:  # noqa: ANN401
                return types.SimpleNamespace(images=[Image()])

        diffusers = types.ModuleType("diffusers")
        diffusers.StableDiffusionXLPipeline = types.SimpleNamespace(from_pretrained=lambda directory, **kw: Pipe())  # type: ignore[attr-defined]
        torch = types.ModuleType("torch")
        torch.float16 = "fp16"  # type: ignore[attr-defined]
        torch.__version__ = "2.12.0+rocm7.14.1"  # type: ignore[attr-defined]
        torch.version = types.SimpleNamespace(hip="7.14.60850", cuda=None)  # type: ignore[attr-defined]
        torch.Generator = lambda device: types.SimpleNamespace(manual_seed=lambda seed: f"g{seed}")  # type: ignore[attr-defined]
        return {"diffusers": diffusers, "torch": torch}

    def test_generating_holds_the_variant_and_reports_its_settings(self) -> None:
        guest = Guest("/opt/reference-image/model", fixed_clock)
        request = {
            "seed": 23,
            "prompt": "One green oak tree on a plain white background, no text.",
            "inferenceSteps": 30,
            "guidance": 7.5,
            "width": 1024,
            "height": 1024,
            "dtype": "float16",
            "device": "cuda",
        }
        with mock.patch.dict(sys.modules, self._pipeline_modules()):
            answer = guest.generate(request)
        self.assertEqual(answer["seed"], 23)
        self.assertEqual(answer["settings"], {
            "inferenceSteps": 30,
            "guidance": 7.5,
            "width": 1024,
            "height": 1024,
            "dtype": "float16",
            "device": "cuda",
        })
        self.assertEqual(answer["runtime"], {"torch": "2.12.0+rocm7.14.1", "hip": "7.14.60850"})
        held = guest.held[str(answer["digest"])]
        self.assertEqual(digest_of(held), answer["digest"])
        self.assertEqual(parse_png(held).header.width, 4)

    def test_the_pipeline_is_loaded_once_and_reused_across_seeds(self) -> None:
        guest = Guest("/opt/reference-image/model", fixed_clock)
        request = {
            "seed": 11,
            "prompt": "tree",
            "inferenceSteps": 30,
            "guidance": 7.5,
            "width": 1024,
            "height": 1024,
            "dtype": "float16",
            "device": "cuda",
        }
        with mock.patch.dict(sys.modules, self._pipeline_modules()), mock.patch.object(
            image_guest, "load_pipeline", wraps=load_pipeline
        ) as loader:
            guest.generate(request)
            guest.generate({**request, "seed": 37})
        self.assertEqual(loader.call_count, 1)

    def test_a_generation_failure_becomes_a_named_guest_error(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        request = {
            "seed": -5,
            "prompt": "tree",
            "inferenceSteps": 30,
            "guidance": 7.5,
            "width": 1024,
            "height": 1024,
            "dtype": "float16",
            "device": "cuda",
        }
        guest.pipeline = lambda **kwargs: types.SimpleNamespace(images=["x"])
        with self.assertRaises(GuestError) as caught:
            guest.invoke({"name": "generate", "input": request})
        self.assertIn("generation_seed_invalid", str(caught.exception))


class EncodeImageTest(unittest.TestCase):
    def test_the_pipeline_image_is_written_by_this_pack_rather_than_the_library(self) -> None:
        class Image:
            size = (2, 2)

            def convert(self, mode: str) -> Image:
                return self

            def tobytes(self) -> bytes:
                return bytes([1, 2, 3] * 4)

        written = encode_pillow_png(Image())
        self.assertEqual(parse_png(written).kinds, ("IHDR", "IDAT", "IEND"))
        self.assertEqual(decode_scanlines(parse_png(written)), bytes([1, 2, 3] * 4))


class TesseractTest(unittest.TestCase):
    def test_runs_the_pinned_command_against_the_written_image(self) -> None:
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="level\tconf\ttext\n", stderr="")
        with mock.patch.object(subprocess, "run", return_value=completed) as runner:
            document, command = run_tesseract(b"png bytes", "eng", 11, 3)
        self.assertEqual(document, "level\tconf\ttext\n")
        self.assertEqual(command[0], "tesseract")
        self.assertEqual(command[3:], ("-l", "eng", "--psm", "11", "--oem", "3", "tsv"))
        passed = runner.call_args.args[0]
        self.assertEqual(tuple(passed), command)

    def test_a_non_zero_exit_is_an_engine_failure(self) -> None:
        completed = subprocess.CompletedProcess(args=[], returncode=2, stdout="", stderr="boom")
        with mock.patch.object(subprocess, "run", return_value=completed), self.assertRaises(
            OcrError
        ) as caught:
            run_tesseract(b"png", "eng", 11, 3)
        self.assertEqual(caught.exception.code, "ocr_engine_failed")

    def test_a_missing_binary_is_an_engine_failure(self) -> None:
        with mock.patch.object(subprocess, "run", side_effect=FileNotFoundError("no tesseract")), self.assertRaises(
            OcrError
        ) as caught:
            run_tesseract(b"png", "eng", 11, 3)
        self.assertEqual(caught.exception.code, "ocr_engine_unavailable")

    def test_a_timeout_is_an_engine_failure(self) -> None:
        expired = subprocess.TimeoutExpired(cmd="tesseract", timeout=120)
        with mock.patch.object(subprocess, "run", side_effect=expired), self.assertRaises(
            OcrError
        ) as caught:
            run_tesseract(b"png", "eng", 11, 3)
        self.assertEqual(caught.exception.code, "ocr_engine_unavailable")


class FixturesToolTest(unittest.TestCase):
    def test_it_holds_the_caption_and_its_blank_control(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        drawn = guest.fixtures({"width": 256, "height": 128, "scale": 8, "compressLevel": 6})
        self.assertEqual(set(drawn), {"caption", "blank"})
        for entry in drawn.values():
            self.assertIn(entry["digest"], guest.held)
            self.assertEqual(len(guest.held[entry["digest"]]), entry["bytes"])
        self.assertNotEqual(drawn["caption"]["digest"], drawn["blank"]["digest"])

    def test_the_two_fixtures_differ_only_by_the_caption(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        drawn = guest.fixtures({"width": 256, "height": 128, "scale": 8, "compressLevel": 6})
        caption = parse_png(guest.held[str(drawn["caption"]["digest"])])
        blank = parse_png(guest.held[str(drawn["blank"]["digest"])])
        self.assertEqual((caption.header.width, caption.header.height), (blank.header.width, blank.header.height))
        self.assertGreater(caption.total_bytes, blank.total_bytes)

    def test_a_caption_that_cannot_be_drawn_becomes_a_named_guest_error(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        with self.assertRaises(GuestError) as caught:
            guest.invoke({"name": "fixtures", "input": {"width": 40, "height": 128, "scale": 24, "compressLevel": 6}})
        self.assertIn("fixture_text_too_wide", str(caught.exception))


class DispatchTest(unittest.TestCase):
    def test_discovery_returns_the_manifest(self) -> None:
        self.assertEqual(Guest("/opt/model", fixed_clock).dispatch("extension/discover", None), MANIFEST)

    def test_the_manifest_lists_every_tool_the_guest_answers(self) -> None:
        named = {str(tool["name"]) for tool in MANIFEST["tools"]}
        self.assertEqual(named, {"put", "fetch", "generate", "normalize", "claims", "runtime", "fixtures"})

    def test_the_manifest_declares_no_permission(self) -> None:
        self.assertEqual(MANIFEST["permissions"], {})

    def test_cancellation_is_acknowledged(self) -> None:
        self.assertEqual(Guest("/opt/model", fixed_clock).dispatch("extension/cancel", None), {"cancelled": True})

    def test_an_unknown_method_is_refused(self) -> None:
        with self.assertRaises(GuestError):
            Guest("/opt/model", fixed_clock).dispatch("extension/publish", None)

    def test_an_unknown_export_is_refused(self) -> None:
        with self.assertRaises(GuestError):
            Guest("/opt/model", fixed_clock).invoke({"name": "exfiltrate", "input": {}})

    def test_invoke_requires_an_object(self) -> None:
        with self.assertRaises(GuestError):
            Guest("/opt/model", fixed_clock).invoke(["not", "an", "object"])

    def test_the_runtime_tool_reports_the_guest_version(self) -> None:
        torch = types.ModuleType("torch")
        torch.__version__ = "2.12.0"  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"torch": torch}):
            answer = Guest("/opt/model", fixed_clock).runtime(None)
        self.assertEqual(answer["guest"], "factory.reference-image-guest.v1")

    def test_a_missing_input_names_the_field(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        with self.assertRaises(GuestError) as caught:
            guest.fetch({"digest": "sha256:" + "0" * 64})
        self.assertIn("offset", str(caught.exception))

    def test_a_field_of_the_wrong_type_is_refused(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        with self.assertRaises(GuestError):
            guest.fetch({"digest": 5, "offset": 0})
        with self.assertRaises(GuestError):
            guest.fetch({"digest": "sha256:" + "0" * 64, "offset": True})

    def test_a_non_object_parameter_set_is_refused(self) -> None:
        guest = Guest("/opt/model", fixed_clock)
        with self.assertRaises(GuestError):
            guest.fetch("digest")


class ServeTest(unittest.TestCase):
    def _answers(self, lines: list[str]) -> list[dict[str, Any]]:
        sink = io.StringIO()
        serve(Guest("/opt/model", fixed_clock), io.StringIO("".join(f"{line}\n" for line in lines)), sink)
        return [json.loads(line) for line in sink.getvalue().splitlines()]

    def test_answers_a_well_formed_request(self) -> None:
        answers = self._answers([json.dumps({"jsonrpc": "2.0", "id": 1, "method": "extension/discover"})])
        self.assertEqual(answers[0]["result"], MANIFEST)

    def test_an_invoke_frame_reaches_the_tool_and_returns_its_result(self) -> None:
        answers = self._answers(
            [
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": 4,
                        "method": "extension/invoke",
                        "params": {"name": "put", "input": {"name": "v", "data": ""}},
                    }
                )
            ]
        )
        self.assertEqual(answers[0]["result"], {"name": "v", "received": 0, "sealed": False})

    def test_a_blank_line_is_ignored(self) -> None:
        self.assertEqual(self._answers(["", "   "]), [])

    def test_an_oversize_frame_is_refused_without_being_parsed(self) -> None:
        answers = self._answers(["x" * (1024 * 1024 + 1)])
        self.assertEqual(answers[0]["error"]["message"], "Control frame exceeds policy")

    def test_invalid_protocol_data_is_refused(self) -> None:
        answers = self._answers(["{not json"])
        self.assertEqual(answers[0]["error"]["code"], -32700)

    def test_a_frame_that_is_not_a_request_is_refused(self) -> None:
        for frame in ['["a"]', '{"jsonrpc":"1.0","method":"x"}', '{"jsonrpc":"2.0","method":5}']:
            with self.subTest(frame=frame):
                answers = self._answers([frame])
                self.assertEqual(answers[0]["error"]["code"], -32600)

    def test_a_refusal_answers_the_frame_that_caused_it_and_the_loop_continues(self) -> None:
        answers = self._answers([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "nope"}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "extension/cancel"}),
        ])
        self.assertEqual(answers[0]["id"], 1)
        self.assertEqual(answers[0]["error"]["code"], -32000)
        self.assertEqual(answers[1]["result"], {"cancelled": True})

    def test_the_loop_ends_at_end_of_input(self) -> None:
        self.assertEqual(serve(Guest("/opt/model", fixed_clock), io.StringIO(""), io.StringIO()), 0)


class MainTest(unittest.TestCase):
    def test_the_launcher_serves_the_guest_over_standard_streams(self) -> None:
        frame = json.dumps({"jsonrpc": "2.0", "id": 9, "method": "extension/discover"})
        sink = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO(f"{frame}\n")), mock.patch.object(sys, "stdout", sink):
            self.assertEqual(main("/opt/reference-image/model"), 0)
        self.assertEqual(json.loads(sink.getvalue())["result"]["name"], "reference-image")


class DigestTest(unittest.TestCase):
    def test_the_digest_is_the_sha256_of_the_bytes(self) -> None:
        self.assertEqual(digest_of(b"abc"), f"sha256:{hashlib.sha256(b'abc').hexdigest()}")


if __name__ == "__main__":
    unittest.main()
