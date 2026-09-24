#!/usr/bin/env python3
"""Prepare sealed candidate settings for the isolated Incus qualification app.

This never runs a shell, changes a service, writes /etc, or changes the database.
The operator holds traffic before capturing the actual old app process environment.
"""

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path


CRYPTO = ("EZCORP_ENCRYPTION_SECRET", "EZCORP_ENCRYPTION_SALT", "EZCORP_JWT_SECRET")
SOURCE_KEYS = set(CRYPTO) | {
    "EZCORP_DB_PATH", "EZCORP_PROJECT_ROOT", "EZCORP_PORT", "ORIGIN",
    "EZCORP_PUBLIC_URL", "EZCORP_EXTENSION_RUNNER_SOCKET",
    "EZCORP_EXTENSION_RUNNER_TOKEN_FILE", "EZCORP_INCUS_SETUP_SSH_TARGET",
    "EZCORP_INCUS_SETUP_SSH_IDENTITY_FILE",
    "EZCORP_INCUS_SETUP_SSH_KNOWN_HOSTS_FILE",
    "EZCORP_INCUS_SETUP_SSH_HOST_KEY_SHA256", "EZCORP_INCUS_SETUP_ENDPOINT",
    "EZCORP_INCUS_SETUP_RECIPE_FILE",
}
FIELDS = {
    "sourcePid", "sourceStartTicks", "sourceBootId", "oldUid", "newUid", "runnerUid",
    "sourceDb", "sourceProjectRoot", "targetDb", "targetProjectRoot",
    "stageDir", "holdReceipt", "port", "origin", "publicUrl",
    "runnerSocket", "runnerTokenRuntime", "runnerStore", "supervisorSocket",
    "controlProbeRoot", "qualificationProjectId", "composeFixtureImageRef",
    "setupSshMode", "setupSshTarget", "setupSshIdentityFile",
    "setupSshKnownHostsFile", "setupSshHostKeySha256", "setupEndpoint",
    "setupRecipeFile",
}
FILES = ("old-isolated.env", "qualification.env", "qualification-runner.env",
         "qualification-runner-token", "qualification-settings-receipt.json")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def private_file(path):
    path = Path(path)
    require(path.is_absolute(), "absolute private file required")
    for parent in path.parents:
        item = parent.lstat()
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == 0
                and item.st_mode & 0o022 == 0,
                "private file has a mutable ancestor")
    item = path.lstat()
    require(stat.S_ISREG(item.st_mode) and item.st_uid == 0
            and stat.S_IMODE(item.st_mode) == 0o600,
            "root-owned mode 0600 file required")
    return path


def private_stage(path):
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts,
            "absolute stage path required")
    for parent in (path, *path.parents):
        item = parent.lstat()
        require(stat.S_ISDIR(item.st_mode) and item.st_uid == 0
                and item.st_mode & 0o022 == 0,
                "stage directory has a mutable ancestor")
    require(stat.S_IMODE(path.lstat().st_mode) == 0o700,
            "stage directory must be root-owned mode 0700")
    return path


def clean_value(value):
    require(isinstance(value, str) and value and len(value) <= 4096
            and not any(char.isspace() or ord(char) == 127 for char in value)
            and not any(char in value for char in ('"', "'", "\\", "$", "`", "%")),
            "setting is not a literal systemd environment value")
    return value


def absolute(value):
    clean_value(value)
    path = Path(value)
    require(path.is_absolute() and ".." not in path.parts and str(path) == value,
            "canonical absolute path required")
    return value


def manifest(path):
    value = json.loads(private_file(path).read_text())
    require(isinstance(value, dict) and set(value) == FIELDS,
            "settings manifest keys changed")
    for key in ("sourcePid", "sourceStartTicks", "oldUid", "newUid", "runnerUid", "port"):
        require(type(value[key]) is int and value[key] > 0, "positive numeric identity required")
    require(isinstance(value["sourceBootId"], str)
            and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}",
                             value["sourceBootId"]), "pinned boot identity required")
    require(len({value["oldUid"], value["newUid"], value["runnerUid"]}) == 3,
            "old app, dedicated app, and runner need distinct UIDs")
    for key in ("sourceDb", "sourceProjectRoot", "targetDb", "targetProjectRoot",
                "stageDir", "holdReceipt", "runnerSocket", "runnerTokenRuntime",
                "runnerStore", "supervisorSocket", "controlProbeRoot",
                "setupSshIdentityFile", "setupSshKnownHostsFile", "setupRecipeFile"):
        absolute(value[key])
    app_paths = tuple(Path(value[key]) for key in
                      ("sourceDb", "targetDb", "sourceProjectRoot", "targetProjectRoot"))
    stage = Path(value["stageDir"])
    require(all(stage != path and stage not in path.parents and path not in stage.parents
                for path in app_paths), "stage path overlaps app data")
    for key in FIELDS - {"sourcePid", "sourceStartTicks", "sourceBootId", "oldUid", "newUid",
                         "runnerUid", "port", "sourceDb", "sourceProjectRoot",
                         "targetDb", "targetProjectRoot", "stageDir", "holdReceipt",
                         "runnerSocket", "runnerTokenRuntime", "runnerStore",
                         "supervisorSocket", "controlProbeRoot",
                         "setupSshIdentityFile", "setupSshKnownHostsFile",
                         "setupRecipeFile"}:
        clean_value(value[key])
    require(value["setupSshMode"] == "reviewed-envelope-v1",
            "reviewed SSH gate required")
    require(re.fullmatch(r"SHA256:[A-Za-z0-9+/]{43}", value["setupSshHostKeySha256"]),
            "pinned SSH host fingerprint required")
    require(value["setupEndpoint"].startswith("https://"),
            "HTTPS setup endpoint required")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+",
                         value["setupSshTarget"]), "reviewed SSH principal required")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}",
                         value["qualificationProjectId"]), "qualification project ID invalid")
    require(re.fullmatch(r"[a-z0-9][a-z0-9.-]+(?::[1-9][0-9]{0,4})?/"
                         r"[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}",
                         value["composeFixtureImageRef"]), "pinned fixture image required")
    require(value["origin"].startswith("http://127.0.0.1:")
            and value["origin"] == value["publicUrl"]
            and value["origin"] == f"http://127.0.0.1:{value['port']}",
            "isolated local app origin required")
    return value


def parse_environ(raw):
    require(raw.endswith(b"\0"), "process environment is incomplete")
    values = {}
    for item in raw[:-1].split(b"\0"):
        key, separator, val = item.partition(b"=")
        require(separator and key and key not in values,
                "duplicate or invalid process environment")
        values[key] = val
    require(b"DATABASE_URL" not in values, "external database is forbidden")
    for key in values:
        name = key.decode("ascii", errors="strict")
        require(not name.startswith("EZCORP_") or name in SOURCE_KEYS,
                "unexpected app setting in old process")
    selected = {}
    for key in SOURCE_KEYS:
        encoded = key.encode()
        require(encoded in values, "old process setting is missing")
        selected[key] = clean_value(values[encoded].decode("utf-8", errors="strict"))
    return selected


def process_start_ticks(raw):
    right = raw.rfind(b")")
    require(right >= 0, "process stat is invalid")
    fields = raw[right + 2:].split()
    require(len(fields) > 19, "process stat is incomplete")
    return int(fields[19])


def read_old_process(value):
    require(Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            == value["sourceBootId"], "host boot changed")
    pid = value["sourcePid"]
    root = Path("/proc") / str(pid)
    before = process_start_ticks((root / "stat").read_bytes())
    require(before == value["sourceStartTicks"] and root.stat().st_uid == value["oldUid"],
            "old app PID, start time, or UID changed")
    selected = parse_environ((root / "environ").read_bytes())
    after = process_start_ticks((root / "stat").read_bytes())
    require(after == before, "old app process changed during capture")
    require(selected["EZCORP_DB_PATH"] == value["sourceDb"]
            and selected["EZCORP_PROJECT_ROOT"] == value["sourceProjectRoot"]
            and selected["EZCORP_PORT"] == str(value["port"])
            and selected["ORIGIN"] == value["origin"]
            and selected["EZCORP_PUBLIC_URL"] == value["publicUrl"],
            "old app source identity does not match reviewed manifest")
    return selected


def hold_receipt(value):
    receipt = json.loads(private_file(value["holdReceipt"]).read_text())
    require(type(receipt) is dict and set(receipt) ==
            {"sourcePid", "sourceStartTicks", "sourceBootId", "sourceDb", "trafficHeld"}
            and receipt["sourcePid"] == value["sourcePid"]
            and receipt["sourceStartTicks"] == value["sourceStartTicks"]
            and receipt["sourceBootId"] == value["sourceBootId"]
            and receipt["sourceDb"] == value["sourceDb"]
            and receipt["trafficHeld"] is True,
            "operator traffic hold receipt does not match old app")


def env_bytes(values):
    require("DATABASE_URL" not in values, "external database is forbidden")
    return "".join(f"{key}={clean_value(values[key])}\n"
                   for key in sorted(values)).encode()


def candidates(old, value, token):
    require(all(old[key] for key in CRYPTO), "old app crypto identity is incomplete")
    old_env = dict(old)
    app = {key: old[key] for key in
               (*CRYPTO, "EZCORP_DB_PATH", "EZCORP_PROJECT_ROOT", "EZCORP_PORT",
                "ORIGIN", "EZCORP_PUBLIC_URL")}
    app.update({
        "EZCORP_DB_PATH": value["targetDb"],
        "EZCORP_PROJECT_ROOT": value["targetProjectRoot"],
        "EZCORP_PROJECT_ROOT": value["targetProjectRoot"],
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
        "EZCORP_EXTENSION_RUNNER_SOCKET": value["runnerSocket"],
        "EZCORP_EXTENSION_RUNNER_TOKEN_FILE": value["runnerTokenRuntime"],
        "EZCORP_INCUS_SUPERVISOR_SOCKET": value["supervisorSocket"],
        "EZCORP_INCUS_CONTROL_PROBE_ROOT": value["controlProbeRoot"],
        "EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID": value["qualificationProjectId"],
        "EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF": value["composeFixtureImageRef"],
        "EZCORP_INCUS_SETUP_SSH_MODE": value["setupSshMode"],
        "EZCORP_INCUS_SETUP_SSH_TARGET": value["setupSshTarget"],
        "EZCORP_INCUS_SETUP_SSH_IDENTITY_FILE": value["setupSshIdentityFile"],
        "EZCORP_INCUS_SETUP_SSH_KNOWN_HOSTS_FILE": value["setupSshKnownHostsFile"],
        "EZCORP_INCUS_SETUP_SSH_HOST_KEY_SHA256": value["setupSshHostKeySha256"],
        "EZCORP_INCUS_SETUP_ENDPOINT": value["setupEndpoint"],
        "EZCORP_INCUS_SETUP_RECIPE_FILE": value["setupRecipeFile"],
    })
    runner = {
        "EZ_EXTENSION_APP_UID": str(value["newUid"]),
        "EZ_EXTENSION_RUNNER_SOCKET": value["runnerSocket"],
        "EZ_EXTENSION_RUNNER_TOKEN_FILE": value["runnerTokenRuntime"],
        "EZ_EXTENSION_RUNNER_STORE": value["runnerStore"],
    }
    return {
        FILES[0]: env_bytes(old_env),
        FILES[1]: env_bytes(app),
        FILES[2]: env_bytes(runner),
        FILES[3]: token,
    }


def file_digest(data):
    return hashlib.sha256(data).hexdigest()


def prepare(value):
    require(os.geteuid() == 0, "root operator required")
    stage = private_stage(value["stageDir"])
    require(not any(stage.iterdir()), "stage directory must be empty")
    hold_receipt(value)
    old = read_old_process(value)
    result = candidates(old, value, os.urandom(32).hex().encode() + b"\n")
    receipt = {
        "version": 1,
        "sourcePid": value["sourcePid"],
        "sourceStartTicks": value["sourceStartTicks"],
        "sourceBootId": value["sourceBootId"],
        "sourceDb": value["sourceDb"],
        "targetDb": value["targetDb"],
        "files": {name: file_digest(data) for name, data in result.items()},
    }
    result[FILES[4]] = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode() + b"\n"
    try:
        for name in FILES:
            fd = os.open(stage / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(result[name])
                stream.flush()
                os.fsync(stream.fileno())
        check(value)
    except Exception:
        for name in FILES:
            (stage / name).unlink(missing_ok=True)
        raise
    print("Prepared five sealed candidate files; receipt records hashes only.")


def parse_env_file(data):
    values = {}
    for line in data.decode().splitlines():
        key, separator, val = line.partition("=")
        require(separator and re.fullmatch(r"[A-Z][A-Z0-9_]*", key)
                and key not in values, "invalid candidate environment")
        values[key] = clean_value(val)
    return values


def check(value):
    require(os.geteuid() == 0, "root operator required")
    stage = private_stage(value["stageDir"])
    require(set(path.name for path in stage.iterdir()) == set(FILES),
            "candidate file set changed")
    data = {name: private_file(stage / name).read_bytes() for name in FILES}
    receipt = json.loads(data[FILES[4]])
    require(type(receipt) is dict and set(receipt) ==
            {"version", "sourcePid", "sourceStartTicks", "sourceBootId",
             "sourceDb", "targetDb", "files"}
            and receipt["version"] == 1
            and receipt["sourcePid"] == value["sourcePid"]
            and receipt["sourceStartTicks"] == value["sourceStartTicks"]
            and receipt["sourceBootId"] == value["sourceBootId"]
            and receipt["sourceDb"] == value["sourceDb"]
            and receipt["targetDb"] == value["targetDb"]
            and receipt["files"] == {name: file_digest(data[name]) for name in FILES[:-1]},
            "candidate receipt changed")
    old = parse_env_file(data[FILES[0]])
    app = parse_env_file(data[FILES[1]])
    runner = parse_env_file(data[FILES[2]])
    require(set(old) == SOURCE_KEYS,
            "old baseline keys changed")
    expected = candidates(old, value, data[FILES[3]])
    require(data[FILES[0]] == expected[FILES[0]]
            and data[FILES[1]] == expected[FILES[1]]
            and data[FILES[2]] == expected[FILES[2]],
            "candidate settings changed")
    require(old["EZCORP_DB_PATH"] == value["sourceDb"]
            and old["EZCORP_PROJECT_ROOT"] == value["sourceProjectRoot"]
            and old["EZCORP_PORT"] == str(value["port"])
            and old["ORIGIN"] == value["origin"]
            and old["EZCORP_PUBLIC_URL"] == value["publicUrl"],
            "old baseline identity changed")
    require(all(old[key] == app[key] for key in CRYPTO),
            "crypto identity changed")
    require(set(runner) == {"EZ_EXTENSION_APP_UID", "EZ_EXTENSION_RUNNER_SOCKET",
                            "EZ_EXTENSION_RUNNER_TOKEN_FILE", "EZ_EXTENSION_RUNNER_STORE"},
            "runner keys changed")
    require(re.fullmatch(rb"[0-9a-f]{64}\n", data[FILES[3]]),
            "runner token candidate is invalid")
    print("Sealed candidate files match the pinned source and manifest.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("action", choices=("prepare", "check"))
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    require(args.action != "prepare" or args.execute,
            "prepare requires --execute")
    value = manifest(args.manifest)
    if args.action == "prepare":
        prepare(value)
    else:
        check(value)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, UnicodeError, KeyError, json.JSONDecodeError) as error:
        print(f"Settings preparation refused: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
