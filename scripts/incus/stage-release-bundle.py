#!/usr/bin/env python3
"""Build and verify a relocatable qualification release; never install it."""

import argparse
import hashlib
import io
import json
import os
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


def require(condition, message):
    if not condition:
        raise ValueError(message)


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
        for item in members.getmembers():
            name = Path(item.name)
            require(name.parts and not name.is_absolute() and ".." not in name.parts,
                    "archive path escapes release")
            require(item.isfile() or item.isdir(), "tracked links or special files are not allowed")
        members.extractall(target, filter="data")


def inventory(root):
    files = []
    for path in sorted(root.rglob("*")):
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
        require((root / relative).exists(), f"required release file is absent: {relative}")
    require((root / "bin/bun").is_file(), "pinned Bun is absent")


def verify(root):
    root = root.resolve(strict=True)
    document = json.loads((root / MANIFEST).read_text())
    require(set(document) == {"schema", "gitSha", "bunVersion", "bunSha256", "locks", "files"}
            and document["schema"] == 1 and document["bunVersion"] == "1.3.14",
            "release manifest schema or Bun version changed")
    require(document["bunSha256"] == sha256(root / "bin/bun"), "Bun digest changed")
    for relative, digest in document["locks"].items():
        require(relative in ("bun.lock", "web/bun.lock") and digest == sha256(root / relative),
                "dependency lock changed")
    require(set(document["locks"]) == {"bun.lock", "web/bun.lock"}, "dependency locks incomplete")
    check_required(root)
    require(document["files"] == inventory(root), "release file inventory changed")
    return document


def smoke(root):
    require(os.geteuid() != 0, "smoke must run as a non-root user")
    verify(root)
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
        process = subprocess.Popen([str(root / "bin/bun"), str(root / "web/build/index.js")],
                                   cwd=root, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True)
        try:
            url = f"http://127.0.0.1:{port}/api/health"
            deadline = time.monotonic() + 45
            status = None
            while time.monotonic() < deadline:
                require(process.poll() is None, "bundled app exited during smoke")
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
            return {"healthStatus": status, "nonRootUid": os.geteuid(),
                    "smokeRoot": str(scratch)}
        finally:
            process.terminate()
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)


def stage(source, output, bun, expected_bun_sha256):
    source = source.resolve(strict=True)
    output = output.absolute()
    require(not output.exists(), "release destination already exists")
    require(not output.is_relative_to(source), "release destination cannot be inside source checkout")
    require(len(expected_bun_sha256) == 64 and sha256(bun) == expected_bun_sha256,
            "pinned Bun SHA-256 mismatch")
    require(subprocess.check_output([str(bun), "--version"], text=True).strip() == "1.3.14",
            "Bun 1.3.14 is required")
    head = git_head(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".ezh-release-build-", dir=output.parent) as temporary:
        work = Path(temporary) / "release"
        work.mkdir()
        extract_head(source, work)
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
        run([executable, "install", "--frozen-lockfile", "--ignore-scripts"], cwd=work, env=env)
        run([executable, "install", "--frozen-lockfile", "--ignore-scripts"], cwd=work / "web", env=env)
        for package in ("sdk", "harness-client"):
            run([executable, "run", "--cwd", f"packages/@ezcorp/{package}", "build"], cwd=work, env=env)
        run([executable, "run", "build:sandbox-tools"], cwd=work, env=env)
        run([executable, "run", "build:sandbox-supervisor"], cwd=work, env=env)
        run([executable, "run", "--cwd", "web", "build"], cwd=work, env=env)
        run([executable, "install", "--production", "--frozen-lockfile", "--ignore-scripts"], cwd=work, env=env)
        run([executable, "install", "--production", "--frozen-lockfile", "--ignore-scripts"], cwd=work / "web", env=env)
        shutil.rmtree(work / "web/.svelte-kit", ignore_errors=True)
        check_required(work)
        document = {"schema": 1, "gitSha": head, "bunVersion": "1.3.14",
                    "bunSha256": expected_bun_sha256,
                    "locks": {name: sha256(work / name) for name in ("bun.lock", "web/bun.lock")},
                    "files": inventory(work)}
        (work / MANIFEST).write_text(json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n")
        verify(work)
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
        commands.add_parser(name).add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "stage":
        result = stage(args.source, args.output, args.bun, args.bun_sha256)
    elif args.command == "verify":
        result = {"gitSha": verify(args.root)["gitSha"], "verified": True}
    else:
        result = smoke(args.root)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
