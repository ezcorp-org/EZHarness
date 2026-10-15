"""The pinned PyArrow serialisation for ``reference.data.v1``.

C10 requires the serialisation settings to be pinned and requires acceptance to
check "values and manifests rather than assuming all Parquet writers emit the
same bytes". Both halves matter here. The settings below are the pin, stated
once; the reconciliation validator reads the result back with its own decoder
and compares values, never bytes.

Every setting is chosen so the export is the simplest thing a conforming
Parquet reader can decode: uncompressed, no dictionary, no statistics, no
embedded Arrow schema, v1 data pages, and one row group per partition. A
simpler file is not a smaller file; it is a file whose meaning does not depend
on the library that wrote it.
"""

from __future__ import annotations

import io
from typing import Any, Final

import pyarrow as pa
import pyarrow.parquet as pq

from refdata.rows import PARTITION_ROWS, Row

#: The declared output schema. Every column is REQUIRED, so no row can hold a null.
SCHEMA: Final = pa.schema(
    [
        pa.field("record_id", pa.string(), nullable=False),
        pa.field("category", pa.string(), nullable=False),
        pa.field("amount_cents", pa.int64(), nullable=False),
    ]
)

#: C10's pinned serialisation settings, in one place so nothing drifts per call.
WRITER_SETTINGS: Final[dict[str, Any]] = {
    "version": "2.6",
    "compression": "none",
    "use_dictionary": False,
    "write_statistics": False,
    "data_page_version": "1.0",
    "store_schema": False,
    "write_page_index": False,
    "row_group_size": PARTITION_ROWS,
}

#: The media type every exported part carries.
MEDIA_TYPE: Final = "application/vnd.apache.parquet"


def write_partition(rows: list[Row]) -> bytes:
    """Serialise one partition's rows, in input order, with the pinned settings."""
    table = pa.table(
        {
            "record_id": [row.record_id for row in rows],
            "category": [row.category for row in rows],
            "amount_cents": [row.amount_cents for row in rows],
        },
        schema=SCHEMA,
    )
    sink = io.BytesIO()
    pq.write_table(table, sink, **WRITER_SETTINGS)
    return sink.getvalue()


def summarize(rows: list[Row]) -> dict[str, Any]:
    """What the transform observed about the partition it just wrote.

    These are the transform's OWN counters. C10 forbids acceptance from
    resting on them, and nothing here pretends otherwise: the reduction uses
    them to assemble the manifest, and the protected reconciliation recomputes
    every one of them from the immutable input and the exported Parquet. A
    transform that lies here fails there.
    """
    categories: dict[str, dict[str, int]] = {}
    total = 0
    for row in rows:
        total += row.amount_cents
        bucket = categories.setdefault(row.category, {"count": 0, "sumCents": 0})
        bucket["count"] += 1
        bucket["sumCents"] += row.amount_cents
    return {
        "rowCount": len(rows),
        "firstRowIndex": rows[0].index if rows else 0,
        # Exact integer accounting crosses the wire as a decimal string: a JSON
        # number is a double, and the declared domain reaches 2**63 - 1.
        "totalAmountCents": str(total),
        "categories": [
            {"category": name, "count": bucket["count"], "sumCents": str(bucket["sumCents"])}
            for name, bucket in sorted(categories.items())
        ],
        "firstRecordId": rows[0].record_id if rows else "",
        "lastRecordId": rows[-1].record_id if rows else "",
    }
