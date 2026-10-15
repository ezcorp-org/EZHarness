"""Builders that make PNG bytes with an exactly stated defect.

Every negative case in this suite is a real file that a real decoder would read,
differing from the good one in one named way. Building them here rather than
checking in opaque fixtures keeps the defect visible in the test that uses it.
"""

from __future__ import annotations

import struct
import zlib

SIGNATURE = b"\x89PNG\r\n\x1a\n"


def chunk(kind: str, payload: bytes, *, crc: int | None = None) -> bytes:
    """One chunk, optionally with a checksum the caller chose to be wrong."""
    body = kind.encode("ascii") + payload
    checksum = zlib.crc32(body) & 0xFFFFFFFF if crc is None else crc
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", checksum)


def header_bytes(
    width: int,
    height: int,
    bit_depth: int = 8,
    colour_type: int = 2,
    compression: int = 0,
    filter_method: int = 0,
    interlace: int = 0,
) -> bytes:
    return struct.pack(">IIBBBBB", width, height, bit_depth, colour_type, compression, filter_method, interlace)


def channels_for(colour_type: int) -> int:
    return {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour_type]


def solid_scanlines(width: int, height: int, colour: tuple[int, ...]) -> bytes:
    """Raw samples for a single-colour picture."""
    return bytes(colour) * width * height


def filtered(scanlines: bytes, width: int, height: int, channels: int, filter_type: int = 0) -> bytes:
    """Prefixes each row with a filter byte without actually filtering.

    Filter zero means "no filter", so the samples are already correct. A caller
    that asks for another type gets a file whose stated filter does not match its
    bytes, which is exactly what an unfilter test needs.
    """
    row_bytes = width * channels
    out = bytearray()
    for index in range(height):
        out.append(filter_type)
        out += scanlines[index * row_bytes : (index + 1) * row_bytes]
    return bytes(out)


def make_png(
    width: int = 4,
    height: int = 3,
    colour: tuple[int, ...] = (10, 200, 30),
    colour_type: int = 2,
    bit_depth: int = 8,
    extra_chunks: tuple[bytes, ...] = (),
    trailing: bytes = b"",
    interlace: int = 0,
    compress_level: int = 6,
) -> bytes:
    """A complete, valid PNG unless the caller asked for a defect."""
    channels = channels_for(colour_type)
    scanlines = solid_scanlines(width, height, colour[:channels])
    body = filtered(scanlines, width, height, channels)
    parts = [
        SIGNATURE,
        chunk("IHDR", header_bytes(width, height, bit_depth, colour_type, interlace=interlace)),
        *extra_chunks,
        chunk("IDAT", zlib.compress(body, compress_level)),
        chunk("IEND", b""),
    ]
    return b"".join(parts) + trailing


def text_chunk(keyword: str = "Comment", value: str = "generated") -> bytes:
    return chunk("tEXt", keyword.encode("latin-1") + b"\x00" + value.encode("latin-1"))


def animation_control(frames: int) -> bytes:
    """An `acTL` chunk declaring a frame count, which makes the file animated."""
    return chunk("acTL", struct.pack(">II", frames, 0))


def tsv(rows: tuple[tuple[str, str], ...], header: str = "level\tconf\ttext") -> str:
    """Tesseract-shaped tab-separated output from (confidence, text) pairs."""
    lines = [header]
    lines.extend(f"5\t{confidence}\t{text}" for confidence, text in rows)
    return "\n".join(lines) + "\n"
