"""Test package for the locked Python distribution.

Importing this package puts the distribution's own directory on ``sys.path``,
so every test module imports the runner modules by their plain names in both
layouts: the repository checkout and the staged guest workspace.

The shared fixtures live here rather than in a sibling module because the
package marker is the one file under ``tests/`` that the new-file coverage gate
already treats as test code, and a fixture module is test code.

The generated schemas are found in whichever layout the suite is running in.
Beside the package is the isolated guest, where the build stages the generated
bytes next to ``guest.py``. Walking up to ``packages/@ezcorp/factory-sdk/src``
is the repository checkout. Both resolve to the same committed file, so the
host lane and the guest lane are measured against one document.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

PACKAGE = Path(__file__).resolve().parent.parent
if str(PACKAGE) not in sys.path:
    sys.path.insert(0, str(PACKAGE))

Json = Any


def schema_path(name: str) -> Path:
    beside = PACKAGE / name
    if beside.is_file():
        return beside
    for parent in PACKAGE.parents:
        candidate = parent / "packages" / "@ezcorp" / "factory-sdk" / "src" / name
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(name)


def load(name: str) -> dict[str, Json]:
    document: dict[str, Json] = json.loads(schema_path(name).read_text(encoding="utf-8"))
    return document


REQUEST_SCHEMA: dict[str, Json] = load("factory-runner-request.schema.json")
RESULT_SCHEMA: dict[str, Json] = load("factory-runner-result.schema.json")


def guest_model_schemas() -> tuple[dict[str, Json], dict[str, Json]]:
    """The guest model pair, loaded on demand rather than at package import.

    Importing this package must not require them. The reference data pack stages
    this same test package beside its own tests and stages only the two runner
    schemas, so loading the pair here would break a pack that never calls a
    model. A module that does need them calls this and fails loudly when they
    were not staged, which is the opposite of skipping.
    """
    return load("factory-guest-model-request.schema.json"), load("factory-guest-model-response.schema.json")

DIGEST = "a" * 64
OTHER_DIGEST = "b" * 64


def request(**overrides: Json) -> dict[str, Json]:
    """One pinned C02 runner request that the Bun validator also admits."""
    value: dict[str, Json] = {
        "schemaVersion": "factory.runner.request.v1",
        "authority": {
            "attemptId": "attempt-python",
            "tenantId": "tenant-python",
            "projectId": "project-python",
            "runId": "run-python",
            "nodeInstanceId": "node-python",
            "candidateGeneration": 1,
            "attemptNumber": 1,
            "grantRevision": 2,
            "reservationGeneration": 3,
            "executionEpoch": 4,
            "cancellationEpoch": 0,
            "deadlineAtMs": 1_800_000_000_000,
            "nextOperationIndex": 0,
        },
        "runner": {
            "package": "@ezcorp/factory-python-runner",
            "manifestName": "factory-python-runner",
            "version": "1.0.0",
            "digest": f"sha256:{DIGEST}",
            "export": "run",
            "model": "pinned-model",
            "configurationDigest": f"sha256:{OTHER_DIGEST}",
        },
        "model": {
            "provider": "pinned-provider",
            "model": "pinned-model",
            "configuration": {"temperature": 0},
            "configurationDigest": f"sha256:{OTHER_DIGEST}",
            "policy": {"redact": True},
            "policyDigest": f"sha256:{DIGEST}",
        },
        "input": {"kind": "inline", "value": {"prompt": "python guest"}},
        "grants": ["storage.get"],
        "resources": {"maxCostMicros": "1200", "maxTokens": 16, "resourceClass": "cpu-small"},
        "tools": [
            {
                "name": "echo",
                "description": "Echo one value",
                "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
            }
        ],
        "broker": {"audience": "gateway", "attemptToken": "attempt-token"},
    }
    value.update(overrides)
    return value


def result(**overrides: Json) -> dict[str, Json]:
    """One completed C02 runner result whose cursor, checkpoint and operation agree."""
    checkpoint = {
        "artifactId": "checkpoint-python",
        "digest": f"sha256:{DIGEST}",
        "encodedBytes": 128,
        "journalCursor": 0,
    }
    value: dict[str, Json] = {
        "schemaVersion": "factory.runner.result.v1",
        "status": "completed",
        "journalCursor": 0,
        "operations": [
            {
                "operationId": "operation-python:0",
                "operationIndex": 0,
                "kind": "model",
                "requestDigest": DIGEST,
                "state": "completed",
                "resultDigest": OTHER_DIGEST,
                "usage": {
                    "kind": "measured",
                    "inputTokens": 11,
                    "outputTokens": 7,
                    "computeMs": 21,
                    "costMicros": "1200",
                },
                "workspaceCheckpoint": checkpoint,
            }
        ],
        "resultDigest": OTHER_DIGEST,
        "output": {"artifactId": "output-python", "digest": f"sha256:{OTHER_DIGEST}", "encodedBytes": 256},
        "usage": {"kind": "measured", "inputTokens": 11, "outputTokens": 7, "computeMs": 21, "costMicros": "1200"},
        "workspaceCheckpoint": checkpoint,
    }
    value.update(overrides)
    return value


def at(value: Json, path: list[str | int], replacement: Json) -> Json:
    """Replaces one field in a deep copy, so a case varies exactly one thing."""
    copied: Json = json.loads(json.dumps(value))
    target = copied
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = replacement
    return copied


def without(value: Json, path: list[str | int]) -> Json:
    copied: Json = json.loads(json.dumps(value))
    target = copied
    for key in path[:-1]:
        target = target[key]
    del target[path[-1]]
    return copied


def guest_model_request(**overrides: Json) -> dict[str, Json]:
    """One guest model request the Bun validator also admits."""
    value: dict[str, Json] = {
        "schemaVersion": "factory.guest-model-request.v1",
        "operationId": "run-python:node-python:1:2",
        "operationIndex": 2,
        "model": {
            "provider": "pinned-provider",
            "model": "pinned-model",
            "configuration": {"temperature": 0},
            "configurationDigest": f"sha256:{OTHER_DIGEST}",
            "policy": {"redact": True},
            "policyDigest": f"sha256:{DIGEST}",
        },
        "messages": [
            {"role": "system", "text": "Answer exactly what was asked."},
            {"role": "user", "text": "Summarise the staged diff."},
        ],
        "maxOutputTokens": 1024,
    }
    value.update(overrides)
    return value


def guest_model_response(**overrides: Json) -> dict[str, Json]:
    """One completed guest model response carrying a receipt and measured usage."""
    value: dict[str, Json] = {
        "schemaVersion": "factory.guest-model-response.v1",
        "status": "completed",
        "operationId": "run-python:node-python:1:2",
        "text": "The staged diff renames one export and adds a test.",
        "providerReceiptDigest": f"sha256:{DIGEST}",
        "usage": {"kind": "measured", "inputTokens": 11, "outputTokens": 7, "computeMs": 21, "costMicros": "1200"},
    }
    value.update(overrides)
    return value


def guest_model_refusal(**overrides: Json) -> dict[str, Json]:
    value: dict[str, Json] = {
        "schemaVersion": "factory.guest-model-response.v1",
        "status": "refused",
        "operationId": "run-python:node-python:1:2",
        "refusal": {"code": "model_pin_mismatch", "message": "A guest may only call the model its attempt pinned."},
    }
    value.update(overrides)
    return value
