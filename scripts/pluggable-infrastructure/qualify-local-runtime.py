#!/usr/bin/env python3
"""Qualify an owned rootless-Podman fixture without changing host configuration."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import uuid
from typing import Any

PROFILES = ("canary", "linux-exec.v1", "persistent-web-compose.v1")
REQUIRED = {
    "canary": (
        "rootless",
        "cgroups-v2",
        "cpu-ceiling",
        "memory-ceiling",
        "pid-ceiling",
        "seccomp",
        "no-new-privileges",
        "capabilities-dropped",
        "network-disabled",
        "read-only-root",
        "filesystem-isolation",
        "workspace-persistence",
        "workspace-remount-persistence",
        "filesystem-check",
        "host-storage-accounting",
        "process-exec",
        "process-cancel",
        "bounded-output",
        "container-restart",
        "cleanup",
    ),
    "linux-exec.v1": (
        "rootless",
        "cgroups-v2",
        "cpu-ceiling",
        "memory-ceiling",
        "pid-ceiling",
        "storage-ceiling",
        "seccomp",
        "no-new-privileges",
        "capabilities-dropped",
        "network-disabled",
        "read-only-root",
        "filesystem-isolation",
        "workspace-persistence",
        "workspace-remount-persistence",
        "filesystem-check",
        "host-storage-accounting",
        "process-exec",
        "process-cancel",
        "bounded-output",
        "container-restart",
        "cleanup",
    ),
    "persistent-web-compose.v1": (
        "rootless",
        "cgroups-v2",
        "cpu-ceiling",
        "memory-ceiling",
        "pid-ceiling",
        "storage-ceiling",
        "seccomp",
        "no-new-privileges",
        "capabilities-dropped",
        "workspace-persistence",
        "workspace-remount-persistence",
        "process-exec",
        "process-cancel",
        "bounded-output",
        "container-restart",
        "isolated-nested-engine",
        "nested-compose",
        "nested-resource-accounting",
        "cleanup",
    ),
}


class ProbeError(RuntimeError):
    pass


def command(argv: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, text=True, capture_output=True, timeout=30, check=False)
    if check and result.returncode != 0:
        raise ProbeError(f"command failed ({result.returncode}): {' '.join(argv)}: {result.stderr.strip()}")
    return result


def podman(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return command(["podman", "--remote=false", *args], check=check)


def record(controls: dict[str, dict[str, Any]], name: str, passed: bool, evidence: Any) -> None:
    controls[name] = {"passed": bool(passed), "evidence": evidence}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=PROFILES, default="canary")
    parser.add_argument("--image", default="docker.io/library/alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b")
    parser.add_argument("--receipt", type=pathlib.Path)
    parser.add_argument("--simulate-missing-control", choices=sorted({x for values in REQUIRED.values() for x in values}))
    args = parser.parse_args()

    run_id = f"local-qualification-{uuid.uuid4().hex[:12]}"
    container = f"ezpi-{uuid.uuid4().hex[:16]}"
    controls: dict[str, dict[str, Any]] = {}
    receipt: dict[str, Any] = {
        "schemaVersion": 1,
        "runId": run_id,
        "profile": args.profile,
        "candidate": "rootless-podman",
        "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "controls": controls,
        "limits": {"cpus": 0.5, "memoryBytes": 134217728, "pids": 32, "tmpfsBytes": 16777216},
        "simulatedMissingControl": args.simulate_missing_control,
    }
    work_root = pathlib.Path(tempfile.mkdtemp(prefix="ezpi-local-", dir=os.environ.get("TMPDIR", "/tmp")))
    filesystem_image = work_root / "workspace.ext4"
    workspace = work_root / "workspace"
    workspace.mkdir(mode=0o700)
    marker = hashlib.sha256(run_id.encode()).hexdigest()
    created = False
    mounted = False

    try:
        if not shutil.which("podman"):
            raise ProbeError("podman is not installed")
        info = json.loads(podman("info", "--format", "json").stdout)
        version = json.loads(podman("version", "--format", "json").stdout)
        host = info["host"]
        receipt["runtime"] = {
            "version": version["Client"]["Version"],
            "kernel": host["kernel"],
            "os": host["distribution"],
            "architecture": host["arch"],
            "cgroupVersion": host["cgroupVersion"],
            "cgroupManager": host["cgroupManager"],
            "ociRuntime": host["ociRuntime"]["name"],
            "security": host["security"],
            "storageDriver": info["store"]["graphDriverName"],
        }
        record(controls, "rootless", host["security"]["rootless"] is True, host["security"]["rootless"])
        record(controls, "cgroups-v2", host["cgroupVersion"] == "v2", host["cgroupVersion"])
        record(controls, "seccomp", host["security"]["seccompEnabled"] is True, host["security"])

        image = podman("image", "inspect", args.image, "--format", "{{.Id}}", check=False)
        if image.returncode != 0:
            raise ProbeError(f"image is not local (pulls are intentionally disabled): {args.image}")
        receipt["image"] = {"reference": args.image, "id": image.stdout.strip()}

        command(["truncate", "-s", "32M", str(filesystem_image)])
        command(["mkfs.ext2", "-q", "-F", "-m", "0", str(filesystem_image)])
        command(["nix", "shell", "nixpkgs#fuse2fs", "-c", "fuse2fs", "-o", "fakeroot", str(filesystem_image), str(workspace)])
        mounted = True

        create_args = [
            "create", "--pull=never", "--name", container,
            "--label", f"io.ezcorp.pluggable-qualification={run_id}",
            "--network=none", "--pid=private", "--ipc=private", "--uts=private", "--read-only", "--read-only-tmpfs=false",
            "--log-driver=none",
            "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--memory=128m", "--memory-swap=128m", "--cpus=0.5", "--pids-limit=32",
            "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
            "--mount", f"type=bind,source={workspace},destination=/workspace,rw",
            args.image, "sleep", "300",
        ]
        podman(*create_args)
        created = True
        podman("start", container)
        inspect = json.loads(podman("inspect", container).stdout)[0]
        host_config = inspect["HostConfig"]
        record(controls, "cpu-ceiling", host_config["NanoCpus"] == 500_000_000, host_config["NanoCpus"])
        record(controls, "memory-ceiling", host_config["Memory"] == 134_217_728 and host_config["MemorySwap"] == 134_217_728,
               {"memory": host_config["Memory"], "memorySwap": host_config["MemorySwap"]})
        record(controls, "pid-ceiling", host_config["PidsLimit"] == 32, host_config["PidsLimit"])
        record(controls, "no-new-privileges", "no-new-privileges" in inspect["HostConfig"]["SecurityOpt"], inspect["HostConfig"]["SecurityOpt"])
        cap_eff = podman("exec", container, "sh", "-c", "awk '/^CapEff:/ {print $2}' /proc/self/status").stdout.strip()
        record(controls, "capabilities-dropped", cap_eff == "0000000000000000", {"CapEff": cap_eff, "inspect": host_config["CapDrop"]})
        record(controls, "network-disabled", host_config["NetworkMode"] == "none", host_config["NetworkMode"])
        record(controls, "read-only-root", host_config["ReadonlyRootfs"] is True, host_config["ReadonlyRootfs"])
        receipt["containerIsolation"] = {key: host_config.get(key) for key in ("NetworkMode", "PidMode", "IpcMode", "UtsMode", "UsernsMode", "Privileged", "CapDrop", "SecurityOpt")}
        if host_config.get("PidMode") != "private" or host_config.get("IpcMode") != "private" or host_config.get("UtsMode") is not None or host_config.get("Privileged") is not False:
            raise ProbeError("container namespace or privilege identity differs from the fixed local profile")

        cgroup_values = podman("exec", container, "sh", "-c", "cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/pids.max").stdout.splitlines()
        receipt["observedCgroup"] = {"cpu.max": cgroup_values[0], "memory.max": cgroup_values[1], "memory.swap.max": cgroup_values[2], "pids.max": cgroup_values[3]}
        record(controls, "cpu-ceiling", controls["cpu-ceiling"]["passed"] and cgroup_values[0] == "50000 100000", controls["cpu-ceiling"]["evidence"] | {"cpu.max": cgroup_values[0]} if isinstance(controls["cpu-ceiling"]["evidence"], dict) else {"inspectNanoCpus": controls["cpu-ceiling"]["evidence"], "cpu.max": cgroup_values[0]})
        record(controls, "memory-ceiling", controls["memory-ceiling"]["passed"] and cgroup_values[1] == "134217728" and cgroup_values[2] == "0", {**controls["memory-ceiling"]["evidence"], "memory.max": cgroup_values[1], "memory.swap.max": cgroup_values[2]})
        record(controls, "pid-ceiling", controls["pid-ceiling"]["passed"] and cgroup_values[3] == "32", {"inspect": host_config["PidsLimit"], "pids.max": cgroup_values[3]})

        exec_result = podman("exec", container, "sh", "-c", f"printf %s {marker} > /workspace/marker && cat /workspace/marker")
        record(controls, "process-exec", exec_result.stdout == marker, exec_result.stdout)
        bounded = podman("exec", container, "sh", "-c", "yes x | head -c 4096").stdout
        retained = bounded[:1024]
        record(controls, "bounded-output", len(retained.encode()) == 1024, {"producedBytes": len(bounded.encode()), "retainedBytes": len(retained.encode()), "limitBytes": 1024})
        podman("exec", "--detach", container, "sh", "-c", "sleep 300 & child=$!; echo $child > /workspace/cancel-pid; wait $child")
        cancel_pid = podman("exec", container, "sh", "-c", "while [ ! -s /workspace/cancel-pid ]; do sleep 0.01; done; cat /workspace/cancel-pid").stdout.strip()
        cancel = podman("exec", container, "sh", "-c", f"kill -TERM {cancel_pid}", check=False)
        still_alive = podman("exec", container, "sh", "-c", f"i=0; while [ -r /proc/{cancel_pid}/stat ] && [ \"$(cut -d' ' -f3 /proc/{cancel_pid}/stat)\" != Z ] && [ $i -lt 100 ]; do i=$((i+1)); sleep 0.01; done; [ -r /proc/{cancel_pid}/stat ] && [ \"$(cut -d' ' -f3 /proc/{cancel_pid}/stat)\" != Z ]", check=False)
        record(controls, "process-cancel", cancel.returncode == 0 and still_alive.returncode != 0, {"pid": cancel_pid, "killExitCode": cancel.returncode, "aliveExitCode": still_alive.returncode})
        denied = podman("exec", container, "sh", "-c", "printf forbidden > /qualification-host-canary", check=False)
        record(controls, "filesystem-isolation", denied.returncode != 0 and not (pathlib.Path("/") / "qualification-host-canary").exists(), {"exitCode": denied.returncode, "stderr": denied.stderr.strip()[:512]})
        podman("restart", "--time", "2", container)
        persisted = podman("exec", container, "cat", "/workspace/marker").stdout
        restarted_inspect = json.loads(podman("inspect", container).stdout)[0]
        record(controls, "workspace-persistence", persisted == marker, {"sha256": hashlib.sha256(persisted.encode()).hexdigest()})
        record(controls, "container-restart", restarted_inspect["State"]["Running"] is True and persisted == marker, "restart followed by successful exec")

        disk_fill = podman("exec", container, "sh", "-c", "set +e; dd if=/dev/zero of=/workspace/fill bs=1M count=64 2>/workspace/dd.err; rc=$?; cat /workspace/dd.err; rm /workspace/fill; exit $rc", check=False)
        record(controls, "storage-ceiling", disk_fill.returncode != 0 and "No space left on device" in disk_fill.stdout,
               {"imageBytes": filesystem_image.stat().st_size, "writeExitCode": disk_fill.returncode, "output": disk_fill.stdout[-512:]})

        podman("rm", "--force", "--volumes", container)
        created = False
        command(["fusermount3", "-u", str(workspace)])
        mounted = False
        filesystem_check = command(["e2fsck", "-p", "-f", str(filesystem_image)], check=False)
        record(controls, "filesystem-check", filesystem_check.returncode in (0, 1),
               {"exitCode": filesystem_check.returncode, "output": (filesystem_check.stdout + filesystem_check.stderr)[-512:]})
        allocated_bytes = filesystem_image.stat().st_blocks * 512
        record(controls, "host-storage-accounting", allocated_bytes <= filesystem_image.stat().st_size,
               {"logicalBytes": filesystem_image.stat().st_size, "allocatedBytes": allocated_bytes})
        command(["nix", "shell", "nixpkgs#fuse2fs", "-c", "fuse2fs", "-o", "fakeroot", str(filesystem_image), str(workspace)])
        mounted = True
        remounted = (workspace / "marker").read_text(encoding="utf-8")
        record(controls, "workspace-remount-persistence", remounted == marker, {"sha256": hashlib.sha256(remounted.encode()).hexdigest()})
        # A nested engine needs either a host engine socket (host authority) or elevated devices/capabilities.
        record(controls, "isolated-nested-engine", False, "No isolated inner engine was provided; the host Podman socket is not mounted.")
        record(controls, "nested-compose", False, "Compose was not run because an isolated nested engine is absent.")
        record(controls, "nested-resource-accounting", False, "Inner container storage, logs, and processes are not proven under the outer ceilings.")
    except (ProbeError, KeyError, IndexError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
        receipt["probeError"] = str(error)
    finally:
        cleanup_errors: list[str] = []
        if created:
            removed = podman("rm", "--force", "--volumes", container, check=False)
            if removed.returncode != 0:
                cleanup_errors.append(removed.stderr.strip())
        leftovers = podman("ps", "--all", "--quiet", "--filter", f"label=io.ezcorp.pluggable-qualification={run_id}", check=False)
        if leftovers.stdout.strip():
            cleanup_errors.append(f"owned containers remain: {leftovers.stdout.split()}")
        if mounted:
            unmounted = command(["fusermount3", "-u", str(workspace)], check=False)
            if unmounted.returncode != 0:
                cleanup_errors.append(unmounted.stderr.strip())
        shutil.rmtree(work_root, ignore_errors=True)
        if work_root.exists():
            cleanup_errors.append(f"temporary workspace remains: {work_root}")
        record(controls, "cleanup", not cleanup_errors, cleanup_errors or "container and temporary workspace removed")

    if args.simulate_missing_control:
        record(controls, args.simulate_missing_control, False, "forced missing control for rejection-canary verification")
    required = REQUIRED[args.profile]
    missing = [name for name in required if not controls.get(name, {}).get("passed", False)]
    receipt["requiredControls"] = list(required)
    receipt["missingControls"] = missing
    receipt["qualified"] = not missing and "probeError" not in receipt
    receipt["scope"] = "local fixture only; no provider, remote networking, or portability claim"
    receipt["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
    output = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    if args.receipt:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(output, encoding="utf-8")
    sys.stdout.write(output)
    return 0 if receipt["qualified"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
