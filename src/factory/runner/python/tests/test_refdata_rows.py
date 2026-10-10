"""The strict row grammar, case by case.

Every refusal names its own code, because "it threw" is not evidence that the
grammar refused for the reason C10 states.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from unittest.mock import patch

from refdata import rows as grammar
from refdata.rows import (
    HEADER,
    MAX_AMOUNT_CENTS,
    MAX_CATEGORY_BYTES,
    MAX_RECORD_ID_BYTES,
    PARTITION_ROWS,
    RowError,
    parse_amount,
    parse_line,
    parse_partition,
)

GOLDEN = b"record_id,category,amount_cents\na,alpha,100\nb,beta,250\nc,alpha,50\n"


class AmountGrammar(unittest.TestCase):
    def test_reads_the_declared_domain(self) -> None:
        self.assertEqual(parse_amount("0", 2), 0)
        self.assertEqual(parse_amount("100", 2), 100)
        self.assertEqual(parse_amount(str(MAX_AMOUNT_CENTS), 2), MAX_AMOUNT_CENTS)

    def test_refuses_one_past_the_domain(self) -> None:
        with self.assertRaises(RowError) as caught:
            parse_amount(str(MAX_AMOUNT_CENTS + 1), 7)
        self.assertEqual(caught.exception.code, "amount_overflow")
        self.assertEqual(caught.exception.line, 7)

    def test_refuses_every_shape_int_would_have_accepted(self) -> None:
        for field, code in (
            ("", "amount_empty"),
            ("007", "amount_leading_zero"),
            ("00", "amount_leading_zero"),
            ("+5", "amount_charset"),
            ("-1", "amount_charset"),
            (" 5", "amount_charset"),
            ("5 ", "amount_charset"),
            ("5.0", "amount_charset"),
            ("1e3", "amount_charset"),
            ("\u0665", "amount_charset"),  # ARABIC-INDIC DIGIT FIVE: int() would read it as 5
            ("1_0", "amount_charset"),
        ):
            with self.subTest(field=field), self.assertRaises(RowError) as caught:
                parse_amount(field, 3)
            self.assertEqual(caught.exception.code, code)


class LineGrammar(unittest.TestCase):
    def test_reads_one_row(self) -> None:
        row = parse_line("a,alpha,100", 4, 5)
        self.assertEqual((row.index, row.record_id, row.category, row.amount_cents), (4, "a", "alpha", 100))

    def test_refuses_a_field_count_that_is_not_three(self) -> None:
        for text in ("", "a,alpha", "a,alpha,1,extra", "a"):
            with self.subTest(text=text), self.assertRaises(RowError) as caught:
                parse_line(text, 0, 2)
            self.assertIn(caught.exception.code, {"row_blank_line", "row_field_count"})

    def test_refuses_empty_and_oversized_identifiers(self) -> None:
        long_id = "x" * (MAX_RECORD_ID_BYTES + 1)
        long_category = "y" * (MAX_CATEGORY_BYTES + 1)
        for text, code in (
            (",alpha,1", "record_id_empty"),
            ("a,,1", "category_empty"),
            (f"{long_id},alpha,1", "record_id_bytes"),
            (f"a,{long_category},1", "category_bytes"),
        ):
            with self.subTest(code=code), self.assertRaises(RowError) as caught:
                parse_line(text, 0, 2)
            self.assertEqual(caught.exception.code, code)

    def test_measures_identifier_bounds_in_bytes_not_characters(self) -> None:
        # Each of these is one character and four UTF-8 bytes.
        wide = "\U0001f600" * (MAX_RECORD_ID_BYTES // 4)
        self.assertEqual(parse_line(f"{wide},alpha,1", 0, 2).record_id, wide)
        with self.assertRaises(RowError) as caught:
            parse_line(f"{wide}\U0001f600,alpha,1", 0, 2)
        self.assertEqual(caught.exception.code, "record_id_bytes")


class PartitionGrammar(unittest.TestCase):
    def test_reads_the_golden_three_rows_in_order(self) -> None:
        rows = parse_partition(GOLDEN)
        self.assertEqual([row.record_id for row in rows], ["a", "b", "c"])
        self.assertEqual([row.amount_cents for row in rows], [100, 250, 50])
        self.assertEqual([row.index for row in rows], [0, 1, 2])

    def test_places_rows_at_their_offset_in_the_whole_input(self) -> None:
        rows = parse_partition(GOLDEN, first_row_index=20_000)
        self.assertEqual([row.index for row in rows], [20_000, 20_001, 20_002])

    def test_accepts_a_partition_with_no_trailing_newline(self) -> None:
        self.assertEqual(len(parse_partition(GOLDEN.rstrip(b"\n"))), 3)

    def test_refuses_a_header_that_is_not_the_pinned_one(self) -> None:
        for payload, code in (
            (b"record_id,category,amount\na,alpha,1\n", "header_mismatch"),
            (b"", "header_missing"),
            (b"\n", "header_mismatch"),
            (HEADER.encode() + b"\n", "row_empty"),
        ):
            with self.subTest(code=code), self.assertRaises(RowError) as caught:
                parse_partition(payload)
            self.assertEqual(caught.exception.code, code)

    def test_refuses_a_carriage_return_rather_than_stripping_it(self) -> None:
        with self.assertRaises(RowError) as caught:
            parse_partition(b"record_id,category,amount_cents\r\na,alpha,1\r\n")
        self.assertEqual(caught.exception.code, "row_carriage_return")

    def test_refuses_bytes_that_are_not_utf8(self) -> None:
        with self.assertRaises(RowError) as caught:
            parse_partition(b"record_id,category,amount_cents\na,\xff\xfe,1\n")
        self.assertEqual(caught.exception.code, "encoding_invalid")

    def test_refuses_a_repeated_record_id_inside_one_partition(self) -> None:
        with self.assertRaises(RowError) as caught:
            parse_partition(b"record_id,category,amount_cents\na,alpha,1\na,beta,2\n")
        self.assertEqual(caught.exception.code, "record_id_duplicate")

    def test_refuses_a_blank_line_between_rows(self) -> None:
        with self.assertRaises(RowError) as caught:
            parse_partition(b"record_id,category,amount_cents\na,alpha,1\n\nb,beta,2\n")
        self.assertEqual(caught.exception.code, "row_blank_line")

    def test_accepts_exactly_the_partition_row_bound_and_refuses_one_more(self) -> None:
        body = "\n".join(f"id{index},alpha,{index}" for index in range(PARTITION_ROWS))
        exact = f"{HEADER}\n{body}\n".encode()
        self.assertEqual(len(parse_partition(exact)), PARTITION_ROWS)
        with self.assertRaises(RowError) as caught:
            parse_partition(f"{HEADER}\n{body}\nover,alpha,1\n".encode())
        self.assertEqual(caught.exception.code, "row_limit")

    def test_refuses_a_partition_past_the_declared_byte_bound(self) -> None:
        # The real bound is 256 MiB; narrowing it here proves the refusal
        # without materialising a quarter of a gibibyte in a unit test.
        with patch.object(grammar, "MAX_BYTES", 4), self.assertRaises(RowError) as caught:
            parse_partition(GOLDEN)
        self.assertEqual(caught.exception.code, "byte_limit")


class SharedFixtures(unittest.TestCase):
    """The Bun parser reads the same vectors. A divergence is a failure here, not a surprise later."""

    def test_every_committed_vector_gets_its_declared_verdict(self) -> None:
        path = Path(__file__).resolve().parents[4] / "factory/reference-data/fixtures/grammar.json"
        vectors = json.loads(path.read_text(encoding="utf-8"))
        self.assertGreater(len(vectors["partitions"]), 0)
        for vector in vectors["partitions"]:
            with self.subTest(name=vector["name"]):
                payload = vector["csv"].encode("utf-8")
                if vector["accepts"]:
                    rows = parse_partition(payload)
                    self.assertEqual([row.record_id for row in rows], vector["recordIds"])
                    self.assertEqual([str(row.amount_cents) for row in rows], vector["amounts"])
                else:
                    with self.assertRaises(RowError) as caught:
                        parse_partition(payload)
                    self.assertEqual(caught.exception.code, vector["code"])


if __name__ == "__main__":  # pragma: no cover - the lane runs discovery, not this module
    unittest.main()
