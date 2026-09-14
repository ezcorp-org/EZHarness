"""The isolated Python guest: the framed request and result bridge.

It speaks exactly the frame protocol that ``extension-runner``'s
``FramedExecution`` writes, so one host contract serves both the Bun guest and
this one.  Frames are newline-delimited JSON-RPC 2.0 objects on the descriptors
the in-container shim hands over as stdin and stdout, and the shim holds those
FIFOs ``O_RDWR`` for the guest's whole life, so no host process's exit can reach
this process as end-of-input.

Two exports exist.  ``validate`` answers a raw conformance envelope, which is
what the C07 equivalence suite compares against the Bun validator.  ``run``
answers a real ``FactoryRunnerRequest`` with a ``FactoryRunnerResult``, both
checked by the Python-native validator before they cross the wire, so an
invalid request never becomes a result and an invalid result never leaves the
guest.

The guest reaches nothing but its own stdio.  It has no network, no credential,
and no host capability, and it never emits a reverse request.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, Final, TextIO

from factory_ijson import canonicalize_json
from factory_validation import validate_factory_runner_request, validate_factory_runner_result

Json = Any

GUEST_VERSION: Final = "factory.python-guest.v1"
MAX_FRAME_BYTES: Final = 1024 * 1024
# The generated schemas are staged beside this module, so the guest reads the
# same committed bytes the Bun runtime imports and resolves them without an
# environment variable the C05 profile does not permit.
SCHEMA_DIRECTORY: Final = Path(__file__).resolve().parent

MANIFEST: Final[dict[str, Json]] = {
    "schemaVersion": 4,
    "name": "factory-python-runner",
    "version": "1.0.0",
    "author": {"name": "EZCorp factory platform"},
    "description": "Isolated Python guest for C02 runner conformance and C07 validator equivalence",
    "permissions": {},
    "tools": [
        {
            "name": "validate",
            "description": "Validate one C02 runner request or result envelope with the Python-native validator",
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
        },
        {
            "name": "run",
            "description": "Answer one FactoryRunnerRequest with a FactoryRunnerResult",
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
        },
        {
            "name": "controls",
            "description": "Report the runtime controls this guest observes applied to itself",
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
        },
        {
            "name": "hostile",
            "description": "Attempt every escape a hostile package would try and report each refusal",
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
        },
    ],
}


class GuestError(Exception):
    """A refusal the guest reports as a JSON-RPC error rather than a crash."""


UNAVAILABLE: Final = "unavailable"


def read_control(path: str) -> str:
    """A control the guest cannot read reports ``unavailable`` rather than
    crashing the report. It is never a value the host's exact comparison can
    accept, so a missing control still fails closed."""
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return UNAVAILABLE


def _connect() -> None:
    """Any egress at all. The profile gives the guest no route, so this must fail."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(2)
        client.connect(("1.1.1.1", 443))


def _spawn_status(path: str) -> int:
    """Execs the payload directly, so the refusal comes from the kernel's exec
    of that inode and from nothing a helper wrapped around it."""
    child = os.posix_spawn(path, [path], {})
    return os.waitpid(child, 0)[1]


def _execute_from_tmp(run: Callable[[str], int] = _spawn_status) -> None:
    """The writable tmpfs is `noexec`, so a dropped payload cannot run. A
    payload that did run is raised as a breach rather than passing quietly."""
    payload = Path(tempfile.gettempdir()) / "escape.sh"
    payload.write_text("#!/bin/sh\necho escaped\n", encoding="utf-8")
    payload.chmod(payload.stat().st_mode | stat.S_IXUSR)
    if run(str(payload)) == 0:
        raise RuntimeError("EXECUTED")


def _status_field(status: str, name: str) -> str:
    for line in status.splitlines():
        label, separator, value = line.partition(":")
        if separator and label == name:
            return value.strip()
    return ""


def load_schema(path: Path) -> dict[str, Json]:
    document: Json = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or document.get("$schema") != "http://json-schema.org/draft-07/schema#":
        raise GuestError(f"{path} is not the generated Draft 7 schema")
    return document


class Guest:
    """One guest process. It holds the two pinned schemas and nothing else."""

    def __init__(self, request_schema: dict[str, Json], result_schema: dict[str, Json]) -> None:
        self.request_schema = request_schema
        self.result_schema = result_schema

    def verdict(self, kind: str, value: Json) -> dict[str, Json]:
        """One envelope's verdict, in the shape the equivalence suite compares."""
        if kind == "request":
            result = validate_factory_runner_request(value, self.request_schema)
            schema_id = self.request_schema.get("$id")
        elif kind == "result":
            result = validate_factory_runner_result(value, self.result_schema)
            schema_id = self.result_schema.get("$id")
        else:
            raise GuestError("envelope kind must be request or result")
        answer: dict[str, Json] = {"ok": result.ok, "schemaId": schema_id, "runtime": GUEST_VERSION}
        if result.issue is not None:
            answer["code"] = result.issue.code
            answer["path"] = list(result.issue.path)
        return answer

    def run(self, request: Json) -> dict[str, Json]:
        """Answer a real attempt.

        A request the shared contract refuses becomes a failed result carrying
        that exact issue code, never a completed one, and the result is checked
        against the same contract before it leaves this process, so the guest
        cannot emit a shape the host would have to reject.
        """
        verdict = self.verdict("request", request)
        cursor = -1
        if verdict["ok"]:
            canonical = canonicalize_json(request).encode("utf-8")
            digest = hashlib.sha256(canonical).hexdigest()
            result: dict[str, Json] = {
                "schemaVersion": "factory.runner.result.v1",
                "status": "completed",
                "journalCursor": cursor,
                "operations": [],
                "resultDigest": digest,
                "output": {
                    "artifactId": f"python-guest-{digest[:32]}",
                    "digest": f"sha256:{digest}",
                    "encodedBytes": len(canonical),
                },
                "usage": {"kind": "measured", "inputTokens": 0, "outputTokens": 0, "computeMs": 0, "costMicros": "0"},
                "workspaceCheckpoint": {
                    "artifactId": f"python-guest-checkpoint-{digest[:24]}",
                    "digest": f"sha256:{digest}",
                    "encodedBytes": len(canonical),
                    "journalCursor": cursor,
                },
            }
        else:
            code = str(verdict.get("code", "RUNNER_REQUEST_SCHEMA"))
            result = {
                "schemaVersion": "factory.runner.result.v1",
                "status": "failed",
                "journalCursor": cursor,
                "operations": [],
                "resultDigest": hashlib.sha256(code.encode("utf-8")).hexdigest(),
                "error": {
                    "code": code,
                    "message": "The Python guest refused this request under the shared C02 contract.",
                    "retryable": False,
                },
            }
        outgoing = validate_factory_runner_result(result, self.result_schema)
        if outgoing.issue is not None:
            raise GuestError(f"Python guest built an invalid result: {outgoing.issue.code}")
        return result

    @staticmethod
    def controls(read: Callable[[str], str] = read_control) -> dict[str, Json]:
        """What the guest observes of its own confinement.

        The host verifies the same facts from the container runtime, which is
        what C05 requires; this corroborates them from inside so a control that
        the runtime reports but the kernel did not apply cannot pass unseen.
        """
        status = read("/proc/self/status")
        writable_root = True
        try:
            Path("/root-write-probe").write_text("x", encoding="utf-8")
        except OSError:
            writable_root = False
        devices = sorted(entry.name for entry in Path("/dev").iterdir()) if Path("/dev").is_dir() else []
        return {
            "uid": os.getuid(),
            "gid": os.getgid(),
            "capabilities": _status_field(status, "CapEff"),
            "noNewPrivileges": _status_field(status, "NoNewPrivs"),
            "seccomp": _status_field(status, "Seccomp"),
            "memoryMax": read("/sys/fs/cgroup/memory.max"),
            "swapMax": read("/sys/fs/cgroup/memory.swap.max"),
            "cpuMax": read("/sys/fs/cgroup/cpu.max"),
            "pidsMax": read("/sys/fs/cgroup/pids.max"),
            "routes": [line for line in read("/proc/net/route").splitlines() if line][1:],
            "ipv6Routes": [
                line for line in read("/proc/net/ipv6_route").splitlines() if line and not line.endswith("lo")
            ],
            "environment": sorted(os.environ),
            "devices": devices,
            "gpuDevices": [name for name in devices if name in {"kfd", "dri"}],
            "writableRoot": writable_root,
            "distributions": sorted(
                f"{d.metadata['Name']}=={d.version}" for d in importlib.metadata.distributions() if d.metadata["Name"]
            ),
            "python": f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}",
            "runtime": GUEST_VERSION,
        }

    @staticmethod
    def hostile() -> dict[str, Json]:
        """A hostile task fixture, run inside the component environment.

        Each entry is an escape a candidate package would try. Every one must be
        refused by the kernel, so the report is a list of refusals rather than a
        list of successes; a `true` anywhere here is a breach.
        """
        attempts: dict[str, Json] = {}

        def refused(name: str, action: Callable[[], object]) -> None:
            try:
                action()
                attempts[name] = False
            except (OSError, ValueError, RuntimeError, ImportError, PermissionError):
                attempts[name] = True

        refused("write-workspace", lambda: Path("/workspace/escape.py").write_text("x", encoding="utf-8"))
        refused("replace-guest-source", lambda: Path("/workspace/guest.py").write_text("x", encoding="utf-8"))
        refused("unlink-guest-source", lambda: Path("/workspace/guest.py").unlink())
        refused("write-root", lambda: Path("/escape").write_text("x", encoding="utf-8"))
        refused("write-channel", lambda: Path("/channel/escape").write_text("x", encoding="utf-8"))
        refused("unlink-channel", lambda: Path("/channel/in").unlink())
        refused("symlink-channel", lambda: os.symlink("/etc/passwd", "/channel/out"))
        refused("read-host-secret", lambda: Path("/proc/1/environ").read_bytes())
        refused("open-network", _connect)
        refused(
            "spawn-shell", lambda: subprocess.run(["/bin/sh", "-c", "echo escaped"], check=True, capture_output=True)
        )
        refused("execute-from-tmp", _execute_from_tmp)
        attempts["allRefused"] = all(value is True for key, value in attempts.items())
        return attempts

    def invoke(self, params: Json) -> Json:
        if not isinstance(params, dict):
            raise GuestError("invoke params must be an object")
        name = params.get("name")
        payload = params.get("input")
        if name == "validate":
            if not isinstance(payload, dict) or "kind" not in payload or "value" not in payload:
                raise GuestError("envelope must contain kind and value")
            return self.verdict(str(payload["kind"]), payload["value"])
        if name == "run":
            return self.run(payload)
        if name == "controls":
            return self.controls()
        if name == "hostile":
            return self.hostile()
        raise GuestError(f"unknown export {name}")

    def dispatch(self, method: str, params: Json) -> Json:
        if method == "extension/discover":
            return MANIFEST
        if method == "extension/invoke":
            return self.invoke(params)
        if method == "extension/cancel":
            return {"cancelled": True}
        raise GuestError(f"unknown method {method}")


def serve(guest: Guest, source: TextIO, sink: TextIO) -> int:
    """Read frames until end-of-input. Every failure answers the frame that
    caused it; only an unreadable stream ends the loop."""
    for line in source:
        text = line.strip()
        if not text:
            continue
        if len(text.encode("utf-8")) > MAX_FRAME_BYTES:
            _write(
                sink,
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Control frame exceeds policy"}},
            )
            continue
        try:
            frame: Json = json.loads(text)
        except ValueError:
            _write(
                sink,
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": "Guest received invalid protocol data"},
                },
            )
            continue
        if not isinstance(frame, dict) or frame.get("jsonrpc") != "2.0" or not isinstance(frame.get("method"), str):
            _write(
                sink,
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Expected a JSON-RPC 2.0 request"}},
            )
            continue
        identifier = frame.get("id")
        try:
            result = guest.dispatch(frame["method"], frame.get("params"))
        except GuestError as error:
            _write(sink, {"jsonrpc": "2.0", "id": identifier, "error": {"code": -32000, "message": str(error)}})
            continue
        _write(sink, {"jsonrpc": "2.0", "id": identifier, "result": result})
    return 0


def _write(sink: TextIO, frame: dict[str, Json]) -> None:
    sink.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
    sink.flush()


def main(directory: Path = SCHEMA_DIRECTORY) -> int:
    """The launcher the in-guest shim starts calls exactly this."""
    request_schema = load_schema(directory / "factory-runner-request.schema.json")
    result_schema = load_schema(directory / "factory-runner-result.schema.json")
    return serve(Guest(request_schema, result_schema), sys.stdin, sys.stdout)
