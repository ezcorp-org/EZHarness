#!/usr/bin/env python3
"""Operator-owned, single-app Incus qualification restart supervisor (Linux only).

The supervisor owns the child and signing key. Its socket accepts requests only
from that exact child process, verified with SO_PEERCRED and /proc start ticks.
"""

import argparse
import base64
import json
import os
import pwd
import re
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import stat
from pathlib import Path


IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
DIGEST = re.compile(r"^[a-f0-9]{64}$")
REQUEST_KEYS = {"version", "action", "runId", "nonce", "deadlineMs", "scope",
                "fixtureOperationId", "bindingId", "generation", "connectionRevision",
                "lastOperationId", "beforeDigest"}
CLAIM_KEYS = {"version", "action", "runId", "nonce", "afterDigest"}
SCOPE_KEYS = {"installationId", "releaseId", "connectionId", "presetId"}


def identity(pid):
    stat = Path(f"/proc/{pid}/stat").read_text()
    fields = stat[stat.rfind(")") + 2:].split()
    if len(fields) < 20 or not fields[19].isdigit():
        raise ValueError("process start identity unavailable")
    return {"pid": pid, "startTicks": fields[19]}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def read_message(connection):
    data = bytearray()
    while not data.endswith(b"\n"):
        chunk = connection.recv(4096)
        if not chunk or len(data) + len(chunk) > 16384:
            raise ValueError("invalid control frame")
        data.extend(chunk)
    return json.loads(data[:-1])


def send_message(connection, message):
    connection.sendall(canonical(message) + b"\n")


def validate_request(message):
    if not isinstance(message, dict) or set(message) != REQUEST_KEYS or message["version"] != 1 \
            or message["action"] != "restart" or not isinstance(message["scope"], dict) \
            or set(message["scope"]) != SCOPE_KEYS:
        raise ValueError("invalid restart request")
    for name in ("runId", "nonce", "fixtureOperationId", "bindingId", "lastOperationId"):
        if not isinstance(message[name], str) or not IDENTIFIER.fullmatch(message[name]):
            raise ValueError("invalid restart identity")
    for value in message["scope"].values():
        if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
            raise ValueError("invalid restart scope")
    if not isinstance(message["beforeDigest"], str) or not DIGEST.fullmatch(message["beforeDigest"]):
        raise ValueError("invalid before digest")
    for name in ("generation", "connectionRevision", "deadlineMs"):
        if type(message[name]) is not int or message[name] <= 0:
            raise ValueError("invalid restart number")
    now = int(time.time() * 1000)
    if not now < message["deadlineMs"] <= now + 120000:
        raise ValueError("restart deadline expired or excessive")


class Supervisor:
    def __init__(self, socket_path, app_command, app_uid, app_gid, key_path, authority_command,
                 receipt_authority_command,
                 *, enforce_distinct_uid=True):
        if sys.platform != "linux" or not hasattr(socket, "SO_PEERCRED"):
            raise RuntimeError("Linux SO_PEERCRED is required")
        if enforce_distinct_uid and os.geteuid() == app_uid:
            raise RuntimeError("supervisor and app must have distinct UIDs")
        if enforce_distinct_uid and os.geteuid() != 0:
            raise RuntimeError("supervisor must be root to launch the distinct app UID")
        self.socket_path = Path(socket_path)
        self.app_command = app_command
        self.app_uid = app_uid
        self.app_gid = app_gid
        self.key_path = Path(key_path)
        self.authority_command = authority_command
        self.receipt_authority_command = receipt_authority_command
        self.child = None
        self.pending = None
        self.used_runs = set()
        key_stat = self.key_path.lstat()
        if not stat.S_ISREG(key_stat.st_mode) or key_stat.st_uid != os.geteuid() \
                or key_stat.st_mode & 0o077:
            raise RuntimeError("operator signing key must be a private regular file")
        if not self.authority_command:
            raise RuntimeError("operator authority verifier is required")
        if not self.receipt_authority_command:
            raise RuntimeError("independent backend receipt verifier is required")

    def drop_app_privileges(self):
        if os.geteuid() != self.app_uid:
            os.initgroups(pwd.getpwuid(self.app_uid).pw_name, self.app_gid)
            os.setgid(self.app_gid)
            os.setuid(self.app_uid)

    def start_child(self):
        self.child = subprocess.Popen(self.app_command, close_fds=True, start_new_session=True,
                                      preexec_fn=self.drop_app_privileges)
        self.child_identity = identity(self.child.pid)

    def peer_is_child(self, connection):
        pid, uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return (self.child is not None and self.child.poll() is None and uid == self.app_uid
                and pid == self.child.pid and identity(pid) == self.child_identity)

    def authorize(self, request):
        check = subprocess.run(self.authority_command, input=canonical(request) + b"\n",
                               capture_output=True, timeout=10, check=False,
                               preexec_fn=self.drop_app_privileges)
        if check.returncode != 0:
            raise ValueError("operator authority verifier rejected run")
        result = json.loads(check.stdout)
        if result != {"authorized": True, "oldProcess": self.child_identity}:
            raise ValueError("operator authority verifier disagreed")

    def receipt(self, request):
        if not isinstance(request, dict) or set(request) != CLAIM_KEYS \
                or request["version"] != 1 or request["action"] != "receipt" \
                or not isinstance(request["afterDigest"], str) \
                or not DIGEST.fullmatch(request["afterDigest"]):
            raise ValueError("invalid receipt request")
        pending = self.pending
        if pending is None or request["runId"] != pending["request"]["runId"] \
                or request["nonce"] != pending["request"]["nonce"]:
            raise ValueError("receipt unavailable")
        original = pending["request"]
        if int(time.time() * 1000) >= original["deadlineMs"]:
            self.pending = None
            raise ValueError("receipt expired")
        payload = {key: original[key] for key in ("runId", "nonce", "deadlineMs", "scope",
                   "fixtureOperationId", "bindingId", "generation", "connectionRevision",
                   "lastOperationId", "beforeDigest")}
        payload.update(version=1, oldProcess=pending["oldProcess"],
                       newProcess=self.child_identity, afterDigest=request["afterDigest"])
        verified = subprocess.run(self.receipt_authority_command,
                                  input=canonical(payload) + b"\n", capture_output=True,
                                  timeout=10, check=False)
        if verified.returncode != 0 or json.loads(verified.stdout) != {
                "authorized": True, "afterDigest": request["afterDigest"]}:
            raise ValueError("independent backend receipt verification failed")
        # OpenSSL's Ed25519 one-shot operation requires a seekable input file.
        with tempfile.TemporaryDirectory(prefix="incus-handoff-") as directory:
            data = Path(directory) / "payload"
            data.write_bytes(canonical(payload))
            signed = subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey",
                                     str(self.key_path), "-in", str(data)],
                                    capture_output=True, timeout=5, check=True)
        self.pending = None
        return {"payload": payload, "signature": base64.b64encode(signed.stdout).decode("ascii")}

    def serve(self):
        parent = self.socket_path.parent.stat()
        if parent.st_uid != os.geteuid() or parent.st_mode & 0o007:
            raise RuntimeError("control directory must be operator-owned and private")
        if self.socket_path.exists():
            raise RuntimeError("control socket already exists")
        listener = socket.socket(socket.AF_UNIX)
        try:
            listener.bind(str(self.socket_path))
            os.chown(self.socket_path, -1, self.app_gid)
            os.chmod(self.socket_path, 0o660)
            listener.listen(4)
            self.start_child()
            while True:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(5)
                    try:
                        if not self.peer_is_child(connection):
                            raise ValueError("unauthorized control peer")
                        message = read_message(connection)
                        if not isinstance(message, dict):
                            raise ValueError("invalid control request")
                        if message.get("action") == "restart":
                            validate_request(message)
                            if self.pending is not None or message["runId"] in self.used_runs:
                                raise ValueError("restart already pending or used")
                            # Ack before terminating the requesting child.
                            send_message(connection, {"accepted": True})
                            self.restart_authorized(message)
                        elif message.get("action") == "receipt":
                            send_message(connection, {"receipt": self.receipt(message)})
                        else:
                            raise ValueError("unknown control action")
                    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
                        try:
                            send_message(connection, {"error": str(error)})
                        except OSError:
                            pass
        finally:
            listener.close()
            self.socket_path.unlink(missing_ok=True)
            if self.child and self.child.poll() is None:
                self.child.terminate()
                self.child.wait(timeout=10)

    def restart_authorized(self, request):
        old_identity = self.child_identity
        self.used_runs.add(request["runId"])
        os.killpg(self.child.pid, signal.SIGTERM)
        try:
            self.child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(self.child.pid, signal.SIGKILL)
            self.child.wait(timeout=5)
        # Embedded PGlite permits only one owner. Inspect its durable state
        # after the old app exits, before any new app can open the database.
        try:
            self.authorize(request)
        except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError):
            self.start_child()
            return
        self.pending = {"request": request, "oldProcess": old_identity}
        self.start_child()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    required = {"socket", "appCommand", "appUid", "appGid", "key", "authorityCommand",
                "receiptAuthorityCommand"}
    if set(config) != required or not all(type(config[name]) is int and config[name] > 0
                                           for name in ("appUid", "appGid")) \
            or not all(isinstance(config[name], str) and config[name].startswith("/")
                       for name in ("socket", "key")) \
            or not all(isinstance(config[name], list) and config[name]
                       and all(isinstance(value, str) and value for value in config[name])
                       for name in ("appCommand", "authorityCommand", "receiptAuthorityCommand")):
        raise ValueError("invalid supervisor configuration")
    Supervisor(config["socket"], config["appCommand"], config["appUid"], config["appGid"],
               config["key"], config["authorityCommand"], config["receiptAuthorityCommand"]).serve()


if __name__ == "__main__":
    main()
