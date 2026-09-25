#!/usr/bin/env python3
"""Forced SSH command for one reviewed Incus setup plan. Install as root-owned code."""

import hashlib
import json
import os
import re
from datetime import datetime, timezone, timedelta
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time

ORIGINAL_COMMAND = "ezh-incus-operator-v1"
OBSERVE_COMMAND = "ezh-incus-noeffect-observe-v1"
MAX_REQUEST = 64 * 1024
MAX_POLICY = 128 * 1024
MAX_OUTPUT = 1024 * 1024
TIMEOUT = 55
MAX_WRITE_WINDOW = timedelta(minutes=20)
EXECUTABLES = {"hostnamectl", "cat", "uname", "nproc", "getconf", "df", "stat",
               "timedatectl", "systemctl", "incus", "ip"}
READ_ONLY_COMMANDS = {
    ("hostnamectl", "--static"), ("cat", "/etc/os-release"), ("uname", "-r"), ("uname", "-m"),
    ("nproc",), ("getconf", "_PHYS_PAGES"), ("getconf", "PAGESIZE"),
    ("df", "-B1", "--output=avail", "/"), ("stat", "-f", "-c", "%T", "/sys/fs/cgroup"),
    ("timedatectl", "show", "--property=NTPSynchronized", "--value"),
    ("systemctl", "is-active", "incus.service"), ("incus", "version"),
    ("incus", "query", "/1.0"), ("incus", "project", "list", "--format=json"),
    ("incus", "storage", "list", "--format=json"),
    ("incus", "network", "list", "--all-projects", "--format=json"),
    ("incus", "profile", "list", "--all-projects", "--format=json"),
    ("incus", "list", "--all-projects", "--format=json"),
    ("incus", "config", "trust", "list", "--format=json"),
    ("incus", "image", "list", "--project=default", "--format=json"),
    ("ip", "-j", "route", "show", "table", "all"), ("ip", "-j", "address", "show"),
    ("cat", "/proc/meminfo"), ("cat", "/proc/loadavg"),
    ("cat", "/proc/sys/kernel/threads-max"), ("cat", "/proc/sys/kernel/pid_max"),
    ("incus", "config", "get", "core.https_address"),
}
SAFE_NAME = r"[a-z][a-z0-9-]{0,62}"
PROFILE_KEYS = {"limits.cpu", "limits.memory", "limits.memory.enforce", "limits.processes",
                "security.idmap.isolated", "security.nesting", "security.privileged"}


def is_read_only_argv(argv):
    values = tuple(argv)
    if values in READ_ONLY_COMMANDS:
        return True
    if len(argv) == 3 and argv[:2] == ["incus", "query"]:
        path = argv[2]
        return bool(re.fullmatch(rf"/1\.0/(?:storage-pools|projects|certificates)/{SAFE_NAME}", path) or
            re.fullmatch(r"/1\.0/certificates/[a-f0-9]{64}", path) or
            re.fullmatch(rf"/1\.0/networks/{SAFE_NAME}\?project=default", path) or
            re.fullmatch(rf"/1\.0/profiles/{SAFE_NAME}\?project={SAFE_NAME}", path))
    if len(argv) == 4 and argv[:3] == ["incus", "--force-local", "query"]:
        return bool(re.fullmatch(rf"/1\.0/storage-pools/{SAFE_NAME}/resources", argv[3]))
    if len(argv) == 7 and argv[:3] == ["incus", "profile", "get"]:
        return bool(re.fullmatch(SAFE_NAME, argv[3]) and argv[4] in PROFILE_KEYS and
                    argv[5] == "--project" and re.fullmatch(SAFE_NAME, argv[6]))
    if len(argv) == 9 and argv[:4] == ["incus", "profile", "device", "get"]:
        return bool(re.fullmatch(SAFE_NAME, argv[4]) and argv[5] in ("eth0", "root") and
                    argv[6] in ("security.port_isolation", "type") and argv[7] == "--project" and
                    re.fullmatch(SAFE_NAME, argv[8]))
    return False


class Denied(Exception):
    pass


def read_policy(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or not 0 < info.st_size <= MAX_POLICY:
            raise Denied("policy must be a bounded root-owned file")
        payload = os.read(fd, MAX_POLICY + 1)
    finally:
        os.close(fd)
    if len(payload) > MAX_POLICY:
        raise Denied("policy is too large")
    return json.loads(payload)


def validate_policy(policy):
    if (not isinstance(policy, dict) or set(policy) not in ({"version", "planDigest", "commands"},
            {"version", "planDigest", "issuedAt", "writeExpiresAt", "commands"}) or policy["version"] != 1):
        raise Denied("unsupported policy")
    if not isinstance(policy["planDigest"], str) or len(policy["planDigest"]) != 64 or any(c not in "0123456789abcdef" for c in policy["planDigest"]):
        raise Denied("invalid reviewed digest")
    if not isinstance(policy["commands"], list) or not 0 < len(policy["commands"]) <= 128:
        raise Denied("invalid command policy")
    for command in policy["commands"]:
        if not isinstance(command, dict) or set(command) not in ({"argv"}, {"argv", "stdinSha256"},
                                                        {"argv", "write"}, {"argv", "stdinSha256", "write"}):
            raise Denied("invalid command entry")
        if "write" in command and command["write"] is not True:
            raise Denied("invalid write classification")
        argv = command["argv"]
        if not isinstance(argv, list) or not 1 <= len(argv) <= 64 or argv[0] not in EXECUTABLES or any(
            not isinstance(arg, str) or not 0 < len(arg) <= 4096 or "\x00" in arg or any(ord(c) < 32 for c in arg)
            for arg in argv
        ):
            raise Denied("invalid command arguments")
        if "stdinSha256" in command and (not isinstance(command["stdinSha256"], str) or
            len(command["stdinSha256"]) != 64 or any(c not in "0123456789abcdef" for c in command["stdinSha256"])):
            raise Denied("invalid input digest")
        if command.get("write") is not True and ("stdinSha256" in command or not is_read_only_argv(argv)):
            raise Denied("command cannot be classified as read-only")
    has_writes = any(command.get("write") is True for command in policy["commands"])
    if has_writes != ("writeExpiresAt" in policy):
        raise Denied("write policy requires an absolute expiry")
    if has_writes:
        issued = parse_utc(policy["issuedAt"])
        expires = parse_utc(policy["writeExpiresAt"])
        if not timedelta(0) < expires - issued <= MAX_WRITE_WINDOW:
            raise Denied("write policy lifetime exceeds the allowed window")


def parse_utc(value):
    if not isinstance(value, str) or len(value) > 32 or not value.endswith("Z"):
        raise Denied("invalid policy timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise Denied("invalid policy timestamp") from error
    if parsed.tzinfo is None:
        raise Denied("invalid policy timestamp")
    return parsed.astimezone(timezone.utc)


def authorize(policy, original, payload, now=None):
    if original != ORIGINAL_COMMAND:
        raise Denied("unexpected SSH command")
    if not isinstance(payload, dict) or set(payload) not in ({"version", "argv"}, {"version", "argv", "stdin"},
                                                         {"version", "argv", "planDigest"},
                                                         {"version", "argv", "stdin", "planDigest"}) or payload["version"] != 1:
        raise Denied("invalid SSH envelope")
    argv = payload["argv"]
    stdin = payload.get("stdin")
    if not isinstance(argv, list) or any(not isinstance(arg, str) for arg in argv) or stdin is not None and not isinstance(stdin, str):
        raise Denied("invalid SSH command")
    plan_digest = payload.get("planDigest")
    if plan_digest is not None and plan_digest != policy["planDigest"]:
        raise Denied("installed SSH policy does not match reviewed plan digest")
    candidate = {"argv": argv}
    if stdin is not None:
        candidate["stdinSha256"] = hashlib.sha256(stdin.encode()).hexdigest()
    matches = [command for command in policy["commands"] if {key: value for key, value in command.items() if key != "write"} == candidate]
    if len(matches) != 1:
        raise Denied("command is outside the reviewed plan")
    if matches[0].get("write") is not True and not is_read_only_argv(argv):
        raise Denied("command cannot be classified as read-only")
    if matches[0].get("write") is True:
        if plan_digest is None:
            raise Denied("a reviewed plan digest is required for server writes")
        current = now or datetime.now(timezone.utc)
        if current < parse_utc(policy["issuedAt"]) - timedelta(minutes=2) or current >= parse_utc(policy["writeExpiresAt"]):
            raise Denied("reviewed server write policy has expired")
    return argv, stdin.encode() if stdin is not None else b""


def execute(argv, input_bytes, timeout=TIMEOUT):
    env = {"PATH": "/run/current-system/sw/bin", "HOME": "/var/empty", "LC_ALL": "C"}
    if argv[0] == "incus":
        # Incus writes client configuration even for local, read-only queries.
        # Give each call its own private directory and remove it on every exit.
        with tempfile.TemporaryDirectory(prefix="ezh-incus-conf-", dir="/tmp") as incus_conf:
            env["INCUS_CONF"] = incus_conf
            return _execute_bounded(argv, input_bytes, timeout, env)
    return _execute_bounded(argv, input_bytes, timeout, env)


def _execute_bounded(argv, input_bytes, timeout, env):
    executable = "/run/current-system/sw/bin/" + argv[0]
    proc = subprocess.Popen([executable, *argv[1:]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, start_new_session=True, close_fds=True)
    selector = selectors.DefaultSelector()
    chunks = {proc.stdout: [], proc.stderr: []}
    total = 0
    deadline = time.monotonic() + timeout
    sent = 0
    try:
        for pipe in chunks:
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ)
        if input_bytes:
            os.set_blocking(proc.stdin.fileno(), False)
            selector.register(proc.stdin, selectors.EVENT_WRITE)
        else:
            proc.stdin.close()
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Denied("connection closed: command timed out; reconcile before retry")
            for key, _ in selector.select(min(remaining, 0.5)):
                pipe = key.fileobj
                if pipe is proc.stdin:
                    try:
                        sent += os.write(pipe.fileno(), input_bytes[sent:])
                    except BrokenPipeError:
                        sent = len(input_bytes)
                    if sent == len(input_bytes):
                        selector.unregister(pipe)
                        pipe.close()
                else:
                    try:
                        data = os.read(pipe.fileno(), min(65536, MAX_OUTPUT + 1 - total))
                    except BlockingIOError:
                        continue
                    if not data:
                        selector.unregister(pipe)
                        pipe.close()
                    else:
                        total += len(data)
                        if total > MAX_OUTPUT:
                            raise Denied("connection closed: output limit exceeded; reconcile before retry")
                        chunks[pipe].append(data)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise Denied("connection closed: command timed out; reconcile before retry")
        return proc.wait(timeout=remaining), b"".join(chunks[proc.stdout]), b"".join(chunks[proc.stderr])
    except (Denied, subprocess.TimeoutExpired):
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        raise Denied("connection closed: result unknown; reconcile before retry")
    finally:
        selector.close()
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            if not pipe.closed:
                pipe.close()


def validate_observation_policy(policy):
    if not isinstance(policy, dict) or set(policy) != {"version", "purpose", "project", "instance", "oldCertificateSha256"} \
            or policy["version"] != 2 or policy["purpose"] != "noeffect-readback":
        raise Denied("observation policy must be dedicated and read-only")
    if not isinstance(policy["project"], str) or not re.fullmatch(SAFE_NAME, policy["project"]):
        raise Denied("invalid observation project")
    if not isinstance(policy["instance"], str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,127}", policy["instance"]):
        raise Denied("invalid observation instance")
    fingerprint = policy["oldCertificateSha256"]
    if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
        raise Denied("invalid old certificate fingerprint")


def observe_noeffect(policy, original, raw):
    validate_observation_policy(policy)
    if original != OBSERVE_COMMAND or raw:
        raise Denied("unexpected observation request")
    project = policy["project"]
    commands = (
        ["incus", "list", f"--project={project}", "--format=json"],
        ["incus", "operation", "list", f"--project={project}", "--format=json"],
        ["incus", "config", "trust", "list", "--format=json"],
    )
    results = []
    for argv in commands:
        code, stdout, _ = execute(argv, b"", timeout=5)
        if code != 0 or len(stdout) > MAX_OUTPUT:
            raise Denied("Incus observation failed")
        try:
            results.append(json.loads(stdout))
        except (ValueError, UnicodeError) as error:
            raise Denied("Incus observation is invalid") from error
    instances, operations, certificates = results
    if not isinstance(instances, list) or any(not isinstance(row, dict) or not isinstance(row.get("name"), str)
                                              for row in instances):
        raise Denied("Incus instance list is invalid")
    if not isinstance(operations, list) or any(not isinstance(row, dict) or
            not isinstance(row.get("id"), str) for row in operations):
        raise Denied("Incus operation list is invalid")
    if not isinstance(certificates, list) or any(not isinstance(row, dict) or
            not isinstance(row.get("fingerprint"), str) for row in certificates):
        raise Denied("Incus trust list is invalid")
    if any(row["fingerprint"].lower() == policy["oldCertificateSha256"] for row in certificates):
        raise Denied("old provider certificate remains trusted")
    if any(row["name"] == policy["instance"] for row in instances) or operations:
        raise Denied("instance or delayed Incus operation remains")
    return {"version": 1, "project": project, "instance": policy["instance"],
            "oldCertificateSha256": policy["oldCertificateSha256"],
            "absent": True, "activeOperations": [], "oldCertificateRevoked": True}


def main():
    if len(sys.argv) != 2:
        raise Denied("policy path is required")
    original = os.environ.get("SSH_ORIGINAL_COMMAND")
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise Denied("SSH request is too large")
    policy = read_policy(sys.argv[1])
    if original == OBSERVE_COMMAND:
        result = observe_noeffect(policy, original, raw)
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
        return 0
    validate_policy(policy)
    argv, stdin = authorize(policy, original, json.loads(raw))
    code, stdout, stderr = execute(argv, stdin)
    sys.stdout.buffer.write(stdout)
    sys.stderr.buffer.write(stderr)
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Denied as error:
        print(str(error), file=sys.stderr)
        sys.exit(125)
    except (ValueError, OSError, UnicodeError, json.JSONDecodeError):
        print("Incus SSH gate denied request", file=sys.stderr)
        sys.exit(125)
