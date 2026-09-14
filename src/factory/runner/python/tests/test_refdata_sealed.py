"""The test the SEALED guest runs, inside its own isolated build profile.

Every other test in this package reads something from the repository - the
shared grammar vectors, the generated C02 schemas - and the guest has no
repository. This one is self-contained on purpose, so the build lane proves
what only the build lane can: that the staged modules import inside the pinned
image, that PyArrow is really in the closure, and that a partition becomes
Parquet there and not merely on a developer's machine.
"""

from __future__ import annotations

import unittest

import refdata
from refdata.guest import MANIFEST
from refdata.parquet import MEDIA_TYPE, write_partition
from refdata.rows import HEADER, RowError, parse_partition

GOLDEN = f"{HEADER}\na,alpha,100\nb,beta,250\nc,alpha,50\n".encode()


class SealedGuest(unittest.TestCase):
    def test_the_pinned_closure_can_write_parquet(self) -> None:
        data = write_partition(parse_partition(GOLDEN))
        self.assertEqual(data[:4], b"PAR1")
        self.assertEqual(data[-4:], b"PAR1")
        self.assertGreater(len(data), 4)
        self.assertEqual(MEDIA_TYPE, "application/vnd.apache.parquet")

    def test_the_grammar_reads_the_golden_rows_and_refuses_an_overflow(self) -> None:
        rows = parse_partition(GOLDEN)
        self.assertEqual([row.record_id for row in rows], ["a", "b", "c"])
        self.assertEqual(sum(row.amount_cents for row in rows), 400)
        with self.assertRaises(RowError) as caught:
            parse_partition(f"{HEADER}\na,alpha,{2**63}\n".encode())
        self.assertEqual(caught.exception.code, "amount_overflow")

    def test_the_package_names_the_modules_the_guest_stages(self) -> None:
        self.assertEqual(refdata.__all__, ["guest", "parquet", "rows"])

    def test_the_manifest_declares_the_four_pinned_exports(self) -> None:
        self.assertEqual(MANIFEST["name"], "reference-data")
        self.assertEqual(
            [tool["name"] for tool in MANIFEST["tools"]],
            ["snapshotCsv", "parseCsv", "transformPartition", "orderedReduce"],
        )


if __name__ == "__main__":  # pragma: no cover - the lane runs discovery, not this module
    unittest.main()
