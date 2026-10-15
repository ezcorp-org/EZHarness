"""The drawn fixtures: what they contain and what they refuse to draw."""

from __future__ import annotations

import unittest

from reference_image.fixtures import (
    BLACK,
    CHANNELS,
    GLYPH_ROWS,
    WHITE,
    FixtureError,
    blank_fixture,
    caption_fixture,
    draw_text,
    solid_canvas,
    text_width,
)
from reference_image.png_format import parse_png
from reference_image.png_normalize import decode_scanlines, normalize_png


def pixel(samples: bytes, width: int, x: int, y: int) -> tuple[int, ...]:
    start = (y * width + x) * CHANNELS
    return tuple(samples[start : start + CHANNELS])


def ink_count(samples: bytes) -> int:
    return sum(1 for index in range(0, len(samples), CHANNELS) if samples[index] == 0)


class CanvasTest(unittest.TestCase):
    def test_a_solid_canvas_is_one_colour_everywhere(self) -> None:
        canvas = solid_canvas(3, 2, (10, 20, 30))
        self.assertEqual(bytes(canvas), bytes([10, 20, 30]) * 6)

    def test_a_canvas_must_have_positive_dimensions(self) -> None:
        for width, height in ((0, 4), (4, 0), (-1, 4)):
            with self.subTest(width=width, height=height), self.assertRaises(FixtureError) as caught:
                solid_canvas(width, height, WHITE)
            self.assertEqual(caught.exception.code, "fixture_size_invalid")


class DrawTextTest(unittest.TestCase):
    def test_it_puts_ink_where_the_glyph_says_and_nowhere_else(self) -> None:
        # 'L' at scale 1 fills the first column of every row and the bottom row.
        canvas = solid_canvas(5, 7, WHITE)
        draw_text(canvas, 5, 7, "L", scale=1, left=0, top=0)
        samples = bytes(canvas)
        self.assertEqual(pixel(samples, 5, 0, 0), BLACK)
        self.assertEqual(pixel(samples, 5, 4, 6), BLACK)
        self.assertEqual(pixel(samples, 5, 4, 0), WHITE)

    def test_scaling_multiplies_every_cell(self) -> None:
        small = solid_canvas(5, 7, WHITE)
        draw_text(small, 5, 7, "L", scale=1, left=0, top=0)
        large = solid_canvas(10, 14, WHITE)
        draw_text(large, 10, 14, "L", scale=2, left=0, top=0)
        self.assertEqual(ink_count(bytes(large)), ink_count(bytes(small)) * 4)

    def test_a_space_draws_nothing_but_still_advances(self) -> None:
        canvas = solid_canvas(30, 7, WHITE)
        draw_text(canvas, 30, 7, " L", scale=1, left=0, top=0)
        samples = bytes(canvas)
        self.assertEqual(pixel(samples, 30, 0, 0), WHITE)
        self.assertEqual(pixel(samples, 30, 6, 0), BLACK)

    def test_ink_outside_the_frame_is_clipped_rather_than_wrapped(self) -> None:
        canvas = solid_canvas(3, 3, WHITE)
        draw_text(canvas, 3, 3, "E", scale=1, left=-1, top=-1)
        self.assertEqual(len(canvas), 3 * 3 * CHANNELS)

    def test_an_undefined_letter_is_refused_rather_than_dropped(self) -> None:
        canvas = solid_canvas(40, 10, WHITE)
        with self.assertRaises(FixtureError) as caught:
            draw_text(canvas, 40, 10, "SALE!", scale=1, left=0, top=0)
        self.assertEqual(caught.exception.code, "fixture_glyph_missing")

    def test_a_scale_below_one_pixel_is_refused(self) -> None:
        canvas = solid_canvas(40, 10, WHITE)
        with self.assertRaises(FixtureError) as caught:
            draw_text(canvas, 40, 10, "S", scale=0, left=0, top=0)
        self.assertEqual(caught.exception.code, "fixture_scale_invalid")

    def test_lower_case_is_drawn_as_upper_case(self) -> None:
        upper = solid_canvas(40, 10, WHITE)
        lower = solid_canvas(40, 10, WHITE)
        draw_text(upper, 40, 10, "SALE", scale=1, left=0, top=0)
        draw_text(lower, 40, 10, "sale", scale=1, left=0, top=0)
        self.assertEqual(bytes(upper), bytes(lower))


class TextWidthTest(unittest.TestCase):
    def test_it_counts_letters_and_the_gaps_between_them(self) -> None:
        self.assertEqual(text_width("SALE", 1), 4 * 6 - 1)
        self.assertEqual(text_width("SALE", 10), 4 * 60 - 10)

    def test_empty_text_occupies_nothing(self) -> None:
        self.assertEqual(text_width("", 10), 0)


class CaptionFixtureTest(unittest.TestCase):
    def test_it_is_a_normalized_png_of_the_asked_size(self) -> None:
        data = caption_fixture(256, 128, "SALE", scale=8)
        image = parse_png(data)
        self.assertEqual((image.header.width, image.header.height), (256, 128))
        self.assertEqual(image.kinds, ("IHDR", "IDAT", "IEND"))
        self.assertEqual(image.header.colour_name, "RGB")

    def test_normalizing_it_changes_nothing(self) -> None:
        data = caption_fixture(256, 128, "SALE", scale=8)
        self.assertEqual(normalize_png(data, 6), data)

    def test_it_actually_carries_ink(self) -> None:
        samples = decode_scanlines(parse_png(caption_fixture(256, 128, "SALE", scale=8)))
        self.assertGreater(ink_count(samples), 1_000)

    def test_the_caption_is_centred(self) -> None:
        width, height, scale = 400, 200, 10
        samples = decode_scanlines(parse_png(caption_fixture(width, height, "SALE", scale=scale)))
        drawn = text_width("SALE", scale)
        left_margin = (width - drawn) // 2
        # The column just left of the caption is blank; the caption's first
        # column carries the 'S' glyph's top-row gap, so check a row with ink.
        self.assertEqual(pixel(samples, width, left_margin - 1, height // 2), WHITE)
        top = (height - GLYPH_ROWS * scale) // 2
        self.assertEqual(pixel(samples, width, left_margin + scale, top), BLACK)

    def test_a_caption_wider_than_the_frame_is_refused(self) -> None:
        with self.assertRaises(FixtureError) as caught:
            caption_fixture(40, 200, "SALE", scale=24)
        self.assertEqual(caught.exception.code, "fixture_text_too_wide")

    def test_it_is_the_same_bytes_every_time(self) -> None:
        self.assertEqual(caption_fixture(256, 128, "SALE", scale=8), caption_fixture(256, 128, "SALE", scale=8))

    def test_another_word_still_draws(self) -> None:
        data = caption_fixture(512, 128, "CAR", scale=12)
        self.assertGreater(ink_count(decode_scanlines(parse_png(data))), 500)


class BlankFixtureTest(unittest.TestCase):
    def test_it_carries_no_ink_at_all(self) -> None:
        samples = decode_scanlines(parse_png(blank_fixture(64, 64)))
        self.assertEqual(ink_count(samples), 0)

    def test_it_is_a_normalized_png(self) -> None:
        data = blank_fixture(64, 64)
        self.assertEqual(normalize_png(data, 6), data)
        self.assertEqual(parse_png(data).kinds, ("IHDR", "IDAT", "IEND"))


if __name__ == "__main__":
    unittest.main()
