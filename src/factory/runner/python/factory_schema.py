"""The generated-schema walker for the Python runtime.

The eight ``*.schema.json`` documents in ``@ezcorp/factory-sdk`` are the single
source of truth for the wire shape, and both runtimes read the same committed
bytes.  What each runtime needs is a walker with identical acceptance, so this is
the exact counterpart of ``packages/@ezcorp/factory-sdk/src/schema.ts``: the same
keywords, in the same order, with the same meaning.

It deliberately does not use a general JSON Schema library.  A library accepts a
larger language than the generator emits, so a document that drifted would still
validate here and be rejected in Bun.  Walking only the emitted subset keeps the
two runtimes exactly as strict as each other.
"""

from __future__ import annotations

from typing import Any, Final

from factory_ijson import (
    is_array,
    is_bool,
    is_finite,
    is_integer_number,
    is_number,
    is_record,
    is_safe_integer,
    json_equal,
    unicode_length,
    validate_ijson,
)

Json = Any
Schema = dict[str, Json]

_DEFINITIONS_PREFIX: Final = "#/definitions/"


def field(schema: Schema, key: str) -> Json:
    """One keyword, read as the untyped JSON it is. Reading through this keeps
    every keyword comparison below as loose as the JavaScript it mirrors."""
    return schema.get(key)


def resolve_reference(root: Schema, reference: str) -> Schema | None:
    if not reference.startswith(_DEFINITIONS_PREFIX):
        return None
    name = _decode_uri_component(reference[len(_DEFINITIONS_PREFIX) :])
    definitions: Json = field(root, "definitions")
    if not is_record(definitions) or name not in definitions:
        return None
    target: Json = definitions[name]
    return target if is_record(target) else None


def _decode_uri_component(value: str) -> str:
    """``decodeURIComponent`` over the ASCII escapes a generated definition name
    can hold. An escape that is not two hexadecimal digits stays literal, so a
    name that never existed simply resolves to nothing."""
    out: list[str] = []
    index = 0
    while index < len(value):
        character = value[index]
        hexadecimal = value[index + 1 : index + 3]
        if (
            character == "%"
            and len(hexadecimal) == 2
            and all(digit in "0123456789abcdefABCDEF" for digit in hexadecimal)
        ):
            out.append(chr(int(hexadecimal, 16)))
            index += 3
            continue
        out.append(character)
        index += 1
    return "".join(out)


def type_matches(expected: str, value: Json) -> bool:
    if expected == "null":
        return value is None
    if expected == "array":
        return is_array(value)
    if expected == "object":
        return is_record(value)
    if expected == "integer":
        return is_safe_integer(value)
    if expected == "string":
        return isinstance(value, str)
    if expected == "number":
        return is_number(value)
    if expected == "boolean":
        return is_bool(value)
    return False


def matches_schema(schema: Schema, root: Schema, value: Json) -> bool:
    """One pass in the SDK's order. Every early return is a rejection."""
    reference: Json = field(schema, "$ref")
    if isinstance(reference, str):
        target = resolve_reference(root, reference)
        return matches_schema(target, root, value) if target is not None else False

    any_of: Json = field(schema, "anyOf")
    if is_array(any_of) and not any(
        is_record(candidate) and matches_schema(candidate, root, value) for candidate in any_of
    ):
        return False

    declared: Json = field(schema, "type")
    if isinstance(declared, str) and not type_matches(declared, value):
        return False
    if is_array(declared) and not any(
        isinstance(candidate, str) and type_matches(candidate, value) for candidate in declared
    ):
        return False

    if "const" in schema and not json_equal(schema["const"], value):
        return False
    enum: Json = field(schema, "enum")
    if is_array(enum) and not any(json_equal(candidate, value) for candidate in enum):
        return False

    if is_array(value):
        minimum_items: Json = field(schema, "minItems")
        maximum_items: Json = field(schema, "maxItems")
        if is_number(minimum_items) and len(value) < minimum_items:
            return False
        if is_number(maximum_items) and len(value) > maximum_items:
            return False
        items: Json = field(schema, "items")
        if is_record(items) and not all(matches_schema(items, root, item) for item in value):
            return False

    if isinstance(value, str):
        length = unicode_length(value)
        minimum_length: Json = field(schema, "minLength")
        maximum_length: Json = field(schema, "maxLength")
        if is_number(minimum_length) and length < minimum_length:
            return False
        if is_number(maximum_length) and length > maximum_length:
            return False

    if is_number(value):
        if not is_finite(value) or (is_integer_number(value) and not is_safe_integer(value)):
            return False
        minimum: Json = field(schema, "minimum")
        maximum: Json = field(schema, "maximum")
        if is_number(minimum) and value < minimum:
            return False
        if is_number(maximum) and value > maximum:
            return False

    if is_record(value):
        required: Json = field(schema, "required")
        if is_array(required) and any(not isinstance(key, str) or key not in value for key in required):
            return False
        raw_properties: Json = field(schema, "properties")
        properties: Json = raw_properties if is_record(raw_properties) else {}
        additional: Json = field(schema, "additionalProperties")
        for key, child in value.items():
            if key in properties:
                declared_property: Json = properties[key]
                if not is_record(declared_property) or not matches_schema(declared_property, root, child):
                    return False
            elif additional is False or (is_record(additional) and not matches_schema(additional, root, child)):
                return False

    return True


def matches_generated_schema(schema: Schema, value: Json) -> bool:
    return validate_ijson(value).ok and matches_schema(schema, schema, value)
