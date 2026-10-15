"""The guest half of the material staging contract, for the Python runtime.

This is the Python counterpart of
``packages/@ezcorp/factory-sdk/src/guest-materials.ts``.  It builds the same
four frames, applies the same bounds, and reads the same generated schemas, so
a Python guest and a Bun guest either both stage a material or are both refused
for the same stated reason.  C07 forbids a contract that exists in only one
runtime.

Nothing here carries authority.  The attempt token the runner request already
holds is what the host verifies, and every scope field — tenant, project, run,
attempt, node instance, candidate generation — is read from that verified
attempt on the host side.  A frame names an operation, an object name, and a
version, and nothing else.

Bytes are chunked at exactly the recorded-page bound, and the whole material is
bounded well under the guest's one-mebibyte lifetime output budget: the framed
channel counts every byte this process writes for the life of the worker, so
the total is what has to fit, not the frame.
"""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Callable, Iterable
from typing import Any, Final

from factory_ijson import canonicalize_json
from factory_schema import Schema
from factory_validation import (
    GUEST_MATERIAL_MAX_CHUNK_BYTES,
    GUEST_MATERIAL_MAX_TOTAL_BYTES,
    validate_factory_guest_material_request,
    validate_factory_guest_material_response,
)

Json = Any

DEFAULT_MEDIA_TYPE: Final = "application/octet-stream"
JSON_MEDIA_TYPE: Final = "application/json"
BROKER_METHOD: Final = "factory.broker"


class FactoryGuestMaterialError(Exception):
    """A refused frame.  ``code`` is the host's own refusal name."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def checkpoint_object_name(journal_cursor: int) -> str:
    """The object name one checkpoint occupies, under the reserved prefix.

    An attempt that settled no operation has cursor -1, which the host-side
    checkpoint writer cannot name because its own names are operation indexes.
    A guest checkpoint is named by its cursor instead, and the two never
    collide: ``attempt`` is not an operation number.
    """
    if not isinstance(journal_cursor, int) or isinstance(journal_cursor, bool) or journal_cursor < -1:
        raise FactoryGuestMaterialError(
            "guest_frame_invalid", "A journal cursor is -1 or a nonnegative safe integer."
        )
    return "workspace/attempt.json" if journal_cursor < 0 else f"workspace/operation-{journal_cursor}.json"


def _digest(content: bytes) -> str:
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


def _collect(source: bytes | Iterable[bytes]) -> bytes:
    if isinstance(source, bytes | bytearray):
        return bytes(source)
    blocks: list[bytes] = []
    total = 0
    for block in source:
        total += len(block)
        if total > GUEST_MATERIAL_MAX_TOTAL_BYTES:
            raise FactoryGuestMaterialError(
                "oversize", f"A guest may stage at most {GUEST_MATERIAL_MAX_TOTAL_BYTES} bytes in one material."
            )
        blocks.append(bytes(block))
    return b"".join(blocks)


class FactoryGuestStaging:
    """One attempt's staging client, bound to one journalled operation.

    Versions are tracked per object name so a guest that stages the same name
    twice advances to version 2 rather than colliding with itself; the host
    enforces the same rule from the durable row, so an out-of-step guest is
    refused by name instead of silently overwriting.
    """

    def __init__(
        self,
        call: Callable[[Json], Json],
        operation_id: str,
        operation_index: int,
        request_schema: Schema,
        response_schema: Schema,
    ) -> None:
        self._call = call
        self._operation_id = operation_id
        self._operation_index = operation_index
        self._request_schema = request_schema
        self._response_schema = response_schema
        self._staged: dict[str, tuple[int, str]] = {}

    def _identity(self, object_name: str, version: int) -> dict[str, Json]:
        return {
            "operationId": self._operation_id,
            "operationIndex": self._operation_index,
            "objectName": object_name,
            "version": version,
        }

    def _send(self, frame: dict[str, Json]) -> dict[str, Json]:
        outgoing = validate_factory_guest_material_request(frame, self._request_schema)
        if outgoing.issue is not None:
            raise FactoryGuestMaterialError("guest_frame_invalid", outgoing.issue.message)
        answer = self._call(frame)
        incoming = validate_factory_guest_material_response(answer, self._response_schema)
        if incoming.issue is not None:
            raise FactoryGuestMaterialError("guest_response_invalid", incoming.issue.message)
        response: dict[str, Json] = answer
        if response.get("status") == "refused":
            refusal = response.get("refusal", {})
            raise FactoryGuestMaterialError(str(refusal.get("code")), str(refusal.get("message")))
        return response

    def stage_output(
        self, object_name: str, source: bytes | Iterable[bytes], media_type: str = DEFAULT_MEDIA_TYPE
    ) -> dict[str, Json]:
        """Chunks, seals, and returns the sealed material.

        ``material`` is the sealed handle, whose digest covers the chunk
        manifest the scoped reader resolves.  ``digest`` covers the assembled
        content, and that is the one a promotion names.  They are different
        values over different bytes, so both are returned.
        """
        content = _collect(source)
        version = self._staged.get(object_name, (0, ""))[0] + 1
        chunk_count = max(1, -(-len(content) // GUEST_MATERIAL_MAX_CHUNK_BYTES))
        self._send(
            {
                "schemaVersion": "factory.guest-material-begin.v1",
                **self._identity(object_name, version),
                "mediaType": media_type,
                "totalBytes": len(content),
                "chunkCount": chunk_count,
            }
        )
        for index in range(chunk_count):
            part = content[index * GUEST_MATERIAL_MAX_CHUNK_BYTES : (index + 1) * GUEST_MATERIAL_MAX_CHUNK_BYTES]
            self._send(
                {
                    "schemaVersion": "factory.guest-material-chunk.v1",
                    **self._identity(object_name, version),
                    "index": index,
                    "digest": _digest(part),
                    "encodedBytes": len(part),
                    "contentBase64": base64.b64encode(part).decode("ascii"),
                }
            )
        digest = _digest(content)
        sealed = self._send(
            {
                "schemaVersion": "factory.guest-material-seal.v1",
                **self._identity(object_name, version),
                "digest": digest,
            }
        )
        if sealed.get("status") != "sealed":
            raise FactoryGuestMaterialError(
                "guest_response_invalid", f"A seal was answered with '{sealed.get('status')}'."
            )
        self._staged[object_name] = (version, digest)
        return {"material": sealed["material"], "digest": digest, "totalBytes": len(content), "version": version}

    def promote_output(
        self, object_name: str, content_digest: str | None = None, version: int | None = None
    ) -> dict[str, Json]:
        """Promotes one sealed material to this attempt's candidate output.

        ``content_digest`` covers the assembled bytes, not the material handle.
        It defaults to the digest this client computed when it staged that
        name, so the ordinary path cannot pass the wrong one.
        """
        held = self._staged.get(object_name)
        digest = content_digest if content_digest is not None else (held[1] if held else None)
        if digest is None:
            raise FactoryGuestMaterialError(
                "guest_frame_invalid",
                f"This guest did not stage '{object_name}', so it cannot name the bytes to promote.",
            )
        chosen = version if version is not None else (held[0] if held else 1)
        promoted = self._send(
            {
                "schemaVersion": "factory.guest-material-output.v1",
                **self._identity(object_name, chosen),
                "digest": digest,
            }
        )
        if promoted.get("status") != "output":
            raise FactoryGuestMaterialError(
                "guest_response_invalid", f"A promotion was answered with '{promoted.get('status')}'."
            )
        return {"output": promoted["output"], "resultDigest": promoted["resultDigest"]}

    def stage_result(self, object_name: str, value: Json) -> dict[str, Json]:
        """Stages a JSON value as canonical bytes and promotes it in one step."""
        content = canonicalize_json(value).encode("utf-8")
        material = self.stage_output(object_name, content, JSON_MEDIA_TYPE)
        return self.promote_output(object_name, material["digest"], material["version"])

    def stage_checkpoint(self, value: Json, journal_cursor: int) -> dict[str, Json]:
        """Stages one workspace checkpoint and returns the reference a result carries."""
        content = canonicalize_json(value).encode("utf-8")
        material = self.stage_output(checkpoint_object_name(journal_cursor), content, JSON_MEDIA_TYPE)
        return {**material["material"], "journalCursor": journal_cursor}
