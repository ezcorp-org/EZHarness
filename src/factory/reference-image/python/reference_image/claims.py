"""The deterministic claims, written in the strict validator claim shape.

Five of the pack's claims are decided from bytes alone: the frame count, the
size and colour mode, the encoded length, the absence of any payload beyond the
image, and the absence of recognized text. This module measures each one and
writes the report the isolated guest hands back.

Three rules shape every function here. A claim that could not be measured
reports VALIDATOR_ERROR and never FAIL, because "the instrument broke" and "the
picture is wrong" lead to different actions. Every claim carries a reason code
that names the specific rule rather than the outcome, so a rejection can be read
without the summary prose. And the report carries no provenance: the gateway
seals that, and a guest that supplied it would be claiming trust it cannot mint.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .ocr_report import OcrError, OcrOutcome
from .png_format import CRITICAL_CHUNKS, PngFormatError, PngImage, frame_count, parse_png

CLAIMS_SCHEMA_VERSION = "factory.validator-claims.v1"

PASS = "PASS"  # noqa: S105 - a verdict, which the credential rule reads as a password
FAIL = "FAIL"
VALIDATOR_ERROR = "VALIDATOR_ERROR"

CLAIM_SINGLE_FRAME = "png-single-frame"
CLAIM_DIMENSIONS_COLOUR = "png-dimensions-color"
CLAIM_SIZE = "png-size"
CLAIM_NO_EXTRA_PAYLOAD = "png-no-extra-payload"
CLAIM_NO_TEXT = "ocr-no-text"

DETERMINISTIC_CLAIM_IDS = (
    CLAIM_SINGLE_FRAME,
    CLAIM_DIMENSIONS_COLOUR,
    CLAIM_SIZE,
    CLAIM_NO_EXTRA_PAYLOAD,
)


@dataclass(frozen=True)
class ImageConstraints:
    """Exactly the C10 byte-level requirements, supplied by the lock."""

    width: int
    height: int
    colour_modes: tuple[str, ...]
    bit_depth: int
    maximum_bytes: int
    allowed_chunks: frozenset[str]


def _claim(
    claim_id: str, verdict: str, reason_code: str, summary: str, measured_at_ms: int
) -> dict[str, Any]:
    """One claim outcome. Every claim this pack writes is decisive.

    Nothing here is a partial signal that another claim could complete, so an
    indecisive outcome would only be a way of not answering.
    """
    return {
        "id": claim_id,
        "verdict": verdict,
        "decisive": True,
        "summary": summary[:2048],
        "reasonCode": reason_code,
        "evidence": [],
        "measuredAtMs": measured_at_ms,
    }


def single_frame_claim(image: PngImage, measured_at_ms: int) -> dict[str, Any]:
    try:
        frames = frame_count(image)
    except PngFormatError as error:
        return _claim(CLAIM_SINGLE_FRAME, VALIDATOR_ERROR, error.code, str(error), measured_at_ms)
    if frames != 1:
        return _claim(
            CLAIM_SINGLE_FRAME,
            FAIL,
            "png.frames.not_one",
            f"The file declares {frames} frames where exactly one is required",
            measured_at_ms,
        )
    return _claim(CLAIM_SINGLE_FRAME, PASS, "png.frames.one", "The file decodes to exactly one frame", measured_at_ms)


def dimensions_claim(image: PngImage, constraints: ImageConstraints, measured_at_ms: int) -> dict[str, Any]:
    header = image.header
    problems: list[str] = []
    if header.width != constraints.width or header.height != constraints.height:
        problems.append(f"size {header.width}x{header.height} is not {constraints.width}x{constraints.height}")
    if header.colour_name not in constraints.colour_modes:
        problems.append(f"colour mode {header.colour_name} is not one of {', '.join(constraints.colour_modes)}")
    if header.bit_depth != constraints.bit_depth:
        problems.append(f"bit depth {header.bit_depth} is not {constraints.bit_depth}")
    if problems:
        return _claim(
            CLAIM_DIMENSIONS_COLOUR,
            FAIL,
            "png.raster.mismatch",
            "; ".join(problems),
            measured_at_ms,
        )
    return _claim(
        CLAIM_DIMENSIONS_COLOUR,
        PASS,
        "png.raster.exact",
        f"{header.width}x{header.height} {header.colour_name} at {header.bit_depth} bits",
        measured_at_ms,
    )


def size_claim(image: PngImage, constraints: ImageConstraints, measured_at_ms: int) -> dict[str, Any]:
    if image.total_bytes > constraints.maximum_bytes:
        return _claim(
            CLAIM_SIZE,
            FAIL,
            "png.size.over_limit",
            f"The file is {image.total_bytes} bytes, above the {constraints.maximum_bytes} byte limit",
            measured_at_ms,
        )
    return _claim(
        CLAIM_SIZE,
        PASS,
        "png.size.within_limit",
        f"The file is {image.total_bytes} bytes, within the {constraints.maximum_bytes} byte limit",
        measured_at_ms,
    )


def payload_claim(image: PngImage, constraints: ImageConstraints, measured_at_ms: int) -> dict[str, Any]:
    """Refuses any chunk the lock does not allow, critical or not.

    Parsing already rejected bytes after IEND, so what remains is a chunk that is
    structurally valid and still does not belong: a text chunk, a colour profile,
    a private type, or a second image.
    """
    disallowed = [kind for kind in image.kinds if kind not in constraints.allowed_chunks]
    if disallowed:
        present = ", ".join(sorted(set(disallowed)))
        return _claim(
            CLAIM_NO_EXTRA_PAYLOAD,
            FAIL,
            "png.payload.extra_chunk",
            f"The normalized file carries chunk(s) outside the allowed set: {present}",
            measured_at_ms,
        )
    ancillary = image.ancillary_kinds
    if ancillary:
        return _claim(
            CLAIM_NO_EXTRA_PAYLOAD,
            FAIL,
            "png.payload.ancillary_chunk",
            f"The normalized file carries ancillary chunk(s): {', '.join(ancillary)}",
            measured_at_ms,
        )
    critical = ", ".join(sorted(set(image.kinds) & CRITICAL_CHUNKS))
    return _claim(
        CLAIM_NO_EXTRA_PAYLOAD,
        PASS,
        "png.payload.none",
        f"The normalized file carries only {critical} and no trailing bytes",
        measured_at_ms,
    )


def text_claim(outcome: OcrOutcome, measured_at_ms: int) -> dict[str, Any]:
    if outcome.has_text:
        return _claim(CLAIM_NO_TEXT, FAIL, "ocr.text.recognized", outcome.summary(), measured_at_ms)
    return _claim(CLAIM_NO_TEXT, PASS, "ocr.text.none", outcome.summary(), measured_at_ms)


def text_error_claim(error: OcrError, measured_at_ms: int) -> dict[str, Any]:
    """An engine that could not run leaves the claim unmeasured, never passed."""
    return _claim(CLAIM_NO_TEXT, VALIDATOR_ERROR, error.code, str(error), measured_at_ms)


def deterministic_claims(
    data: bytes, constraints: ImageConstraints, measured_at_ms: int
) -> list[dict[str, Any]]:
    """The four byte-level claims.

    When the container cannot be parsed at all, every claim reports the same
    parse failure as a VALIDATOR_ERROR. Reporting FAIL would say the picture
    breaks four rules, when what actually happened is that no rule could be
    measured.
    """
    try:
        image = parse_png(data)
    except PngFormatError as error:
        return [
            _claim(claim_id, VALIDATOR_ERROR, error.code, str(error), measured_at_ms)
            for claim_id in DETERMINISTIC_CLAIM_IDS
        ]
    return [
        single_frame_claim(image, measured_at_ms),
        dimensions_claim(image, constraints, measured_at_ms),
        size_claim(image, constraints, measured_at_ms),
        payload_claim(image, constraints, measured_at_ms),
    ]


def claim_report(claims: Sequence[dict[str, Any]], error: dict[str, str] | None = None) -> dict[str, Any]:
    """The envelope the guest writes.

    The optional error field is only for the case where nothing could be
    measured; the strict schema refuses it alongside a claim that has a verdict.
    """
    report: dict[str, Any] = {"schemaVersion": CLAIMS_SCHEMA_VERSION, "claims": list(claims)}
    if error is not None:
        report["error"] = error
    return report
