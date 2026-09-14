"""The isolated guest for the reference image pack.

It answers the same JSON-RPC protocol every v4 guest answers, over the same
three FIFOs, with no network, a read-only root, and only the device nodes its
attempt's grant named. Five tools cover the pack's work: put bytes in, generate
a variant, normalize one, measure the deterministic claims, run the pinned OCR
engine, and read bytes back out.

Bytes do not travel in a single frame. A control frame is capped at a mebibyte
and a normalized variant is larger than that, so every image is addressed by its
digest and moved in fixed-size pieces. The digest is what binds a reassembly:
the host recomputes it over the pieces it received, so a lost or reordered chunk
is a mismatch rather than a corrupt picture that still looks like a picture.

The guest holds no credential and makes no outbound request. The semantic
evaluation is not here, because it needs a provider the isolation profile
deliberately puts out of reach.
"""

from __future__ import annotations

import base64
import hashlib
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Final, TextIO

from reference_image.claims import (
    ImageConstraints,
    claim_report,
    deterministic_claims,
    text_claim,
    text_error_claim,
)
from reference_image.fixtures import FixtureError, blank_fixture, caption_fixture
from reference_image.ocr_report import OcrError, read_words, tesseract_command
from reference_image.png_format import PngFormatError
from reference_image.png_normalize import normalize_png
from reference_image.sdxl import (
    GenerationError,
    GenerationSettings,
    assert_generation_request,
    generate,
    load_pipeline,
    runtime_facts,
)

GUEST_VERSION: Final = "factory.reference-image-guest.v1"
MAX_FRAME_BYTES: Final = 1024 * 1024
#: Raw bytes per transfer piece. Base64 grows this by a third and still leaves
#: room inside the frame ceiling for the envelope.
CHUNK_BYTES: Final = 512 * 1024

MANIFEST: Final[dict[str, Any]] = {
    "schemaVersion": 4,
    "name": "reference-image",
    "version": "1.0.0",
    "author": {"name": "EZCorp factory platform"},
    "description": "Isolated SDXL generation, PNG normalization, and deterministic image claims",
    "permissions": {},
    "tools": [
        {
            "name": name,
            "description": description,
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
        }
        for name, description in (
            ("put", "Accept one base64 piece of an inbound image"),
            ("fetch", "Return one base64 piece of a held image"),
            ("generate", "Generate one seeded SDXL variant"),
            ("normalize", "Rewrite one held image to the canonical PNG form"),
            ("claims", "Measure the deterministic and OCR claims over one held image"),
            ("runtime", "Report the observed generation runtime"),
            ("fixtures", "Draw the caption negative fixture and its blank control"),
        )
    ],
}


class GuestError(Exception):
    """A refusal reported as a JSON-RPC error rather than a crash."""


def digest_of(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def _require(params: Any, name: str) -> Any:  # noqa: ANN401 - protocol values are arbitrary JSON by definition
    if not isinstance(params, dict) or name not in params:
        raise GuestError(f"missing input {name}")
    return params[name]


def _require_int(params: Any, name: str) -> int:  # noqa: ANN401
    value = _require(params, name)
    if not isinstance(value, int) or isinstance(value, bool):
        raise GuestError(f"input {name} must be an integer")
    return value


def _require_str(params: Any, name: str) -> str:  # noqa: ANN401
    value = _require(params, name)
    if not isinstance(value, str):
        raise GuestError(f"input {name} must be a string")
    return value


class Guest:
    """Holds the images one attempt produced or received, addressed by digest."""

    def __init__(self, model_directory: str, clock: Any = time.time) -> None:  # noqa: ANN401
        self.model_directory = model_directory
        self.clock = clock
        self.held: dict[str, bytes] = {}
        self.inbound: dict[str, bytearray] = {}
        self.pipeline: Any = None

    def now_ms(self) -> int:
        return int(self.clock() * 1000)

    # --- byte transfer -------------------------------------------------

    def put(self, params: Any) -> dict[str, Any]:  # noqa: ANN401
        """Appends one piece to a named inbound buffer and seals it when told.

        The buffer is keyed by a caller-chosen name rather than by digest,
        because the digest is only knowable once every piece has arrived.
        """
        name = _require_str(params, "name")
        piece = base64.b64decode(_require_str(params, "data"), validate=True)
        buffer = self.inbound.setdefault(name, bytearray())
        buffer += piece
        if not bool(params.get("final", False)):
            return {"name": name, "received": len(buffer), "sealed": False}
        data = bytes(buffer)
        del self.inbound[name]
        identity = digest_of(data)
        self.held[identity] = data
        return {"name": name, "received": len(data), "sealed": True, "digest": identity, "bytes": len(data)}

    def fetch(self, params: Any) -> dict[str, Any]:  # noqa: ANN401
        """Returns one piece, at most the caller's size and never more than the ceiling.

        The caller knows its own frame budget and this guest does not, so the
        size is an input. It is still clamped here, because a caller that asked
        for a piece larger than a frame would be told the answer was too big
        rather than given a smaller one.
        """
        identity = _require_str(params, "digest")
        offset = _require_int(params, "offset")
        maximum = min(int(params.get("maximum", CHUNK_BYTES)), CHUNK_BYTES)
        if maximum < 1:
            raise GuestError("the requested piece size must be at least one byte")
        data = self.held.get(identity)
        if data is None:
            raise GuestError(f"no held image {identity}")
        if offset < 0 or offset > len(data):
            raise GuestError(f"offset {offset} is outside the held image")
        piece = data[offset : offset + maximum]
        return {
            "digest": identity,
            "offset": offset,
            "data": base64.b64encode(piece).decode("ascii"),
            "length": len(piece),
            "remaining": len(data) - offset - len(piece),
        }

    # --- work ----------------------------------------------------------

    def runtime(self, _params: Any) -> dict[str, Any]:  # noqa: ANN401
        return {"guest": GUEST_VERSION, "runtime": runtime_facts()}

    def fixtures(self, params: Any) -> dict[str, Any]:  # noqa: ANN401
        """Draws the caption fixture and the blank control, and holds both.

        They are drawn inside the guest rather than sent in, so the bytes the
        OCR claim measures are the bytes this pack's own encoder produced. The
        blank control exists so a caption's failure can be attributed to the
        caption: without it, an engine reporting text on any white frame would
        look like a correct rejection.
        """
        width = _require_int(params, "width")
        height = _require_int(params, "height")
        scale = _require_int(params, "scale")
        level = _require_int(params, "compressLevel")
        drawn: dict[str, Any] = {}
        for name, data in (
            ("caption", caption_fixture(width, height, "SALE", scale=scale, compress_level=level)),
            ("blank", blank_fixture(width, height, compress_level=level)),
        ):
            identity = digest_of(data)
            self.held[identity] = data
            drawn[name] = {"digest": identity, "bytes": len(data)}
        return drawn

    def generate(self, params: Any) -> dict[str, Any]:  # noqa: ANN401
        """Produces one seeded variant with exactly the settings it was given."""
        settings = GenerationSettings(
            inference_steps=_require_int(params, "inferenceSteps"),
            guidance_scale=float(_require(params, "guidance")),
            width=_require_int(params, "width"),
            height=_require_int(params, "height"),
            dtype=_require_str(params, "dtype"),
            device=_require_str(params, "device"),
        )
        prompt = _require_str(params, "prompt")
        seed = _require_int(params, "seed")
        # Refuse a bad request before any weight is read. Loading the pipeline
        # first would make an empty prompt look like a runtime failure.
        assert_generation_request(prompt, seed, settings)
        if self.pipeline is None:
            self.pipeline = load_pipeline(self.model_directory, settings.dtype, settings.device)
        variant = generate(
            pipeline=self.pipeline,
            prompt=prompt,
            seed=seed,
            settings=settings,
            encode=encode_pillow_png,
            runtime=runtime_facts(),
        )
        identity = digest_of(variant.png)
        self.held[identity] = variant.png
        return {
            "digest": identity,
            "bytes": len(variant.png),
            "seed": variant.seed,
            "prompt": variant.prompt,
            "runtime": variant.runtime,
            "settings": {
                "inferenceSteps": settings.inference_steps,
                "guidance": settings.guidance_scale,
                "width": settings.width,
                "height": settings.height,
                "dtype": settings.dtype,
                "device": settings.device,
            },
        }

    def normalize(self, params: Any) -> dict[str, Any]:  # noqa: ANN401
        identity = _require_str(params, "digest")
        level = _require_int(params, "compressLevel")
        data = self.held.get(identity)
        if data is None:
            raise GuestError(f"no held image {identity}")
        try:
            rewritten = normalize_png(data, level)
        except PngFormatError as error:
            return {"source": identity, "error": {"code": error.code, "message": str(error)}}
        normalized = digest_of(rewritten)
        self.held[normalized] = rewritten
        return {"source": identity, "digest": normalized, "bytes": len(rewritten), "sourceBytes": len(data)}

    def claims(self, params: Any) -> dict[str, Any]:  # noqa: ANN401
        """Measures every deterministic claim and the OCR claim over one image."""
        identity = _require_str(params, "digest")
        data = self.held.get(identity)
        if data is None:
            raise GuestError(f"no held image {identity}")
        constraints = ImageConstraints(
            width=_require_int(params, "width"),
            height=_require_int(params, "height"),
            colour_modes=tuple(_require(params, "colourModes")),
            bit_depth=_require_int(params, "bitDepth"),
            maximum_bytes=_require_int(params, "maximumBytes"),
            allowed_chunks=frozenset(_require(params, "allowedChunks")),
        )
        measured_at = self.now_ms()
        outcomes = deterministic_claims(data, constraints, measured_at)
        outcomes.append(self._text_claim(data, params, measured_at))
        return claim_report(outcomes)

    def _text_claim(self, data: bytes, params: Any, measured_at: int) -> dict[str, Any]:  # noqa: ANN401
        try:
            document, command = run_tesseract(
                data,
                _require_str(params, "language"),
                _require_int(params, "pageSegmentationMode"),
                _require_int(params, "engineMode"),
            )
            outcome = read_words(document, _require_int(params, "minimumWordConfidence"), command)
        except OcrError as error:
            return text_error_claim(error, measured_at)
        return text_claim(outcome, measured_at)

    # --- protocol ------------------------------------------------------

    def invoke(self, params: Any) -> Any:  # noqa: ANN401
        if not isinstance(params, dict):
            raise GuestError("invoke expects an object")
        name = params.get("name")
        given = params.get("input")
        handlers = {
            "put": self.put,
            "fetch": self.fetch,
            "generate": self.generate,
            "normalize": self.normalize,
            "claims": self.claims,
            "runtime": self.runtime,
            "fixtures": self.fixtures,
        }
        handler = handlers.get(name if isinstance(name, str) else "")
        if handler is None:
            raise GuestError(f"unknown export {name}")
        try:
            return handler(given)
        except (FixtureError, GenerationError, PngFormatError) as error:
            raise GuestError(f"{error.code}: {error}") from error

    def dispatch(self, method: str, params: Any) -> Any:  # noqa: ANN401
        if method == "extension/discover":
            return MANIFEST
        if method == "extension/invoke":
            return self.invoke(params)
        if method == "extension/cancel":
            return {"cancelled": True}
        raise GuestError(f"unknown method {method}")


def encode_pillow_png(image: Any) -> bytes:  # noqa: ANN401 - the pipeline's image type is the library's
    """Serializes the pipeline's image without letting the library add metadata.

    Pillow writes its own ancillary chunks when asked to save, so the bytes are
    taken raw and written by this pack's own encoder. Normalization would strip
    the extra chunks anyway; producing them and removing them would just make the
    generator's output depend on Pillow's version.
    """
    from reference_image.png_format import PngHeader
    from reference_image.png_normalize import encode_png

    converted = image.convert("RGB")
    width, height = converted.size
    header = PngHeader(
        width=width, height=height, bit_depth=8, colour_type=2, compression=0, filter_method=0, interlace=0
    )
    return encode_png(header, converted.tobytes(), 6)


def run_tesseract(
    data: bytes, language: str, page_segmentation_mode: int, engine_mode: int
) -> tuple[str, tuple[str, ...]]:
    """Runs the pinned engine over one image and returns its output and command.

    The image is written to the attempt's own temporary directory because the
    engine reads a path. A non-zero exit or a missing binary is an OCR error, so
    the claim reports that the instrument failed rather than that no text exists.
    """
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "variant.png"
        path.write_bytes(data)
        command = tesseract_command(str(path), language, page_segmentation_mode, engine_mode)
        try:
            # A fixed argument vector built from the lock, never a shell.
            completed = subprocess.run(  # noqa: S603
                command, capture_output=True, text=True, check=False, timeout=120
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise OcrError("ocr_engine_unavailable", f"The OCR engine could not run: {error}") from error
        if completed.returncode != 0:
            detail = completed.stderr.strip()[:500]
            raise OcrError("ocr_engine_failed", f"The OCR engine exited {completed.returncode}: {detail}")
        return completed.stdout, command


def _error(identifier: Any, code: int, message: str) -> dict[str, Any]:  # noqa: ANN401
    """One JSON-RPC error frame."""
    return {"jsonrpc": "2.0", "id": identifier, "error": {"code": code, "message": message}}


def write_frame(sink: TextIO, frame: dict[str, Any]) -> None:
    sink.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
    sink.flush()


def serve(guest: Guest, source: TextIO, sink: TextIO) -> int:
    """Answers frames until end-of-input; only an unreadable stream ends the loop."""
    for line in source:
        text = line.strip()
        if not text:
            continue
        if len(text.encode("utf-8")) > MAX_FRAME_BYTES:
            write_frame(sink, _error(None, -32600, "Control frame exceeds policy"))
            continue
        try:
            frame = json.loads(text)
        except ValueError:
            write_frame(sink, _error(None, -32700, "Guest received invalid protocol data"))
            continue
        if not isinstance(frame, dict) or frame.get("jsonrpc") != "2.0" or not isinstance(frame.get("method"), str):
            write_frame(sink, _error(None, -32600, "Expected a JSON-RPC 2.0 request"))
            continue
        identifier = frame.get("id")
        try:
            result = guest.dispatch(frame["method"], frame.get("params"))
        except GuestError as error:
            write_frame(sink, _error(identifier, -32000, str(error)))
            continue
        write_frame(sink, {"jsonrpc": "2.0", "id": identifier, "result": result})
    return 0


def main(model_directory: str = "/opt/reference-image/model") -> int:
    """The launcher the in-guest shim starts calls exactly this."""
    return serve(Guest(model_directory), sys.stdin, sys.stdout)
