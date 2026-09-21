"""The C02 runner request and result semantics for the Python runtime.

This is the Python counterpart of the two exported entry points in
``packages/@ezcorp/factory-sdk/src/validation.ts``:
``validateFactoryRunnerRequest`` and ``validateFactoryRunnerResult``.  It walks
the same checks in the same order and returns the same issue code, so the
Bun runtime and this one either both admit a value or both refuse it for the
same stated reason.  C07 forbids a validator that works in only one runtime, and
the conformance suite compares the two verdict by verdict over the committed
fixtures.

The generated schema is not restated here.  Both runtimes read the same
``factory-runner-request.schema.json`` and ``factory-runner-result.schema.json``
bytes, so the wire shape has one definition and only the semantics are ported.
"""

from __future__ import annotations

from typing import Any, Final

from factory_ijson import (
    OK,
    Result,
    encode_number,
    encoded_bytes,
    is_array,
    is_finite,
    is_number,
    is_record,
    is_safe_integer,
    is_unsigned_decimal,
    json_equal,
    reject,
    unicode_length,
    validate_ijson,
)
from factory_schema import Schema, matches_generated_schema

Json = Any
Path = tuple[str | int, ...]

MAX_WIRE_BYTES: Final = 64 * 1024
MAX_INLINE_VALUE_BYTES: Final = 64 * 1024

# The guest model frame bounds, mirroring ``FACTORY_GUEST_MODEL_LIMITS`` in
# ``packages/@ezcorp/factory-sdk/src/types.ts``.  A bound that differed between
# the runtimes would let a guest send in Python what Bun refuses.
GUEST_MODEL_MAX_MESSAGES: Final = 64
GUEST_MODEL_MAX_MESSAGE_BYTES: Final = 16 * 1024
GUEST_MODEL_MAX_INPUT_BYTES: Final = 32 * 1024
GUEST_MODEL_MAX_OUTPUT_TOKENS: Final = 8192
GUEST_MODEL_MAX_RESPONSE_BYTES: Final = 128 * 1024

PORT_SCHEMA_KEYS: Final = frozenset(
    {
        "$defs",
        "$ref",
        "additionalProperties",
        "const",
        "description",
        "enum",
        "items",
        "maxItems",
        "maxLength",
        "maximum",
        "minItems",
        "minLength",
        "minimum",
        "properties",
        "required",
        "title",
        "type",
    }
)
PORT_SCHEMA_TYPES: Final = frozenset({"array", "boolean", "integer", "null", "number", "object", "string"})


def valid_digest(value: Json, prefixed: bool) -> bool:
    if not isinstance(value, str):
        return False
    content = (value[7:] if value.startswith("sha256:") else "") if prefixed else value
    if len(content) != 64:
        return False
    return all("0" <= character <= "9" or "a" <= character <= "f" for character in content)


def safe_counter(value: Json, minimum: int = 0) -> bool:
    return is_safe_integer(value) and value >= minimum


def bounded_text(value: Json, maximum: int = 256) -> bool:
    if not isinstance(value, str) or len(value) == 0 or unicode_length(value) > maximum:
        return False
    return all(ord(character) >= 32 for character in value)


# --------------------------------------------------------------------------
# Port schemas, which a tool declaration carries.
# --------------------------------------------------------------------------


def _decode_pointer_token(token: str) -> str | None:
    out: list[str] = []
    index = 0
    while index < len(token):
        character = token[index]
        if character != "~":
            out.append(character)
            index += 1
            continue
        escaped = token[index + 1] if index + 1 < len(token) else None
        if escaped == "0":
            out.append("~")
        elif escaped == "1":
            out.append("/")
        else:
            return None
        index += 2
    return "".join(out)


def resolve_local_reference(root: Schema, reference: str) -> Schema | None:
    if not reference.startswith("#"):
        return None
    if reference == "#":
        return root
    if not reference.startswith("#/"):
        return None
    value: Json = root
    for raw_token in reference[2:].split("/"):
        token = _decode_pointer_token(raw_token)
        if token is None or not is_record(value) or token not in value:
            return None
        value = value[token]
    return value if is_record(value) else None


def _optional_integer(record: Schema, key: str, path: Path) -> Result:
    if key not in record:
        return OK
    value = record[key]
    if is_safe_integer(value) and value >= 0:
        return OK
    return reject("SCHEMA_BOUND_INVALID", f"{key} must be a nonnegative safe integer.", (*path, key))


def _validate_schema_node(node: Json, root: Schema, path: Path, ancestors: tuple[int, ...]) -> Result:
    if not is_record(node):
        return reject("SCHEMA_OBJECT_REQUIRED", "A port schema must be an object.", path)
    for key in node:
        if key not in PORT_SCHEMA_KEYS:
            return reject("SCHEMA_KEYWORD_UNSUPPORTED", f"Unsupported schema keyword: {key}.", (*path, key))
    if id(node) in ancestors:
        return reject("SCHEMA_RECURSIVE", "Recursive schemas are not supported.", path)
    nested = (*ancestors, id(node))

    if "title" in node and not isinstance(node["title"], str):
        return reject("SCHEMA_DESCRIPTION_INVALID", "title must be a string.", (*path, "title"))
    if "description" in node and not isinstance(node["description"], str):
        return reject("SCHEMA_DESCRIPTION_INVALID", "description must be a string.", (*path, "description"))
    if "additionalProperties" in node and not isinstance(node["additionalProperties"], bool):
        return reject(
            "SCHEMA_ADDITIONAL_PROPERTIES_INVALID",
            "additionalProperties must be boolean.",
            (*path, "additionalProperties"),
        )
    if "properties" in node and not is_record(node["properties"]):
        return reject("SCHEMA_PROPERTIES_INVALID", "properties must be an object.", (*path, "properties"))
    if "$defs" in node and not is_record(node["$defs"]):
        return reject("SCHEMA_DEFS_INVALID", "$defs must be an object.", (*path, "$defs"))
    if "items" in node and not is_record(node["items"]):
        return reject("SCHEMA_ITEMS_INVALID", "items must be one schema.", (*path, "items"))
    if "required" in node and (
        not is_array(node["required"]) or any(not isinstance(name, str) for name in node["required"])
    ):
        return reject("SCHEMA_REQUIRED_INVALID", "required must be an array of strings.", (*path, "required"))
    if "enum" in node and (not is_array(node["enum"]) or len(node["enum"]) == 0):
        return reject("SCHEMA_ENUM_INVALID", "enum must be a nonempty array.", (*path, "enum"))
    for key in ("minItems", "maxItems", "minLength", "maxLength"):
        result = _optional_integer(node, key, path)
        if not result.ok:
            return result
    for key in ("minimum", "maximum"):
        if key in node and not is_finite(node[key]):
            return reject("SCHEMA_BOUND_INVALID", f"{key} must be finite.", (*path, key))
    if "const" in node:
        result = validate_ijson(node["const"])
        if not result.ok and result.issue is not None:
            return reject("SCHEMA_CONST_INVALID", "const must be I-JSON.", (*path, "const", *result.issue.path))
    if is_array(node.get("enum")):
        values: list[Json] = node["enum"]
        for index, candidate in enumerate(values):
            if not validate_ijson(candidate).ok:
                return reject("SCHEMA_ENUM_INVALID", "Every enum value must be I-JSON.", (*path, "enum", index))
            if any(json_equal(earlier, candidate) for earlier in values[:index]):
                return reject("SCHEMA_ENUM_INVALID", "Enum values must be unique.", (*path, "enum", index))

    reference = node.get("$ref")
    if isinstance(reference, str):
        if any(key not in ("$ref", "$defs", "title", "description") for key in node):
            return reject("SCHEMA_REF_SIBLING", "A local reference cannot have execution siblings.", path)
        target = resolve_local_reference(root, reference)
        if target is None:
            return reject("SCHEMA_REF_INVALID", "Reference must resolve through a local JSON Pointer.", (*path, "$ref"))
        result = _validate_schema_node(target, root, (*path, "$ref"), nested)
        if not result.ok:
            return result
    else:
        if "$ref" in node:
            return reject("SCHEMA_REF_INVALID", "$ref must be a string.", (*path, "$ref"))
        declared = node.get("type")
        types: list[Json] = declared if is_array(declared) else ([declared] if isinstance(declared, str) else [])
        valid_nullable = len(types) == 2 and "null" in types and types[0] != types[1]
        if len(types) == 0:
            return reject("SCHEMA_TYPE_REQUIRED", "A port schema type is required.", (*path, "type"))
        if any(not isinstance(entry, str) or entry not in PORT_SCHEMA_TYPES for entry in types) or (
            len(types) != 1 and not valid_nullable
        ):
            return reject(
                "SCHEMA_TYPE_UNSUPPORTED", "Type must be one supported type or a nullable union.", (*path, "type")
            )

    for low, high, label in (
        ("minItems", "maxItems", "minItems cannot exceed maxItems."),
        ("minLength", "maxLength", "minLength cannot exceed maxLength."),
        ("minimum", "maximum", "minimum cannot exceed maximum."),
    ):
        if node.get(low) is not None and node.get(high) is not None and node[low] > node[high]:
            return reject("SCHEMA_BOUND_ORDER", label, path)

    properties = node.get("properties") if is_record(node.get("properties")) else None
    if properties is not None:
        for name, child in properties.items():
            result = _validate_schema_node(child, root, (*path, "properties", name), nested)
            if not result.ok:
                return result
    if is_array(node.get("required")):
        seen: set[str] = set()
        for name in node["required"]:
            if name in seen or properties is None or name not in properties:
                return reject(
                    "SCHEMA_REQUIRED_INVALID", "Required names must be unique declared properties.", (*path, "required")
                )
            seen.add(name)
    if is_record(node.get("items")):
        result = _validate_schema_node(node["items"], root, (*path, "items"), nested)
        if not result.ok:
            return result
    if is_record(node.get("$defs")):
        for name, child in node["$defs"].items():
            result = _validate_schema_node(child, root, (*path, "$defs", name), nested)
            if not result.ok:
                return result
    return OK


def validate_port_schema(schema: Json) -> Result:
    return _validate_schema_node(schema, schema if is_record(schema) else {}, (), ())


# --------------------------------------------------------------------------
# Shared runner fragments.
# --------------------------------------------------------------------------


def _validate_artifact_reference(reference: Json, path: Path) -> Result:
    artifact_id = reference.get("artifactId")
    if not bounded_text(artifact_id) or "/" in artifact_id or "\\" in artifact_id:
        return reject(
            "RUNNER_ARTIFACT_ID", "Artifact IDs must be bounded opaque identifiers, not paths.", (*path, "artifactId")
        )
    if not valid_digest(reference.get("digest"), True):
        return reject("RUNNER_DIGEST", "Artifact digest must be a lowercase sha256 value.", (*path, "digest"))
    if safe_counter(reference.get("encodedBytes")):
        return OK
    return reject(
        "RUNNER_ARTIFACT_BYTES", "Artifact bytes must be a nonnegative safe integer.", (*path, "encodedBytes")
    )


MANIFEST_NAME_LETTERS: Final = "abcdefghijklmnopqrstuvwxyz"


def is_manifest_name(value: Json) -> bool:
    """The v4 manifest name grammar, the exact counterpart of ``isManifestName``
    in the SDK. A scoped distribution name belongs in ``package``, never here."""
    if not isinstance(value, str) or not 0 < len(value) <= 64 or value[0] not in MANIFEST_NAME_LETTERS:
        return False
    return all(character in MANIFEST_NAME_LETTERS or character.isdigit() or character == "-" for character in value)


def _validate_runner_reference(reference: Json, path: Path) -> Result:
    version = reference.get("version")
    if (
        not bounded_text(reference.get("package"))
        or not bounded_text(reference.get("export"))
        or not bounded_text(version)
        or version == "latest"
        or "*" in version
        or not valid_digest(reference.get("digest"), True)
    ):
        return reject("RUNNER_PIN", "Runner package, exact version, export, and digest are required.", path)
    if not bounded_text(reference.get("manifestName")) or not is_manifest_name(reference.get("manifestName")):
        return reject(
            "RUNNER_MANIFEST_NAME",
            "Runner manifest name must be the built v4 manifest's own name, which cannot be a scoped package name.",
            (*path, "manifestName"),
        )
    if reference.get("model") is not None and not bounded_text(reference["model"]):
        return reject("RUNNER_MODEL_PIN", "Runner model must be a bounded identity.", (*path, "model"))
    if reference.get("configurationDigest") is not None and not valid_digest(reference["configurationDigest"], True):
        return reject(
            "RUNNER_MODEL_PIN",
            "Runner configuration digest must be a prefixed lowercase sha256 value.",
            (*path, "configurationDigest"),
        )
    return OK


def _validate_usage(usage: Json, path: Path) -> Result:
    if usage.get("kind") == "unknown":
        if bounded_text(usage.get("reason"), 1_024) and is_unsigned_decimal(usage.get("heldCostMicros", "")):
            return OK
        return reject("RUNNER_USAGE", "Unknown usage needs a reason and unsigned held cost.", path)
    if (
        safe_counter(usage.get("inputTokens"))
        and safe_counter(usage.get("outputTokens"))
        and safe_counter(usage.get("computeMs"))
        and is_unsigned_decimal(usage.get("costMicros", ""))
    ):
        return OK
    return reject("RUNNER_USAGE", "Measured usage counters and cost must be nonnegative integers.", path)


def _validate_operation(operation: Json, path: Path) -> Result:
    state = operation.get("state")
    result_digest = operation.get("resultDigest")
    if state == "uncertain":
        digest_invalid = result_digest is not None and not valid_digest(result_digest, False)
    else:
        digest_invalid = not valid_digest(result_digest, False)
    operation_id = operation.get("operationId")
    operation_index = operation.get("operationIndex")
    receipt = operation.get("providerReceiptDigest")
    if (
        not bounded_text(operation_id, 1_024)
        or not operation_id.endswith(f":{_index_text(operation_index)}")
        or not safe_counter(operation_index)
        or not valid_digest(operation.get("requestDigest"), False)
        or digest_invalid
        or (receipt is not None and not valid_digest(receipt, False))
    ):
        return reject("RUNNER_OPERATION", "Runner operation identity or digest is invalid.", path)
    if operation.get("usage") is not None:
        usage = _validate_usage(operation["usage"], (*path, "usage"))
        if not usage.ok:
            return usage
    if operation.get("workspaceCheckpoint") is not None:
        return _validate_artifact_reference(operation["workspaceCheckpoint"], (*path, "workspaceCheckpoint"))
    return OK


def _index_text(value: Json) -> str:
    """The template literal the SDK builds. An integral value never prints its
    fraction there, so ``5.0`` must render as ``5`` here too."""
    return encode_number(value) if is_number(value) else str(value)


def _validate_runner_envelope(value: Json, kind: str) -> Result:
    if encoded_bytes(value) > MAX_WIRE_BYTES:
        return reject("RUNNER_WIRE_BYTES", f"Factory runner {kind} exceeds 64 KiB.", ())
    return OK


# --------------------------------------------------------------------------
# The two exported entry points.
# --------------------------------------------------------------------------


def validate_factory_runner_request(value: Json, schema: Schema) -> Result:
    if not matches_generated_schema(schema, value):
        return reject("RUNNER_REQUEST_SCHEMA", "Value does not match the generated FactoryRunnerRequest schema.", ())
    envelope = _validate_runner_envelope(value, "request")
    if not envelope.ok:
        return envelope

    authority = value["authority"]
    for key, field in authority.items():
        valid = bounded_text(field, 1_024) if isinstance(field, str) else safe_counter(field)
        if not valid:
            return reject(
                "RUNNER_AUTHORITY",
                "Runner authority fields must be bounded identities and nonnegative safe counters.",
                ("authority", key),
            )
    if authority["deadlineAtMs"] < 1:
        return reject(
            "RUNNER_DEADLINE", "Runner deadline must be a positive epoch millisecond.", ("authority", "deadlineAtMs")
        )

    runner = _validate_runner_reference(value["runner"], ("runner",))
    if not runner.ok:
        return runner

    model = value.get("model")
    reference = value["runner"]
    if model is not None and (
        not bounded_text(model.get("provider"))
        or not bounded_text(model.get("model"))
        or not valid_digest(model.get("configurationDigest"), True)
        or not valid_digest(model.get("policyDigest"), True)
        or (reference.get("model") is not None and reference["model"] != model["model"])
        or (
            reference.get("configurationDigest") is not None
            and reference["configurationDigest"] != model["configurationDigest"]
        )
    ):
        return reject("RUNNER_MODEL_PIN", "Model and policy pins must match the runner reference.", ("model",))

    broker = value["broker"]
    grants = value["grants"]
    if (
        not bounded_text(broker.get("attemptToken"), 4_096)
        or not bounded_text(broker.get("audience"))
        or any(not bounded_text(grant) for grant in grants)
        or len(set(grants)) != len(grants)
    ):
        return reject("RUNNER_GRANT", "Broker authority and grants must be bounded and unique.", ("grants",))

    resources = value["resources"]
    if (
        (resources.get("maxCostMicros") is not None and not is_unsigned_decimal(resources["maxCostMicros"]))
        or (resources.get("resourceClass") is not None and not bounded_text(resources["resourceClass"]))
        or any(
            resources.get(bound) is not None and not safe_counter(resources[bound])
            for bound in ("maxTokens", "maxComputeMs", "memoryBytes")
        )
    ):
        return reject(
            "RUNNER_RESOURCES",
            "Runner resource bounds must use safe counters and unsigned decimal cost.",
            ("resources",),
        )

    runner_input = value["input"]
    if runner_input["kind"] == "artifact":
        artifact = _validate_artifact_reference(runner_input["artifact"], ("input", "artifact"))
        if not artifact.ok:
            return artifact
    elif encoded_bytes(runner_input["value"]) > MAX_INLINE_VALUE_BYTES:
        return reject("RUNNER_INLINE_BYTES", "Inline runner input exceeds 64 KiB.", ("input", "value"))

    checkpoint = value.get("checkpoint")
    if checkpoint is not None:
        result = _validate_artifact_reference(checkpoint, ("checkpoint",))
        if not result.ok:
            return result
        if not safe_counter(checkpoint.get("journalCursor"), -1):
            return reject("RUNNER_CURSOR", "Checkpoint cursor must be a safe integer.", ("checkpoint", "journalCursor"))

    expected_index = (checkpoint["journalCursor"] if checkpoint is not None else -1) + 1
    if authority["nextOperationIndex"] != expected_index:
        return reject(
            "RUNNER_CURSOR",
            "Next operation index must continue the supplied checkpoint.",
            ("authority", "nextOperationIndex"),
        )

    tool_names: set[str] = set()
    for index, tool in enumerate(value["tools"]):
        description = tool.get("description")
        if (
            not bounded_text(tool.get("name"))
            or tool["name"] in tool_names
            or (description is not None and not bounded_text(description, 4_096))
        ):
            return reject("RUNNER_TOOL", "Tool declarations must have unique bounded names.", ("tools", index))
        tool_names.add(tool["name"])
        if not validate_port_schema(tool["inputSchema"]).ok:
            return reject("RUNNER_TOOL_SCHEMA", "Tool input schema is invalid.", ("tools", index, "inputSchema"))
        if tool.get("outputSchema") is not None and not validate_port_schema(tool["outputSchema"]).ok:
            return reject("RUNNER_TOOL_SCHEMA", "Tool output schema is invalid.", ("tools", index, "outputSchema"))
    return OK


def validate_factory_runner_result(value: Json, schema: Schema) -> Result:
    if not matches_generated_schema(schema, value):
        return reject("RUNNER_RESULT_SCHEMA", "Value does not match the generated FactoryRunnerResult schema.", ())
    envelope = _validate_runner_envelope(value, "result")
    if not envelope.ok:
        return envelope

    cursor = value["journalCursor"]
    if not safe_counter(cursor, -1):
        return reject("RUNNER_CURSOR", "Result cursor must be a safe integer.", ("journalCursor",))

    previous = -1
    for index, operation in enumerate(value["operations"]):
        operation_index = operation["operationIndex"]
        if operation_index <= previous:
            return reject(
                "RUNNER_OPERATION_ORDER",
                "Operation results must be strictly ordered by index.",
                ("operations", index, "operationIndex"),
            )
        previous = operation_index
        result = _validate_operation(operation, ("operations", index))
        if not result.ok:
            return result
        uncertain = operation["state"] == "uncertain"
        if (operation_index <= cursor) if uncertain else (operation_index > cursor):
            return reject(
                "RUNNER_OPERATION_CURSOR",
                "Settled operations cannot exceed the cursor and uncertain operations cannot advance it.",
                ("operations", index, "operationIndex"),
            )
        if operation["state"] == "completed" and operation["workspaceCheckpoint"]["journalCursor"] != operation_index:
            return reject(
                "RUNNER_OPERATION_CURSOR",
                "Completed operation checkpoint must equal its operation index.",
                ("operations", index, "workspaceCheckpoint", "journalCursor"),
            )

    if value.get("usage") is not None:
        usage = _validate_usage(value["usage"], ("usage",))
        if not usage.ok:
            return usage

    checkpoint = value.get("workspaceCheckpoint")
    if checkpoint is not None:
        result = _validate_artifact_reference(checkpoint, ("workspaceCheckpoint",))
        if not result.ok:
            return result
        if checkpoint["journalCursor"] != cursor:
            return reject(
                "RUNNER_CURSOR",
                "Workspace checkpoint must match the result cursor.",
                ("workspaceCheckpoint", "journalCursor"),
            )

    status = value["status"]
    if status == "completed":
        if not valid_digest(value.get("resultDigest"), False):
            return reject("RUNNER_DIGEST", "Completed result digest is invalid.", ("resultDigest",))
        output = _validate_artifact_reference(value["output"], ("output",))
        if not output.ok:
            return output
    elif status == "failed":
        error = value["error"]
        if (
            not valid_digest(value.get("resultDigest"), False)
            or not bounded_text(error.get("code"))
            or not bounded_text(error.get("message"), 4_096)
        ):
            return reject("RUNNER_FAILURE", "Failed result needs a digest and structured bounded error.", ("error",))
    elif status == "uncertain" and (
        not valid_digest(value.get("providerReceiptDigest"), False)
        or (value.get("resultDigest") is not None and not valid_digest(value["resultDigest"], False))
    ):
        return reject(
            "RUNNER_UNCERTAIN", "Uncertain result receipt or result digest is invalid.", ("providerReceiptDigest",)
        )
    return OK


# --------------------------------------------------------------------------
# The guest model contract, the third and fourth exported entry points.
# --------------------------------------------------------------------------


def validate_factory_guest_model_request(value: Json, schema: Schema) -> Result:
    """The Python counterpart of ``validateFactoryGuestModelRequest``.

    Same checks, same order, same issue code.  A guest that reaches the model
    through the Python runtime is held to exactly the bounds the Bun runtime
    holds it to, which is what C07 requires of any validator that exists twice.
    """
    if not matches_generated_schema(schema, value):
        return reject(
            "GUEST_MODEL_SCHEMA",
            "Value does not match the generated FactoryGuestModelRequest schema.",
            (),
        )
    operation_id = value.get("operationId")
    operation_index = value.get("operationIndex")
    if (
        not bounded_text(operation_id, 1_024)
        or not operation_id.endswith(f":{_index_text(operation_index)}")
        or not safe_counter(operation_index)
    ):
        return reject(
            "GUEST_MODEL_OPERATION",
            "A guest model request must name its own journalled operation.",
            ("operationId",),
        )
    max_output_tokens = value.get("maxOutputTokens")
    if not safe_counter(max_output_tokens, 1) or max_output_tokens > GUEST_MODEL_MAX_OUTPUT_TOKENS:
        return reject(
            "GUEST_MODEL_OUTPUT",
            f"Requested output must be between 1 and {GUEST_MODEL_MAX_OUTPUT_TOKENS} tokens.",
            ("maxOutputTokens",),
        )
    messages = value.get("messages")
    if len(messages) < 1 or len(messages) > GUEST_MODEL_MAX_MESSAGES:
        return reject(
            "GUEST_MODEL_MESSAGES",
            f"A guest model request carries 1 to {GUEST_MODEL_MAX_MESSAGES} messages.",
            ("messages",),
        )
    for index, message in enumerate(messages):
        if encoded_bytes(message.get("text")) > GUEST_MODEL_MAX_MESSAGE_BYTES:
            return reject(
                "GUEST_MODEL_MESSAGES",
                "A guest model message exceeds its byte bound.",
                ("messages", index, "text"),
            )
    if encoded_bytes(messages) > GUEST_MODEL_MAX_INPUT_BYTES:
        return reject(
            "GUEST_MODEL_INPUT_BYTES",
            f"A guest model request input exceeds {GUEST_MODEL_MAX_INPUT_BYTES} bytes.",
            ("messages",),
        )
    return OK


def validate_factory_guest_model_response(value: Json, schema: Schema) -> Result:
    """The Python counterpart of ``validateFactoryGuestModelResponse``.

    A refusal is checked for a bounded message and nothing else; a completed
    answer must carry a provider receipt digest and measured usage, because a
    cost with no receipt is a cost the usage resolver cannot settle.
    """
    if not matches_generated_schema(schema, value):
        return reject(
            "GUEST_MODEL_SCHEMA",
            "Value does not match the generated FactoryGuestModelResponse schema.",
            (),
        )
    if not bounded_text(value.get("operationId"), 1_024):
        return reject("GUEST_MODEL_OPERATION", "A guest model response must name its operation.", ("operationId",))
    if value.get("status") == "refused":
        if bounded_text(value.get("refusal", {}).get("message"), 4_096):
            return OK
        return reject("GUEST_MODEL_REFUSAL", "A refusal needs a bounded message.", ("refusal", "message"))
    if encoded_bytes(value.get("text")) > GUEST_MODEL_MAX_RESPONSE_BYTES:
        return reject(
            "GUEST_MODEL_RESPONSE_BYTES",
            f"A guest model response exceeds {GUEST_MODEL_MAX_RESPONSE_BYTES} bytes.",
            ("text",),
        )
    # BARE 64-hex, the same form an operation's receipt takes in a runner result.
    # A terminal result must mirror the journal row exactly, so a prefixed digest
    # would make the row unsettleable or the attempt uncompletable.
    if not valid_digest(value.get("providerReceiptDigest"), False):
        return reject(
            "GUEST_MODEL_RECEIPT",
            "A completed model call carries its provider receipt digest as bare 64-character hex.",
            ("providerReceiptDigest",),
        )
    return _validate_usage(value.get("usage"), ("usage",))
