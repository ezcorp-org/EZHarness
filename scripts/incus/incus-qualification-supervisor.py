#!/usr/bin/env python3
"""Operator-owned, single-app Incus qualification restart supervisor (Linux only).

The supervisor owns the child and signing key. Its socket accepts requests only
from that exact child process, verified with SO_PEERCRED and /proc start ticks.
"""

import argparse
import base64
import hashlib
import json
import os
import pwd
import re
import select
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
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
REQUEST_KEYS = {"version", "action", "runId", "nonce", "deadlineMs", "scope",
                "fixtureOperationId", "bindingId", "generation", "connectionRevision",
                "lastOperationId", "beforeDigest"}
CLAIM_KEYS = {"version", "action", "runId", "nonce", "afterDigest"}
RECOVERY_KEYS = {"version", "action", "nonce", "reviewId", "scope",
                 "fixtureOperationId", "bindingId", "operationId", "generation",
                 "connectionRevision", "fenceEvidence", "allClientsFenced", "deadlineMs"}
SCOPE_KEYS = {"installationId", "releaseId", "connectionId", "presetId"}
FAULT_ARM_KEYS = {"runId", "nonce", "deadlineMs", "scope", "fixtureOperationId",
                  "bindingId", "destroyOperationId", "generation", "providerGeneration",
                  "connectionRevision"}
AUTHORIZE_TIMEOUT_SECONDS = 10
SNAPSHOT_TIMEOUT_SECONDS = 30
VERIFY_TIMEOUT_SECONDS = 30
SIGN_TIMEOUT_SECONDS = 5
PROCESS_FENCE_TIMEOUT_SECONDS = 5


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


def bounded_timeout(deadline_ms, stage_limit_seconds):
    remaining = (deadline_ms - time.time() * 1000) / 1000
    if remaining <= 0:
        raise ValueError("receipt expired")
    return min(remaining, stage_limit_seconds)


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


def validate_recovery(message):
    if not isinstance(message, dict) or set(message) != RECOVERY_KEYS \
            or message["version"] != 1 or message["action"] != "recover-noeffect" \
            or message["allClientsFenced"] is not True \
            or not isinstance(message["scope"], dict) or set(message["scope"]) != SCOPE_KEYS:
        raise ValueError("invalid operator recovery request")
    for name in ("nonce", "reviewId", "fixtureOperationId", "bindingId", "operationId"):
        if not isinstance(message[name], str) or not IDENTIFIER.fullmatch(message[name]):
            raise ValueError("invalid operator recovery identity")
    if not all(isinstance(value, str) and IDENTIFIER.fullmatch(value)
               for value in message["scope"].values()):
        raise ValueError("invalid operator recovery scope")
    if not isinstance(message["fenceEvidence"], str) \
            or not 8 <= len(message["fenceEvidence"]) <= 512:
        raise ValueError("operator client fence evidence required")
    for name in ("generation", "connectionRevision", "deadlineMs"):
        if type(message[name]) is not int or message[name] <= 0:
            raise ValueError("invalid operator recovery number")
    now = int(time.time() * 1000)
    if not now + 145000 < message["deadlineMs"] <= now + 180000:
        raise ValueError("operator recovery deadline invalid")


def validate_fault(message):
    if not isinstance(message, dict) or message.get("version") != 1 \
            or message.get("action") != "fault" or message.get("phase") not in \
            ("presence", "arm", "readback"):
        raise ValueError("invalid fault request")
    if message["phase"] == "presence":
        if set(message) != {"version", "action", "phase"}:
            raise ValueError("invalid fault presence request")
        return None
    if set(message) != {"version", "action", "phase", "arm"} \
            or not isinstance(message["arm"], dict) or set(message["arm"]) != FAULT_ARM_KEYS:
        raise ValueError("invalid fault arm")
    arm = message["arm"]
    if not isinstance(arm["scope"], dict) or set(arm["scope"]) != SCOPE_KEYS \
            or not all(isinstance(value, str) and IDENTIFIER.fullmatch(value)
                       for value in arm["scope"].values()):
        raise ValueError("invalid fault scope")
    for name in ("runId", "nonce", "fixtureOperationId", "bindingId"):
        if not isinstance(arm[name], str) or not IDENTIFIER.fullmatch(arm[name]):
            raise ValueError("invalid fault identity")
    if not isinstance(arm["destroyOperationId"], str) \
            or not UUID.fullmatch(arm["destroyOperationId"]):
        raise ValueError("invalid destroy operation identity")
    for name in ("deadlineMs", "generation", "providerGeneration", "connectionRevision"):
        if type(arm[name]) is not int or arm[name] <= 0:
            raise ValueError("invalid fault number")
    now = int(time.time() * 1000)
    if not now < arm["deadlineMs"] <= now + 30000:
        raise ValueError("fault deadline expired or excessive")
    return arm


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
        self.enforce_distinct_uid = enforce_distinct_uid
        self.key_path = Path(key_path)
        self.recovery_hold_path = self.key_path.with_name(self.key_path.name + ".noeffect-hold")
        self.authority_command = authority_command
        self.receipt_authority_command = receipt_authority_command
        self.child = None
        self.pending = None
        self.claimed = None
        self.fault_armed = None
        self.fault_authority_command = None
        self.used_runs = set()
        self.used_recoveries = set()
        self.operator_socket_path = None
        self.recovery_command = None
        self.recovery_fence_command = None
        key_stat = self.key_path.lstat()
        if not stat.S_ISREG(key_stat.st_mode) or key_stat.st_uid != os.geteuid() \
                or key_stat.st_mode & 0o077:
            raise RuntimeError("operator signing key must be a private regular file")
        parent_stat = self.key_path.parent.stat()
        if parent_stat.st_uid != os.geteuid() or parent_stat.st_mode & 0o022:
            raise RuntimeError("operator signing key directory must be operator-owned and private")
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
        if self.recovery_held():
            raise RuntimeError("recovery held for operator review")
        self.child = subprocess.Popen(self.app_command, close_fds=True, start_new_session=True,
                                      preexec_fn=self.drop_app_privileges)
        self.child_identity = identity(self.child.pid)

    def recovery_held(self):
        try:
            hold = self.recovery_hold_path.lstat()
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(hold.st_mode) or hold.st_uid != os.geteuid() \
                or hold.st_mode & 0o077:
            raise RuntimeError("unsafe recovery hold; operator review required")
        return True

    def set_recovery_hold(self, request):
        descriptor = os.open(self.recovery_hold_path,
                             os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(canonical({"nonce": request["nonce"], "reviewId": request["reviewId"]}) + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        self.sync_hold_directory()

    def clear_recovery_hold(self):
        self.recovery_hold_path.unlink()
        self.sync_hold_directory()

    def sync_hold_directory(self):
        descriptor = os.open(self.key_path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def child_exited(self):
        return os.waitid(os.P_PID, self.child.pid,
                         os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None

    def peer_is_child(self, connection):
        pid, uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return (self.child is not None and not self.child_exited() and uid == self.app_uid
                and pid == self.child.pid and identity(pid) == self.child_identity)

    def peer_is_operator(self, connection):
        _pid, uid, _gid = struct.unpack("3i", connection.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return uid == os.geteuid()

    def sign_payload(self, payload):
        with tempfile.TemporaryDirectory(prefix="incus-operator-sign-") as directory:
            data = Path(directory) / "payload"
            data.write_bytes(canonical(payload))
            signed = subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey",
                                     str(self.key_path), "-in", str(data)],
                                    capture_output=True, timeout=SIGN_TIMEOUT_SECONDS, check=True)
        return {"payload": payload, "signature": base64.b64encode(signed.stdout).decode("ascii")}

    def live_processes(self):
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                status = (entry / "stat").read_text()
                if status[status.rfind(")") + 2] == "Z":
                    continue
                yield int(entry.name), entry.stat().st_uid, os.getpgid(int(entry.name))
            except (FileNotFoundError, ProcessLookupError):
                continue

    def remaining_app_processes(self, old_group):
        return [pid for pid, uid, group in self.live_processes()
                if group == old_group or (self.enforce_distinct_uid and uid == self.app_uid)]

    def stop_child(self):
        old_identity = self.child_identity
        old_group = self.child.pid
        try:
            os.killpg(old_group, signal.SIGTERM)
        except ProcessLookupError:
            pass
        # WNOWAIT keeps the leader PID reserved while its group is signalled.
        # Reaping it first could let a new process reuse the group ID.
        term_deadline = time.monotonic() + 10
        while not self.child_exited():
            if time.monotonic() >= term_deadline:
                break
            time.sleep(0.05)
        # The leader can exit while a child in its process group ignores TERM.
        # Kill the complete group and wait for all live members to disappear.
        try:
            os.killpg(old_group, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.child.wait(timeout=PROCESS_FENCE_TIMEOUT_SECONDS)
        deadline = time.monotonic() + PROCESS_FENCE_TIMEOUT_SECONDS
        while self.remaining_app_processes(old_group):
            if time.monotonic() >= deadline:
                raise ValueError("old app process group or UID remains live; client fence failed")
            time.sleep(0.05)
        self.child = None
        return old_identity

    def assert_exclusive_app_uid(self):
        if not self.enforce_distinct_uid:
            return
        if any(uid == self.app_uid and group != self.child.pid
               for _pid, uid, group in self.live_processes()):
            raise ValueError("app UID is shared outside the managed process group")

    def recovery_stage(self, phase, value, deadline_ms):
        check = subprocess.run(self.recovery_command,
            input=canonical({"phase": phase, **value}) + b"\n", capture_output=True,
            timeout=bounded_timeout(deadline_ms, VERIFY_TIMEOUT_SECONDS), check=False,
            preexec_fn=self.drop_app_privileges if phase in ("durable", "apply") else None)
        if check.returncode != 0:
            raise ValueError("independent operator recovery verifier failed")
        return json.loads(check.stdout)

    def verify_recovery_fence(self, request, old_process):
        if not self.recovery_fence_command:
            raise ValueError("independent runner client fence verifier is required")
        check = subprocess.run(self.recovery_fence_command,
            input=canonical({"request": request, "oldProcess": old_process}) + b"\n",
            capture_output=True,
            timeout=bounded_timeout(request["deadlineMs"], AUTHORIZE_TIMEOUT_SECONDS),
            check=False)
        if check.returncode != 0 or json.loads(check.stdout) != {
                "fenced": True, "evidence": request["fenceEvidence"]}:
            raise ValueError("independent runner client fence verification failed")

    def preflight_recovery_config(self):
        path = os.environ.get("EZCORP_INCUS_NOEFFECT_CONFIG")
        if not path or not Path(path).is_absolute():
            raise ValueError("operator recovery config requires an absolute path")
        try:
            file = Path(path).lstat()
        except OSError as error:
            raise ValueError("operator recovery config is unavailable") from error
        if not stat.S_ISREG(file.st_mode) or file.st_uid != os.geteuid() \
                or file.st_mode & 0o077 or not 0 < file.st_size <= 128 * 1024:
            raise ValueError("operator recovery config must be a private operator-owned regular file")

    def recover_noeffect(self, request):
        validate_recovery(request)
        if not self.recovery_command or not self.recovery_fence_command \
                or request["nonce"] in self.used_recoveries or self.recovery_held() \
                or self.child is None:
            raise ValueError("operator recovery unavailable, replayed, or held for operator review")
        self.assert_exclusive_app_uid()
        self.preflight_recovery_config()
        self.used_recoveries.add(request["nonce"])
        self.set_recovery_hold(request)
        old_process = self.stop_child()
        stopped_at_ms = int(time.time() * 1000)
        self.verify_recovery_fence(request, old_process)
        # The host transport has a 30-second RPC deadline, but the v4
        # worker policy can run for 60 seconds. Leave margin for exit.
        time.sleep(65)
        bounded_timeout(request["deadlineMs"], VERIFY_TIMEOUT_SECONDS)
        target = {key: request[key] for key in ("scope", "fixtureOperationId", "bindingId",
                  "operationId", "generation", "connectionRevision")}
        if self.recovery_stage("durable", {"target": target}, request["deadlineMs"]) != {
                "verified": True}:
            raise ValueError("operator durable CREATE verification failed")
        first = self.recovery_stage("backend", {"target": target}, request["deadlineMs"])
        first_at = int(time.time() * 1000)
        time.sleep(5)
        if self.recovery_stage("durable", {"target": target}, request["deadlineMs"]) != {
                "verified": True}:
            raise ValueError("operator durable CREATE changed")
        second = self.recovery_stage("backend", {"target": target}, request["deadlineMs"])
        second_at = int(time.time() * 1000)
        if first != {"absent": True, "activeOperations": []} \
                or second != {"absent": True, "activeOperations": []}:
            raise ValueError("operator backend absence not independently verified")
        scope = request["scope"]
        resource = hashlib.sha256((scope["connectionId"] + "\0" +
                                   request["bindingId"]).encode()).hexdigest()[:32]
        payload = {"version": 1, "action": "recover-noeffect", "nonce": request["nonce"],
                   "reviewId": request["reviewId"], "scope": scope,
                   "fixtureOperationId": request["fixtureOperationId"],
                   "bindingId": request["bindingId"], "operationId": request["operationId"],
                   "generation": request["generation"],
                   "connectionRevision": request["connectionRevision"],
                   "resourceName": "ezh-" + resource, "oldProcess": old_process,
                   "stoppedAtMs": stopped_at_ms, "fenceUntilMs": request["deadlineMs"],
                   "allClientsFenced": True, "fenceEvidence": request["fenceEvidence"],
                   "first": {"observedAtMs": first_at, "instanceState": "absent",
                             "activeOperations": []},
                   "second": {"observedAtMs": second_at, "instanceState": "absent",
                              "activeOperations": []}}
        receipt = self.sign_payload(payload)
        public = subprocess.run(["openssl", "pkey", "-in", str(self.key_path), "-pubout"],
                                capture_output=True, timeout=SIGN_TIMEOUT_SECONDS, check=True)
        # A stopped runner can restart during the quiet window or readbacks.
        # Recheck the same exact local fence immediately before the DB write.
        self.verify_recovery_fence(request, old_process)
        result = self.recovery_stage("apply", {"receipt": receipt,
            "publicKeyPem": public.stdout.decode("ascii")}, request["deadlineMs"])
        if set(result) != {"cleanupOperationId"} \
                or not isinstance(result["cleanupOperationId"], str) \
                or not IDENTIFIER.fullmatch(result["cleanupOperationId"]):
            raise ValueError("operator recovery apply result invalid")
        self.clear_recovery_hold()
        self.start_child()
        return {"receipt": receipt, "cleanupOperationId": result["cleanupOperationId"]}

    def authorize(self, request):
        check = subprocess.run(self.authority_command, input=canonical(request) + b"\n",
                               capture_output=True,
                               timeout=bounded_timeout(request["deadlineMs"], AUTHORIZE_TIMEOUT_SECONDS),
                               check=False,
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
        verification_payload = {key: value for key, value in payload.items() if key != "afterDigest"}
        verified = subprocess.run(self.receipt_authority_command,
                                  input=canonical({"phase": "verify", "payload": verification_payload,
                                                   "snapshot": pending["snapshot"]}) + b"\n", capture_output=True,
                                  timeout=bounded_timeout(original["deadlineMs"], VERIFY_TIMEOUT_SECONDS),
                                  check=False)
        if verified.returncode != 0 or json.loads(verified.stdout) != {
                "afterDigest": request["afterDigest"]}:
            raise ValueError("independent backend receipt verification failed")
        sign_timeout = bounded_timeout(original["deadlineMs"], SIGN_TIMEOUT_SECONDS)
        # OpenSSL's Ed25519 one-shot operation requires a seekable input file.
        with tempfile.TemporaryDirectory(prefix="incus-handoff-") as directory:
            data = Path(directory) / "payload"
            data.write_bytes(canonical(payload))
            signed = subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey",
                                    str(self.key_path), "-in", str(data)],
                                    capture_output=True, timeout=sign_timeout, check=True)
        bounded_timeout(original["deadlineMs"], SIGN_TIMEOUT_SECONDS)
        self.pending = None
        self.claimed = {"request": original, "newProcess": self.child_identity}
        return {"payload": payload, "signature": base64.b64encode(signed.stdout).decode("ascii")}

    def fault(self, message):
        arm = validate_fault(message)
        claimed = self.claimed
        if not self.fault_authority_command or claimed is None \
                or self.child_identity != claimed["newProcess"]:
            raise ValueError("operator fault authority unavailable")
        if arm is None:
            return {"authorized": True}
        original = claimed["request"]
        if arm["runId"] != original["runId"] or arm["nonce"] != original["nonce"] \
                or arm["scope"] != original["scope"] \
                or arm["fixtureOperationId"] != original["fixtureOperationId"] \
                or arm["bindingId"] != original["bindingId"] \
                or arm["generation"] != original["generation"] \
                or arm["connectionRevision"] != original["connectionRevision"]:
            raise ValueError("fault claim mismatch")
        arm_bytes = canonical(arm)
        if self.fault_armed is not None and arm_bytes != self.fault_armed:
            raise ValueError("different fault already armed")
        if message["phase"] == "readback" and self.fault_armed is None:
            raise ValueError("fault was not armed")
        expected = {"authorized": True, "armDigest": hashlib.sha256(arm_bytes).hexdigest()}
        check = subprocess.run(self.fault_authority_command,
                               input=canonical({"phase": message["phase"], "arm": arm}) + b"\n",
                               capture_output=True,
                               timeout=min(5, (arm["deadlineMs"] - time.time() * 1000) / 1000),
                               check=False)
        if check.returncode != 0 or json.loads(check.stdout) != expected:
            raise ValueError("independent fault readback rejected")
        if int(time.time() * 1000) >= arm["deadlineMs"]:
            raise ValueError("fault deadline expired")
        if message["phase"] == "arm":
            self.fault_armed = arm_bytes
        return {"authorized": True}

    def readiness(self, message):
        if message != {"version": 1, "action": "readiness"}:
            raise ValueError("invalid readiness request")
        if self.pending is not None or self.claimed is not None:
            raise ValueError("qualification run is already active")
        if not self.fault_authority_command:
            raise ValueError("operator fault verifier is unavailable")
        for command, name in ((self.receipt_authority_command, "receipt"),
                              (self.fault_authority_command, "fault")):
            check = subprocess.run(command, input=b'{"phase":"readiness"}\n',
                                   capture_output=True, timeout=5, check=False)
            if check.returncode != 0 or check.stdout != \
                    (b'{"ready":"' + name.encode() + b'.v1"}\n'):
                raise ValueError("operator " + name + " verifier is unavailable")
        return {"ready": True, "protocol": "incus-qualification.v1"}

    def serve(self):
        parent = self.socket_path.parent.stat()
        if parent.st_uid != os.geteuid() or parent.st_mode & 0o027:
            raise RuntimeError("control directory must be operator-owned and private")
        if self.socket_path.exists():
            raise RuntimeError("control socket already exists")
        if bool(self.operator_socket_path) != bool(self.recovery_command):
            raise RuntimeError("operator recovery socket and verifier must be configured together")
        if self.operator_socket_path:
            operator_parent = self.operator_socket_path.parent.stat()
            if operator_parent.st_uid != os.geteuid() or operator_parent.st_mode & 0o027 \
                    or self.operator_socket_path.exists():
                raise RuntimeError("operator recovery socket directory is unavailable")
        listener = socket.socket(socket.AF_UNIX)
        operator_listener = socket.socket(socket.AF_UNIX) if self.operator_socket_path else None
        previous_term = signal.getsignal(signal.SIGTERM)
        signal.signal(signal.SIGTERM, lambda _signum, _frame: sys.exit(0))
        try:
            listener.bind(str(self.socket_path))
            os.chown(self.socket_path, -1, self.app_gid)
            os.chmod(self.socket_path, 0o660)
            listener.listen(4)
            listener.settimeout(0.5)
            if operator_listener:
                operator_listener.bind(str(self.operator_socket_path))
                os.chmod(self.operator_socket_path, 0o600)
                operator_listener.listen(1)
            if not self.recovery_held():
                self.start_child()
            while True:
                if self.child is not None and self.child_exited():
                    raise RuntimeError("managed app exited unexpectedly")
                ready, _, _ = select.select(
                    [listener] + ([operator_listener] if operator_listener else []), [], [], 0.5)
                if not ready:
                    continue
                source = ready[0]
                connection, _ = source.accept()
                with connection:
                    connection.settimeout(5)
                    try:
                        if source is operator_listener:
                            if not self.peer_is_operator(connection):
                                raise ValueError("unauthorized operator peer")
                            message = read_message(connection)
                            send_message(connection, self.recover_noeffect(message))
                            continue
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
                        elif message.get("action") == "fault":
                            send_message(connection, self.fault(message))
                        elif message.get("action") == "readiness":
                            send_message(connection, self.readiness(message))
                        else:
                            raise ValueError("unknown control action")
                    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
                        try:
                            send_message(connection, {"error": str(error)})
                        except OSError:
                            pass
        finally:
            signal.signal(signal.SIGTERM, previous_term)
            listener.close()
            self.socket_path.unlink(missing_ok=True)
            if operator_listener:
                operator_listener.close()
                self.operator_socket_path.unlink(missing_ok=True)
            if self.child:
                self.stop_child()

    def restart_authorized(self, request):
        self.assert_exclusive_app_uid()
        self.used_runs.add(request["runId"])
        self.claimed = None
        self.fault_armed = None
        old_identity = self.stop_child()
        # Embedded PGlite permits only one owner. Inspect its durable state
        # after the old app exits, before any new app can open the database.
        try:
            self.authorize(request)
            snapshot_result = subprocess.run(self.receipt_authority_command,
                input=canonical({"phase": "snapshot", "request": request}) + b"\n",
                capture_output=True,
                timeout=bounded_timeout(request["deadlineMs"], SNAPSHOT_TIMEOUT_SECONDS),
                check=False,
                preexec_fn=self.drop_app_privileges)
            if snapshot_result.returncode != 0:
                raise ValueError("independent durable receipt snapshot failed")
            snapshot_reply = json.loads(snapshot_result.stdout)
            if set(snapshot_reply) != {"snapshot"} or not isinstance(snapshot_reply["snapshot"], dict):
                raise ValueError("independent durable receipt snapshot invalid")
            bounded_timeout(request["deadlineMs"], SNAPSHOT_TIMEOUT_SECONDS)
        except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError):
            self.start_child()
            return
        self.pending = {"request": request, "oldProcess": old_identity,
                        "snapshot": snapshot_reply["snapshot"]}
        self.start_child()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--recover-request")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    required = {"socket", "appCommand", "appUid", "appGid", "key", "authorityCommand",
                "receiptAuthorityCommand"}
    optional = {"operatorSocket", "recoveryCommand", "recoveryFenceCommand",
                "faultAuthorityCommand"}
    if not required <= set(config) or set(config) - required - optional \
            or bool(config.get("operatorSocket")) != bool(config.get("recoveryCommand")) \
            or not all(type(config[name]) is int and config[name] > 0
                                           for name in ("appUid", "appGid")) \
            or not all(isinstance(config[name], str) and config[name].startswith("/")
                       for name in ("socket", "key")) \
            or not all(isinstance(config[name], list) and config[name]
                       and all(isinstance(value, str) and value for value in config[name])
                       for name in ("appCommand", "authorityCommand", "receiptAuthorityCommand")):
        raise ValueError("invalid supervisor configuration")
    if "operatorSocket" in config and (not isinstance(config["operatorSocket"], str)
            or not config["operatorSocket"].startswith("/")):
        raise ValueError("invalid operator recovery socket")
    if "recoveryCommand" in config and (not isinstance(config["recoveryCommand"], list)
            or not config["recoveryCommand"]
            or not all(isinstance(value, str) and value for value in config["recoveryCommand"])):
        raise ValueError("invalid operator recovery verifier")
    if "recoveryFenceCommand" in config and (not isinstance(config["recoveryFenceCommand"], list)
            or not config["recoveryFenceCommand"]
            or not all(isinstance(value, str) and value for value in config["recoveryFenceCommand"])):
        raise ValueError("invalid independent runner fence verifier")
    if "faultAuthorityCommand" in config and (not isinstance(config["faultAuthorityCommand"], list)
            or not config["faultAuthorityCommand"]
            or not all(isinstance(value, str) and value for value in config["faultAuthorityCommand"])):
        raise ValueError("invalid operator fault verifier")
    if args.recover_request:
        if os.geteuid() != 0 or not config.get("operatorSocket"):
            raise ValueError("operator recovery requires root and a private socket")
        path = Path(args.recover_request)
        file = path.lstat()
        if not stat.S_ISREG(file.st_mode) or file.st_uid != 0 or file.st_mode & 0o077:
            raise ValueError("operator recovery request must be a private root-owned file")
        request = json.loads(path.read_text())
        validate_recovery(request)
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(180)
            connection.connect(config["operatorSocket"])
            send_message(connection, request)
            response = read_message(connection)
        print(json.dumps(response, sort_keys=True))
        if "error" in response:
            raise SystemExit(1)
        return
    supervisor = Supervisor(config["socket"], config["appCommand"], config["appUid"], config["appGid"],
                            config["key"], config["authorityCommand"], config["receiptAuthorityCommand"])
    if config.get("operatorSocket"):
        supervisor.operator_socket_path = Path(config["operatorSocket"])
        supervisor.recovery_command = config["recoveryCommand"]
        supervisor.recovery_fence_command = config.get("recoveryFenceCommand")
    supervisor.fault_authority_command = config.get("faultAuthorityCommand")
    supervisor.serve()


if __name__ == "__main__":
    main()
