"""PNG structure, read with the standard library only.

The reference image pack has to answer four byte-level questions about every
variant: is there exactly one decoded frame, is it 1,024 by 1,024 in RGB or
RGBA, is it at most ten mebibytes, and does it carry any payload beyond the
image. Answering them with an imaging library would mean trusting that library's
tolerance for malformed input, and a tolerant reader is the wrong instrument for
a question about what the bytes contain. This module therefore parses the
container itself and treats anything it does not recognise as a finding rather
than as something to repair.

It deliberately does not decode pixels. `png_normalize` does that.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

#: Chunks that carry the image itself. Everything else is ancillary.
CRITICAL_CHUNKS = frozenset({"IHDR", "PLTE", "IDAT", "IEND"})

#: The chunks an animated PNG uses. Their presence means more than one frame.
ANIMATION_CHUNKS = frozenset({"acTL", "fcTL", "fdAT"})

#: Colour type to the number of samples per pixel.
CHANNELS: dict[int, int] = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}

#: Colour type to its name in the specification.
COLOUR_NAMES: dict[int, str] = {
    0: "grayscale",
    2: "RGB",
    3: "palette",
    4: "grayscale-alpha",
    6: "RGBA",
}


class PngFormatError(ValueError):
    """Raised when bytes cannot be read as a PNG at all.

    A file that is not a PNG is a different finding from a PNG that breaks a
    rule, so the two never share a code path.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PngChunk:
    """One chunk, with the offset it started at so a finding can name a place."""

    kind: str
    offset: int
    data: bytes


@dataclass(frozen=True)
class PngHeader:
    """The IHDR fields this pack reasons about."""

    width: int
    height: int
    bit_depth: int
    colour_type: int
    compression: int
    filter_method: int
    interlace: int

    @property
    def colour_name(self) -> str:
        return COLOUR_NAMES.get(self.colour_type, f"unknown-{self.colour_type}")

    @property
    def channels(self) -> int:
        return CHANNELS.get(self.colour_type, 0)

    @property
    def bytes_per_pixel(self) -> int:
        """Filtering works on whole bytes, so a sub-byte depth has a stride of one."""
        return max(1, self.channels * self.bit_depth // 8)

    @property
    def row_bytes(self) -> int:
        return (self.width * self.channels * self.bit_depth + 7) // 8


@dataclass(frozen=True)
class PngImage:
    """A parsed container: its header, every chunk in order, and its size."""

    header: PngHeader
    chunks: tuple[PngChunk, ...]
    total_bytes: int

    def of_kind(self, kind: str) -> tuple[PngChunk, ...]:
        return tuple(chunk for chunk in self.chunks if chunk.kind == kind)

    @property
    def kinds(self) -> tuple[str, ...]:
        return tuple(chunk.kind for chunk in self.chunks)

    @property
    def ancillary_kinds(self) -> tuple[str, ...]:
        """Every non-critical chunk type present, in order, without repeats."""
        seen: list[str] = []
        for chunk in self.chunks:
            if chunk.kind not in CRITICAL_CHUNKS and chunk.kind not in seen:
                seen.append(chunk.kind)
        return tuple(seen)


def _chunk_name(raw: bytes) -> str:
    """The four-letter type, rejected unless it is actually four letters.

    A chunk type outside A-Za-z is malformed rather than merely unknown, and
    accepting it would let arbitrary bytes name themselves a chunk.
    """
    if len(raw) != 4 or not all(0x41 <= byte <= 0x5A or 0x61 <= byte <= 0x7A for byte in raw):
        raise PngFormatError("png_chunk_type_invalid", f"Chunk type {raw!r} is not four letters")
    return raw.decode("ascii")


def parse_png(data: bytes) -> PngImage:
    """Parses the container and verifies every structural invariant it can.

    Every length, every CRC, and the position of IEND are checked. Trailing
    bytes after IEND are an error here rather than a later finding, because a
    reader that ignores them is exactly how a payload survives.
    """
    if not data.startswith(PNG_SIGNATURE):
        raise PngFormatError("png_signature_missing", "The bytes do not start with the PNG signature")
    chunks: list[PngChunk] = []
    offset = len(PNG_SIGNATURE)
    header: PngHeader | None = None
    seen_end = False
    while offset < len(data):
        if seen_end:
            raise PngFormatError("png_trailing_bytes", f"{len(data) - offset} bytes follow the IEND chunk")
        if offset + 8 > len(data):
            raise PngFormatError("png_chunk_truncated", f"A chunk header is truncated at offset {offset}")
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        if length > 0x7FFFFFFF:
            raise PngFormatError("png_chunk_length_invalid", f"Chunk at offset {offset} declares {length} bytes")
        kind = _chunk_name(data[offset + 4 : offset + 8])
        end = offset + 12 + length
        if end > len(data):
            raise PngFormatError("png_chunk_truncated", f"Chunk {kind} at offset {offset} runs past the end")
        payload = data[offset + 8 : offset + 8 + length]
        (declared_crc,) = struct.unpack(">I", data[offset + 8 + length : end])
        actual_crc = zlib.crc32(data[offset + 4 : offset + 8 + length]) & 0xFFFFFFFF
        if declared_crc != actual_crc:
            raise PngFormatError("png_chunk_crc_mismatch", f"Chunk {kind} at offset {offset} fails its checksum")
        if kind == "IHDR":
            if chunks:
                raise PngFormatError("png_header_misplaced", "IHDR must be the first chunk")
            if length != 13:
                raise PngFormatError("png_header_invalid", f"IHDR declares {length} bytes rather than 13")
            width, height, bit_depth, colour_type, compression, filter_method, interlace = struct.unpack(
                ">IIBBBBB", payload
            )
            if width == 0 or height == 0:
                raise PngFormatError("png_header_invalid", "IHDR declares a zero dimension")
            header = PngHeader(width, height, bit_depth, colour_type, compression, filter_method, interlace)
        elif header is None:
            raise PngFormatError("png_header_missing", f"Chunk {kind} appears before IHDR")
        if kind == "IEND":
            if length != 0:
                raise PngFormatError("png_end_invalid", f"IEND carries {length} bytes")
            seen_end = True
        chunks.append(PngChunk(kind, offset, payload))
        offset = end
    if header is None:
        raise PngFormatError("png_header_missing", "The file has no IHDR chunk")
    if not seen_end:
        raise PngFormatError("png_end_missing", "The file has no IEND chunk")
    return PngImage(header, tuple(chunks), len(data))


def frame_count(image: PngImage) -> int:
    """The number of frames a decoder would produce.

    A plain PNG has one. An animated PNG declares its count in `acTL`, and this
    reports that number so "exactly one frame" is a measurement rather than an
    assumption about the absence of a chunk.
    """
    control = image.of_kind("acTL")
    if not control:
        return 1
    if len(control[0].data) < 4:
        raise PngFormatError("png_animation_invalid", "The acTL chunk is too short to declare a frame count")
    (frames,) = struct.unpack(">I", control[0].data[:4])
    return int(frames)


def idat_bytes(image: PngImage) -> bytes:
    """The concatenated compressed image data, which is one stream across chunks."""
    parts = image.of_kind("IDAT")
    if not parts:
        raise PngFormatError("png_image_data_missing", "The file has no IDAT chunk")
    return b"".join(chunk.data for chunk in parts)
