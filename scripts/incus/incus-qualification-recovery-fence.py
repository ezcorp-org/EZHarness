#!/usr/bin/env python3
"""Read-only local client fence for the exact saved Incus CREATE.

The supervisor invokes this as root before readback and immediately before
apply. The separate SSH observer proves certificate revocation and absence.
"""

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
from pathlib import Path


TARGET_KEYS = {"scope", "fixtureOperationId", "bindingId", "operationId",
               "generation", "connectionRevision"}
SCOPE_KEYS = {"installationId", "releaseId", "connectionId", "presetId"}
CONFIG_KEYS = {"target", "appUid", "runnerUid", "runnerUnit", "observerConfig",
               "project", "instance", "oldCertificateSha256"}
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
RUNTIME_RUNNER_UNIT = "ezharness-qual-runner.service"
RUNNER_ALLOW_START = Path("/run/ezharness-qual-runner-allow-start")
RUNTIME_ASSERT_CONTENT = b"[Unit]\nAssertPathExists=/run/ezharness-qual-runner-allow-start\n"


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def private_root_file(path):
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts, "absolute private path required")
    for parent in path.parents:
        entry = parent.lstat()
        require(stat.S_ISDIR(entry.st_mode) and entry.st_uid == 0
                and not entry.st_mode & 0o022,
                f"private file parent is mutable: {parent}")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        entry = os.fstat(fd)
        require(stat.S_ISREG(entry.st_mode) and entry.st_uid == 0
                and not entry.st_mode & 0o077 and 0 < entry.st_size <= 131072,
                f"root-owned mode 0600 file required: {path}")
        return json.loads(os.read(fd, 131073))
    finally:
        os.close(fd)


def resource_name(target):
    raw = (target["scope"]["connectionId"] + "\0" + target["bindingId"]).encode()
    return "ezh-" + hashlib.sha256(raw).hexdigest()[:32]


def load_config(path):
    config = private_root_file(path)
    require(isinstance(config, dict) and set(config) == CONFIG_KEYS,
            "fence config keys changed")
    target = config["target"]
    require(isinstance(target, dict) and set(target) == TARGET_KEYS
            and isinstance(target["scope"], dict)
            and set(target["scope"]) == SCOPE_KEYS
            and all(isinstance(value, str) and IDENTIFIER.fullmatch(value)
                    for value in target["scope"].values())
            and all(isinstance(target[key], str) and IDENTIFIER.fullmatch(target[key])
                    for key in ("fixtureOperationId", "bindingId", "operationId"))
            and all(type(target[key]) is int and target[key] > 0
                    for key in ("generation", "connectionRevision")),
            "exact saved CREATE target required")
    require(type(config["appUid"]) is int and config["appUid"] > 0
            and type(config["runnerUid"]) is int and config["runnerUid"] > 0
            and config["appUid"] != config["runnerUid"],
            "separate dedicated app and runner UIDs required")
    unit = config["runnerUnit"]
    require(isinstance(unit, str) and re.fullmatch(r"[A-Za-z0-9_.@-]+\.service", unit),
            "exact runner service required")
    observer_path = config["observerConfig"]
    require(isinstance(observer_path, str)
            and observer_path == os.environ.get("EZCORP_INCUS_NOEFFECT_CONFIG"),
            "fence and observer must use the same sealed config")
    observer = private_root_file(observer_path)
    observation = observer.get("observation") if isinstance(observer, dict) else None
    require(config["instance"] == resource_name(target)
            and isinstance(config["project"], str)
            and re.fullmatch(r"[a-z][a-z0-9-]{0,62}", config["project"])
            and isinstance(config["oldCertificateSha256"], str)
            and re.fullmatch(r"[a-f0-9]{64}", config["oldCertificateSha256"])
            and isinstance(observation, dict)
            and all(observation.get(key) == config[key]
                    for key in ("instance", "project", "oldCertificateSha256")),
            "observer does not pin this CREATE, project, and old certificate")
    return config


def live_processes(process_root=Path("/proc")):
    for process in process_root.iterdir():
        if not process.name.isdigit():
            continue
        try:
            raw = (process / "stat").read_text()
            fields = raw[raw.rfind(")") + 2:].split()
            require(len(fields) >= 20 and fields[19].isdigit(),
                    f"process {process.name} identity unavailable")
            if fields[0] == "Z":
                continue
            yield (int(process.name), process.stat().st_uid, int(fields[2]), fields[19])
        except FileNotFoundError:
            continue
        except PermissionError as error:
            raise ValueError(f"cannot inspect process {process.name}") from error


def app_and_runner_absent(config, old_process, processes=None):
    require(isinstance(old_process, dict) and set(old_process) == {"pid", "startTicks"}
            and type(old_process["pid"]) is int and old_process["pid"] > 1
            and isinstance(old_process["startTicks"], str)
            and old_process["startTicks"].isdigit(), "old process identity invalid")
    for pid, uid, group, ticks in live_processes() if processes is None else processes:
        require(not (pid == old_process["pid"] and ticks == old_process["startTicks"])
                and group != old_process["pid"] and uid not in
                (config["appUid"], config["runnerUid"]),
                f"old app process group or dedicated client remains: {pid}")


def runtime_assert_gate(unit, state, systemd_root=Path("/run/systemd/system"),
                        allow_start=RUNNER_ALLOW_START):
    """Accept only the loaded, root-owned NixOS gate for this runner unit."""
    require(unit == RUNTIME_RUNNER_UNIT, "runtime gate is for the dedicated runner only")
    gate = systemd_root / (unit + ".d") / "hold.conf"
    require(state["DropInPaths"] == str(gate) and state["NeedDaemonReload"] == "no",
            "runner assertion is not the loaded unit configuration")
    for parent in gate.parents:
        entry = parent.lstat()
        require(stat.S_ISDIR(entry.st_mode) and entry.st_uid == 0
                and not entry.st_mode & 0o022,
                f"runner assertion parent is mutable: {parent}")
    fd = os.open(gate, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        entry = os.fstat(fd)
        require(stat.S_ISREG(entry.st_mode) and entry.st_uid == 0
                and not entry.st_mode & 0o022
                and entry.st_size == len(RUNTIME_ASSERT_CONTENT)
                and os.read(fd, len(RUNTIME_ASSERT_CONTENT) + 1) == RUNTIME_ASSERT_CONTENT,
                "runner assertion file differs from reviewed gate")
    finally:
        os.close(fd)
    try:
        allow_start.lstat()
    except FileNotFoundError:
        return
    raise ValueError("runner start permission path exists")


def runner_unit_quiesced(unit, cgroup_root=Path("/sys/fs/cgroup"),
                         systemd_root=Path("/run/systemd/system"),
                         allow_start=RUNNER_ALLOW_START):
    result = subprocess.run(["systemctl", "show", unit,
                             "--property=LoadState,ActiveState,SubState,MainPID,ControlGroup,UnitFileState,DropInPaths,NeedDaemonReload",
                             "--no-pager"], capture_output=True, timeout=3, check=False)
    require(result.returncode == 0, "cannot inspect runner service")
    lines = result.stdout.decode().splitlines()
    require(len(lines) == 8 and all("=" in line for line in lines),
            "runner service state unavailable")
    state = dict(line.split("=", 1) for line in lines)
    require(set(state) == {"LoadState", "ActiveState", "SubState", "MainPID",
                           "ControlGroup", "UnitFileState", "DropInPaths", "NeedDaemonReload"}
            and state["ActiveState"] == "inactive" and state["SubState"] == "dead"
            and state["MainPID"] == "0", "runner service is not stopped")
    masked = (state["LoadState"] == "masked"
              and state["UnitFileState"] in ("masked", "masked-runtime"))
    if not masked:
        require(state["LoadState"] == "loaded", "runner service state is unsafe")
        runtime_assert_gate(unit, state, systemd_root, allow_start)
    expected = "/system.slice/" + unit
    require(state["ControlGroup"] in ("", expected),
            "runner service cgroup differs from reviewed unit")
    cgroup = cgroup_root / expected.lstrip("/")
    if not cgroup.exists():
        require(not cgroup.is_symlink(), "runner cgroup path changed")
        return
    require(cgroup.is_dir() and not cgroup.is_symlink(), "runner cgroup invalid")
    for directory, dirs, _files in os.walk(cgroup, followlinks=False,
                                            onerror=lambda error: (_ for _ in ()).throw(error)):
        require(not (Path(directory) / "cgroup.procs").read_text().strip(),
                "runner cgroup still has clients")
        require(all(not (Path(directory) / name).is_symlink() for name in dirs),
                "runner cgroup link forbidden")


def verify(config, message):
    require(isinstance(message, dict) and set(message) == {"request", "oldProcess"},
            "supervisor fence input invalid")
    request = message["request"]
    require(isinstance(request, dict) and request.get("action") == "recover-noeffect"
            and request.get("allClientsFenced") is True
            and type(request.get("deadlineMs")) is int
            and int(time.time() * 1000) < request["deadlineMs"]
            and isinstance(request.get("fenceEvidence"), str),
            "operator fence request invalid or expired")
    require({key: request.get(key) for key in TARGET_KEYS} == config["target"],
            "saved CREATE target differs from sealed fence config")
    app_and_runner_absent(config, message["oldProcess"])
    runner_unit_quiesced(config["runnerUnit"])
    return {"fenced": True, "evidence": request["fenceEvidence"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0, "root execution required")
        config = load_config(args.config)
        raw = sys.stdin.buffer.read(16385)
        require(len(raw) <= 16384, "supervisor fence input too large")
        print(json.dumps(verify(config, json.loads(raw)), separators=(",", ":")))
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(f"recovery fence denied: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
