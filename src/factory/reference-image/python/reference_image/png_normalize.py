"""Normalization: decode a PNG and re-encode it to one canonical form.

Normalization is what makes "no extra embedded payload" checkable. A generator
writes whatever its imaging library chose to write, including timestamps,
colour profiles, text chunks, and any bytes an attacker managed to attach. This
module decodes the pixels and writes them again from nothing but the pixel
values, so the output contains exactly IHDR, IDAT, and IEND and nothing that
survived from the input container.

The decode is a full unfilter rather than a recompression of the original
scanlines. Recompressing would carry the input's filter choices forward, and the
output bytes would then depend on the generator rather than on the picture. With
filter type zero on every row the same pixels always produce the same file,
which is what lets a publication claim exact bytes.

Interlaced input is refused rather than decoded. The pack's generator never
produces it, and a second, differently shaped decode path would be code whose
only exercise is a test.
"""

from __future__ import annotations

import struct
import zlib

from .png_format import PngFormatError, PngHeader, PngImage, idat_bytes, parse_png

#: Written into IHDR. Filtering and compression each have one defined method.
COMPRESSION_METHOD = 0
FILTER_METHOD = 0
NO_INTERLACE = 0

#: The filter this module writes. Reading still handles all five.
FILTER_NONE = 0


def _paeth(left: int, above: int, upper_left: int) -> int:
    """The specification's predictor: whichever neighbour the gradient is nearest."""
    estimate = left + above - upper_left
    distance_left = abs(estimate - left)
    distance_above = abs(estimate - above)
    distance_upper_left = abs(estimate - upper_left)
    if distance_left <= distance_above and distance_left <= distance_upper_left:
        return left
    if distance_above <= distance_upper_left:
        return above
    return upper_left


def _unfilter_row(filter_type: int, row: bytearray, previous: bytes, stride: int) -> None:
    """Reverses one row's filter in place.

    The four non-trivial filters all read bytes this loop has already restored,
    so the row must be walked forwards and cannot be vectorised by slicing.
    """
    if filter_type == FILTER_NONE:
        return
    if filter_type == 1:
        for index in range(stride, len(row)):
            row[index] = (row[index] + row[index - stride]) & 0xFF
        return
    if filter_type == 2:
        for index in range(len(row)):
            row[index] = (row[index] + previous[index]) & 0xFF
        return
    if filter_type == 3:
        for index in range(len(row)):
            left = row[index - stride] if index >= stride else 0
            row[index] = (row[index] + ((left + previous[index]) >> 1)) & 0xFF
        return
    if filter_type == 4:
        for index in range(len(row)):
            left = row[index - stride] if index >= stride else 0
            upper_left = previous[index - stride] if index >= stride else 0
            row[index] = (row[index] + _paeth(left, previous[index], upper_left)) & 0xFF
        return
    raise PngFormatError("png_filter_unknown", f"Scanline filter {filter_type} is not defined")


def decode_scanlines(image: PngImage) -> bytes:
    """Decompresses and unfilters every row, returning raw samples.

    The decompressed length is checked against what the header implies, so a
    stream that is short or long fails here rather than producing a picture
    partly made of zeroes.
    """
    header = image.header
    if header.interlace != NO_INTERLACE:
        raise PngFormatError("png_interlace_unsupported", "An interlaced PNG is not supported by this pack")
    if header.compression != COMPRESSION_METHOD:
        raise PngFormatError("png_compression_unknown", f"Compression method {header.compression} is not defined")
    if header.filter_method != FILTER_METHOD:
        raise PngFormatError("png_filter_method_unknown", f"Filter method {header.filter_method} is not defined")
    if header.channels == 0:
        raise PngFormatError("png_colour_type_unknown", f"Colour type {header.colour_type} is not defined")
    try:
        raw = zlib.decompress(idat_bytes(image))
    except zlib.error as error:
        raise PngFormatError("png_image_data_corrupt", f"The image data does not decompress: {error}") from error
    stride = header.bytes_per_pixel
    row_bytes = header.row_bytes
    expected = (row_bytes + 1) * header.height
    if len(raw) != expected:
        raise PngFormatError(
            "png_image_data_length", f"The image data is {len(raw)} bytes where the header implies {expected}"
        )
    out = bytearray(row_bytes * header.height)
    previous = bytes(row_bytes)
    position = 0
    for index in range(header.height):
        filter_type = raw[position]
        row = bytearray(raw[position + 1 : position + 1 + row_bytes])
        _unfilter_row(filter_type, row, previous, stride)
        start = index * row_bytes
        out[start : start + row_bytes] = row
        previous = bytes(row)
        position += row_bytes + 1
    return bytes(out)


def _chunk(kind: str, payload: bytes) -> bytes:
    body = kind.encode("ascii") + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def encode_png(header: PngHeader, scanlines: bytes, compress_level: int) -> bytes:
    """Writes one canonical PNG: signature, IHDR, a single IDAT, IEND.

    Every row is written with filter type zero and the whole stream is
    compressed once at the locked level, so the same pixels and the same level
    always produce the same bytes.
    """
    row_bytes = header.row_bytes
    if len(scanlines) != row_bytes * header.height:
        implied = row_bytes * header.height
        raise PngFormatError(
            "png_scanline_length", f"Received {len(scanlines)} sample bytes where the header implies {implied}"
        )
    body = bytearray()
    for index in range(header.height):
        body.append(FILTER_NONE)
        body += scanlines[index * row_bytes : (index + 1) * row_bytes]
    ihdr = struct.pack(
        ">IIBBBBB",
        header.width,
        header.height,
        header.bit_depth,
        header.colour_type,
        COMPRESSION_METHOD,
        FILTER_METHOD,
        NO_INTERLACE,
    )
    return b"".join(
        [
            b"\x89PNG\r\n\x1a\n",
            _chunk("IHDR", ihdr),
            _chunk("IDAT", zlib.compress(bytes(body), compress_level)),
            _chunk("IEND", b""),
        ]
    )


def normalize_png(data: bytes, compress_level: int) -> bytes:
    """Decodes and rewrites one variant.

    Normalization does not change the picture's size or colour mode; a variant
    that is the wrong shape stays the wrong shape and is refused by the checks
    rather than silently resized here. Fixing it here would let a wrong-size
    generation reach acceptance.
    """
    image = parse_png(data)
    return encode_png(image.header, decode_scanlines(image), compress_level)
