#!/usr/bin/env python3
"""Build and verify a relocatable qualification release; never install it."""

import argparse
import copy
import hashlib
import io
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


REQUIRED = (
    "web/build/index.js",
    "packages/@ezcorp/extension-runner/src/main.ts",
    "packages/@ezcorp/sdk/src/index.ts",
    "packages/@ezcorp/extension-contract/src/index.ts",
    "scripts/incus/incus-qualification-supervisor.py",
    "scripts/incus/recipe.json",
    "dist/native-tools.js",
    "dist/sandbox-supervisor",
    "node_modules/@ezcorp/extension-runner",
    "web/node_modules/@sveltejs/kit",
)
MANIFEST = "release-bundle-manifest.json"
RUNTIME_DIR = ".ezcorp"
BUN_VERSION = ".bun-version"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def pinned_bun_version(root):
    path = root / BUN_VERSION
    require(path.is_file() and stat.S_ISREG(path.lstat().st_mode),
            "regular .bun-version is required")
    require(0 < path.stat().st_size <= 32, "invalid .bun-version")
    raw = path.read_bytes()
    match = re.fullmatch(rb"([0-9]+\.[0-9]+\.[0-9]+)\n?", raw)
    require(match is not None, "invalid .bun-version")
    return match.group(1).decode("ascii")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(argv, *, cwd=None, env=None):
    subprocess.run(argv, cwd=cwd, env=env, check=True, timeout=1800)


def git_head(source):
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    require(len(head) == 40 and all(c in "0123456789abcdef" for c in head), "invalid Git HEAD")
    require(not subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"],
                                        cwd=source), "source checkout must be clean")
    return head


def extract_head(source, target):
    archive = subprocess.check_output(["git", "archive", "--format=tar", "HEAD"], cwd=source)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as members:
        entries = {}
        for item in members.getmembers():
            name = Path(item.name)
            require(name.parts and not name.is_absolute() and ".." not in name.parts,
                    "archive path escapes release")
            require(name.parts[0] != RUNTIME_DIR, "tracked reserved runtime path is not allowed")
            require(item.isfile() or item.isdir() or item.issym(),
                    "tracked hard links or special files are not allowed")
            require(name != Path(BUN_VERSION) or item.isfile(), "tracked Bun version pin must be regular")
            require(name not in entries, "duplicate archive path")
            entries[name] = item
        # Validate the complete tree before writing anything. A source link
        # cannot act as a directory, even when its target is inside the archive.
        for name in entries:
            for parent in name.parents:
                require(parent not in entries or entries[parent].isdir(),
                        "archive parent must be a directory")
        extracted = []
        for name, item in entries.items():
            if item.issym():
                link = Path(item.linkname)
                require(link.parts and not link.is_absolute(), "tracked link target must be relative")
                require(not item.linkname.endswith(("/", "/.")),
                        "tracked links must target regular archived files directly")
                parts = list(name.parent.parts)
                for index, part in enumerate(link.parts):
                    if part == "..":
                        require(parts, "tracked link target escapes release")
                        parts.pop()
                    else:
                        parts.append(part)
                        parent = entries.get(Path(*parts))
                        require(index == len(link.parts) - 1 or parent is not None and parent.isdir(),
                                "tracked link target traverses a non-directory")
                referent = entries.get(Path(*parts))
                require(referent is not None and referent.isfile(),
                        "tracked links must target regular archived files directly")
                # Read bytes and mode from that Git archive member, never from
                # the checkout or a host link. No filesystem link is created.
                item = copy.copy(referent)
                item.name = name.as_posix()
            extracted.append(item)
        members.extractall(target, members=extracted, filter="data")


def immutable_entries(root):
    """Fresh metadata for every immutable entry; never follow directory links."""
    def visit(directory):
        with os.scandir(directory) as entries:
            for entry in entries:
                path = Path(entry.path)
                status = entry.stat(follow_symlinks=False)
                if directory == root and entry.name == RUNTIME_DIR:
                    require(stat.S_ISDIR(status.st_mode), "runtime directory must not be a symlink or file")
                    continue
                yield path, status
                if stat.S_ISDIR(status.st_mode):
                    yield from visit(path)

    yield root, root.lstat()
    yield from visit(root)


def immutable_paths(root):
    return sorted(path for path, _status in immutable_entries(root))


def normalize_modes(root):
    for path in immutable_paths(root):
        status = path.lstat()
        mode = status.st_mode
        if stat.S_ISLNK(mode):
            continue
        if stat.S_ISDIR(mode):
            safe_mode = 0o755
        elif stat.S_ISREG(mode):
            safe_mode = 0o755 if mode & 0o111 else 0o644
        else:
            raise ValueError(f"special file in release: {path.relative_to(root)}")
        if stat.S_IMODE(mode) == safe_mode:
            continue
        if stat.S_ISREG(mode) and status.st_nlink > 1:
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
                temporary_path = Path(temporary.name)
            try:
                shutil.copyfile(path, temporary_path)
                os.chmod(temporary_path, safe_mode)
                temporary_path.replace(path)
            finally:
                temporary_path.unlink(missing_ok=True)
        else:
            os.chmod(path, safe_mode)


def check_safe_modes(root):
    for path in immutable_paths(root):
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode) or stat.S_ISREG(mode):
            kind = "directory" if stat.S_ISDIR(mode) else "file"
            require(not mode & 0o022,
                    f"writable release {kind}: {path.relative_to(root)}")


def inventory(root):
    files = []
    for path in immutable_paths(root):
        relative = path.relative_to(root).as_posix()
        if relative == MANIFEST:
            continue
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            continue
        entry = {"path": relative, "mode": stat.S_IMODE(mode)}
        if stat.S_ISREG(mode):
            entry.update(type="file", size=path.stat().st_size, sha256=sha256(path))
        elif stat.S_ISLNK(mode):
            resolved = path.resolve(strict=True)
            require(resolved.is_relative_to(root.resolve())
                    and (resolved.is_file() or resolved.is_dir()),
                    f"dependency link escapes release: {relative}")
            entry.update(type="link", target=os.readlink(path))
        else:
            raise ValueError(f"special file in release: {relative}")
        files.append(entry)
    return files


def check_required(root):
    for relative in REQUIRED:
        path = root / relative
        expected = path.is_dir() if relative.startswith(("node_modules/", "web/node_modules/")) else path.is_file()
        require(expected, f"required release file is absent: {relative}")
    require((root / "bin/bun").is_file(), "pinned Bun is absent")


def check_runtime_placeholder(root):
    try:
        mode = (root / RUNTIME_DIR).lstat().st_mode
    except FileNotFoundError as error:
        raise ValueError("runtime directory is absent") from error
    require(stat.S_ISDIR(mode), "runtime directory must not be a symlink or file")
    require(stat.S_IMODE(mode) == 0o755, "runtime directory must have mode 0755")


def check_empty_runtime_placeholder(root):
    check_runtime_placeholder(root)
    require(not any((root / RUNTIME_DIR).iterdir()), "runtime placeholder must be empty")


def check_runtime_directory(path, uid, gid, mode):
    status = path.lstat()
    require(stat.S_ISDIR(status.st_mode) and status.st_uid == uid
            and status.st_gid == gid and stat.S_IMODE(status.st_mode) == mode,
            f"unsafe bound runtime directory: {path}")
    return status


def is_exact_mountpoint(path):
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        mountpoint = line.split()[4]
        for escaped, plain in ((r"\040", " "), (r"\011", "\t"),
                               (r"\012", "\n"), (r"\134", "\\")):
            mountpoint = mountpoint.replace(escaped, plain)
        if mountpoint == str(path):
            return True
    return False


def check_bound_runtime(root, source, app_uid, app_gid, owner=0):
    require(isinstance(source, str) and source.startswith("/")
            and type(app_uid) is int and app_uid > 0
            and type(app_gid) is int and app_gid > 0,
            "explicit bound runtime source and app identity required")
    configured_source = source
    source = Path(source)
    require(str(source) == configured_source and source == source.resolve(strict=True)
            and not source.is_relative_to(root),
            "bound runtime source must be canonical and outside release")
    check_runtime_directory(source.parent, owner, app_gid, 0o730)
    for ancestor in source.parent.parents:
        status = ancestor.stat()
        require(status.st_uid == owner and not status.st_mode & 0o022,
                "unsafe bound runtime ancestor")
    source_status = check_runtime_directory(source, app_uid, app_gid, 0o700)
    target = root / RUNTIME_DIR
    target_status = check_runtime_directory(target, app_uid, app_gid, 0o700)
    require(is_exact_mountpoint(target)
            and (source_status.st_dev, source_status.st_ino)
            == (target_status.st_dev, target_status.st_ino),
            "configured runtime bind mount is missing or changed")
    return source_status.st_dev, source_status.st_ino


def remove_empty_runtime_dirs(root):
    def clean(directory):
        for path in directory.iterdir():
            if stat.S_ISDIR(path.lstat().st_mode):
                clean(path)
                if not any(path.iterdir()):
                    path.rmdir()

    clean(root / RUNTIME_DIR)


def verify(root, *, runtime_source=None, app_uid=None, app_gid=None, owner=0):
    root = root.resolve(strict=True)
    if runtime_source is None:
        check_runtime_placeholder(root)
    else:
        check_bound_runtime(root, runtime_source, app_uid, app_gid, owner)
    check_safe_modes(root)
    document = json.loads((root / MANIFEST).read_text())
    require(set(document) == {"schema", "gitSha", "bunVersion", "bunSha256", "locks", "files"}
            and document["schema"] == 1 and document["bunVersion"] == pinned_bun_version(root),
            "release manifest schema or Bun version changed")
    require(document["bunSha256"] == sha256(root / "bin/bun"), "Bun digest changed")
    for relative, digest in document["locks"].items():
        require(relative in ("bun.lock", "web/bun.lock") and digest == sha256(root / relative),
                "dependency lock changed")
    require(set(document["locks"]) == {"bun.lock", "web/bun.lock"}, "dependency locks incomplete")
    check_required(root)
    require(document["files"] == inventory(root), "release file inventory changed")
    return document


def smoke(root, native_lib_dir=None):
    require(os.geteuid() != 0, "smoke must run as a non-root user")
    verify(root)
    check_empty_runtime_placeholder(root)
    if native_lib_dir is not None:
        native_lib_dir = native_lib_dir.resolve(strict=True)
        require(native_lib_dir.is_dir() and (native_lib_dir / "libstdc++.so.6").is_file(),
                "native library directory must contain libstdc++.so.6")
    with tempfile.TemporaryDirectory(prefix="ezh-bundle-smoke-", dir="/tmp") as scratch:
        scratch = Path(scratch)
        require(not scratch.is_relative_to(Path("/home/dev")), "smoke data must be outside /home/dev")
        (scratch / "projects").mkdir()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = {"PATH": os.environ.get("PATH", "/run/current-system/sw/bin:/usr/bin:/bin"),
               "HOME": str(scratch), "XDG_CACHE_HOME": str(scratch / "cache"),
               "NODE_ENV": "production", "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
               "HOST": "127.0.0.1", "PORT": str(port), "ORIGIN": f"http://127.0.0.1:{port}",
               "EZCORP_DB_PATH": str(scratch / "db"),
               "EZCORP_PROJECT_ROOT": str(root),
               "EZCORP_ENCRYPTION_SECRET": "smoke-only-encryption-secret-32-bytes",
               "EZCORP_JWT_SECRET": "smoke-only-jwt-secret-32-bytes"}
        if native_lib_dir is not None:
            env["LD_LIBRARY_PATH"] = str(native_lib_dir)
        process = subprocess.Popen([str(root / "bin/bun"), str(root / "web/build/index.js")],
                                   cwd=root, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True)
        try:
            url = f"http://127.0.0.1:{port}/api/health"
            deadline = time.monotonic() + 45
            status = None
            while time.monotonic() < deadline:
                require(process.poll() is None, "bundled app exited during smoke; check the pinned native library path")
                try:
                    with urllib.request.urlopen(url, timeout=2) as response:
                        status = response.status
                except urllib.error.HTTPError as error:
                    status = error.code
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.25)
                    continue
                break
            require(status in (200, 401), f"bundled app health check failed: {status}")
        finally:
            process.terminate()
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)
            remove_empty_runtime_dirs(root)
        check_empty_runtime_placeholder(root)
        verify(root)
        return {"healthStatus": status, "nonRootUid": os.geteuid(),
                "smokeRoot": str(scratch)}


def stage(source, output, bun, expected_bun_sha256):
    source = source.resolve(strict=True)
    output = output.absolute()
    require(not output.exists(), "release destination already exists")
    require(not output.is_relative_to(source), "release destination cannot be inside source checkout")
    require(any(output.parent.resolve(strict=False).is_relative_to(Path(allowed))
                for allowed in ("/tmp", "/var/tmp")),
            "release staging destination must be under /tmp or /var/tmp")
    require(len(expected_bun_sha256) == 64 and sha256(bun) == expected_bun_sha256,
            "pinned Bun SHA-256 mismatch")
    head = git_head(source)
    version = pinned_bun_version(source)
    require(subprocess.check_output([str(bun), "--version"], text=True).strip() == version,
            f"Bun {version} is required")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".ezh-release-build-", dir=output.parent) as temporary:
        work = Path(temporary) / "release"
        work.mkdir()
        extract_head(source, work)
        require(pinned_bun_version(work) == version, "archived Bun version changed")
        (work / "bin").mkdir()
        shutil.copy2(bun, work / "bin/bun")
        os.chmod(work / "bin/bun", 0o755)
        cache = Path(temporary) / "cache"
        home = Path(temporary) / "home"
        home.mkdir()
        env = {**os.environ, "HOME": str(home), "BUN_INSTALL_CACHE_DIR": str(cache),
               "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
               "PATH": f"{work / 'bin'}:{os.environ.get('PATH', '')}"}
        executable = str(work / "bin/bun")
        dependency_roots = (work, work / "web")
        for dependency_root in dependency_roots:
            run([executable, "install", "--frozen-lockfile", "--ignore-scripts"], cwd=dependency_root, env=env)
        # Clean archives have no published workspace outputs. Reuse the same
        # dependency-ordered builder as postinstall and container builds.
        run([executable, "run", "build:packages"], cwd=work, env=env)
        run([executable, "run", "build:sandbox-tools"], cwd=work, env=env)
        run([executable, "run", "build:sandbox-supervisor"], cwd=work, env=env)
        run([executable, "run", "--cwd", "web", "build"], cwd=work, env=env)
        # Reconcile dev packages and their bin links while their metadata is
        # still present. A production install alone can leave dangling bins.
        for dependency_root in dependency_roots:
            run([executable, "prune", "--production"], cwd=dependency_root, env=env)
        for dependency_root in dependency_roots:
            run([executable, "install", "--production", "--frozen-lockfile", "--ignore-scripts"],
                cwd=dependency_root, env=env)
        for name in ("index.js", "index.d.ts"):
            require((work / "packages/@ezcorp/extension-contract/dist" / name).is_file(),
                    f"built extension contract is absent: {name}")
        shutil.rmtree(work / "web/.svelte-kit", ignore_errors=True)
        require(not os.path.lexists(work / RUNTIME_DIR), "build created reserved runtime path")
        (work / RUNTIME_DIR).mkdir(mode=0o755)
        os.chmod(work / RUNTIME_DIR, 0o755)
        check_required(work)
        normalize_modes(work)
        document = {"schema": 1, "gitSha": head, "bunVersion": version,
                    "bunSha256": expected_bun_sha256,
                    "locks": {name: sha256(work / name) for name in ("bun.lock", "web/bun.lock")},
                    "files": inventory(work)}
        (work / MANIFEST).write_text(json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n")
        os.chmod(work / MANIFEST, 0o644)
        verify(work)
        check_empty_runtime_placeholder(work)
        work.rename(output)
    return {"gitSha": head, "files": len(document["files"]), "output": str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("stage")
    build.add_argument("--source", type=Path, required=True)
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--bun", type=Path, required=True)
    build.add_argument("--bun-sha256", required=True)
    for name in ("verify", "smoke"):
        command = commands.add_parser(name)
        command.add_argument("--root", type=Path, required=True)
        if name == "smoke":
            command.add_argument("--native-lib-dir", type=Path)
    args = parser.parse_args()
    if args.command == "stage":
        result = stage(args.source, args.output, args.bun, args.bun_sha256)
    elif args.command == "verify":
        result = {"gitSha": verify(args.root)["gitSha"], "verified": True}
    else:
        result = smoke(args.root, args.native_lib_dir)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
