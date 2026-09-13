#!/usr/bin/env python3
"""C02 runner wire gate for Python runners.

It validates the exact generated SDK JSON Schema first, then delegates semantic
checks to the SDK bridge.  Keeping semantics in the SDK prevents a Python
runner from accepting a different authority, pin, usage, or checkpoint contract.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Any


Json = Any


class SchemaError(Exception):
    pass


def json_type(value: Json, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    raise SchemaError(f"unsupported JSON Schema type: {expected}")


def resolve(root: dict[str, Json], ref: str) -> Json:
    if not ref.startswith("#/"):
        raise SchemaError(f"external JSON Schema reference is not permitted: {ref}")
    value: Json = root
    for part in ref[2:].split("/"):
        value = value[part.replace("~1", "/").replace("~0", "~")]
    return value


def validate(value: Json, schema: Json, root: dict[str, Json], path: str = "$") -> None:
    if not isinstance(schema, dict):
        raise SchemaError(f"{path}: schema must be an object")
    if "$ref" in schema:
        validate(value, resolve(root, schema["$ref"]), root, path)
        return
    for keyword in ("allOf", "anyOf", "oneOf"):
        if keyword not in schema:
            continue
        matches = []
        for candidate in schema[keyword]:
            try:
                validate(value, candidate, root, path)
                matches.append(candidate)
            except SchemaError:
                pass
        if keyword == "allOf" and len(matches) != len(schema[keyword]):
            raise SchemaError(f"{path}: does not satisfy allOf")
        if keyword == "anyOf" and not matches:
            raise SchemaError(f"{path}: does not satisfy anyOf")
        if keyword == "oneOf" and len(matches) != 1:
            raise SchemaError(f"{path}: does not satisfy oneOf")
    if "const" in schema and value != schema["const"]:
        raise SchemaError(f"{path}: does not match const")
    if "enum" in schema and value not in schema["enum"]:
        raise SchemaError(f"{path}: does not match enum")
    expected = schema.get("type")
    if expected is not None:
        expected_types = expected if isinstance(expected, list) else [expected]
        if not any(json_type(value, item) for item in expected_types):
            raise SchemaError(f"{path}: does not match type")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                raise SchemaError(f"{path}: missing required property {key}")
        properties = schema.get("properties", {})
        for key, item in value.items():
            if key in properties:
                validate(item, properties[key], root, f"{path}.{key}")
            elif schema.get("additionalProperties") is False:
                raise SchemaError(f"{path}: additional property {key}")
            elif isinstance(schema.get("additionalProperties"), dict):
                validate(item, schema["additionalProperties"], root, f"{path}.{key}")
    if isinstance(value, list) and "items" in schema:
        for index, item in enumerate(value):
            validate(item, schema["items"], root, f"{path}[{index}]")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            raise SchemaError(f"{path}: below minimum")
        if "maximum" in schema and value > schema["maximum"]:
            raise SchemaError(f"{path}: above maximum")


def sdk_validate(node: str, bridge: Path, envelope: dict[str, Json]) -> dict[str, Json]:
    result = subprocess.run(
        [node, str(bridge)], input=json.dumps(envelope), text=True, capture_output=True, check=False
    )
    if result.returncode not in (0, 1):
        raise SchemaError(f"SDK validator failed: {result.stderr.strip()}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SchemaError("SDK validator returned invalid JSON") from error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-schema", type=Path, required=True)
    parser.add_argument("--result-schema", type=Path, required=True)
    parser.add_argument("--sdk-bridge", type=Path, required=True)
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    try:
        envelope = json.load(sys.stdin)
        if not isinstance(envelope, dict) or envelope.get("kind") not in ("request", "result") or "value" not in envelope:
            raise SchemaError("envelope must contain kind and value")
        schema_path = args.request_schema if envelope["kind"] == "request" else args.result_schema
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        if schema.get("$schema") != "http://json-schema.org/draft-07/schema#":
            raise SchemaError("expected generated Draft 7 schema")
        validate(envelope["value"], schema, schema)
        result = sdk_validate(args.node, args.sdk_bridge, envelope)
        if not result.get("ok"):
            raise SchemaError(result.get("issues", [{"code": "SDK_REJECTED"}])[0].get("code", "SDK_REJECTED"))
        print(json.dumps({"ok": True, "schemaId": schema["$id"]}))
        return 0
    except (OSError, ValueError, SchemaError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
