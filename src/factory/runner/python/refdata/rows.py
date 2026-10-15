"""C10's strict row grammar for ``reference.data.v1``, in Python.

This is the second implementation of the grammar that ``src/factory/
reference-data/csv.ts`` states in Bun, and it exists for the same reason
``factory_validation.py`` mirrors ``validation.ts``: the guest runs Python and
cannot call the host's parser. The two are held equal by the committed fixture
vectors in ``src/factory/reference-data/fixtures/grammar.json``, which both
runtimes read, so a divergence is a test failure rather than a silent
disagreement about what a valid row is.

Every bound here is a refusal, never a clamp. There is no code path that drops
a row, truncates a field, or reinterprets a value.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final

#: C10: at most one million rows and 256 MiB of input.
MAX_ROWS: Final = 1_000_000
MAX_BYTES: Final = 256 * 1024 * 1024
#: C10: ordered partitions of ten thousand rows.
PARTITION_ROWS: Final = 10_000
MAX_PARTITIONS: Final = MAX_ROWS // PARTITION_ROWS
#: Pack-chosen field bounds, so a partition buffer and a duplicate index are both bounded.
MAX_RECORD_ID_BYTES: Final = 256
MAX_CATEGORY_BYTES: Final = 128
#: C10: the declared signed-64-bit domain, nonnegative half.
MAX_AMOUNT_CENTS: Final = 2**63 - 1
#: C10's exact header line.
HEADER: Final = "record_id,category,amount_cents"

_AMOUNT: Final = re.compile(r"^(?:0|[1-9][0-9]*)$")
_LEADING_ZERO: Final = re.compile(r"^0[0-9]+$")


class RowError(Exception):
    """A refusal naming its exact reason and the one-based source line."""

    def __init__(self, code: str, line: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.line = line


@dataclass(frozen=True, slots=True)
class Row:
    """One validated row. ``index`` is its zero-based position, which is its output order."""

    index: int
    record_id: str
    category: str
    amount_cents: int


def _refuse(code: str, line: int, message: str) -> None:
    raise RowError(code, line, message)


def parse_amount(field: str, line: int) -> int:
    """Read one ``amount_cents`` field under the pinned grammar.

    Python's ``int`` accepts an Arabic-Indic digit, a leading space and a
    leading plus sign, and
    every one of them would reinterpret the source bytes, so the ASCII shape is
    checked before the conversion rather than after it. A leading zero is
    refused for the same reason: two byte sequences denoting one value would
    make "every row matches its source value" ambiguous.
    """
    if not field:
        _refuse("amount_empty", line, "amount_cents is empty")
    if _AMOUNT.match(field) is None:
        if _LEADING_ZERO.match(field) is not None:
            _refuse("amount_leading_zero", line, "amount_cents carries a leading zero")
        _refuse("amount_charset", line, "amount_cents is not a nonnegative ASCII decimal integer")
    value = int(field)
    if value > MAX_AMOUNT_CENTS:
        _refuse("amount_overflow", line, "amount_cents leaves the declared signed-64-bit domain")
    return value


def parse_line(text: str, index: int, line: int) -> Row:
    """Read one already-decoded data line. ``line`` is one-based over the partition."""
    if not text:
        _refuse("row_blank_line", line, "a blank line is not a row")
    fields = text.split(",")
    if len(fields) != 3:
        _refuse("row_field_count", line, "a row must hold exactly three comma-separated fields")
    record_id, category, amount = fields
    if not record_id:
        _refuse("record_id_empty", line, "record_id is empty")
    if len(record_id.encode("utf-8")) > MAX_RECORD_ID_BYTES:
        _refuse("record_id_bytes", line, "record_id exceeds its declared byte bound")
    if not category:
        _refuse("category_empty", line, "category is empty")
    if len(category.encode("utf-8")) > MAX_CATEGORY_BYTES:
        _refuse("category_bytes", line, "category exceeds its declared byte bound")
    return Row(index=index, record_id=record_id, category=category, amount_cents=parse_amount(amount, line))


def parse_partition(data: bytes, first_row_index: int = 0) -> list[Row]:
    """Read one partition's exact, self-contained CSV bytes.

    A partition carries C10's header and its own rows, so it is a valid input to
    the same grammar as the whole file. ``first_row_index`` places the rows in
    the whole input, which is what makes the guest's output order verifiable
    against the source without the guest ever seeing the rest of the file.

    The duplicate check here is partition-local. The host holds the global
    index; this is the second line of defence, not the first.
    """
    if len(data) > MAX_BYTES:
        _refuse("byte_limit", 1, "partition exceeds the declared 256 MiB bound")
    if b"\r" in data:
        _refuse("row_carriage_return", 1, "a carriage return is not part of the pinned line grammar")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        _refuse("encoding_invalid", 1, "partition is not valid UTF-8")
        raise  # pragma: no cover - _refuse always raises
    lines = text.split("\n")
    # A partition may or may not end with a newline; a blank line anywhere else
    # is refused by parse_line, so the only tolerated empty tail is this one.
    # `split` never returns an empty list, so the last element is always readable.
    if lines[-1] == "":
        lines.pop()
    if not lines:
        _refuse("header_missing", 1, "partition holds no header line")
    if lines[0] != HEADER:
        _refuse("header_mismatch", 1, "the first line is not the pinned header")
    body = lines[1:]
    if not body:
        _refuse("row_empty", 1, "partition holds a header and no rows")
    if len(body) > PARTITION_ROWS:
        _refuse("row_limit", 1, "partition exceeds the declared ten-thousand-row bound")
    rows: list[Row] = []
    seen: set[str] = set()
    for offset, line_text in enumerate(body):
        row = parse_line(line_text, first_row_index + offset, offset + 2)
        if row.record_id in seen:
            _refuse("record_id_duplicate", offset + 2, "record_id repeats an earlier row in this partition")
        seen.add(row.record_id)
        rows.append(row)
    return rows
