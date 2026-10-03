"""The pinned PyArrow serialisation and the transform's own counters."""

from __future__ import annotations

import unittest

import pyarrow.parquet as pq

from refdata.parquet import MEDIA_TYPE, SCHEMA, WRITER_SETTINGS, summarize, write_partition
from refdata.rows import parse_partition

GOLDEN = b"record_id,category,amount_cents\na,alpha,100\nb,beta,250\nc,alpha,50\n"


class PinnedSettings(unittest.TestCase):
    def test_the_declared_schema_forbids_a_null_in_every_column(self) -> None:
        self.assertEqual(SCHEMA.names, ["record_id", "category", "amount_cents"])
        for field in SCHEMA:
            self.assertFalse(field.nullable, f"{field.name} must be REQUIRED")

    def test_the_settings_are_the_ones_the_independent_reader_expects(self) -> None:
        self.assertEqual(WRITER_SETTINGS["compression"], "none")
        self.assertFalse(WRITER_SETTINGS["use_dictionary"])
        self.assertFalse(WRITER_SETTINGS["write_statistics"])
        self.assertFalse(WRITER_SETTINGS["store_schema"])
        self.assertEqual(WRITER_SETTINGS["data_page_version"], "1.0")
        self.assertEqual(MEDIA_TYPE, "application/vnd.apache.parquet")


class Writer(unittest.TestCase):
    def test_writes_the_golden_rows_in_input_order(self) -> None:
        data = write_partition(parse_partition(GOLDEN))
        self.assertEqual(data[:4], b"PAR1")
        self.assertEqual(data[-4:], b"PAR1")
        table = pq.read_table(__import__("io").BytesIO(data))
        self.assertEqual(table.column("record_id").to_pylist(), ["a", "b", "c"])
        self.assertEqual(table.column("category").to_pylist(), ["alpha", "beta", "alpha"])
        self.assertEqual(table.column("amount_cents").to_pylist(), [100, 250, 50])

    def test_writes_one_row_group_per_partition_with_no_dictionary(self) -> None:
        data = write_partition(parse_partition(GOLDEN))
        metadata = pq.read_metadata(__import__("io").BytesIO(data))
        self.assertEqual(metadata.num_row_groups, 1)
        self.assertEqual(metadata.num_rows, 3)
        for column in range(3):
            chunk = metadata.row_group(0).column(column)
            self.assertFalse(chunk.has_dictionary_page)
            self.assertEqual(chunk.compression, "UNCOMPRESSED")

    def test_carries_the_whole_signed_64_bit_domain_without_loss(self) -> None:
        limit = 2**63 - 1
        rows = parse_partition(f"record_id,category,amount_cents\nbig,alpha,{limit}\nzero,beta,0\n".encode())
        table = pq.read_table(__import__("io").BytesIO(write_partition(rows)))
        self.assertEqual(table.column("amount_cents").to_pylist(), [limit, 0])


class Counters(unittest.TestCase):
    def test_reports_the_golden_accounting(self) -> None:
        report = summarize(parse_partition(GOLDEN))
        self.assertEqual(report["rowCount"], 3)
        self.assertEqual(report["totalAmountCents"], "400")
        self.assertEqual(report["firstRecordId"], "a")
        self.assertEqual(report["lastRecordId"], "c")
        self.assertEqual(
            report["categories"],
            [
                {"category": "alpha", "count": 2, "sumCents": "150"},
                {"category": "beta", "count": 1, "sumCents": "250"},
            ],
        )

    def test_reports_sums_as_exact_decimal_strings(self) -> None:
        limit = 2**63 - 1
        rows = parse_partition(f"record_id,category,amount_cents\nbig,alpha,{limit}\n".encode())
        report = summarize(rows)
        self.assertEqual(report["totalAmountCents"], str(limit))
        self.assertNotEqual(int(report["totalAmountCents"]), int(float(limit)))

    def test_reports_an_empty_partition_without_indexing_a_row(self) -> None:
        report = summarize([])
        self.assertEqual(report["rowCount"], 0)
        self.assertEqual(report["totalAmountCents"], "0")
        self.assertEqual(report["firstRecordId"], "")
        self.assertEqual(report["lastRecordId"], "")
        self.assertEqual(report["firstRowIndex"], 0)
        self.assertEqual(report["categories"], [])


if __name__ == "__main__":  # pragma: no cover - the lane runs discovery, not this module
    unittest.main()
