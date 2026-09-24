#!/usr/bin/env python3
"""Stage a stopped, isolated PGlite app for a dedicated supervised UID.

No service is stopped or started here. 'check' is read-only; 'stage --execute'
quarantines the stopped source DB and makes two private copies. The original
remains the rollback source. This script never connects to Incus.
"""

import argparse
import grp
import hashlib
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import tempfile
import time
from pathlib import Path


FIELDS = {"oldUid", "oldGid", "newUid", "newGid", "sourceDb", "quarantineDb", "targetDb",
          "rollbackDb", "oldAppUnit", "runnerUnit", "supervisorUnit",
          "oldProcessIds", "runnerProcessIds",
          "builtApp", "oldEnv", "newEnv", "runnerEnv", "runnerSocket",
          "runnerTokenFile", "supervisorConfig"}
SERVICE = re.compile(r"^[A-Za-z0-9_.@-]+\.service$")
IDENTITY_KEYS = ("EZCORP_ENCRYPTION_SECRET", "EZCORP_ENCRYPTION_SALT",
                 "EZCORP_JWT_SECRET")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def private_file(path, owner=0):
    path = Path(path)
    for parent in path.parents:
        state = parent.lstat()
        require(stat.S_ISDIR(state.st_mode) and state.st_uid == 0
                and state.st_mode & 0o022 == 0,
                f"private file parent is mutable: {parent}")
    found = path.lstat()
    require(stat.S_ISREG(found.st_mode) and found.st_uid == owner
            and found.st_mode & 0o077 == 0, f"private root file required: {path}")
    return path


def read_env(path):
    values = {}
    for line in private_file(path).read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        require(separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key)
                and key not in values and "\0" not in value, "invalid sealed environment file")
        values[key] = value
    return values


def checked_path(value):
    require(isinstance(value, str) and value.startswith("/") and "\0" not in value,
            "absolute path required")
    path = Path(value)
    require(".." not in path.parts, "parent path component forbidden")
    return path


def config(path):
    value = json.loads(private_file(path).read_text())
    require(isinstance(value, dict) and set(value) == FIELDS, "cutover manifest keys changed")
    for key in ("oldUid", "oldGid", "newUid", "newGid"):
        require(type(value[key]) is int and value[key] > 0, "positive static UID/GID required")
    require(value["oldUid"] != value["newUid"], "new app UID must be dedicated")
    for key in FIELDS - {"oldUid", "oldGid", "newUid", "newGid",
                         "oldProcessIds", "runnerProcessIds",
                         "oldAppUnit", "runnerUnit", "supervisorUnit"}:
        checked_path(value[key])
    for key in ("oldProcessIds", "runnerProcessIds"):
        require(isinstance(value[key], list) and value[key]
                and all(type(pid) is int and pid > 1 for pid in value[key])
                and len(set(value[key])) == len(value[key]),
                f"reviewed process IDs required: {key}")
    for key in ("oldAppUnit", "runnerUnit", "supervisorUnit"):
        require(value[key] is None or (isinstance(value[key], str)
                and SERVICE.fullmatch(value[key])), "systemd service name or null required")
    return value


def inactive(unit):
    loaded = subprocess.run(["systemctl", "show", unit, "--property=LoadState",
                             "--value"], capture_output=True, text=True, timeout=5)
    require(loaded.returncode == 0 and loaded.stdout.strip() == "loaded",
            f"reviewed service unit is not loaded: {unit}")
    result = subprocess.run(["systemctl", "show", unit, "--property=ActiveState",
                             "--value"], capture_output=True, text=True, timeout=5)
    require(result.returncode == 0 and result.stdout.strip() == "inactive",
            f"service must be inactive: {unit}")
    pid = subprocess.run(["systemctl", "show", unit, "--property=MainPID",
                          "--value"], capture_output=True, text=True, timeout=5)
    require(pid.returncode == 0 and pid.stdout.strip() == "0",
            f"service still has a main process: {unit}")


def no_open_database_files(source):
    prefix = str(source) + "/"
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        for directory in (process / "fd", process / "map_files"):
            try:
                entries = list(directory.iterdir())
            except (OSError, PermissionError):
                continue
            for entry in entries:
                try:
                    target = os.readlink(entry)
                except OSError:
                    continue
                require(target != str(source) and not target.startswith(prefix),
                        f"process {process.name} still holds the database")


def no_old_clients(value, source):
    for key in ("oldProcessIds", "runnerProcessIds"):
        for pid in value[key]:
            require(not (Path("/proc") / str(pid)).exists(),
                    f"reviewed old process still runs: {pid}")
    source_env = b"EZCORP_DB_PATH=" + os.fsencode(source) + b"\0"
    socket_env = b"EZ_EXTENSION_RUNNER_SOCKET=" + os.fsencode(value["runnerSocket"]) + b"\0"
    socket_arg = os.fsencode(value["runnerSocket"]) + b"\0"
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            environment = (process / "environ").read_bytes()
            arguments = (process / "cmdline").read_bytes()
        except FileNotFoundError:
            continue
        require(source_env not in environment and socket_env not in environment
                and socket_arg not in arguments,
                f"old app or runner client still runs: {process.name}")


def closed_socket(path):
    require(not path.exists() and not path.is_symlink(),
            "runner socket remains; stop the runner and inspect its gateway")


def owned_tree(root, uid, gid):
    require(root.is_dir() and not root.is_symlink(), "PGlite source directory unavailable")
    for directory, dirs, files in os.walk(root, followlinks=False,
                                          onerror=lambda error: (_ for _ in ()).throw(error)):
        for name in [".", *dirs, *files]:
            path = Path(directory) if name == "." else Path(directory) / name
            item = path.lstat()
            require((stat.S_ISDIR(item.st_mode) or stat.S_ISREG(item.st_mode))
                    and item.st_uid == uid and item.st_gid == gid,
                    f"PGlite tree contains an unexpected owner or file type: {path}")


def regular_tree(root):
    for directory, dirs, files in os.walk(root, followlinks=False,
                                          onerror=lambda error: (_ for _ in ()).throw(error)):
        for name in [".", *dirs, *files]:
            path = Path(directory) if name == "." else Path(directory) / name
            item = path.lstat()
            require(stat.S_ISDIR(item.st_mode) or stat.S_ISREG(item.st_mode),
                    f"PGlite tree changed file type: {path}")


def root_build(path):
    require(path.name == "index.js" and path.parent.name == "build"
            and path.parent.parent.name == "web", "built app must be web/build/index.js")
    for item in [path, *path.parents]:
        found = item.lstat()
        require(not stat.S_ISLNK(found.st_mode) and found.st_uid == 0
                and found.st_mode & 0o022 == 0, f"built release is not root-owned: {item}")
    require(path.is_file(), "built app is absent")


def accessible_to(path, uid, gid, read_file=False):
    for item in [path, *path.parents]:
        found = item.lstat()
        bits = found.st_mode & (0o700 if found.st_uid == uid else
                                0o070 if found.st_gid == gid else 0o007)
        needed = (0o400 if found.st_uid == uid else
                  0o040 if found.st_gid == gid else 0o004) if item == path and read_file else (
                  0o100 if found.st_uid == uid else
                  0o010 if found.st_gid == gid else 0o001)
        require(bits & needed, f"dedicated app cannot access: {item}")


def parent_mode(path, uid, gid, mode):
    parent = path.parent
    found = parent.lstat()
    require(stat.S_ISDIR(found.st_mode) and found.st_uid == uid
            and found.st_gid == gid and stat.S_IMODE(found.st_mode) == mode,
            f"private destination parent required: {parent}")
    require(not path.exists() and not path.is_symlink(),
            f"destination already exists: {path}")


def sealed_source_parent(source):
    found = source.parent.lstat()
    require(stat.S_ISDIR(found.st_mode) and found.st_uid == 0
            and found.st_gid == 0 and stat.S_IMODE(found.st_mode) == 0o700,
            "source parent must be root-owned mode 0700 after old clients stop")


def check(value):
    require(os.geteuid() == 0, "root operator required")
    require(value["newUid"] == pwd.getpwuid(value["newUid"]).pw_uid
            and value["newGid"] == grp.getgrgid(value["newGid"]).gr_gid,
            "dedicated static app UID/GID is not provisioned")
    source = checked_path(value["sourceDb"])
    quarantine = checked_path(value["quarantineDb"])
    target = checked_path(value["targetDb"])
    rollback = checked_path(value["rollbackDb"])
    paths = (source, quarantine, target, rollback)
    require(all(left != right and left not in right.parents and right not in left.parents
                for index, left in enumerate(paths) for right in paths[index + 1:]),
            "database paths overlap")
    require(not (rollback.parent / "dedicated-uid-stage.json").exists(),
            "stage receipt already exists")
    owned_tree(source, value["oldUid"], value["oldGid"])
    sealed_source_parent(source)
    parent_mode(quarantine, 0, 0, 0o700)
    require(source.stat().st_dev == quarantine.parent.stat().st_dev,
            "source and root-only quarantine must share a filesystem for atomic rename")
    built = checked_path(value["builtApp"])
    root_build(built)
    accessible_to(built, value["newUid"], value["newGid"], read_file=True)
    parent_mode(target, 0, value["newGid"], 0o710)
    parent_mode(rollback, 0, 0, 0o700)
    old_env, new_env, runner_env = (read_env(value[name])
                                    for name in ("oldEnv", "newEnv", "runnerEnv"))
    require(old_env.get("EZCORP_DB_PATH") == str(source)
            and new_env.get("EZCORP_DB_PATH") == str(target)
            and not old_env.get("DATABASE_URL") and not new_env.get("DATABASE_URL"),
            "isolated PGlite environment changed")
    require(all(old_env.get(key) and old_env[key] == new_env.get(key)
                for key in IDENTITY_KEYS), "encryption or session identity changed")
    require(new_env.get("BUN_RUNTIME_TRANSPILER_CACHE_PATH") == "0"
            and new_env.get("EZCORP_EXTENSION_RUNNER_SOCKET") == value["runnerSocket"]
            and new_env.get("EZCORP_EXTENSION_RUNNER_TOKEN_FILE") == value["runnerTokenFile"]
            and new_env.get("EZCORP_INCUS_SUPERVISOR_SOCKET"),
            "new app environment is incomplete")
    require(runner_env.get("EZ_EXTENSION_APP_UID") == str(value["newUid"])
            and runner_env.get("EZ_EXTENSION_RUNNER_SOCKET") == value["runnerSocket"]
            and runner_env.get("EZ_EXTENSION_RUNNER_TOKEN_FILE") == value["runnerTokenFile"],
            "runner peer UID or socket changed")
    supervisor = json.loads(private_file(value["supervisorConfig"]).read_text())
    command = supervisor.get("appCommand")
    fence = supervisor.get("recoveryFenceCommand")
    require(isinstance(command, list) and len(command) == 2
            and checked_path(command[0]).is_file()
            and supervisor.get("appUid") == value["newUid"]
            and supervisor.get("appGid") == value["newGid"]
            and command[1] == value["builtApp"]
            and supervisor.get("socket") == new_env["EZCORP_INCUS_SUPERVISOR_SOCKET"]
            and supervisor.get("operatorSocket") and supervisor.get("recoveryCommand")
            and isinstance(fence, list) and fence and isinstance(fence[0], str)
            and Path(fence[0]).name != "false",
            "supervisor config does not pin the dedicated app")
    token = checked_path(value["runnerTokenFile"]).lstat()
    require(stat.S_ISREG(token.st_mode) and token.st_gid == value["newGid"]
            and token.st_mode & 0o027 == 0 and token.st_mode & 0o040
            and 32 <= token.st_size <= 4096, "runner token is not private and app-readable")
    accessible_to(checked_path(value["runnerTokenFile"]), value["newUid"], value["newGid"],
                  read_file=True)
    socket_parent = checked_path(value["runnerSocket"]).parent.lstat()
    require(stat.S_ISDIR(socket_parent.st_mode)
            and socket_parent.st_gid == value["newGid"]
            and socket_parent.st_mode & 0o020 == 0
            and socket_parent.st_mode & 0o010 != 0,
            "runner socket directory is not app-searchable")
    accessible_to(checked_path(value["runnerSocket"]).parent,
                  value["newUid"], value["newGid"])
    for unit in ("oldAppUnit", "runnerUnit", "supervisorUnit"):
        if value[unit] is not None:
            inactive(value[unit])
    no_old_clients(value, source)
    for process in Path("/proc").iterdir():
        if process.name.isdigit():
            try:
                owner = process.stat().st_uid
            except FileNotFoundError:
                continue
            require(owner != value["newUid"],
                    f"dedicated app UID already has process {process.name}")
    closed_socket(checked_path(value["runnerSocket"]))
    no_open_database_files(source)
    return source, quarantine, target, rollback


def tree_digest(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode() + b"\0")
        if path.is_file():
            with path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
    return digest.hexdigest()


def chown_tree(root, uid, gid):
    for directory, dirs, files in os.walk(root, topdown=False, followlinks=False):
        for name in files + dirs:
            os.chown(Path(directory) / name, uid, gid, follow_symlinks=False)
        os.chown(directory, uid, gid, follow_symlinks=False)


def stage(value):
    source, quarantine, target, rollback = check(value)
    source_mode = stat.S_IMODE(source.lstat().st_mode)
    os.rename(source, quarantine)
    os.chown(quarantine, 0, 0, follow_symlinks=False)
    os.chmod(quarantine, 0o700)
    try:
        no_old_clients(value, source)
        no_open_database_files(quarantine)
        regular_tree(quarantine)
        chown_tree(quarantine, 0, 0)
        before = tree_digest(quarantine)
        backup_temp = Path(tempfile.mkdtemp(prefix=".db-backup-", dir=rollback.parent))
        target_temp = Path(tempfile.mkdtemp(prefix=".db-target-", dir=target.parent))
        try:
            shutil.copytree(quarantine, backup_temp, dirs_exist_ok=True, symlinks=False)
            shutil.copytree(quarantine, target_temp, dirs_exist_ok=True, symlinks=False)
            require(tree_digest(backup_temp) == before
                    and tree_digest(target_temp) == before, "PGlite copy checksum changed")
            chown_tree(target_temp, value["newUid"], value["newGid"])
            os.chmod(target_temp, 0o700)
            os.chmod(backup_temp, 0o700)
            os.replace(backup_temp, rollback)
            os.replace(target_temp, target)
        finally:
            if backup_temp.exists():
                shutil.rmtree(backup_temp)
            if target_temp.exists():
                shutil.rmtree(target_temp)
        receipt = {"sourceDb": str(source), "quarantineDb": str(quarantine), "targetDb": str(target),
                   "rollbackDb": str(rollback), "sourceUid": value["oldUid"],
                   "sourceGid": value["oldGid"], "sourceMode": source_mode,
                   "newUid": value["newUid"], "newGid": value["newGid"],
                   "sha256": before, "stagedAtMs": int(time.time() * 1000)}
        receipt_path = rollback.parent / "dedicated-uid-stage.json"
        descriptor = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(receipt, stream, sort_keys=True)
            stream.write("\n")
        return receipt_path
    except Exception:
        # A failed cutover must not leave the shared old UID able to modify
        # a partially staged database. The runbook handles owner restoration.
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("action", choices=("check", "stage"))
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    value = config(args.manifest)
    if args.action == "stage":
        require(args.execute, "stage needs explicit --execute")
        print(f"staged; receipt: {stage(value)}")
    else:
        require(not args.execute, "--execute is only valid for stage")
        check(value)
        print("ready: old app, runner, and supervisor stopped; private paths and UID pins agree")


if __name__ == "__main__":
    main()
