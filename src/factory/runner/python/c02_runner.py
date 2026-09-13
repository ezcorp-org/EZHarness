#!/usr/bin/env python3
"""C02 runner wire gate for Python runners.

It validates the exact generated SDK JSON Schema first, then delegates semantic
checks to the SDK bridge.  Keeping semantics in the SDK prevents a Python
runner from accepting a different authority, pin, usage, or checkpoint contract.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, cast
from jsonschema import Draft7Validator


Json = Any


class SchemaError(Exception):
    pass


def sdk_validate(node: str, bridge: Path, envelope: dict[str, Json]) -> dict[str, Json]:
    result = subprocess.run(
        [node, str(bridge)], input=json.dumps(envelope), text=True, capture_output=True, check=False
    )
    if result.returncode not in (0, 1):
        raise SchemaError(f"SDK validator failed: {result.stderr.strip()}")
    try:
        return cast(dict[str, Json], json.loads(result.stdout))
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
        Draft7Validator.check_schema(schema)
        errors = sorted(Draft7Validator(schema).iter_errors(envelope["value"]), key=lambda error: list(error.path))
        if errors:
            raise SchemaError(errors[0].message)
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
