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
NATIVE_CLEANUP_PIN_KEYS = {"installationGeneration", "releaseDigest", "grantsDigest", "endpoint", "project", "providerOperationId", "nativeOperationId", "operationTag", "payloadHash", "presetDigest", "effectiveSettingsDigest", "imageFingerprint", "helperVersion", "serverCertificateSha256"}
STABLE_CLEANUP_PIN_KEYS = (NATIVE_CLEANUP_PIN_KEYS - {"nativeOperationId"}) | {"operationHandleKind", "expectedProviderGeneration"}


RETAINED_CLEANUP_PIN_KEYS = STABLE_CLEANUP_PIN_KEYS | {"originOperationId", "originReceiptSha256"}


def cleanup_pin_keys(version):
    return RETAINED_CLEANUP_PIN_KEYS if version == 3 else STABLE_CLEANUP_PIN_KEYS if version == 2 else NATIVE_CLEANUP_PIN_KEYS


def validate_stable_cleanup_config(config):
    pins, target = config.get("pins"), config.get("target")
    retained = config.get("version") == 3
    if not isinstance(pins, dict) or set(pins) != cleanup_pin_keys(config.get("version")) \
            or pins.get("operationHandleKind") != ("retained-destroy-noeffect" if retained else "stable-start-intent") \
            or type(pins.get("expectedProviderGeneration")) is not int \
            or not 1 < pins["expectedProviderGeneration"] <= 9007199254740991 \
            or not isinstance(target, dict) or not isinstance(target.get("scope"), dict):
        raise ValueError("stable cleanup pins invalid")
    scope = target["scope"]
    values = [scope.get("connectionId"), target.get("bindingId"), target.get("operationId")]
    if any(not isinstance(value, str) or not IDENTIFIER.fullmatch(value) for value in values):
        raise ValueError("stable cleanup target invalid")
    connection, binding, operation = values
    if retained:
        origin = pins.get("originOperationId")
        if not isinstance(origin, str) or not IDENTIFIER.fullmatch(origin) or origin == operation \
                or not isinstance(pins.get("originReceiptSha256"), str) or not DIGEST.fullmatch(pins["originReceiptSha256"]) \
                or pins.get("providerOperationId") is not None:
            raise ValueError("retained DELETE origin invalid")
        operation = origin
    resource = hashlib.sha256((connection + "\0" + binding).encode()).hexdigest()[:32]
    intent = hashlib.sha256((connection + "\0" + binding + "\0" + operation + "\0" + operation + "\0setPower").encode()).hexdigest()[:32]
    tag = "ezh-setPower-" + resource + "-" + intent
    if (not retained and pins.get("providerOperationId") != tag) or pins.get("operationTag") != tag:
        raise ValueError("stable cleanup original intent changed")


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


def process_credentials(pid):
    before = identity(pid)
    status = Path(f"/proc/{pid}/status").read_text()
    rows = [row.split()[1:] for row in status.splitlines() if row.startswith("Uid:")]
    if len(rows) != 1 or len(rows[0]) != 4 or not all(value.isdigit() for value in rows[0]) \
            or identity(pid) != before:
        raise ValueError("process credentials unavailable or changed")
    return tuple(int(value) for value in rows[0])


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


def validate_recovery(message, *, historical=False):
    if not isinstance(message, dict) or set(message) != RECOVERY_KEYS \
            or message["version"] != 1 or message["action"] not in ("recover-noeffect", "recover-fenced-cleanup") \
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
    if not historical and not now + 145000 < message["deadlineMs"] <= now + 180000:
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
        self.terminal_claim = None
        self.fault_armed = None
        self.fault_authority_command = None
        self.used_runs = set()
        self.used_recoveries = set()
        self.operator_socket_path = None
        self.recovery_command = None
        self.recovery_abort_command = None
        self.recovery_request_path = None
        self.abort_stopped_guard = None
        self.abort_offline = False
        self.restore_offline = False
        self.recovery_restore_command = None
        self.recovery_restore_journal_path = None
        self.recovery_restore_config_path = None
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
                yield int(entry.name), process_credentials(int(entry.name))[1], os.getpgid(int(entry.name))
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
        managed_group = self.child.pid if self.child is not None else None
        if any(uid == self.app_uid and group != managed_group
               for _pid, uid, group in self.live_processes()):
            raise ValueError("app UID is shared outside the managed process group")

    def recovery_diagnostic(self, phase, outcome, exit_code, stdout, stderr):
        # These bytes may contain credentials. They stay in a bounded private
        # operator file, never the RPC response, app log or public journal.
        def clipped(value):
            data = value.encode("utf8") if isinstance(value, str) else value or b""
            return data[:4096].decode("utf8", errors="replace"), len(data) > 4096
        out, out_truncated = clipped(stdout)
        err, err_truncated = clipped(stderr)
        record = canonical({"stage": phase, "outcome": outcome, "exitCode": exit_code,
            "stdout": out, "stderr": err, "stdoutTruncated": out_truncated,
            "stderrTruncated": err_truncated}) + b"\n"
        path = self.key_path.with_name(self.key_path.name + ".recovery-stage-diagnostics.jsonl")
        try:
            if not path.is_absolute() or path.parent.resolve(strict=True) != path.parent:
                raise ValueError("private diagnostic path changed")
            parent = path.parent.lstat()
            if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
                raise ValueError("private diagnostic parent changed")
            parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                opened = os.fstat(parent_fd)
                if (opened.st_dev, opened.st_ino) != (parent.st_dev, parent.st_ino):
                    raise ValueError("private diagnostic parent changed")
                fd = os.open(path.name, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
            finally:
                os.close(parent_fd)
            try:
                status = os.fstat(fd)
                if not stat.S_ISREG(status.st_mode) or status.st_uid != os.geteuid() \
                        or stat.S_IMODE(status.st_mode) != 0o600 or status.st_nlink != 1 \
                        or status.st_size + len(record) > 65536:
                    raise ValueError("private diagnostic metadata or bound changed")
                remaining = memoryview(record)
                while remaining:
                    written = os.write(fd, remaining)
                    if written <= 0:
                        raise OSError("private diagnostic write failed")
                    remaining = remaining[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
        except (OSError, ValueError):
            # Do not replace the actual recovery error, or expose captured data.
            sys.stderr.write("Private recovery stage diagnostic unavailable\n")

    def recovery_stage(self, phase, value, deadline_ms):
        if phase not in ("durable", "backend", "apply", "restore", "abort", "inspect-abort",
                         "inspect-admitted-restoration", "restore-admitted", "inspect-noeffect"):
            raise ValueError("invalid operator recovery stage")
        command = self.recovery_abort_command if phase in ("abort", "inspect-abort") else self.recovery_command
        if phase in ("inspect-admitted-restoration", "restore-admitted"):
            command = self.recovery_restore_command
        if not command:
            raise ValueError("operator recovery command unavailable")
        try:
            check = subprocess.run(command,
                input=canonical({"phase": phase, **value}) + b"\n", capture_output=True,
                timeout=bounded_timeout(deadline_ms, VERIFY_TIMEOUT_SECONDS), check=False,
                preexec_fn=self.drop_app_privileges if phase in ("durable", "apply", "abort", "inspect-abort", "inspect-noeffect") else None)
        except OSError:
            self.recovery_diagnostic(phase, "spawn_failed", None, b"", b"")
            raise ValueError("independent operator recovery verifier failed") from None
        except subprocess.TimeoutExpired as error:
            self.recovery_diagnostic(phase, "timeout", None, error.stdout, error.stderr)
            raise ValueError("independent operator recovery verifier failed") from None
        except subprocess.SubprocessError:
            self.recovery_diagnostic(phase, "spawn_failed", None, b"", b"")
            raise ValueError("independent operator recovery verifier failed") from None
        if check.returncode != 0:
            self.recovery_diagnostic(phase, "nonzero", check.returncode, check.stdout, check.stderr)
            raise ValueError("independent operator recovery verifier failed")
        try:
            result = json.loads(check.stdout)
        except (ValueError, UnicodeError):
            self.recovery_diagnostic(phase, "invalid_json", check.returncode, check.stdout, check.stderr)
            raise ValueError("independent operator recovery verifier failed") from None

        self.recovery_diagnostic(phase, "returned", check.returncode, check.stdout, check.stderr)
        return result

    def private_recovery_bytes(self, path, maximum=16384, links=1):
        path = Path(path)
        if not path.is_absolute() or path.parent.resolve(strict=True) != path.parent:
            raise ValueError("private recovery path changed")
        parent = path.parent.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
            raise ValueError("private recovery directory changed")
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(directory)
            if (opened.st_dev, opened.st_ino) != (parent.st_dev, parent.st_ino):
                raise ValueError("private recovery directory changed")
            descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
            try:
                info = os.fstat(descriptor)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600 \
                        or not 1 <= info.st_nlink <= links or not 0 < info.st_size <= maximum:
                    raise ValueError("private recovery file changed")
                data = os.read(descriptor, maximum + 1)
                if len(data) != info.st_size:
                    raise ValueError("private recovery file changed")
                return data
            finally:
                os.close(descriptor)
        finally:
            os.close(directory)

    def persist_abort_file(self, path, value, exclusive=False):
        data = canonical(value) + b"\n"
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            if exclusive:
                raise ValueError("operator restoration record already exists") from None
            if self.private_recovery_bytes(path) != data:
                raise ValueError("operator abort record changed")
            return
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        self.sync_hold_directory()

    def assert_abort_actors_stopped(self, units, runner_uid):
        if type(runner_uid) is not int or runner_uid <= 0 or runner_uid == self.app_uid \
                or not isinstance(units, list) or len(units) != 3 \
                or not all(isinstance(unit, str) and re.fullmatch(r"[A-Za-z0-9_.@:-]+\.service", unit) for unit in units) \
                or len(set(units)) != 3 or units[2] != f"user@{runner_uid}.service":
            raise ValueError("operator abort stopped-actor configuration invalid")
        check = subprocess.run(["systemctl", "show", *units, "--no-pager",
            "--property=Id,ActiveState,SubState,MainPID"], capture_output=True, timeout=5, check=False)
        if check.returncode != 0 or check.stderr:
            raise ValueError("operator abort stopped-unit proof unavailable")
        blocks = check.stdout.decode("ascii").strip().split("\n\n")
        observed = {}
        for block in blocks:
            rows = [line.split("=", 1) for line in block.splitlines()]
            if any(len(row) != 2 for row in rows) or len(rows) != 4:
                raise ValueError("operator abort stopped-unit proof invalid")
            item = dict(rows)
            if set(item) != {"Id", "ActiveState", "SubState", "MainPID"} or item["Id"] in observed:
                raise ValueError("operator abort stopped-unit proof invalid")
            observed[item["Id"]] = item
        expected = {name: {"Id": name, "ActiveState": "inactive", "SubState": "dead", "MainPID": "0"} for name in units}
        if observed != expected:
            raise ValueError("operator abort requires stopped units")
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                state = (entry / "stat").read_text()
                if state[state.rfind(")") + 2] == "Z":
                    continue
                if {self.app_uid, runner_uid}.intersection(process_credentials(int(entry.name))):
                    raise ValueError("operator abort has live app or runner actor")
            except (FileNotFoundError, ProcessLookupError):
                continue

    def trusted_recovery_original(self, message):
        original = message["originalRequest"]
        validate_recovery(original, historical=True)
        saved = self.private_recovery_bytes(self.recovery_request_path)
        if original["action"] != "recover-fenced-cleanup" or json.loads(saved) != original \
                or hashlib.sha256(saved).hexdigest() != message["requestFileSha256"] \
                or hashlib.sha256(canonical(original)).hexdigest() != message["requestSha256"]:
            raise ValueError("operator original recovery request changed")
        return original

    def restoration_context(self, message):
        if not self.restore_offline or not self.abort_stopped_guard:
            raise ValueError("admitted restoration requires offline stopped actors")
        self.abort_stopped_guard()
        keys = {"version", "action", "originalRequest", "requestFileSha256", "requestSha256",
                "holdSha256", "cleanupOperationId", "journalSha256", "configSha256",
                "originalReceiptSha256", "currentSourceCommit", "currentManifestSha256"}
        if not isinstance(message, dict) or set(message) != keys or type(message["version"]) is not int or message["version"] != 1 \
                or message["action"] != "restore-already-admitted-cleanup" \
                or not self.recovery_restore_command or not self.recovery_request_path \
                or not self.recovery_restore_config_path or not self.recovery_restore_journal_path:
            raise ValueError("admitted restoration configuration or request invalid")
        if not isinstance(message["currentSourceCommit"], str) or not re.fullmatch(r"[0-9a-f]{40}", message["currentSourceCommit"]) or any(
                not isinstance(message[k], str) or not re.fullmatch(r"[0-9a-f]{64}", message[k])
                for k in ("originalReceiptSha256", "currentManifestSha256")):
            raise ValueError("admitted restoration source or receipt pin invalid")
        original = self.trusted_recovery_original(message)
        hold = self.private_recovery_bytes(self.recovery_hold_path)
        if hold != canonical({"nonce": original["nonce"], "reviewId": original["reviewId"]}) + b"\n" \
                or hashlib.sha256(hold).hexdigest() != message["holdSha256"]:
            raise ValueError("admitted restoration hold changed")
        config_raw = self.private_recovery_bytes(self.recovery_restore_config_path, maximum=128*1024)
        journal_raw = self.private_recovery_bytes(self.recovery_restore_journal_path, maximum=128*1024)
        if hashlib.sha256(config_raw).hexdigest() != message["configSha256"] \
                or hashlib.sha256(journal_raw).hexdigest() != message["journalSha256"]:
            raise ValueError("admitted restoration history changed")
        request = self.restoration_history(message, original, config_raw, journal_raw)
        return original, hold, request

    def restoration_history(self, message, original, config_raw, journal_raw):
        config, journal = json.loads(config_raw), json.loads(journal_raw)
        request = journal.get("request")
        if set(journal) != {"configSha256", "request"} or journal["configSha256"] != message["configSha256"] \
                or not isinstance(request, dict) or set(request) != {"cleanupOperationId", "target", "clientCertificateSha256"} \
                or request["cleanupOperationId"] != message["cleanupOperationId"] \
                or not isinstance(request["cleanupOperationId"], str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", request["cleanupOperationId"]) \
                or request["target"] != config.get("target") \
                or request["clientCertificateSha256"] != config.get("clientCertificateSha256") \
                or config.get("holdSha256") != message["holdSha256"]:
            raise ValueError("admitted restoration journal linkage changed")
        target = request["target"]
        expected = {k: original[k] for k in ("scope", "fixtureOperationId", "bindingId", "operationId", "generation", "connectionRevision")}
        if not isinstance(target, dict) or set(target) != {*expected, "action", "pins"} \
                or any(target[k] != v for k, v in expected.items()) or target["action"] != original["action"]:
            raise ValueError("admitted restoration target changed")
        return request

    def restoration_stage(self, phase, value, deadline_ms):
        if phase not in ("inspect-admitted-restoration", "restore-admitted", "inspect-noeffect"):
            raise ValueError("invalid admitted restoration stage")
        return self.recovery_stage(phase, value, deadline_ms)

    def restore_admitted(self, message):
        original, hold, request = self.restoration_context(message)
        receipt_path = self.recovery_hold_path.with_name(self.recovery_hold_path.name + ".restoration-receipt")
        proof_path = self.recovery_hold_path.with_name(self.recovery_hold_path.name + ".restoration-proof")
        if os.path.lexists(receipt_path) or os.path.lexists(proof_path):
            raise ValueError("admitted restoration already attempted; inspect saved stage")
        inspection_deadline = int(time.time()*1000) + 30000
        # The fixed trusted consumer checks current release/admission linkage and
        # exact current certificate without creating another recovery or journal.
        inspect = self.restoration_stage("inspect-admitted-restoration", {"request": request,
            "history": message}, inspection_deadline)
        authority = {k: message[k] for k in ("originalReceiptSha256", "currentSourceCommit", "currentManifestSha256")}
        if inspect != {"admitted": True, **request, **authority}:
            raise ValueError("admitted restoration current linkage unverified")
        self.abort_stopped_guard()
        if self.private_recovery_bytes(self.recovery_hold_path) != hold:
            raise ValueError("admitted restoration hold changed before signing")
        now = int(time.time()*1000)
        deadline = now + 30000
        bounded_timeout(deadline, SIGN_TIMEOUT_SECONDS)
        payload = {**message, "restoration": request, "issuedAtMs": now, "expiresAtMs": deadline}
        receipt = self.sign_payload(payload)
        self.persist_abort_file(receipt_path, receipt, exclusive=True)
        bounded_timeout(deadline, VERIFY_TIMEOUT_SECONDS)
        ready = self.restoration_stage("restore-admitted", {"receipt": receipt}, deadline)
        if ready != {"transportReady": True, **request}:
            raise ValueError("admitted restoration transport unverified")
        bounded_timeout(deadline, SIGN_TIMEOUT_SECONDS)
        if self.private_recovery_bytes(self.recovery_hold_path) != hold:
            raise ValueError("admitted restoration hold changed before archive")
        receipt_hash = hashlib.sha256(canonical(receipt)).hexdigest()
        proof = {"cleanupOperationId": request["cleanupOperationId"], "restorationReceiptSha256": receipt_hash,
                 "transportReady": True}
        self.persist_abort_file(proof_path, proof, exclusive=True)
        archive = self.recovery_hold_path.with_name(self.recovery_hold_path.name + ".restored." + receipt_hash)
        bounded_timeout(deadline, SIGN_TIMEOUT_SECONDS)
        os.link(self.recovery_hold_path, archive, follow_symlinks=False)
        self.sync_hold_directory()
        bounded_timeout(deadline, SIGN_TIMEOUT_SECONDS)
        self.recovery_hold_path.unlink()
        self.sync_hold_directory()
        proof = {**proof, "holdArchived": True}
        self.persist_abort_file(proof_path.with_name(proof_path.name + ".complete"), proof, exclusive=True)
        # Explicit normal service startup remains an operator decision. This
        # offline command does not launch the app or reconciliation; its fixed
        # trusted restoration consumer can start only the verified runner.
        return proof

    def abort_context(self, message):
        if not self.abort_offline:
            raise ValueError("operator abort requires offline control")
        if self.abort_stopped_guard:
            self.abort_stopped_guard()
        else:
            raise ValueError("operator abort stopped-actor guard required")
        # Only the offline root command can reach this action. The stopped
        # app UID owns the database transaction; no guest/provider assertion can
        # clear the hold, and this method never starts the app.
        keys = {"version", "action", "originalRequest", "requestFileSha256", "requestSha256", "holdSha256"}
        if not isinstance(message, dict) or set(message) not in (keys, keys | {"reauthorizeAbort"}) or message.get("reauthorizeAbort", True) is not True or message["version"] != 1 \
                or message["action"] != "abort-fenced-cleanup-before-admission" \
                or not self.recovery_abort_command or not self.recovery_request_path:
            raise ValueError("operator abort unavailable or invalid")
        original = self.trusted_recovery_original(message)
        hold_bytes = canonical({"nonce": original["nonce"], "reviewId": original["reviewId"]}) + b"\n"
        if hashlib.sha256(hold_bytes).hexdigest() != message["holdSha256"]:
            raise ValueError("operator abort hold hash changed")
        suffix = message["requestSha256"]
        archive = self.recovery_hold_path.with_name(self.recovery_hold_path.name + ".aborted." + suffix)
        receipt_path = self.recovery_hold_path.with_name(self.recovery_hold_path.name + ".abort-receipt." + suffix)
        proof_path = self.recovery_hold_path.with_name(self.recovery_hold_path.name + ".abort-proof." + suffix)
        try:
            actual_hold = self.private_recovery_bytes(self.recovery_hold_path, links=2)
        except FileNotFoundError:
            actual_hold = self.private_recovery_bytes(archive)
        if actual_hold != hold_bytes:
            raise ValueError("operator abort held request changed")
        if self.recovery_hold_path.exists() and self.recovery_hold_path.stat().st_nlink != 1:
            if not archive.exists() or self.recovery_hold_path.stat().st_nlink != 2 \
                    or (self.recovery_hold_path.stat().st_dev, self.recovery_hold_path.stat().st_ino) != (archive.stat().st_dev, archive.stat().st_ino):
                raise ValueError("operator abort hold link changed")
        if self.child is not None and not self.child_exited():
            raise ValueError("operator abort requires stopped app")
        self.assert_exclusive_app_uid()
        sealed = self.preflight_recovery_config("recover-fenced-cleanup")
        target = {key: original[key] for key in ("scope", "fixtureOperationId", "bindingId", "operationId", "generation", "connectionRevision")}
        if sealed.get("target") != target or not isinstance(sealed.get("pins"), dict):
            raise ValueError("operator abort sealed target changed")
        return original, sealed, hold_bytes, archive, receipt_path, proof_path

    def validate_abort_receipt(self, stored, message, original, sealed):
        if not isinstance(stored, dict) or set(stored) != {"payload", "signature"} or not isinstance(stored["signature"], str) or not re.fullmatch(r"[A-Za-z0-9+/]{86}==", stored["signature"]):
            raise ValueError("operator abort receipt changed")
        payload = stored["payload"]
        expected = {"version": sealed["version"], "action": message["action"], "originalRequest": original,
            "pins": sealed["pins"], "requestSha256": message["requestSha256"], "holdSha256": message["holdSha256"]}
        if not isinstance(payload, dict) or set(payload) != set(expected) | {"issuedAtMs", "expiresAtMs"} \
                or any(payload[key] != value for key, value in expected.items()) \
                or type(payload["issuedAtMs"]) is not int or type(payload["expiresAtMs"]) is not int \
                or payload["expiresAtMs"] - payload["issuedAtMs"] != 30000:
            raise ValueError("operator abort receipt changed")

    def abort_receipt(self, message, original, sealed, receipt_path):
        base_path = receipt_path
        history = []
        try:
            journal = json.loads(self.private_recovery_bytes(receipt_path))
            if not isinstance(journal, dict) or set(journal) != {"requestFileSha256", "receipt"} or journal["requestFileSha256"] != message["requestFileSha256"]:
                raise ValueError("operator abort source file changed")
            stored = journal["receipt"]
            self.validate_abort_receipt(stored, message, original, sealed)
            history.append(stored)
            for _ in range(8):
                following = base_path.with_name(base_path.name + ".reauthorized." + hashlib.sha256(canonical(stored)).hexdigest())
                try:
                    child = json.loads(self.private_recovery_bytes(following))
                except FileNotFoundError:
                    break
                if not isinstance(child, dict) or set(child) != {"requestFileSha256", "receipt"} or child["requestFileSha256"] != message["requestFileSha256"]:
                    raise ValueError("operator abort authorization archive changed")
                receipt_path, stored = following, child["receipt"]
                self.validate_abort_receipt(stored, message, original, sealed)
                history.append(stored)
            else:
                raise ValueError("operator abort authorization archive limit reached")
        except FileNotFoundError:
            now = int(time.time()*1000)
            payload = {"version": sealed["version"], "action": message["action"], "originalRequest": original,
                "pins": sealed["pins"], "requestSha256": message["requestSha256"],
                "holdSha256": message["holdSha256"], "issuedAtMs": now, "expiresAtMs": now+30000}
            stored = self.sign_payload(payload)
            self.persist_abort_file(receipt_path, {"requestFileSha256": message["requestFileSha256"], "receipt": stored})
            phase = "abort"
        else:
            phase = "inspect-abort"
        self.validate_abort_receipt(stored, message, original, sealed)
        return stored, phase, base_path, history

    def archive_abort_hold(self, original, hold_bytes, archive, proof_path, proof):
        if self.abort_stopped_guard:
            self.abort_stopped_guard()
        self.persist_abort_file(proof_path, proof)
        try:
            os.link(self.recovery_hold_path, archive, follow_symlinks=False)
        except FileExistsError:
            if self.private_recovery_bytes(archive, links=2) != hold_bytes:
                raise ValueError("operator abort archive changed")
        except FileNotFoundError:
            if self.private_recovery_bytes(archive) != hold_bytes:
                raise ValueError("operator abort archive unavailable")
        self.sync_hold_directory()
        if self.recovery_hold_path.exists():
            if self.private_recovery_bytes(self.recovery_hold_path, links=2) != hold_bytes \
                    or self.recovery_hold_path.stat().st_ino != archive.stat().st_ino:
                raise ValueError("operator abort archive identity changed")
            self.recovery_hold_path.unlink()
            self.sync_hold_directory()
        self.used_recoveries.add(original["nonce"])
        return proof

    def validate_abort_proof(self, proof, stored, original, message, *, uncommitted=False):
        state_keys = {"status"} if uncommitted else {"abortId"}
        common_keys = {"nonce", "requestSha256", "holdSha256", "receiptSha256"}
        if not isinstance(proof, dict) or set(proof) != common_keys | state_keys \
                or proof["nonce"] != original["nonce"] or proof["requestSha256"] != message["requestSha256"] \
                or proof["holdSha256"] != message["holdSha256"] \
                or proof["receiptSha256"] != hashlib.sha256(canonical(stored)).hexdigest():
            raise ValueError("operator abort committed proof invalid")
        if uncommitted:
            if proof["status"] != "uncommitted":
                raise ValueError("operator abort absence proof invalid")
        elif not isinstance(proof["abortId"], str) or not UUID.fullmatch(proof["abortId"]):
            raise ValueError("operator abort committed proof invalid")

    def renew_abort_receipt(self, message, stored, receipt_path):
        # An explicit root request plus a DB-authoritative uncommitted proof is
        # required. Keep every previous signature immutable; a child file binds
        # its parent receipt hash. A retry follows the same persisted child.
        if message.get("reauthorizeAbort") is not True:
            raise ValueError("expired uncommitted abort requires explicit reauthorization")
        now = int(time.time()*1000)
        payload = {**stored["payload"], "issuedAtMs": now, "expiresAtMs": now+30000}
        following = receipt_path.with_name(receipt_path.name + ".reauthorized." + hashlib.sha256(canonical(stored)).hexdigest())
        renewed = self.sign_payload(payload)
        self.persist_abort_file(following, {"requestFileSha256": message["requestFileSha256"], "receipt": renewed})
        return renewed

    def inspect_abort_winner(self, phase, arguments, history, original, message, deadline_ms):
        try:
            return self.recovery_stage(phase, arguments, deadline_ms), arguments["receipt"], phase
        except ValueError as failure:
            # Another exact old signature can win the shared DB nonce lock
            # during explicit renewal. Only its independently inspected exact
            # committed proof can close the hold; an error is never absence.
            for previous in reversed(history):
                if previous == arguments["receipt"]:
                    continue
                try:
                    proof = self.recovery_stage("inspect-abort", {**arguments, "receipt": previous}, deadline_ms)
                except ValueError:
                    continue
                if isinstance(proof, dict) and "abortId" in proof:
                    self.validate_abort_proof(proof, previous, original, message)
                    return proof, previous, "inspect-abort"
            raise failure

    def abort_recovery(self, message):
        deadline_ms = int(time.time()*1000)+90000
        original, sealed, hold_bytes, archive, receipt_path, proof_path = self.abort_context(message)
        stored, phase, receipt_path, history = self.abort_receipt(message, original, sealed, receipt_path)
        public = subprocess.run(["openssl", "pkey", "-in", str(self.key_path), "-pubout"],
            capture_output=True, timeout=SIGN_TIMEOUT_SECONDS, check=True)
        arguments = {"receipt": stored, "publicKeyPem": public.stdout.decode("ascii")}
        proof, stored, phase = self.inspect_abort_winner(phase, arguments, history, original, message, deadline_ms)
        if phase == "inspect-abort" and isinstance(proof, dict) and proof.get("status") == "uncommitted":
            self.validate_abort_proof(proof, stored, original, message, uncommitted=True)
            now = int(time.time()*1000)
            if not stored["payload"]["issuedAtMs"] <= now < stored["payload"]["expiresAtMs"]:
                stored = self.renew_abort_receipt(message, stored, receipt_path)
                arguments = {**arguments, "receipt": stored}
            phase = "abort"
            proof, stored, phase = self.inspect_abort_winner(phase, arguments, history, original, message, deadline_ms)
        self.validate_abort_proof(proof, stored, original, message)
        # Re-read the database's exact signed record before consuming any hold.
        if phase == "abort" and self.recovery_stage("inspect-abort", arguments, deadline_ms) != proof:
            raise ValueError("operator abort committed proof changed")
        return self.archive_abort_hold(original, hold_bytes, archive, proof_path, proof)

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

    def preflight_recovery_config(self, action="recover-noeffect"):
        variable = "EZCORP_INCUS_FENCED_CLEANUP_CONFIG" if action == "recover-fenced-cleanup" else "EZCORP_INCUS_NOEFFECT_CONFIG"
        path = os.environ.get(variable)
        if not path or not Path(path).is_absolute():
            raise ValueError("operator recovery config requires an absolute path")
        try:
            file = Path(path).lstat()
        except OSError as error:
            raise ValueError("operator recovery config is unavailable") from error
        if not stat.S_ISREG(file.st_mode) or file.st_uid != os.geteuid() \
                or file.st_mode & 0o077 or not 0 < file.st_size <= 128 * 1024:
            raise ValueError("operator recovery config must be a private operator-owned regular file")
        if action == "recover-fenced-cleanup":
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or not 0 < info.st_size <= 128 * 1024:
                    raise ValueError("sealed cleanup config changed")
                config = json.loads(os.read(fd, 128 * 1024 + 1))
            finally:
                os.close(fd)
            if not isinstance(config, dict) or config.get("version") not in (1, 2, 3) or config.get("action") != action:
                raise ValueError("sealed cleanup config action invalid")
            if config["version"] in (2, 3):
                validate_stable_cleanup_config(config)
            elif isinstance(config.get("pins"), dict) and ("operationHandleKind" in config["pins"] or "expectedProviderGeneration" in config["pins"]):
                raise ValueError("native cleanup pin version changed")
            return config


    def recover_noeffect(self, request):
        validate_recovery(request)
        if not self.recovery_command or not self.recovery_fence_command \
                or request["nonce"] in self.used_recoveries or self.recovery_held() \
                or self.child is None:
            raise ValueError("operator recovery unavailable, replayed, or held for operator review")
        self.assert_exclusive_app_uid()
        fenced_cleanup = request["action"] == "recover-fenced-cleanup"
        if fenced_cleanup:
            sealed = self.preflight_recovery_config(request["action"])
            target = {key: request[key] for key in ("scope", "fixtureOperationId", "bindingId", "operationId", "generation", "connectionRevision")}
            if sealed.get("target") != target or not isinstance(sealed.get("pins"), dict):
                raise ValueError("sealed cleanup target changed")
            transport_certificate = sealed.get("observation", {}).get("oldCertificateSha256") if isinstance(sealed.get("observation"), dict) else None
            if not isinstance(transport_certificate, str) or not re.fullmatch(r"[a-f0-9]{64}", transport_certificate):
                raise ValueError("sealed cleanup transport certificate invalid")
        else:
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
        if fenced_cleanup:
            target["action"] = request["action"]
            target["pins"] = sealed["pins"]
        durable = self.recovery_stage("durable", {"target": target}, request["deadlineMs"])
        if not isinstance(durable, dict) or durable.get("verified") is not True or (
                (set(durable) != {"verified", "pins"} or durable.get("pins") != sealed["pins"]) if fenced_cleanup else durable != {"verified": True}):
            raise ValueError("operator durable recovery verification failed")
        first = self.recovery_stage("backend", {"target": target}, request["deadlineMs"])
        first_at = int(time.time() * 1000)
        time.sleep(5)
        if self.recovery_stage("durable", {"target": target}, request["deadlineMs"]) != durable:
            raise ValueError("operator durable recovery changed")
        second = self.recovery_stage("backend", {"target": target}, request["deadlineMs"])
        second_at = int(time.time() * 1000)
        if fenced_cleanup:
            stable = sealed["version"] in (2, 3)
            observation_keys = ({"instanceState", "noActiveOperations", "providerGeneration", "pins"} if stable
                else {"instanceState", "nativeOperationAbsent", "activeOperations", "providerGeneration", "pins"})
            def valid_observation(o):
                if not isinstance(o, dict) or set(o) != observation_keys or o["instanceState"] != "stopped" \
                        or type(o["providerGeneration"]) is not int or o["providerGeneration"] <= 0 or o["pins"] != durable["pins"]:
                    return False
                return (o["noActiveOperations"] is True and o["providerGeneration"] == sealed["pins"]["expectedProviderGeneration"] if stable
                    else o["nativeOperationAbsent"] is True and o["activeOperations"] == [])
            if not all(valid_observation(o) for o in (first, second)) or first != second:
                raise ValueError("operator backend owned stopped state not independently verified")
        elif first != {"absent": True, "activeOperations": []} \
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
        if fenced_cleanup:
            pins = durable["pins"]
            if not isinstance(pins, dict) or set(pins) != cleanup_pin_keys(sealed["version"]):
                raise ValueError("operator durable recovery pins invalid")
            payload["version"] = sealed["version"]
            payload.update(pins)
            payload["action"] = request["action"]
            for label, observation, observed_at in (("first", first, first_at), ("second", second, second_at)):
                payload[label] = {key: value for key, value in observation.items() if key != "pins"}
                payload[label]["observedAtMs"] = observed_at
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
        if fenced_cleanup:
            # Admission ran as the app UID. Restore only the sealed current
            # transport in the trusted root phase, before startup reconciliation
            # can dispatch the linked cleanup. Errors retain the durable hold.
            restore = {"cleanupOperationId": result["cleanupOperationId"],
                       "target": target,
                       "clientCertificateSha256": transport_certificate}
            ready = self.recovery_stage("restore", restore, request["deadlineMs"])
            if not isinstance(ready, dict) or set(ready) != {"transportReady", *restore} \
                    or ready.get("transportReady") is not True \
                    or any(ready.get(key) != value for key, value in restore.items()):
                raise ValueError("operator cleanup transport restoration proof invalid")
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
                or arm["fixtureOperationId"] != f"qual-recovery-{original['runId']}" \
                or arm["bindingId"] == original["bindingId"] \
                or arm["connectionRevision"] != original["connectionRevision"]:
            raise ValueError("fault claim mismatch")
        # Cleanup uses a new fixture, not the stopped restart fixture. The app
        # checkpoint binds its exact database identity; the independent verifier
        # below checks the supplied binding and provider generation on Incus.
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

    def terminal(self, message):
        # The managed host owns its live database and reports only committed
        # terminal state after exact fixture cleanup/accounting verification.
        # Providers and public requests have no path to this child-only RPC.
        keys = {"version", "action", "runId", "nonce", "scope", "connectionRevision",
                "process", "claimedProcess", "state"}
        if not isinstance(message, dict) or set(message) != keys or message["version"] != 1 \
                or message["action"] != "terminal" or message["state"] not in ("COMPLETED", "FAILED"):
            raise ValueError("invalid terminal claim")
        if message["process"] != self.child_identity:
            raise ValueError("terminal process changed")
        if self.pending is not None:
            raise ValueError("restart is still pending")
        if self.claimed is None:
            if self.terminal_claim == canonical(message):
                return {"released": True}
            raise ValueError("terminal claim unavailable")
        request = self.claimed["request"]
        if any(message[key] != request[key] for key in ("runId", "nonce", "scope", "connectionRevision")) \
                or message["claimedProcess"] != self.claimed["newProcess"]:
            raise ValueError("terminal claim changed")
        historical = self.claimed["newProcess"]
        if historical != self.child_identity:
            try:
                if identity(historical["pid"]) == historical:
                    raise ValueError("claimed process is still alive")
            except (FileNotFoundError, ProcessLookupError):
                pass
        self.terminal_claim = canonical(message)
        self.claimed = None
        # used_runs and fault_armed intentionally remain replay fences.
        return {"released": True}

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
                        elif message.get("action") == "terminal":
                            send_message(connection, self.terminal(message))
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
    parser.add_argument("--abort-request")
    parser.add_argument("--restore-admitted-request")
    args = parser.parse_args()
    if sum(bool(v) for v in (args.abort_request, args.recover_request, args.restore_admitted_request)) > 1:
        raise ValueError("operator control requires a single action")
    config = json.loads(Path(args.config).read_text())
    required = {"socket", "appCommand", "appUid", "appGid", "key", "authorityCommand",
                "receiptAuthorityCommand"}
    optional = {"operatorSocket", "recoveryCommand", "recoveryFenceCommand",
                "faultAuthorityCommand", "recoveryAbortCommand", "recoveryRequestPath",
                "recoveryAbortStoppedUnits", "recoveryAbortRunnerUid", "recoveryRestoreCommand",
                "recoveryRestoreJournalPath", "recoveryRestoreConfigPath"}
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
    if bool(config.get("recoveryAbortCommand") or config.get("recoveryRestoreCommand")) != bool(config.get("recoveryRequestPath")) \
            or (config.get("recoveryAbortCommand") and (not config.get("operatorSocket")
                or not isinstance(config["recoveryAbortCommand"], list)
                or not all(isinstance(value, str) and value for value in config["recoveryAbortCommand"])
                or not isinstance(config["recoveryRequestPath"], str)
                or not config["recoveryRequestPath"].startswith("/"))):
        raise ValueError("invalid operator abort configuration")
    restore_keys = ("recoveryRestoreCommand", "recoveryRestoreJournalPath", "recoveryRestoreConfigPath")
    if any(config.get(k) for k in restore_keys) and (not all(config.get(k) for k in restore_keys)
            or not isinstance(config.get("recoveryRequestPath"), str) or not config["recoveryRequestPath"].startswith("/")
            or not isinstance(config["recoveryRestoreCommand"], list)
            or not all(isinstance(v, str) and v for v in config["recoveryRestoreCommand"])
            or not all(isinstance(config[k], str) and config[k].startswith("/") for k in restore_keys[1:])):
        raise ValueError("invalid admitted restoration configuration")
    if args.recover_request:
        if os.geteuid() != 0 or not config.get("operatorSocket"):
            raise ValueError("operator recovery requires root and a private socket")
        path = Path(args.recover_request)
        file = path.lstat()
        if not stat.S_ISREG(file.st_mode) or file.st_uid != 0 or file.st_mode & 0o077:
            raise ValueError("operator recovery request must be a private root-owned file")
        request = json.loads(path.read_text())
        if not isinstance(request, dict) or request.get("action") != "abort-fenced-cleanup-before-admission":
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
        supervisor.recovery_abort_command = config.get("recoveryAbortCommand")
        supervisor.recovery_fence_command = config.get("recoveryFenceCommand")
    supervisor.recovery_request_path = config.get("recoveryRequestPath")
    supervisor.fault_authority_command = config.get("faultAuthorityCommand")
    if config.get("recoveryAbortCommand") or config.get("recoveryRestoreCommand"):
        units = config.get("recoveryAbortStoppedUnits")
        runner_uid = config.get("recoveryAbortRunnerUid")
        supervisor.abort_stopped_guard = lambda: supervisor.assert_abort_actors_stopped(units, runner_uid)
    if args.restore_admitted_request:
        if os.geteuid() != 0 or json.loads(supervisor.private_recovery_bytes(args.config, maximum=128*1024)) != config:
            raise ValueError("offline admitted restoration requires root and exact private config")
        supervisor.restore_offline = True
        supervisor.recovery_restore_command = config.get("recoveryRestoreCommand")
        supervisor.recovery_restore_journal_path = config.get("recoveryRestoreJournalPath")
        supervisor.recovery_restore_config_path = config.get("recoveryRestoreConfigPath")
        message = json.loads(supervisor.private_recovery_bytes(args.restore_admitted_request))
        print(json.dumps(supervisor.restore_admitted(message), sort_keys=True))
        return
    if args.abort_request:
        if os.geteuid() != 0 or args.recover_request:
            raise ValueError("offline operator abort requires root and a single action")
        if json.loads(supervisor.private_recovery_bytes(args.config, maximum=128*1024)) != config:
            raise ValueError("offline operator abort config changed")
        supervisor.abort_offline = True
        message = json.loads(supervisor.private_recovery_bytes(args.abort_request))
        print(json.dumps(supervisor.abort_recovery(message), sort_keys=True))
        return
    supervisor.serve()


if __name__ == "__main__":
    main()
