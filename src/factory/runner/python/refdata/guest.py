"""The isolated guest of ``reference.data.v1``.

It reuses the C02 conformance guest rather than writing a second frame loop:
the same ``serve`` reads the same newline-delimited JSON-RPC frames, the same
``Guest.verdict`` refuses a request the shared contract would refuse, and the
same Python-native validator checks the result before it leaves the process.
Only the manifest and the four exports are this pack's.

Bulk bytes never cross the control channel. The channel is capped at one
mebibyte for a guest's whole life, and a partition at C10's own bound is larger
than that, so every payload moves through the per-attempt material directory
the host bind-mounts read-write at ``/materials``: the host writes ``in/``
before the guest starts and reads ``out/`` after it exits, verifying every
digest the guest reports against the bytes it actually finds.

The guest still reaches nothing else. It has no network, no credential, no host
capability, and it emits no reverse request.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Final

from guest import Guest, GuestError, load_schema, serve
from refdata.parquet import MEDIA_TYPE, WRITER_SETTINGS, summarize, write_partition
from refdata.rows import HEADER, MAX_PARTITIONS, PARTITION_ROWS, RowError, parse_partition

Json = Any

#: The per-attempt material directory the host bind-mounts read-write.
MATERIALS: Final = Path("/materials")
#: Where the launcher finds this pack's modules and the generated schemas.
WORKSPACE: Final = Path(__file__).resolve().parent.parent

GUEST_VERSION: Final = "factory.reference-data-guest.v1"

#: The v4 manifest name.
#:
#: It is NOT the factory package reference, and it is not expected to be. The
#: reference carries `manifestName` alongside its scoped `package`, and that is
#: the field the host compares, so the two simply differ.
MANIFEST_NAME: Final = "reference-data"

MANIFEST: Final[dict[str, Json]] = {
    "schemaVersion": 4,
    "name": MANIFEST_NAME,
    "version": "1.0.0",
    "author": {"name": "EZCorp factory platform"},
    "description": "Pinned CSV snapshot, strict parse, PyArrow partition transform and ordered reduction",
    "permissions": {},
    "tools": [
        {
            "name": name,
            "description": description,
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
        }
        for name, description in (
            ("snapshotCsv", "Record the immutable identity of one CSV input before any expansion"),
            ("parseCsv", "Validate one CSV snapshot strictly and cut it into ordered partitions"),
            ("transformPartition", "Write one ordered partition as Parquet with the pinned settings"),
            ("orderedReduce", "Assemble the ordered Parquet dataset and its manifest"),
        )
    ],
}


def _digest(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def _member(name: str) -> Path:
    """Resolve one material path, refusing anything that leaves the mount.

    The host chose these names, but a path is still checked before it is
    opened: a guest that can be persuaded to write outside its own directory
    would turn a data defect into an isolation defect.
    """
    if not name or name.startswith("/") or ".." in Path(name).parts:
        raise GuestError(f"material name {name!r} is not a bounded relative path")
    resolved = (MATERIALS / name).resolve()
    if resolved != MATERIALS.resolve() and MATERIALS.resolve() not in resolved.parents:
        raise GuestError(f"material name {name!r} leaves the material directory")
    return resolved


def _read(name: str) -> bytes:
    path = _member(name)
    try:
        return path.read_bytes()
    except OSError as error:
        raise GuestError(f"material {name!r} is unreadable: {error.strerror}") from error


def _write(name: str, data: bytes) -> dict[str, Json]:
    path = _member(name)
    try:
        # The directory creation is inside the guard too: a name whose parent is
        # an existing FILE raises here, and an unhandled OSError would end the
        # guest process instead of failing the attempt with a reason.
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    except OSError as error:
        raise GuestError(f"material {name!r} is unwritable: {error.strerror}") from error
    return {"name": name, "digest": _digest(data), "encodedBytes": len(data)}


def _command(request: Json) -> dict[str, Json]:
    if not isinstance(request, dict):
        raise GuestError("a runner request must be an object")
    envelope = request.get("input")
    if not isinstance(envelope, dict) or envelope.get("kind") != "inline":
        raise GuestError("this pack takes its command inline; an artifact input is not supported")
    command = envelope.get("value")
    if not isinstance(command, dict):
        raise GuestError("the inline command must be an object")
    return command


def _text(command: dict[str, Json], key: str) -> str:
    value = command.get(key)
    if not isinstance(value, str) or not value:
        raise GuestError(f"command field {key!r} must be a nonempty string")
    return value


def _prefix(command: dict[str, Json], key: str) -> str:
    """An optional name prefix. The material directory is flat, so no prefix is the ordinary case."""
    value = command.get(key, "")
    if not isinstance(value, str):
        raise GuestError(f"command field {key!r} must be a string when present")
    return value


def _whole(command: dict[str, Json], key: str) -> int:
    value = command.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise GuestError(f"command field {key!r} must be a nonnegative integer")
    return value


def snapshot_csv(command: dict[str, Json]) -> dict[str, Json]:
    """Record what the input IS before anything expands it.

    C10 requires the source version and content hash to be snapshotted before
    expansion, so this reads the bytes once, in bounded blocks, and reports
    their identity. It validates nothing: a refusal here would mean the
    snapshot depended on the content being acceptable, and C10 wants the
    rejected input recorded too.
    """
    source = _member(_text(command, "input"))
    digest = hashlib.sha256()
    total = 0
    header = b""
    try:
        with source.open("rb") as handle:
            while True:
                block = handle.read(1024 * 1024)
                if not block:
                    break
                if not header:
                    header = block.split(b"\n", 1)[0]
                digest.update(block)
                total += len(block)
    except OSError as error:
        raise GuestError(f"material {command['input']!r} is unreadable: {error.strerror}") from error
    return {
        "schemaVersion": "factory.reference-data-snapshot.v1",
        "digest": f"sha256:{digest.hexdigest()}",
        "totalBytes": total,
        "headerMatches": header.decode("utf-8", "replace") == HEADER,
        "sourceVersion": _text(command, "sourceVersion"),
    }


def parse_csv(command: dict[str, Json]) -> dict[str, Json]:
    """Validate the snapshot strictly and cut it into ordered partitions.

    The file is STREAMED. A guest has half a gibibyte of memory and C10 allows a
    256 MiB input, so nothing here holds the whole file, the whole line list, or
    more than one partition at a time.

    The global duplicate index holds a 128-bit digest per identifier rather than
    the identifier itself, because a million 256-byte identifiers would not fit
    beside the rest of the work. A digest collision can only cause a REFUSAL, so
    the index fails closed; at 128 bits the chance of one over a million rows is
    about 1.5e-27.

    The FIRST refusal ends the read: C10 forbids dropping a bad row and
    continuing, so there is no rejected-row list to return.
    """
    source = _member(_text(command, "input"))
    prefix = _prefix(command, "outputPrefix")
    expected = _text(command, "snapshotDigest")
    digest = hashlib.sha256()
    partitions: list[dict[str, Json]] = []
    seen: set[bytes] = set()
    produced = 0
    header: bytes | None = None
    buffered: list[bytes] = []
    pending = b""
    line_number = 0

    def flush() -> None:
        nonlocal produced, buffered
        if not buffered:
            return
        index = len(partitions)
        if index >= MAX_PARTITIONS:
            raise RowError("row_limit", line_number, "input exceeds the declared one-million-row bound")
        payload = b"\n".join([HEADER.encode("utf-8"), *buffered]) + b"\n"
        rows = parse_partition(payload, produced)
        for row in rows:
            marker = hashlib.blake2b(row.record_id.encode("utf-8"), digest_size=16).digest()
            if marker in seen:
                raise RowError("record_id_duplicate", line_number, "record_id repeats an earlier row")
            seen.add(marker)
        written = _write(f"{prefix}partition-{index:05d}.csv", payload)
        partitions.append({**written, "index": index, "firstRowIndex": produced, "rowCount": len(rows)})
        produced += len(rows)
        buffered = []

    def consume(line: bytes) -> None:
        nonlocal header, line_number
        line_number += 1
        if header is None:
            if line != HEADER.encode("utf-8"):
                raise RowError("header_mismatch", line_number, "the first line is not the pinned header")
            header = line
            return
        buffered.append(line)
        if len(buffered) == PARTITION_ROWS:
            flush()

    try:
        with source.open("rb") as handle:
            while True:
                block = handle.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
                pending += block
                # Split the WHOLE block at once. Finding one newline at a time
                # and reslicing the remainder is quadratic in the block size,
                # which at C10's 256 MiB bound is hundreds of gigabytes of
                # copying for an input that should take seconds.
                complete = pending.split(b"\n")
                pending = complete.pop()
                for line in complete:
                    consume(line)
    except OSError as error:
        raise GuestError(f"material {command['input']!r} is unreadable: {error.strerror}") from error
    if pending:
        consume(pending)
    flush()

    if f"sha256:{digest.hexdigest()}" != expected:
        raise GuestError("the staged input does not match the snapshot digest it was dispatched with")
    if header is None:
        raise RowError("header_missing", 1, "input holds no header line")
    if not partitions:
        raise RowError("row_empty", 1, "input holds a header and no rows")
    return {
        "schemaVersion": "factory.reference-data-partitions.v1",
        "rowCount": produced,
        "partitionRows": PARTITION_ROWS,
        "partitions": partitions,
    }


def transform_partition(command: dict[str, Json]) -> dict[str, Json]:
    """Write one ordered partition as Parquet with C10's pinned settings."""
    name = _text(command, "input")
    data = _read(name)
    if _digest(data) != _text(command, "partitionDigest"):
        raise GuestError("the staged partition does not match the digest it was dispatched with")
    rows = parse_partition(data, _whole(command, "firstRowIndex"))
    parquet = write_partition(rows)
    written = _write(_text(command, "output"), parquet)
    return {
        "schemaVersion": "factory.reference-data-partition.v1",
        "index": _whole(command, "partitionIndex"),
        "mediaType": MEDIA_TYPE,
        "writerSettings": WRITER_SETTINGS,
        "file": written,
        **summarize(rows),
    }


def ordered_reduce(command: dict[str, Json]) -> dict[str, Json]:
    """Assemble the ordered dataset and its manifest from the partition results.

    The reduction is explicit about order and explicit about completeness: it
    refuses a gap, a repeat, and an out-of-order index rather than sorting them
    into place, because a partition that silently moved would still produce a
    manifest that added up.
    """
    # The partition results arrive as MATERIALS, not inline. A hundred of them
    # would not fit the 64 KiB a runner request may carry, and the command only
    # has to name them.
    names = command.get("reports")
    if not isinstance(names, list) or not names:
        raise GuestError("the reduction takes a nonempty ordered list of partition report names")
    reported: list[Json] = []
    for name in names:
        if not isinstance(name, str):
            raise GuestError("every partition report name must be a string")
        try:
            reported.append(json.loads(_read(name).decode("utf-8")))
        except (ValueError, UnicodeDecodeError) as error:
            raise GuestError(f"partition report {name!r} is not readable JSON") from error
    total = 0
    rows = 0
    categories: dict[str, dict[str, int]] = {}
    files: list[dict[str, Json]] = []
    for position, entry in enumerate(reported):
        if not isinstance(entry, dict):
            raise GuestError("every partition result must be an object")
        if entry.get("index") != position:
            raise GuestError(f"partition index {entry.get('index')!r} is not its position {position}")
        member = entry.get("file")
        if not isinstance(member, dict):
            raise GuestError("every partition result must name the file it wrote")
        if entry.get("firstRowIndex") != rows:
            raise GuestError(f"partition {position} starts at row {entry.get('firstRowIndex')!r}, not {rows}")
        rows += int(entry["rowCount"])
        total += int(entry["totalAmountCents"])
        for bucket in entry.get("categories", []):
            existing = categories.setdefault(bucket["category"], {"count": 0, "sumCents": 0})
            existing["count"] += int(bucket["count"])
            existing["sumCents"] += int(bucket["sumCents"])
        files.append({"name": member["name"], "digest": member["digest"], "encodedBytes": member["encodedBytes"]})
    manifest = {
        "schemaVersion": "factory.reference-data-manifest.v1",
        "source": {"digest": _text(command, "snapshotDigest"), "totalBytes": _whole(command, "snapshotBytes")},
        "rowCount": rows,
        "totalAmountCents": str(total),
        "categories": [
            {"category": name, "count": bucket["count"], "sumCents": str(bucket["sumCents"])}
            for name, bucket in sorted(categories.items())
        ],
        "partitionRows": PARTITION_ROWS,
        "files": files,
        "schema": [
            {"name": "record_id", "physicalType": "BYTE_ARRAY", "logicalType": "STRING", "repetition": "REQUIRED"},
            {"name": "category", "physicalType": "BYTE_ARRAY", "logicalType": "STRING", "repetition": "REQUIRED"},
            {"name": "amount_cents", "physicalType": "INT64", "logicalType": "NONE", "repetition": "REQUIRED"},
        ],
        "writerSettings": WRITER_SETTINGS,
    }
    encoded = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    written = _write(_text(command, "output"), encoded)
    return {"schemaVersion": "factory.reference-data-dataset.v1", "manifest": manifest, "file": written}


class DataGuest(Guest):
    """The four pinned exports of ``@ezcorp/reference-data``."""

    EXPORTS: Final = {
        "snapshotCsv": snapshot_csv,
        "parseCsv": parse_csv,
        "transformPartition": transform_partition,
        "orderedReduce": ordered_reduce,
    }

    def run(self, request: Json) -> dict[str, Json]:
        """Answer one attempt.

        A request the shared C02 contract refuses becomes a failed result
        carrying that exact issue code, never a completed one, and the result
        is validated again before it leaves the process. A refusal by the row
        grammar is a failed result too, carrying the grammar's own code, so an
        operator reads why the input was rejected rather than a stack trace.
        """
        verdict = self.verdict("request", request)
        if not verdict["ok"]:
            return self._failed(str(verdict.get("code", "RUNNER_REQUEST_SCHEMA")), retryable=False)
        started = time.monotonic_ns()
        try:
            command = _command(request)
            export = str(command.get("kind", ""))
            handler = self.EXPORTS.get(export)
            if handler is None:
                raise GuestError(f"unknown export {export!r}")
            # The report target is resolved BEFORE the work runs, so a command
            # that names an unwritable or already-written report fails without
            # first spending a partition transform.
            report_name = _text(command, "report")
            if _member(report_name).exists():
                raise GuestError("the report target already exists; a material version is written once")
            encoded = json.dumps(
                handler(command), ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
            written = _write(report_name, encoded)
        except RowError as error:
            return self._failed(error.code, retryable=False, detail=f"line {error.line}: {error}")
        except GuestError as error:
            return self._failed("reference_data_command_invalid", retryable=False, detail=str(error))
        elapsed = max((time.monotonic_ns() - started) // 1_000_000, 0)
        result: dict[str, Json] = {
            "schemaVersion": "factory.runner.result.v1",
            "status": "completed",
            "journalCursor": -1,
            "operations": [],
            "resultDigest": _digest(encoded).removeprefix("sha256:"),
            "output": {
                "artifactId": Path(written["name"]).name,
                "digest": written["digest"],
                "encodedBytes": written["encodedBytes"],
            },
            "usage": {"kind": "measured", "inputTokens": 0, "outputTokens": 0, "computeMs": elapsed, "costMicros": "0"},
            "workspaceCheckpoint": {
                "artifactId": f"{Path(written['name']).name}.checkpoint",
                "digest": written["digest"],
                "encodedBytes": written["encodedBytes"],
                "journalCursor": -1,
            },
        }
        return self.checked(result)

    def _failed(self, code: str, *, retryable: bool, detail: str = "") -> dict[str, Json]:
        message = f"The reference data guest refused this attempt ({code})."
        return self.checked(
            {
                "schemaVersion": "factory.runner.result.v1",
                "status": "failed",
                "journalCursor": -1,
                "operations": [],
                "resultDigest": hashlib.sha256(f"{code}:{detail}".encode()).hexdigest(),
                "error": {"code": code, "message": f"{message} {detail}".strip(), "retryable": retryable},
            }
        )

    def checked(self, result: dict[str, Json]) -> dict[str, Json]:
        """Refuse to emit a result the shared contract would reject."""
        outgoing = self.validate_result(result)
        if outgoing is not None:
            raise GuestError(f"The reference data guest built an invalid result: {outgoing}")
        return result

    def validate_result(self, result: dict[str, Json]) -> str | None:
        """The issue code the shared contract finds in this result, or ``None``."""
        verdict = self.verdict("result", result)
        return None if verdict["ok"] else str(verdict.get("code", "RUNNER_RESULT_SCHEMA"))

    def invoke(self, params: Json) -> Json:
        if not isinstance(params, dict):
            raise GuestError("invoke params must be an object")
        name = params.get("name")
        if name not in self.EXPORTS:
            raise GuestError(f"unknown export {name}")
        return self.run(params.get("input"))

    def dispatch(self, method: str, params: Json) -> Json:
        if method == "extension/discover":
            return MANIFEST
        if method == "extension/invoke":
            return self.invoke(params)
        if method == "extension/cancel":
            return {"cancelled": True}
        raise GuestError(f"unknown method {method}")


def main(directory: Path = WORKSPACE) -> int:
    """The launcher the in-guest shim starts calls exactly this."""
    request_schema = load_schema(directory / "factory-runner-request.schema.json")
    result_schema = load_schema(directory / "factory-runner-result.schema.json")
    return serve(DataGuest(request_schema, result_schema), sys.stdin, sys.stdout)
