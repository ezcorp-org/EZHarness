"""What the container parser accepts, and what it names when it refuses."""

from __future__ import annotations

import struct
import unittest
import zlib

from reference_image.png_format import (
    PngFormatError,
    frame_count,
    idat_bytes,
    parse_png,
)

from . import SIGNATURE, animation_control, chunk, header_bytes, make_png, text_chunk


class ParsePngTest(unittest.TestCase):
    def test_reads_a_valid_file_and_reports_its_header(self) -> None:
        image = parse_png(make_png(width=7, height=5))
        self.assertEqual((image.header.width, image.header.height), (7, 5))
        self.assertEqual(image.header.colour_name, "RGB")
        self.assertEqual(image.header.channels, 3)
        self.assertEqual(image.header.bit_depth, 8)
        self.assertEqual(image.kinds, ("IHDR", "IDAT", "IEND"))
        self.assertEqual(image.ancillary_kinds, ())

    def test_records_the_total_size_it_read(self) -> None:
        data = make_png()
        self.assertEqual(parse_png(data).total_bytes, len(data))

    def test_row_stride_follows_colour_type_and_depth(self) -> None:
        rgba = parse_png(make_png(width=4, height=2, colour=(1, 2, 3, 4), colour_type=6))
        self.assertEqual(rgba.header.channels, 4)
        self.assertEqual(rgba.header.row_bytes, 16)
        self.assertEqual(rgba.header.bytes_per_pixel, 4)
        self.assertEqual(rgba.header.colour_name, "RGBA")

    def test_a_sub_byte_depth_still_has_a_stride_of_one(self) -> None:
        data = b"".join(
            [
                SIGNATURE,
                chunk("IHDR", header_bytes(8, 1, bit_depth=1, colour_type=0)),
                chunk("IDAT", zlib.compress(bytes([0, 0b10101010]))),
                chunk("IEND", b""),
            ]
        )
        image = parse_png(data)
        self.assertEqual(image.header.bytes_per_pixel, 1)
        self.assertEqual(image.header.row_bytes, 1)

    def test_lists_ancillary_chunks_once_each_in_order(self) -> None:
        image = parse_png(make_png(extra_chunks=(text_chunk("A", "1"), text_chunk("B", "2"))))
        self.assertEqual(image.ancillary_kinds, ("tEXt",))
        self.assertEqual(len(image.of_kind("tEXt")), 2)

    def test_refuses_bytes_that_are_not_a_png(self) -> None:
        with self.assertRaises(PngFormatError) as caught:
            parse_png(b"GIF89a and then some")
        self.assertEqual(caught.exception.code, "png_signature_missing")

    def test_refuses_trailing_bytes_after_the_end_chunk(self) -> None:
        with self.assertRaises(PngFormatError) as caught:
            parse_png(make_png(trailing=b"a hidden payload"))
        self.assertEqual(caught.exception.code, "png_trailing_bytes")

    def test_refuses_a_chunk_whose_checksum_does_not_match(self) -> None:
        broken = b"".join(
            [
                SIGNATURE,
                chunk("IHDR", header_bytes(2, 2), crc=0),
                chunk("IEND", b""),
            ]
        )
        with self.assertRaises(PngFormatError) as caught:
            parse_png(broken)
        self.assertEqual(caught.exception.code, "png_chunk_crc_mismatch")

    def test_refuses_a_truncated_chunk_header(self) -> None:
        with self.assertRaises(PngFormatError) as caught:
            parse_png(SIGNATURE + b"\x00\x00\x00")
        self.assertEqual(caught.exception.code, "png_chunk_truncated")

    def test_refuses_a_chunk_that_runs_past_the_end(self) -> None:
        truncated = SIGNATURE + struct.pack(">I", 40) + b"IHDR" + b"short"
        with self.assertRaises(PngFormatError) as caught:
            parse_png(truncated)
        self.assertEqual(caught.exception.code, "png_chunk_truncated")

    def test_refuses_a_chunk_length_above_the_specified_maximum(self) -> None:
        oversize = SIGNATURE + struct.pack(">I", 0x80000000) + b"IHDR" + bytes(4)
        with self.assertRaises(PngFormatError) as caught:
            parse_png(oversize)
        self.assertEqual(caught.exception.code, "png_chunk_length_invalid")

    def test_refuses_a_chunk_type_that_is_not_four_letters(self) -> None:
        bad = SIGNATURE + struct.pack(">I", 0) + b"1234" + struct.pack(">I", 0)
        with self.assertRaises(PngFormatError) as caught:
            parse_png(bad)
        self.assertEqual(caught.exception.code, "png_chunk_type_invalid")

    def test_refuses_a_header_that_is_not_first(self) -> None:
        misplaced = b"".join(
            [SIGNATURE, text_chunk(), chunk("IHDR", header_bytes(2, 2)), chunk("IEND", b"")]
        )
        with self.assertRaises(PngFormatError) as caught:
            parse_png(misplaced)
        self.assertEqual(caught.exception.code, "png_header_missing")

    def test_refuses_a_second_header(self) -> None:
        doubled = b"".join(
            [
                SIGNATURE,
                chunk("IHDR", header_bytes(2, 2)),
                chunk("IHDR", header_bytes(2, 2)),
                chunk("IEND", b""),
            ]
        )
        with self.assertRaises(PngFormatError) as caught:
            parse_png(doubled)
        self.assertEqual(caught.exception.code, "png_header_misplaced")

    def test_refuses_a_header_of_the_wrong_length(self) -> None:
        short = b"".join([SIGNATURE, chunk("IHDR", bytes(12)), chunk("IEND", b"")])
        with self.assertRaises(PngFormatError) as caught:
            parse_png(short)
        self.assertEqual(caught.exception.code, "png_header_invalid")

    def test_refuses_a_zero_dimension(self) -> None:
        with self.assertRaises(PngFormatError) as caught:
            parse_png(b"".join([SIGNATURE, chunk("IHDR", header_bytes(0, 4)), chunk("IEND", b"")]))
        self.assertEqual(caught.exception.code, "png_header_invalid")

    def test_refuses_a_file_with_no_header(self) -> None:
        with self.assertRaises(PngFormatError) as caught:
            parse_png(SIGNATURE)
        self.assertEqual(caught.exception.code, "png_header_missing")

    def test_refuses_a_file_with_no_end_chunk(self) -> None:
        with self.assertRaises(PngFormatError) as caught:
            parse_png(SIGNATURE + chunk("IHDR", header_bytes(2, 2)))
        self.assertEqual(caught.exception.code, "png_end_missing")

    def test_refuses_an_end_chunk_carrying_bytes(self) -> None:
        with self.assertRaises(PngFormatError) as caught:
            parse_png(b"".join([SIGNATURE, chunk("IHDR", header_bytes(2, 2)), chunk("IEND", b"payload")]))
        self.assertEqual(caught.exception.code, "png_end_invalid")


class FrameCountTest(unittest.TestCase):
    def test_a_plain_file_has_one_frame(self) -> None:
        self.assertEqual(frame_count(parse_png(make_png())), 1)

    def test_an_animated_file_reports_its_declared_count(self) -> None:
        image = parse_png(make_png(extra_chunks=(animation_control(7),)))
        self.assertEqual(frame_count(image), 7)

    def test_a_truncated_animation_chunk_is_an_error_not_a_count(self) -> None:
        image = parse_png(make_png(extra_chunks=(chunk("acTL", b"\x00\x00"),)))
        with self.assertRaises(PngFormatError) as caught:
            frame_count(image)
        self.assertEqual(caught.exception.code, "png_animation_invalid")


class ImageDataTest(unittest.TestCase):
    def test_joins_every_data_chunk_into_one_stream(self) -> None:
        body = zlib.compress(bytes([0, 1, 2, 3]))
        split = b"".join(
            [
                SIGNATURE,
                chunk("IHDR", header_bytes(1, 1)),
                chunk("IDAT", body[:3]),
                chunk("IDAT", body[3:]),
                chunk("IEND", b""),
            ]
        )
        self.assertEqual(idat_bytes(parse_png(split)), body)

    def test_a_file_with_no_image_data_is_an_error(self) -> None:
        image = parse_png(b"".join([SIGNATURE, chunk("IHDR", header_bytes(1, 1)), chunk("IEND", b"")]))
        with self.assertRaises(PngFormatError) as caught:
            idat_bytes(image)
        self.assertEqual(caught.exception.code, "png_image_data_missing")


if __name__ == "__main__":
    unittest.main()
