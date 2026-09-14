#!/usr/bin/env python3
"""C02 runner wire gate for Python runners.

It validates the exact generated SDK JSON Schema and then the C02 semantics with
the Python-native validator.  Earlier it shelled out to a Node bridge for the
semantics, which meant the Python runtime had no validator of its own: C07 calls
a validator that works in only one runtime rejected, and the W00 requirement
index recorded that gap as discrepancy 20.  The bridge is gone.  Nothing here
starts a subprocess, reaches a network, or reads an ambient clock.

This entry point is the narrow host-Python conformance surface.  The same
validator runs inside the digest-pinned isolated guest through ``guest.py``, and
the equivalence suite compares both against the Bun runtime fixture by fixture.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from guest import Guest, GuestError, load_schema

Json = Any


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-schema", type=Path, required=True)
    parser.add_argument("--result-schema", type=Path, required=True)
    args = parser.parse_args()
    try:
        envelope: Json = json.load(sys.stdin)
        if (
            not isinstance(envelope, dict)
            or envelope.get("kind") not in ("request", "result")
            or "value" not in envelope
        ):
            raise GuestError("envelope must contain kind and value")
        guest = Guest(load_schema(args.request_schema), load_schema(args.result_schema))
        answer = guest.verdict(str(envelope["kind"]), envelope["value"])
        if not answer["ok"]:
            answer["error"] = answer["code"]
        print(json.dumps(answer))
        return 0 if answer["ok"] else 1
    except (OSError, ValueError, GuestError) as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
