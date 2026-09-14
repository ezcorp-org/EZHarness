"""The pack's negative fixtures, drawn rather than downloaded.

C10 names three bad images and a retained good one. Two of the bad ones are
pictures a generator can produce on request: a variant at the wrong size, and a
picture of a car. The third is a caption, and a model asked to render specific
words produces them unreliably, which would make the fixture's defect a matter
of luck rather than of construction.

So the caption is drawn here, from a bitmap font small enough to read in this
file. Every pixel is decided by code, the letters are the same every run, and
the fixture's defect is exactly the one it claims: legible text on an otherwise
plain background. The encoder is the pack's own, so the fixture is also a
normalized PNG and cannot fail a byte-level claim for an unrelated reason.
"""

from __future__ import annotations

from .png_format import PngHeader
from .png_normalize import encode_png

#: A five by seven cell font, one row per string, `1` where ink goes. Only the
#: letters the fixtures need are defined; an undefined letter is an error rather
#: than a blank, so a caption never silently loses a character.
GLYPHS: dict[str, tuple[str, ...]] = {
    "S": ("01110", "10001", "10000", "01110", "00001", "10001", "01110"),
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "C": ("01110", "10001", "10000", "10000", "10000", "10001", "01110"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    " ": ("00000", "00000", "00000", "00000", "00000", "00000", "00000"),
}

GLYPH_COLUMNS = 5
GLYPH_ROWS = 7
CHANNELS = 3

WHITE = (255, 255, 255)
BLACK = (0, 0, 0)


class FixtureError(ValueError):
    """Raised when a fixture cannot be drawn as described."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def solid_canvas(width: int, height: int, colour: tuple[int, int, int]) -> bytearray:
    """A single-colour RGB raster, as raw samples."""
    if width <= 0 or height <= 0:
        raise FixtureError("fixture_size_invalid", "A canvas must have positive dimensions")
    return bytearray(bytes(colour) * width * height)


def draw_text(
    canvas: bytearray,
    width: int,
    height: int,
    text: str,
    *,
    scale: int,
    left: int,
    top: int,
    spacing: int = 1,
    colour: tuple[int, int, int] = BLACK,
) -> None:
    """Draws one line of text into the raster at the given cell scale.

    The caller places the text; nothing is centred implicitly, because a fixture
    whose position depends on a measurement is harder to reason about than one
    whose position is stated.
    """
    if scale < 1:
        raise FixtureError("fixture_scale_invalid", "The glyph scale must be at least one pixel per cell")
    pen = left
    for character in text.upper():
        glyph = GLYPHS.get(character)
        if glyph is None:
            raise FixtureError("fixture_glyph_missing", f"The fixture font has no glyph for {character!r}")
        for row_index, row in enumerate(glyph):
            for column_index, cell in enumerate(row):
                if cell != "1":
                    continue
                for y in range(top + row_index * scale, top + (row_index + 1) * scale):
                    if not 0 <= y < height:
                        continue
                    for x in range(pen + column_index * scale, pen + (column_index + 1) * scale):
                        if not 0 <= x < width:
                            continue
                        start = (y * width + x) * CHANNELS
                        canvas[start : start + CHANNELS] = bytes(colour)
        pen += (GLYPH_COLUMNS + spacing) * scale


def text_width(text: str, scale: int, spacing: int = 1) -> int:
    """The pixels one line of text occupies, trailing spacing excluded."""
    if not text:
        return 0
    return len(text) * (GLYPH_COLUMNS + spacing) * scale - spacing * scale


def caption_fixture(
    width: int,
    height: int,
    text: str = "SALE",
    *,
    scale: int = 24,
    compress_level: int = 6,
) -> bytes:
    """A plain white picture carrying one large legible caption.

    The caption is centred from the measured text width, so a different word or
    scale still lands inside the frame. This is the pack's `SALE` negative
    fixture: everything about it satisfies the byte-level claims and it must
    still be refused, because the OCR claim reads text at the locked threshold.
    """
    canvas = solid_canvas(width, height, WHITE)
    drawn = text_width(text, scale)
    if drawn > width:
        raise FixtureError("fixture_text_too_wide", f"The caption needs {drawn} pixels and the frame is {width}")
    draw_text(
        canvas,
        width,
        height,
        text,
        scale=scale,
        left=(width - drawn) // 2,
        top=(height - GLYPH_ROWS * scale) // 2,
    )
    header = PngHeader(
        width=width, height=height, bit_depth=8, colour_type=2, compression=0, filter_method=0, interlace=0
    )
    return encode_png(header, bytes(canvas), compress_level)


def blank_fixture(width: int, height: int, *, compress_level: int = 6) -> bytes:
    """A plain white picture with no caption, for the control case.

    It exists so a caption fixture's OCR failure can be attributed to the
    caption. Without a control, an engine that reported text on any white frame
    would look like a correct rejection.
    """
    header = PngHeader(
        width=width, height=height, bit_depth=8, colour_type=2, compression=0, filter_method=0, interlace=0
    )
    return encode_png(header, bytes(solid_canvas(width, height, WHITE)), compress_level)
