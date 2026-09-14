"""Decoding and re-encoding: what normalization keeps and what it removes."""

from __future__ import annotations

import struct
import unittest
import zlib

from reference_image.png_format import PngFormatError, PngHeader, parse_png
from reference_image.png_normalize import decode_scanlines, encode_png, normalize_png

from .helpers import SIGNATURE, chunk, filtered, header_bytes, make_png, solid_scanlines, text_chunk


def _png_with_filters(width: int, height: int, filter_types: list[int], rows: list[bytes]) -> bytes:
    """A file whose rows really are filtered with the stated types."""
    body = bytearray()
    for filter_type, row in zip(filter_types, rows, strict=True):
        body.append(filter_type)
        body += row
    return b"".join(
        [
            SIGNATURE,
            chunk("IHDR", header_bytes(width, height)),
            chunk("IDAT", zlib.compress(bytes(body))),
            chunk("IEND", b""),
        ]
    )


class DecodeTest(unittest.TestCase):
    def test_an_unfiltered_image_decodes_to_its_samples(self) -> None:
        samples = solid_scanlines(4, 3, (10, 200, 30))
        self.assertEqual(decode_scanlines(parse_png(make_png(4, 3, (10, 200, 30)))), samples)

    def test_every_defined_filter_reverses_to_the_same_picture(self) -> None:
        # One row per filter type, each encoding the same three pixels.
        width, height = 3, 5
        plain = bytes([9, 9, 9, 20, 30, 40, 5, 6, 7])
        rows: list[bytes] = []
        previous = bytes(width * 3)
        for filter_type in range(5):
            row = bytearray(len(plain))
            for index in range(len(plain)):
                left = plain[index - 3] if index >= 3 else 0
                above = previous[index]
                upper_left = previous[index - 3] if index >= 3 else 0
                if filter_type == 0:
                    row[index] = plain[index]
                elif filter_type == 1:
                    row[index] = (plain[index] - left) & 0xFF
                elif filter_type == 2:
                    row[index] = (plain[index] - above) & 0xFF
                elif filter_type == 3:
                    row[index] = (plain[index] - ((left + above) >> 1)) & 0xFF
                else:
                    estimate = left + above - upper_left
                    candidates = (
                        (abs(estimate - left), left),
                        (abs(estimate - above), above),
                        (abs(estimate - upper_left), upper_left),
                    )
                    row[index] = (plain[index] - min(candidates)[1]) & 0xFF
            rows.append(bytes(row))
            previous = plain
        data = _png_with_filters(width, height, list(range(5)), rows)
        decoded = decode_scanlines(parse_png(data))
        for index in range(height):
            self.assertEqual(decoded[index * 9 : (index + 1) * 9], plain, f"row {index}")

    def test_refuses_an_interlaced_file(self) -> None:
        with self.assertRaises(PngFormatError) as caught:
            decode_scanlines(parse_png(make_png(interlace=1)))
        self.assertEqual(caught.exception.code, "png_interlace_unsupported")

    def test_refuses_an_undefined_compression_method(self) -> None:
        data = b"".join(
            [SIGNATURE, chunk("IHDR", header_bytes(2, 2, compression=1)), chunk("IDAT", b""), chunk("IEND", b"")]
        )
        with self.assertRaises(PngFormatError) as caught:
            decode_scanlines(parse_png(data))
        self.assertEqual(caught.exception.code, "png_compression_unknown")

    def test_refuses_an_undefined_filter_method(self) -> None:
        data = b"".join(
            [SIGNATURE, chunk("IHDR", header_bytes(2, 2, filter_method=1)), chunk("IDAT", b""), chunk("IEND", b"")]
        )
        with self.assertRaises(PngFormatError) as caught:
            decode_scanlines(parse_png(data))
        self.assertEqual(caught.exception.code, "png_filter_method_unknown")

    def test_refuses_an_undefined_colour_type(self) -> None:
        data = b"".join(
            [SIGNATURE, chunk("IHDR", header_bytes(2, 2, colour_type=5)), chunk("IDAT", b""), chunk("IEND", b"")]
        )
        with self.assertRaises(PngFormatError) as caught:
            decode_scanlines(parse_png(data))
        self.assertEqual(caught.exception.code, "png_colour_type_unknown")

    def test_refuses_image_data_that_does_not_decompress(self) -> None:
        data = b"".join(
            [SIGNATURE, chunk("IHDR", header_bytes(2, 2)), chunk("IDAT", b"not zlib"), chunk("IEND", b"")]
        )
        with self.assertRaises(PngFormatError) as caught:
            decode_scanlines(parse_png(data))
        self.assertEqual(caught.exception.code, "png_image_data_corrupt")

    def test_refuses_image_data_of_the_wrong_length(self) -> None:
        data = b"".join(
            [
                SIGNATURE,
                chunk("IHDR", header_bytes(4, 4)),
                chunk("IDAT", zlib.compress(bytes(10))),
                chunk("IEND", b""),
            ]
        )
        with self.assertRaises(PngFormatError) as caught:
            decode_scanlines(parse_png(data))
        self.assertEqual(caught.exception.code, "png_image_data_length")

    def test_refuses_an_undefined_scanline_filter(self) -> None:
        body = filtered(solid_scanlines(2, 1, (1, 2, 3)), 2, 1, 3, filter_type=9)
        data = b"".join(
            [
                SIGNATURE,
                chunk("IHDR", header_bytes(2, 1)),
                chunk("IDAT", zlib.compress(body)),
                chunk("IEND", b""),
            ]
        )
        with self.assertRaises(PngFormatError) as caught:
            decode_scanlines(parse_png(data))
        self.assertEqual(caught.exception.code, "png_filter_unknown")


class PaethBranchTest(unittest.TestCase):
    """Every neighbour the Paeth predictor can choose, driven through a real file.

    The three branches are not interchangeable: picking the wrong one shifts a
    whole row, and a decoder that only ever exercised the first branch would
    still pass every test built from unfiltered rows.
    """

    def _grayscale(self, rows: list[tuple[int, bytes]], width: int) -> bytes:
        body = bytearray()
        for filter_type, row in rows:
            body.append(filter_type)
            body += row
        return b"".join(
            [
                SIGNATURE,
                chunk("IHDR", header_bytes(width, len(rows), colour_type=0)),
                chunk("IDAT", zlib.compress(bytes(body))),
                chunk("IEND", b""),
            ]
        )

    def test_the_predictor_chooses_the_row_above_and_the_pixel_above_left(self) -> None:
        # Row 0 is [10, 20]. In row 1 the predictor picks `above` at index 0
        # (left 0, above 10, upper-left 0) and `upper-left` at index 1
        # (left 0, above 20, upper-left 10), which is the only combination that
        # reaches the third branch.
        data = self._grayscale([(0, bytes([10, 20])), (4, bytes([246, 20]))], 2)
        self.assertEqual(decode_scanlines(parse_png(data)), bytes([10, 20, 0, 30]))

    def test_the_predictor_chooses_the_pixel_to_the_left_when_it_is_nearest(self) -> None:
        # Every neighbour equal means the gradient is flat and `left` wins.
        data = self._grayscale([(0, bytes([7, 7])), (4, bytes([0, 0]))], 2)
        self.assertEqual(decode_scanlines(parse_png(data)), bytes([7, 7, 7, 7]))


class EncodeTest(unittest.TestCase):
    def test_writes_only_the_three_critical_chunks(self) -> None:
        header = PngHeader(2, 2, 8, 2, 0, 0, 0)
        image = parse_png(encode_png(header, solid_scanlines(2, 2, (1, 2, 3)), 6))
        self.assertEqual(image.kinds, ("IHDR", "IDAT", "IEND"))

    def test_the_same_pixels_always_produce_the_same_bytes(self) -> None:
        header = PngHeader(8, 8, 8, 2, 0, 0, 0)
        samples = bytes(range(192))
        self.assertEqual(encode_png(header, samples, 6), encode_png(header, samples, 6))

    def test_refuses_samples_that_do_not_fill_the_declared_raster(self) -> None:
        header = PngHeader(4, 4, 8, 2, 0, 0, 0)
        with self.assertRaises(PngFormatError) as caught:
            encode_png(header, b"too short", 6)
        self.assertEqual(caught.exception.code, "png_scanline_length")

    def test_it_always_writes_no_interlace_whatever_the_header_said(self) -> None:
        header = PngHeader(2, 2, 8, 2, 0, 0, 1)
        written = parse_png(encode_png(header, solid_scanlines(2, 2, (4, 5, 6)), 6))
        self.assertEqual(written.header.interlace, 0)


class NormalizeTest(unittest.TestCase):
    def test_removes_ancillary_chunks_and_keeps_the_picture(self) -> None:
        original = make_png(4, 3, (10, 200, 30), extra_chunks=(text_chunk("Software", "a generator"),))
        rewritten = normalize_png(original, 6)
        self.assertEqual(parse_png(rewritten).kinds, ("IHDR", "IDAT", "IEND"))
        self.assertEqual(decode_scanlines(parse_png(rewritten)), decode_scanlines(parse_png(original)))

    def test_is_idempotent(self) -> None:
        once = normalize_png(make_png(4, 3), 6)
        self.assertEqual(normalize_png(once, 6), once)

    def test_two_files_differing_only_in_metadata_normalize_to_the_same_bytes(self) -> None:
        first = make_png(4, 3, (7, 8, 9), extra_chunks=(text_chunk("A", "one"),))
        second = make_png(4, 3, (7, 8, 9), extra_chunks=(text_chunk("B", "two"), text_chunk("C", "three")))
        self.assertEqual(normalize_png(first, 6), normalize_png(second, 6))

    def test_does_not_resize_a_wrong_size_picture(self) -> None:
        rewritten = normalize_png(make_png(32, 16), 6)
        header = parse_png(rewritten).header
        self.assertEqual((header.width, header.height), (32, 16))

    def test_a_trailing_payload_never_survives_because_the_file_is_refused(self) -> None:
        with self.assertRaises(PngFormatError) as caught:
            normalize_png(make_png(trailing=b"\x00payload"), 6)
        self.assertEqual(caught.exception.code, "png_trailing_bytes")

    def test_the_compression_level_changes_the_bytes_but_not_the_picture(self) -> None:
        source = make_png(16, 16, (3, 200, 3))
        low = normalize_png(source, 1)
        high = normalize_png(source, 9)
        self.assertNotEqual(low, high)
        self.assertEqual(decode_scanlines(parse_png(low)), decode_scanlines(parse_png(high)))

    def test_an_rgba_picture_keeps_its_alpha_channel(self) -> None:
        source = make_png(4, 2, (1, 2, 3, 4), colour_type=6)
        rewritten = parse_png(normalize_png(source, 6))
        self.assertEqual(rewritten.header.colour_name, "RGBA")
        self.assertEqual(rewritten.header.channels, 4)

    def test_a_multi_part_image_stream_reassembles_into_one(self) -> None:
        body = zlib.compress(filtered(solid_scanlines(4, 2, (9, 9, 9)), 4, 2, 3))
        split = b"".join(
            [
                SIGNATURE,
                chunk("IHDR", header_bytes(4, 2)),
                chunk("IDAT", body[: len(body) // 2]),
                chunk("IDAT", body[len(body) // 2 :]),
                chunk("IEND", b""),
            ]
        )
        self.assertEqual(len(parse_png(normalize_png(split, 6)).of_kind("IDAT")), 1)


class EncodedHeaderTest(unittest.TestCase):
    def test_the_written_header_repeats_the_declared_raster(self) -> None:
        header = PngHeader(5, 7, 8, 6, 0, 0, 0)
        written = encode_png(header, bytes(5 * 7 * 4), 6)
        fields = struct.unpack(">IIBBBBB", parse_png(written).of_kind("IHDR")[0].data)
        self.assertEqual(fields, (5, 7, 8, 6, 0, 0, 0))


if __name__ == "__main__":
    unittest.main()
