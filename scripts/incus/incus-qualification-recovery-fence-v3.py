#!/usr/bin/env python3
"""Compose the saved CREATE's local client fence with the server freeze lease."""

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import time


CONFIG_KEYS = {"localFenceCommand", "sshExecutable", "serverHost", "serverUser",
               "identityFile", "knownHostsFile", "serverAuditPath", "serverAuditSha256",
               "observerConfig"}
HOST = re.compile(r"[A-Za-z0-9][A-Za-z0-9.:-]{0,252}\Z")
PATH = re.compile(r"/[A-Za-z0-9_./-]+\Z")
DIGEST = re.compile(r"[a-f0-9]{64}\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def private_file(path):
    file = Path(path)
    require(file.is_absolute() and ".." not in file.parts, "absolute private path required")
    parent = file.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.geteuid()
            and not parent.st_mode & 0o022, "private parent required")
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and not info.st_mode & 0o077 and 0 < info.st_size <= 16384,
                "private regular file required")
        return os.read(fd, 16385)
    finally:
        os.close(fd)


def load_config(path):
    config = json.loads(private_file(path))
    require(isinstance(config, dict) and set(config) == CONFIG_KEYS,
            "exact v3 fence config required")
    local = config["localFenceCommand"]
    require(isinstance(local, list) and 1 <= len(local) <= 8
            and all(isinstance(arg, str) and arg and "\0" not in arg for arg in local)
            and local[0].startswith("/"), "absolute local fence command required")
    for key in ("sshExecutable", "identityFile", "knownHostsFile",
                "serverAuditPath", "observerConfig"):
        require(isinstance(config[key], str) and PATH.fullmatch(config[key])
                and ".." not in Path(config[key]).parts, f"invalid {key}")
    for key in ("identityFile", "knownHostsFile", "observerConfig"):
        private_file(config[key])
    require(config["serverUser"] == "root" and isinstance(config["serverHost"], str)
            and HOST.fullmatch(config["serverHost"])
            and isinstance(config["serverAuditSha256"], str)
            and DIGEST.fullmatch(config["serverAuditSha256"]),
            "pinned server authority required")
    return config


def run_fence(config, message):
    require(isinstance(message, dict) and set(message) == {"request", "oldProcess"},
            "supervisor fence input invalid")
    request = message["request"]
    require(isinstance(request, dict) and request.get("action") == "recover-noeffect"
            and request.get("allClientsFenced") is True
            and isinstance(request.get("fenceEvidence"), str)
            and 8 <= len(request["fenceEvidence"]) <= 512
            and type(request.get("deadlineMs")) is int,
            "operator recovery fence request invalid")
    now = int(time.time() * 1000)
    deadline = request["deadlineMs"]
    require(now < deadline <= now + 180000, "operator recovery deadline invalid")
    local = subprocess.run(config["localFenceCommand"], input=json.dumps(message).encode(),
                           capture_output=True, timeout=3, check=False,
                           env={**os.environ, "EZCORP_INCUS_NOEFFECT_CONFIG": config["observerConfig"]})
    require(local.returncode == 0 and len(local.stdout) <= 4096
            and json.loads(local.stdout) == {"fenced": True,
                                              "evidence": request["fenceEvidence"]},
            "local recovery fence failed")
    audit_path = config["serverAuditPath"]
    audit_hash = config["serverAuditSha256"]
    remote = (f'test "$(/run/current-system/sw/bin/sha256sum {shlex.quote(audit_path)} '
              f'| /run/current-system/sw/bin/cut -d\' \' -f1)" = {audit_hash}'
              f' && exec /run/current-system/sw/bin/python3 {shlex.quote(audit_path)} '
              f'frozen-until {deadline}')
    ssh = subprocess.run([config["sshExecutable"], "-F", "/dev/null", "-T",
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", "PasswordAuthentication=no",
        "-o", "KbdInteractiveAuthentication=no", "-o", "ClearAllForwardings=yes",
        "-o", "NumberOfPasswordPrompts=0",
        "-o", f'UserKnownHostsFile={config["knownHostsFile"]}',
        "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=4",
        "-i", config["identityFile"], "-l", "root", config["serverHost"], remote],
        input=b"", capture_output=True, timeout=6, check=False,
        env={"PATH": "/run/current-system/sw/bin", "HOME": "/var/empty", "LC_ALL": "C"})
    require(ssh.returncode == 0 and len(ssh.stdout) <= 4096,
            "server recovery fence unavailable")
    server = json.loads(ssh.stdout)
    # Reserve the full 120 seconds even at the accepted five-second clock skew.
    require(isinstance(server, dict) and set(server) == {"frozen", "nowMs", "timerDeadlineMs"}
            and server["frozen"] is True
            and type(server["nowMs"]) is int and type(server["timerDeadlineMs"]) is int
            and abs(server["nowMs"] - int(time.time() * 1000)) <= 5000
            and server["timerDeadlineMs"] > deadline + 125000,
            "server freeze or rollback timer insufficient")
    return {"fenced": True, "evidence": request["fenceEvidence"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        raw = sys.stdin.buffer.read(16385)
        require(len(raw) <= 16384, "supervisor fence input too large")
        print(json.dumps(run_fence(config, json.loads(raw)), separators=(",", ":")))
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(f"recovery fence denied: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
