#!/usr/bin/env python3
"""Forced SSH command for one reviewed Incus setup plan. Install as root-owned code."""

import hashlib
import json
import os
from datetime import datetime, timezone, timedelta
import selectors
import signal
import stat
import subprocess
import sys
import time

ORIGINAL_COMMAND = "ezh-incus-operator-v1"
MAX_REQUEST = 64 * 1024
MAX_POLICY = 128 * 1024
MAX_OUTPUT = 1024 * 1024
TIMEOUT = 55
MAX_WRITE_WINDOW = timedelta(minutes=20)
EXECUTABLES = {"hostnamectl", "cat", "uname", "nproc", "getconf", "df", "stat",
               "timedatectl", "systemctl", "incus", "ip"}


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
    if matches[0].get("write") is True:
        if plan_digest is None:
            raise Denied("a reviewed plan digest is required for server writes")
        current = now or datetime.now(timezone.utc)
        if current < parse_utc(policy["issuedAt"]) - timedelta(minutes=2) or current >= parse_utc(policy["writeExpiresAt"]):
            raise Denied("reviewed server write policy has expired")
    return argv, stdin.encode() if stdin is not None else b""


def execute(argv, input_bytes):
    env = {"PATH": "/run/current-system/sw/bin", "HOME": "/var/empty", "LC_ALL": "C"}
    executable = "/run/current-system/sw/bin/" + argv[0]
    proc = subprocess.Popen([executable, *argv[1:]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, start_new_session=True, close_fds=True)
    selector = selectors.DefaultSelector()
    chunks = {proc.stdout: [], proc.stderr: []}
    total = 0
    deadline = time.monotonic() + TIMEOUT
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


def main():
    if len(sys.argv) != 2:
        raise Denied("policy path is required")
    if os.environ.get("SSH_ORIGINAL_COMMAND") != ORIGINAL_COMMAND:
        raise Denied("unexpected SSH command")
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise Denied("SSH request is too large")
    policy = read_policy(sys.argv[1])
    validate_policy(policy)
    argv, stdin = authorize(policy, os.environ["SSH_ORIGINAL_COMMAND"], json.loads(raw))
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
