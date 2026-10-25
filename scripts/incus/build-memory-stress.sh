#!/usr/bin/env bash
# Development-only reproducible build. Runtime uses the checked-in static asset.
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 - "$@" <<'PY'
import hashlib, json, os, pathlib, subprocess, sys, tempfile

root = pathlib.Path.cwd()
metadata = json.loads(
    (root / "src/infrastructure/incus-guest/memory-stress.build.json").read_text()
)


def verify(row):
    path = pathlib.Path(row["path"])
    if not path.is_absolute():
        path = root / path
    if hashlib.sha256(path.read_bytes()).hexdigest() != row["sha256"]:
        raise SystemExit("Native build input hash mismatch: " + str(path))
    return path


source = verify(metadata["source"])
verify(metadata["compiler"]["wrapper"])
asset = verify(metadata["artifact"])
for row in metadata["toolchain"] + metadata["linkerInputs"]:
    verify(row)
if sys.argv[1:] not in ([], ["--verify"]):
    raise SystemExit("usage: build-memory-stress.sh [--verify]")
with tempfile.TemporaryDirectory(prefix="ezh-native-build-") as directory:
    output = pathlib.Path(directory) / "memory-stress"
    linker = next(row for row in metadata["toolchain"] if row["path"].endswith("-ld"))
    (pathlib.Path(directory) / "ld").symlink_to(linker["path"])
    env = dict(os.environ, PATH=directory + os.pathsep + os.environ.get("PATH", ""))
    specs = next(
        row for row in metadata["toolchain"] if row["path"].endswith("musl-gcc.specs")
    )
    subprocess.run(
        [
            metadata["compiler"]["path"],
            "-B" + directory + "/",
            *metadata["compiler"]["flags"],
            str(source),
            "-o",
            str(output),
            "-specs=" + specs["path"],
        ],
        check=True,
        env=env,
    )
    rebuilt = output.read_bytes()
    if rebuilt != asset.read_bytes():
        raise SystemExit("Native rebuild differs from the reviewed asset")
    if len(rebuilt) != metadata["artifact"]["bytes"]:
        raise SystemExit("Native asset size mismatch")
    print(
        json.dumps(
            {
                "sha256": hashlib.sha256(rebuilt).hexdigest(),
                "bytes": len(rebuilt),
                "rebuildIdentical": True,
                "runtimeCompilerRequired": False,
            },
            sort_keys=True,
        )
    )
PY
