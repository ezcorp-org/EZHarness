"""The five deterministic claims and the verdicts they are allowed to reach."""

from __future__ import annotations

import unittest

from reference_image.claims import (
    CLAIM_DIMENSIONS_COLOUR,
    CLAIM_NO_EXTRA_PAYLOAD,
    CLAIM_NO_TEXT,
    CLAIM_SINGLE_FRAME,
    CLAIM_SIZE,
    CLAIMS_SCHEMA_VERSION,
    FAIL,
    PASS,
    VALIDATOR_ERROR,
    ImageConstraints,
    claim_report,
    deterministic_claims,
    dimensions_claim,
    payload_claim,
    single_frame_claim,
    size_claim,
    text_claim,
    text_error_claim,
)
from reference_image.ocr_report import OcrError, read_words
from reference_image.png_format import parse_png
from reference_image.png_normalize import normalize_png

from . import animation_control, chunk, make_png, text_chunk, tsv

REFERENCE = ImageConstraints(
    width=1024,
    height=1024,
    colour_modes=("RGB", "RGBA"),
    bit_depth=8,
    maximum_bytes=10 * 1024 * 1024,
    allowed_chunks=frozenset({"IHDR", "PLTE", "IDAT", "IEND"}),
)

SMALL = ImageConstraints(
    width=4,
    height=3,
    colour_modes=("RGB",),
    bit_depth=8,
    maximum_bytes=10 * 1024 * 1024,
    allowed_chunks=frozenset({"IHDR", "PLTE", "IDAT", "IEND"}),
)


def verdicts(claims: list[dict[str, object]]) -> dict[str, object]:
    return {str(claim["id"]): claim["verdict"] for claim in claims}


class DeterministicClaimsTest(unittest.TestCase):
    def test_a_conforming_picture_passes_all_four(self) -> None:
        report = deterministic_claims(normalize_png(make_png(4, 3), 6), SMALL, 1000)
        self.assertEqual(
            verdicts(report),
            {
                CLAIM_SINGLE_FRAME: PASS,
                CLAIM_DIMENSIONS_COLOUR: PASS,
                CLAIM_SIZE: PASS,
                CLAIM_NO_EXTRA_PAYLOAD: PASS,
            },
        )

    def test_every_claim_is_decisive_and_carries_a_reason_code(self) -> None:
        for claim in deterministic_claims(normalize_png(make_png(4, 3), 6), SMALL, 1000):
            self.assertTrue(claim["decisive"], claim["id"])
            self.assertTrue(str(claim["reasonCode"]))
            self.assertEqual(claim["evidence"], [])
            self.assertEqual(claim["measuredAtMs"], 1000)

    def test_a_wrong_size_picture_fails_only_the_raster_claim(self) -> None:
        report = deterministic_claims(normalize_png(make_png(4, 3), 6), REFERENCE, 5)
        self.assertEqual(verdicts(report)[CLAIM_DIMENSIONS_COLOUR], FAIL)
        self.assertEqual(verdicts(report)[CLAIM_SINGLE_FRAME], PASS)
        self.assertEqual(verdicts(report)[CLAIM_NO_EXTRA_PAYLOAD], PASS)

    def test_bytes_that_are_not_a_png_leave_every_claim_unmeasured(self) -> None:
        report = deterministic_claims(b"not an image", SMALL, 7)
        self.assertEqual(set(verdicts(report).values()), {VALIDATOR_ERROR})
        self.assertEqual(len(report), 4)
        for claim in report:
            self.assertEqual(claim["reasonCode"], "png_signature_missing")

    def test_a_trailing_payload_leaves_every_claim_unmeasured_rather_than_failed(self) -> None:
        report = deterministic_claims(make_png(4, 3, trailing=b"payload"), SMALL, 7)
        self.assertEqual(set(verdicts(report).values()), {VALIDATOR_ERROR})
        for claim in report:
            self.assertEqual(claim["reasonCode"], "png_trailing_bytes")


class FrameClaimTest(unittest.TestCase):
    def test_one_frame_passes(self) -> None:
        claim = single_frame_claim(parse_png(make_png()), 1)
        self.assertEqual(claim["verdict"], PASS)
        self.assertEqual(claim["reasonCode"], "png.frames.one")

    def test_an_animation_fails_and_names_its_count(self) -> None:
        claim = single_frame_claim(parse_png(make_png(extra_chunks=(animation_control(3),))), 1)
        self.assertEqual(claim["verdict"], FAIL)
        self.assertEqual(claim["reasonCode"], "png.frames.not_one")
        self.assertIn("3 frames", str(claim["summary"]))

    def test_an_unreadable_animation_chunk_is_an_error_not_a_failure(self) -> None:
        claim = single_frame_claim(parse_png(make_png(extra_chunks=(chunk("acTL", b"\x00"),))), 1)
        self.assertEqual(claim["verdict"], VALIDATOR_ERROR)
        self.assertEqual(claim["reasonCode"], "png_animation_invalid")


class RasterClaimTest(unittest.TestCase):
    def test_names_every_way_the_raster_differs_at_once(self) -> None:
        image = parse_png(make_png(8, 8, (1,), colour_type=0))
        claim = dimensions_claim(image, REFERENCE, 1)
        summary = str(claim["summary"])
        self.assertEqual(claim["verdict"], FAIL)
        self.assertIn("size 8x8 is not 1024x1024", summary)
        self.assertIn("colour mode grayscale is not one of RGB, RGBA", summary)

    def test_a_wrong_bit_depth_fails(self) -> None:
        constraints = ImageConstraints(4, 3, ("RGB",), 16, 1024, frozenset({"IHDR", "IDAT", "IEND"}))
        claim = dimensions_claim(parse_png(make_png(4, 3)), constraints, 1)
        self.assertIn("bit depth 8 is not 16", str(claim["summary"]))

    def test_an_rgba_picture_satisfies_a_contract_allowing_both_modes(self) -> None:
        image = parse_png(make_png(4, 3, (1, 2, 3, 4), colour_type=6))
        constraints = ImageConstraints(4, 3, ("RGB", "RGBA"), 8, 1024 * 1024, frozenset({"IHDR", "IDAT", "IEND"}))
        self.assertEqual(dimensions_claim(image, constraints, 1)["verdict"], PASS)


class SizeClaimTest(unittest.TestCase):
    def test_a_file_at_the_limit_passes(self) -> None:
        data = normalize_png(make_png(4, 3), 6)
        constraints = ImageConstraints(4, 3, ("RGB",), 8, len(data), frozenset({"IHDR", "IDAT", "IEND"}))
        self.assertEqual(size_claim(parse_png(data), constraints, 1)["verdict"], PASS)

    def test_a_file_one_byte_over_the_limit_fails(self) -> None:
        data = normalize_png(make_png(4, 3), 6)
        constraints = ImageConstraints(4, 3, ("RGB",), 8, len(data) - 1, frozenset({"IHDR", "IDAT", "IEND"}))
        claim = size_claim(parse_png(data), constraints, 1)
        self.assertEqual(claim["verdict"], FAIL)
        self.assertEqual(claim["reasonCode"], "png.size.over_limit")


class PayloadClaimTest(unittest.TestCase):
    def test_a_normalized_file_carries_nothing_extra(self) -> None:
        claim = payload_claim(parse_png(normalize_png(make_png(), 6)), SMALL, 1)
        self.assertEqual(claim["verdict"], PASS)
        self.assertIn("IDAT", str(claim["summary"]))

    def test_a_text_chunk_fails_the_claim(self) -> None:
        claim = payload_claim(parse_png(make_png(extra_chunks=(text_chunk(),))), SMALL, 1)
        self.assertEqual(claim["verdict"], FAIL)
        self.assertEqual(claim["reasonCode"], "png.payload.extra_chunk")
        self.assertIn("tEXt", str(claim["summary"]))

    def test_a_critical_chunk_outside_the_allowed_set_also_fails(self) -> None:
        narrow = ImageConstraints(4, 3, ("RGB",), 8, 1024 * 1024, frozenset({"IHDR", "IDAT"}))
        claim = payload_claim(parse_png(make_png()), narrow, 1)
        self.assertEqual(claim["verdict"], FAIL)
        self.assertIn("IEND", str(claim["summary"]))

    def test_an_allowed_ancillary_chunk_still_fails_as_ancillary(self) -> None:
        permissive = ImageConstraints(
            4, 3, ("RGB",), 8, 1024 * 1024, frozenset({"IHDR", "IDAT", "IEND", "tEXt"})
        )
        claim = payload_claim(parse_png(make_png(extra_chunks=(text_chunk(),))), permissive, 1)
        self.assertEqual(claim["verdict"], FAIL)
        self.assertEqual(claim["reasonCode"], "png.payload.ancillary_chunk")


class TextClaimTest(unittest.TestCase):
    def test_no_recognized_word_passes(self) -> None:
        claim = text_claim(read_words(tsv((("20", "smudge"),)), 60, ("tesseract",)), 3)
        self.assertEqual(claim["verdict"], PASS)
        self.assertEqual(claim["reasonCode"], "ocr.text.none")

    def test_a_recognized_word_fails(self) -> None:
        claim = text_claim(read_words(tsv((("88", "SALE"),)), 60, ("tesseract",)), 3)
        self.assertEqual(claim["verdict"], FAIL)
        self.assertEqual(claim["reasonCode"], "ocr.text.recognized")
        self.assertIn("SALE", str(claim["summary"]))

    def test_an_engine_failure_is_never_a_pass(self) -> None:
        claim = text_error_claim(OcrError("ocr_engine_unavailable", "no binary"), 3)
        self.assertEqual(claim["id"], CLAIM_NO_TEXT)
        self.assertEqual(claim["verdict"], VALIDATOR_ERROR)
        self.assertEqual(claim["reasonCode"], "ocr_engine_unavailable")


class ReportTest(unittest.TestCase):
    def test_the_envelope_names_the_strict_claim_schema(self) -> None:
        report = claim_report(deterministic_claims(normalize_png(make_png(4, 3), 6), SMALL, 1))
        self.assertEqual(report["schemaVersion"], CLAIMS_SCHEMA_VERSION)
        self.assertEqual(len(report["claims"]), 4)
        self.assertNotIn("error", report)

    def test_the_envelope_carries_no_provenance(self) -> None:
        report = claim_report(deterministic_claims(normalize_png(make_png(4, 3), 6), SMALL, 1))
        self.assertNotIn("provenance", repr(report))

    def test_an_error_is_carried_only_when_given(self) -> None:
        report = claim_report([], {"code": "guest_failed", "message": "nothing ran"})
        self.assertEqual(report["error"], {"code": "guest_failed", "message": "nothing ran"})

    def test_a_long_summary_is_bounded(self) -> None:
        constraints = ImageConstraints(1, 1, ("x" * 3000,), 8, 1, frozenset({"IHDR", "IDAT", "IEND"}))
        claim = dimensions_claim(parse_png(make_png(4, 3)), constraints, 1)
        self.assertLessEqual(len(str(claim["summary"])), 2048)


if __name__ == "__main__":
    unittest.main()
