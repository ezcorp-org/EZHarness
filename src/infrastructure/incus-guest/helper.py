#!/usr/bin/env python3
"""EZHarness guest protocol 0.1.0. Install as an immutable, guest-owned executable.

The command mode reads one bounded JSON request from stdin and writes one JSON reply.
Only the trusted installer selects /workspace and /var/lib/ezharness-helper.
"""
import base64
import binascii
import ctypes
import errno
import hashlib
import json
import os
import pwd
import re
import selectors
import signal
import stat
import struct
import subprocess
import sys
import time
import uuid
import fcntl

VERSION = "0.1.0"
MAX_REQUEST = 2 * 1024 * 1024
MAX_TRANSFER = 64 * 1024
MAX_OUTPUT = 1024 * 1024
MAX_PAGE = 64 * 1024
MAX_PROCESS_MS = 30 * 60 * 1000
IDENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC


class Failure(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


def require(test, kind="invalid", message="Invalid guest request"):
    if not test:
        raise Failure(kind, message)


def text_id(value):
    require(isinstance(value, str) and IDENT.fullmatch(value))
    return value


def bounded_int(value, minimum, maximum):
    require(type(value) is int and minimum <= value <= maximum)
    return value


def parts(path):
    require(isinstance(path, str) and path and not path.startswith("/") and "\\" not in path)
    if path == ".":
        return []
    names = path.split("/")
    require(all(name not in ("", ".", "..") and "\x00" not in name for name in names))
    return names


def directory_fd(root, names):
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        for name in names:
            next_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def parent_fd(root, path):
    names = parts(path)
    require(names, message="Workspace root cannot be changed")
    return directory_fd(root, names[:-1]), names[-1]


def revision(info):
    raw = f"{info.st_dev}:{info.st_ino}:{info.st_mode}:{info.st_size}:{info.st_mtime_ns}:{info.st_ctime_ns}"
    return hashlib.sha256(raw.encode()).hexdigest()


def entry(path, info):
    require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode),
            "invalid", "Unsupported file type")
    kind = "directory" if stat.S_ISDIR(info.st_mode) else "symlink" if stat.S_ISLNK(info.st_mode) else "file"
    return {"path": path, "kind": kind,
            "revision": revision(info), "sizeBytes": info.st_size if kind == "file" else 0,
            "executable": kind == "file" and bool(info.st_mode & 0o111)}


def stat_at(root, path):
    names = parts(path)
    if not names:
        fd = directory_fd(root, [])
        try:
            return entry(".", os.fstat(fd))
        finally:
            os.close(fd)
    parent, name = parent_fd(root, path)
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        return entry(path, info)
    finally:
        os.close(parent)


def atomic_json(path, value):
    temp = f"{path}.{uuid.uuid4().hex}.tmp"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass


def update_state(directory, patch):
    lock = os.open(os.path.join(directory, "status.lock"), os.O_CREAT | os.O_RDWR | NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = os.path.join(directory, "status.json")
        with open(path, encoding="utf8") as stream:
            current = json.load(stream)
        current.update(patch)
        atomic_json(path, current)
        return current
    finally:
        os.close(lock)


def boot_id():
    with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
        return stream.read().strip()


def proc_start(pid):
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii") as stream:
            line = stream.read()
        return int(line[line.rfind(")") + 2:].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def process_dir(state_root, process_id):
    text_id(process_id)
    return os.path.join(state_root, process_id)


def journaled_file_mutation(action, request, state_root, root):
    request_id = text_id(request.get("requestId"))
    key = text_id(request.get("idempotencyKey"))
    identifier = hashlib.sha256(f"{request['sandboxId']}\0{request_id}\0{key}".encode()).hexdigest()
    request_digest = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    directory = os.path.join(state_root, "mutations")
    os.makedirs(directory, mode=0o700, exist_ok=True)
    lock = os.open(os.path.join(directory, identifier + ".lock"), os.O_CREAT | os.O_RDWR | NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        journal = os.path.join(directory, identifier + ".json")
        try:
            with open(journal, encoding="utf8") as stream:
                prior = json.load(stream)
        except FileNotFoundError:
            prior = None
        if prior is not None:
            require(prior.get("digest") == request_digest, "revision_conflict",
                    "File operation identity was reused with different input")
            require(prior.get("state") == "complete", "internal", "File mutation outcome is unknown")
            return prior["result"]
        atomic_json(journal, {"digest": request_digest, "state": "pending"})
        result = file_action(action, request, root)
        atomic_json(journal, {"digest": request_digest, "state": "complete", "result": result})
        return result
    finally:
        os.close(lock)


def process_state(state_root, request):
    directory = process_dir(state_root, request.get("processId"))
    with open(os.path.join(directory, "status.json"), encoding="utf8") as stream:
        state = json.load(stream)
    require(state.get("sandboxId") == request.get("sandboxId") and
            state.get("bootId") == request.get("bootId") == boot_id(),
            "not_found", "Process identity does not match this guest boot")
    return directory, state


def live_process(state):
    pid = state.get("pid")
    return type(pid) is int and proc_start(pid) == state.get("pidStart")


def file_action(action, request, root):
    path = request.get("path")
    names = parts(path)
    if action == "file.stat":
        return {"file": stat_at(root, path)}
    if action == "file.list":
        fd = directory_fd(root, names)
        try:
            info = os.fstat(fd)
            directory_revision = revision(info)
            cursor = request.get("cursor")
            if cursor is not None:
                require(isinstance(cursor, dict) and cursor.get("sandboxId") == request["sandboxId"] and
                        cursor.get("directoryRevision") == directory_revision,
                        "revision_conflict", "Directory changed")
                after = cursor.get("afterName")
                require(isinstance(after, str))
            else:
                after = ""
            limit = bounded_int(request.get("limit"), 1, 100)
            results = []
            for name in sorted(os.listdir(fd)):
                if name <= after or name.startswith(".ezh-lock-") or name.startswith(".ezh-"):
                    continue
                item = entry(("" if path == "." else path + "/") + name,
                             os.stat(name, dir_fd=fd, follow_symlinks=False))
                results.append(item)
                if len(results) > limit:
                    break
            more = len(results) > limit
            results = results[:limit]
            reply = {"directoryRevision": directory_revision, "entries": results}
            if more:
                reply["nextCursor"] = {"sandboxId": request["sandboxId"],
                                       "directoryRevision": directory_revision,
                                       "afterName": results[-1]["path"].split("/")[-1]}
            return reply
        finally:
            os.close(fd)
    if action == "file.readRange":
        parent, name = parent_fd(root, path)
        try:
            fd = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=parent)
            try:
                info = os.fstat(fd)
                require(stat.S_ISREG(info.st_mode), message="Expected regular file")
                current = revision(info)
                require(request.get("revision") == current, "revision_conflict", "File changed")
                offset = bounded_int(request.get("offsetBytes"), 0, 2**53 - 1)
                length = bounded_int(request.get("lengthBytes"), 0, MAX_TRANSFER)
                data = os.pread(fd, length, offset)
                require(revision(os.fstat(fd)) == current, "revision_conflict", "File changed during read")
                return {"path": path, "revision": current, "offsetBytes": offset,
                        "dataBase64": base64.b64encode(data).decode("ascii"), "byteLength": len(data),
                        "eof": offset + len(data) >= info.st_size}
            finally:
                os.close(fd)
        finally:
            os.close(parent)
    if action == "file.writeAtomic":
        data64 = request.get("dataBase64")
        require(isinstance(data64, str) and len(data64) <= (MAX_TRANSFER * 4 // 3) + 8)
        try:
            data = base64.b64decode(data64, validate=True)
        except (ValueError, binascii.Error):
            raise Failure("invalid", "Invalid base64") from None
        require(len(data) == request.get("byteLength") and len(data) <= MAX_TRANSFER)
        expected = request.get("expectedRevision")
        require(expected is None or isinstance(expected, str))
        parent, name = parent_fd(root, path)
        temp = f".ezh-{uuid.uuid4().hex}"
        lock = os.open(f".ezh-lock-{hashlib.sha256(name.encode()).hexdigest()}",
                       os.O_CREAT | os.O_RDWR | NOFOLLOW, 0o600, dir_fd=parent)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                existing = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require(stat.S_ISREG(existing.st_mode), message="Expected regular file")
                require(expected == revision(existing), "revision_conflict", "File changed")
            except FileNotFoundError:
                require(expected is None, "revision_conflict", "File is absent")
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=parent)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fchmod(stream.fileno(), 0o755 if request.get("executable") is True else 0o644)
                    os.fsync(stream.fileno())
                # Recheck CAS immediately before replacement. Callers serialize same-path writes.
                try:
                    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    require(expected == revision(before), "revision_conflict", "File changed")
                except FileNotFoundError:
                    require(expected is None, "revision_conflict", "File appeared")
                os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
                os.fsync(parent)
                return {"path": path, "revision": revision(os.stat(name, dir_fd=parent,
                                                                       follow_symlinks=False)), "sizeBytes": len(data)}
            finally:
                try:
                    os.unlink(temp, dir_fd=parent)
                except FileNotFoundError:
                    pass
        finally:
            os.close(lock)
            os.close(parent)
    if action == "file.remove":
        require(names, message="Cannot remove workspace root")
        parent, name = parent_fd(root, path)
        lock = os.open(f".ezh-lock-{hashlib.sha256(name.encode()).hexdigest()}",
                       os.O_CREAT | os.O_RDWR | NOFOLLOW, 0o600, dir_fd=parent)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(request.get("expectedRevision") == revision(info), "revision_conflict", "File changed")
            require(request.get("recursive") is False, "unsupported", "Recursive delete is unavailable")
            if stat.S_ISDIR(info.st_mode):
                os.rmdir(name, dir_fd=parent)
            else:
                require(stat.S_ISREG(info.st_mode), message="Unsupported file type")
                os.unlink(name, dir_fd=parent)
            os.fsync(parent)
            return {"removedRevision": revision(info)}
        finally:
            os.close(lock)
            os.close(parent)
    raise Failure("unsupported", "Unknown file action")


def supervise(directory, argv, env, cwd_fd, deadline_ms):
    status_path = os.path.join(directory, "status.json")
    with open(status_path, encoding="utf8") as stream:
        state = json.load(stream)
    expected_parent = os.getpid()
    def child_setup():
        os.fchdir(cwd_fd)
        os.setpgid(0, 0)
        libc = ctypes.CDLL(None)
        libc.prctl(1, signal.SIGKILL, 0, 0, 0)  # PR_SET_PDEATHSIG
        if os.getppid() != expected_parent:
            os._exit(127)
    child = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             preexec_fn=child_setup, close_fds=True, pass_fds=(cwd_fd,))
    os.close(cwd_fd)
    state = update_state(directory, {"state": "running", "pid": child.pid, "pidStart": proc_start(child.pid)})
    poller = selectors.DefaultSelector()
    for stream, label in ((child.stdout, 1), (child.stderr, 2)):
        os.set_blocking(stream.fileno(), False)
        poller.register(stream, selectors.EVENT_READ, label)
    out_fd = os.open(os.path.join(directory, "output.bin"), os.O_WRONLY | os.O_APPEND | NOFOLLOW)
    written = 0
    data_written = 0
    dropped = 0
    published = 0
    published_at = time.monotonic()
    truncated = False
    reason = None
    try:
        while poller.get_map() or child.poll() is None:
            with open(status_path, encoding="utf8") as stream:
                current = json.load(stream)
            if current.get("cancelRequested") and reason is None:
                reason = "cancelled"
                os.killpg(child.pid, signal.SIGTERM)
            if int(time.time() * 1000) >= deadline_ms and reason is None:
                reason = "timed_out"
                os.killpg(child.pid, signal.SIGTERM)
            if reason and "termination_at" not in locals():
                termination_at = time.monotonic()
            if reason and child.poll() is None and time.monotonic() - termination_at > 2:
                os.killpg(child.pid, signal.SIGKILL)
            for key, _ in poller.select(timeout=0.1):
                data = os.read(key.fileobj.fileno(), 8192)
                if not data:
                    poller.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                space = MAX_OUTPUT - written
                chunk = data[:max(0, min(space - 5, len(data)))]
                if chunk:
                    os.write(out_fd, bytes([key.data]) + struct.pack(">I", len(chunk)) + chunk)
                    written += len(chunk) + 5
                    data_written += len(chunk)
                if len(chunk) < len(data):
                    truncated = True
                    dropped += len(data) - len(chunk)
            if data_written - published >= 64 * 1024 or time.monotonic() - published_at >= 0.25:
                update_state(directory, {"outputBytes": data_written, "droppedBytes": dropped,
                                         "truncated": truncated})
                published = data_written
                published_at = time.monotonic()
        code = child.wait()
        update_state(directory, {"state": reason or ("succeeded" if code == 0 else "failed"),
                                 "exitCode": code if code >= 0 else None,
                                 "signal": signal.Signals(-code).name if code < 0 else None,
                                 "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                 "outputBytes": data_written, "droppedBytes": dropped,
                                 "truncated": truncated})
    finally:
        os.close(out_fd)


def process_action(action, request, state_root, root):
    if action == "process.start":
        argv = request.get("argv")
        require(isinstance(argv, list) and 0 < len(argv) <= 128 and
                all(isinstance(a, str) and a and "\x00" not in a and len(a) <= 8192 for a in argv))
        cwd = request.get("cwd")
        names = parts(cwd)
        deadline = bounded_int(request.get("processDeadlineMs"), 1, 2**53 - 1)
        entries = request.get("env")
        require(isinstance(entries, list) and len(entries) <= 128)
        env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": "/workspace"}
        for item in entries:
            require(isinstance(item, dict) and isinstance(item.get("name"), str) and
                    re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", item["name"]) and
                    isinstance(item.get("value"), str) and "\x00" not in item["value"] and
                    len(item["value"]) <= 8192)
            require(item["name"] not in ("LD_PRELOAD", "LD_LIBRARY_PATH"), "permission", "Unsafe environment")
            env[item["name"]] = item["value"]
        request_id = text_id(request.get("requestId"))
        key = text_id(request.get("idempotencyKey"))
        identity = f"{request['sandboxId']}\0{request_id}\0{key}"
        process_id = hashlib.sha256(identity.encode()).hexdigest()[:32]
        request_digest = hashlib.sha256(json.dumps({"sandboxId": request["sandboxId"], "user": request["user"],
            "argv": argv, "cwd": cwd, "env": entries, "processDeadlineMs": deadline},
            sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        directory = process_dir(state_root, process_id)
        def replay():
            with open(os.path.join(directory, "status.json"), encoding="utf8") as stream:
                existing = json.load(stream)
            require(existing.get("requestDigest") == request_digest and
                    existing.get("sandboxId") == request["sandboxId"],
                    "revision_conflict", "Process operation identity was reused with different input")
            require(existing.get("bootId") == boot_id(), "not_found", "Process belongs to another guest boot")
            return {"processId": process_id, "bootId": existing["bootId"], "startedAt": existing["startedAt"]}
        if os.path.isdir(directory):
            return replay()
        require(deadline > int(time.time() * 1000) and deadline <= int(time.time() * 1000) + MAX_PROCESS_MS)
        fd = directory_fd(root, names)
        try:
            os.mkdir(directory, 0o700)
        except FileExistsError:
            os.close(fd)
            return replay()
        state = {"processId": process_id, "sandboxId": request["sandboxId"], "bootId": boot_id(),
                 "requestDigest": request_digest,
                 "state": "starting", "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                 "finishedAt": None, "exitCode": None, "signal": None, "outputBytes": 0,
                 "droppedBytes": 0, "truncated": False}
        atomic_json(os.path.join(directory, "status.json"), state)
        os.close(os.open(os.path.join(directory, "output.bin"), os.O_CREAT | os.O_EXCL | os.O_WRONLY | NOFOLLOW, 0o600))
        pid = os.fork()
        if pid == 0:
            try:
                os.setsid()
                null = os.open(os.devnull, os.O_RDWR)
                for stream_fd in (0, 1, 2):
                    os.dup2(null, stream_fd)
                os.close(null)
                supervise(directory, argv, env, fd, deadline)
            except BaseException as error:
                try:
                    with open(os.path.join(directory, "status.json"), encoding="utf8") as stream:
                        failed = json.load(stream)
                    failed.update(state="failed", error=repr(error), finishedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                    atomic_json(os.path.join(directory, "status.json"), failed)
                except BaseException:
                    pass
                os._exit(1)
            os._exit(0)
        os.close(fd)
        return {"processId": process_id, "bootId": state["bootId"], "startedAt": state["startedAt"]}
    directory, state = process_state(state_root, request)
    if action == "process.inspect":
        if state["state"] in ("starting", "running") and state.get("pid") and not live_process(state):
            state["state"] = "unknown"
        return {"process": {key: state[key] for key in ("processId", "sandboxId", "bootId", "state",
                                                "startedAt", "finishedAt", "exitCode", "signal")}}
    if action == "process.cancel":
        if state["state"] in ("starting", "running"):
            state = update_state(directory, {"cancelRequested": True})
        return {"process": {key: state[key] for key in ("processId", "sandboxId", "bootId", "state",
                                                "startedAt", "finishedAt", "exitCode", "signal")}}
    if action == "process.readOutput":
        cursor = request.get("cursor")
        require(isinstance(cursor, dict) and cursor.get("sandboxId") == state["sandboxId"] and
                cursor.get("processId") == state["processId"] and cursor.get("bootId") == state["bootId"])
        offset = bounded_int(cursor.get("offsetBytes"), 0, MAX_OUTPUT)
        maximum = bounded_int(request.get("maxBytes"), 1, MAX_PAGE)
        chunks = []
        with open(os.path.join(directory, "output.bin"), "rb") as stream:
            position = 0
            used = 0
            while used < maximum and len(chunks) < 128:
                header = stream.read(5)
                if not header:
                    break
                require(len(header) == 5, "internal", "Corrupt output frame")
                size = struct.unpack(">I", header[1:])[0]
                require(size <= 8192, "internal", "Corrupt output frame")
                data = stream.read(size)
                require(len(data) == size, "internal", "Incomplete output frame")
                if position + size <= offset:
                    position += size
                    continue
                begin = max(0, offset - position)
                chunk = data[begin:begin + maximum - used]
                chunks.append({"stream": "stdout" if header[0] == 1 else "stderr",
                               "offsetBytes": position + begin, "byteLength": len(chunk),
                               "dataBase64": base64.b64encode(chunk).decode("ascii")})
                used += len(chunk)
                position += size
            next_offset = offset + used
        terminal = state["state"] not in ("starting", "running")
        gap = {"fromOffsetBytes": state["outputBytes"],
               "toOffsetBytes": state["outputBytes"] + state.get("droppedBytes", 0),
               "reason": "overflow"} if state["truncated"] and next_offset >= state["outputBytes"] else None
        return {"nextCursor": {**cursor, "offsetBytes": gap["toOffsetBytes"] if gap else next_offset},
                "chunks": chunks, "eof": terminal and next_offset >= state["outputBytes"],
                **({"gap": gap} if gap else {})}
    raise Failure("unsupported", "Unknown process action")


def handle(request, root="/workspace", state_root="/var/lib/ezharness-helper"):
    require(isinstance(request, dict) and request.get("version") == VERSION,
            "unsupported", "Guest helper version mismatch")
    require(request.get("user") == pwd.getpwuid(os.geteuid()).pw_name,
            "permission", "Guest user mismatch")
    text_id(request.get("sandboxId"))
    action = request.get("action")
    require(isinstance(action, str))
    if action == "hello":
        result = {"workspaceRoot": "/workspace", "guestUser": request["user"], "bootId": boot_id()}
    elif action in ("file.writeAtomic", "file.remove"):
        result = journaled_file_mutation(action, request, state_root, root)
    elif action.startswith("file."):
        result = file_action(action, request, root)
    elif action.startswith("process."):
        result = process_action(action, request, state_root, root)
    else:
        raise Failure("unsupported", "Unknown guest action")
    return {"version": VERSION, "ok": True, **result}


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        require(len(raw) <= MAX_REQUEST, "resource_exhausted", "Guest request too large")
        request = json.loads(raw)
        response = handle(request)
    except Failure as error:
        response = {"version": VERSION, "ok": False, "error": {"kind": error.kind, "message": str(error)}}
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        kind = "not_found" if isinstance(error, FileNotFoundError) else "invalid"
        response = {"version": VERSION, "ok": False, "error": {"kind": kind, "message": "Guest operation failed"}}
    sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
