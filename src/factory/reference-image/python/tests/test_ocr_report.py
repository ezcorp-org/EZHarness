"""The OCR threshold, and the difference between no text and no measurement."""

from __future__ import annotations

import unittest

from reference_image.ocr_report import (
    OcrError,
    OcrOutcome,
    OcrWord,
    parse_tsv,
    read_words,
    recognized_words,
    tesseract_command,
)

from . import tsv


class ParseTsvTest(unittest.TestCase):
    def test_reads_words_and_their_confidences(self) -> None:
        words = parse_tsv(tsv((("91.5", "SALE"), ("42", "maybe"))))
        self.assertEqual(words, (OcrWord("SALE", 91.5), OcrWord("maybe", 42.0)))

    def test_drops_layout_rows_that_carry_no_text(self) -> None:
        document = "level\tconf\ttext\n1\t-1\t\n5\t80\tTREE\n"
        self.assertEqual(parse_tsv(document), (OcrWord("TREE", 80.0),))

    def test_ignores_blank_lines(self) -> None:
        self.assertEqual(parse_tsv("level\tconf\ttext\n\n5\t70\tOAK\n\n"), (OcrWord("OAK", 70.0),))

    def test_finds_the_columns_wherever_the_header_puts_them(self) -> None:
        document = "text\tleft\tconf\nHELLO\t3\t88\n"
        self.assertEqual(parse_tsv(document), (OcrWord("HELLO", 88.0),))

    def test_empty_output_is_an_error_not_an_empty_result(self) -> None:
        with self.assertRaises(OcrError) as caught:
            parse_tsv("")
        self.assertEqual(caught.exception.code, "ocr_output_empty")

    def test_a_header_without_the_needed_columns_is_unreadable(self) -> None:
        with self.assertRaises(OcrError) as caught:
            parse_tsv("left\ttop\twidth\n1\t2\t3\n")
        self.assertEqual(caught.exception.code, "ocr_output_unreadable")

    def test_a_short_row_is_unreadable_rather_than_skipped(self) -> None:
        with self.assertRaises(OcrError) as caught:
            parse_tsv("level\tconf\ttext\n5\t80\n")
        self.assertEqual(caught.exception.code, "ocr_output_unreadable")

    def test_a_non_numeric_confidence_is_unreadable(self) -> None:
        with self.assertRaises(OcrError) as caught:
            parse_tsv("level\tconf\ttext\n5\thigh\tWORD\n")
        self.assertEqual(caught.exception.code, "ocr_output_unreadable")

    def test_a_header_only_document_yields_no_words(self) -> None:
        self.assertEqual(parse_tsv("level\tconf\ttext\n"), ())


class ThresholdTest(unittest.TestCase):
    def test_a_word_at_the_threshold_counts_as_text(self) -> None:
        self.assertEqual(len(recognized_words((OcrWord("SALE", 60.0),), 60)), 1)

    def test_a_word_below_the_threshold_is_not_text(self) -> None:
        self.assertEqual(recognized_words((OcrWord("smudge", 59.9),), 60), ())

    def test_the_negative_confidence_a_layout_row_carries_never_counts(self) -> None:
        self.assertEqual(recognized_words((OcrWord("x", -1.0),), 60), ())

    def test_it_keeps_only_the_words_above_the_line(self) -> None:
        words = (OcrWord("A", 95.0), OcrWord("B", 10.0), OcrWord("C", 61.0))
        self.assertEqual(tuple(word.text for word in recognized_words(words, 60)), ("A", "C"))


class OutcomeTest(unittest.TestCase):
    def test_reports_no_text_and_still_names_how_many_tokens_were_scored(self) -> None:
        outcome = read_words(tsv((("12", "smudge"), ("3", "blur"))), 60, ("tesseract",))
        self.assertFalse(outcome.has_text)
        self.assertEqual(outcome.total_words, 2)
        self.assertIn("2 candidate token(s) were scored", outcome.summary())

    def test_reports_the_words_it_recognized(self) -> None:
        outcome = read_words(tsv((("95", "SALE"), ("30", "noise"))), 60, ("tesseract", "--psm", "11"))
        self.assertTrue(outcome.has_text)
        self.assertIn("'SALE' at 95", outcome.summary())
        self.assertEqual(outcome.command, ("tesseract", "--psm", "11"))

    def test_a_long_result_names_only_the_first_few_words(self) -> None:
        rows = tuple((str(90 + index), f"W{index}") for index in range(9))
        outcome = read_words(tsv(rows), 60, ("tesseract",))
        self.assertIn("9 recognized word(s)", outcome.summary())
        self.assertNotIn("W8", outcome.summary())

    def test_an_outcome_with_no_recognized_word_has_no_text(self) -> None:
        self.assertFalse(OcrOutcome(("tesseract",), 0, ()).has_text)


class CommandTest(unittest.TestCase):
    def test_every_pinned_argument_appears_in_the_command(self) -> None:
        command = tesseract_command("/tmp/v.png", "eng", 11, 3)  # noqa: S108 - a literal in an argument assertion
        self.assertEqual(
            command,
            ("tesseract", "/tmp/v.png", "stdout", "-l", "eng", "--psm", "11", "--oem", "3", "tsv"),  # noqa: S108
        )


if __name__ == "__main__":
    unittest.main()
