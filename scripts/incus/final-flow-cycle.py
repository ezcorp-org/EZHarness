#!/usr/bin/env python3
"""Bounded coordinator for reviewed live hooks. No credentials or DB access.

Hooks receive a private request JSON pathname as their last argument and emit
one sanitized JSON receipt on stdout. They own normal API/browser execution,
independent observations and approved restart/fault capabilities. This program
cannot establish that a hook tells the truth; retain its independent artifacts.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import tempfile
import uuid


PHASES = (
    "preflight", "denied_credentials", "create", "checkout", "native_work",
    "compose_test", "retain", "stopped_refusal", "resume", "restart",
    "work_after_restart", "stop", "destroy", "cleanup_fault", "recover_cleanup",
    "independent_absence", "accounting",
)
IDENTITY = ("projectId", "bindingId", "workspaceId", "instanceName")
CHECKS = {
    "preflight": ("exactRelease", "qualificationValid", "hostCanarySaved"),
    "denied_credentials": ("denied", "noUnauthorizedEffect"),
    "create": ("terminalSuccess", "independentRunning"),
    "checkout": ("independentCheckout", "exactCommit"),
    "native_work": ("savedNativeToolRows", "editReadSearchShellGit", "independentBytes", "hostCanaryUnchanged"),
    "compose_test": ("testsPassed", "composeHealthy", "composeCleaned", "independentEngineEmpty"),
    "retain": ("terminalSuccess", "stopped", "workspaceRetained"),
    "stopped_refusal": ("refusedBeforeExecution", "hostCanaryUnchanged"),
    "resume": ("terminalSuccess", "sameBytesAndCommit"),
    "restart": ("processIdentityChanged", "healthy", "sameBinding"),
    "work_after_restart": ("savedNativeToolRows", "sameBytesAndCommit", "hostCanaryUnchanged"),
    "stop": ("terminalSuccess", "stopped"),
    "destroy": ("terminalSuccess", "noManualRepair"),
    "cleanup_fault": ("knownFailure", "reservationsRetained"),
    "recover_cleanup": ("terminalSuccess", "linkedRecovery", "noManualRepair"),
    "independent_absence": ("instanceAbsent", "inventoryEmpty", "hostCanaryUnchanged"),
    "accounting": ("bindingAbsent", "computeReleased", "diskReleased", "cleanupConfirmed"),
}
ROUTING_PROOFS = ("host-canary", "virtual-workspace-absence")


def checks_for(phase, routing_proof="host-canary"):
    if routing_proof not in ROUTING_PROOFS:
        raise ValueError("unsupported routing proof")
    return tuple("hostWorkspaceAbsent" if routing_proof == "virtual-workspace-absence"
                 and check in ("hostCanarySaved", "hostCanaryUnchanged") else check
                 for check in CHECKS[phase])


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish(path, value):
    """Atomic private journal; file existence means complete JSON."""
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".journal-")
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(value, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_config(config):
    if set(config) - {"routingProof"} != {"sequenceId", "sourceCommit", "bundleSha256", "cycles", "timeoutSeconds", "faultCycles", "hooks"}:
        raise ValueError("config fields differ from the reviewed contract")
    checks_for("preflight", config.get("routingProof", "host-canary"))
    if not isinstance(config["cycles"], int) or isinstance(config["cycles"], bool) or not 1 <= config["cycles"] <= 10:
        raise ValueError("cycles must be 1 through 10")
    if not isinstance(config["timeoutSeconds"], int) or isinstance(config["timeoutSeconds"], bool) or not 1 <= config["timeoutSeconds"] <= 1800:
        raise ValueError("timeout must be 1 through 1800 seconds")
    faults = config["faultCycles"]
    if not isinstance(faults, list) or len(set(faults)) != len(faults) or any(type(cycle) is not int or not 2 <= cycle <= config["cycles"] for cycle in faults):
        raise ValueError("fault cycles must be distinct later cycles; cycle one is ordinary")
    if config["cycles"] == 10 and not faults:
        raise ValueError("ten-cycle qualification requires a cleanup recovery case")
    for field in ("sequenceId", "sourceCommit", "bundleSha256"):
        if not isinstance(config[field], str) or not config[field]:
            raise ValueError("missing source or sequence identity")
    if set(config["hooks"]) != set(PHASES):
        raise ValueError("all reviewed hooks are required")
    for command in config["hooks"].values():
        if not isinstance(command, list) or not command or any(not isinstance(argument, str) or not argument for argument in command):
            raise ValueError("hook must be a nonempty argv array")
        if not Path(command[0]).is_absolute():
            raise ValueError("hook executable must have an absolute path")


def phases_for(config, cycle):
    fault = cycle in config["faultCycles"]
    return tuple(phase for phase in PHASES if not (phase == "destroy" and fault)
                 and not (phase in ("cleanup_fault", "recover_cleanup") and not fault))


def artifact_digest(root, name, maximum=16 * 1024 * 1024):
    """Open below the owned root without following any symlink; stream bytes."""
    relative = Path(name)
    if relative.is_absolute():
        relative = relative.relative_to(root)
    if not relative.parts or any(part in (".", "..") for part in relative.parts):
        raise ValueError("artifact must be below the current run root")
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in relative.parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        child = os.open(relative.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        try:
            metadata = os.fstat(child)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
                raise ValueError("artifact must be a bounded regular file")
            digest = hashlib.sha256()
            size = 0
            while True:
                block = os.read(child, 65536)
                if not block:
                    break
                size += len(block)
                if size > maximum:
                    raise ValueError("artifact grew beyond its size bound")
                digest.update(block)
            return digest.hexdigest()
        finally:
            os.close(child)
    finally:
        os.close(descriptor)


def supervise(command, output, error, timeout):
    """Kill the hook group on exit, timeout or interruption.

    This standalone fixture has one thread. Its pre-exec mask reset must not
    be reused from a threaded Python process, where preexec_fn can deadlock.
    """
    def interrupted(_number, _frame):
        raise KeyboardInterrupt()
    previous = signal.signal(signal.SIGTERM, interrupted)
    child = None
    try:
        blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
        try:
            child = subprocess.Popen(
                command, stdout=output, stderr=error, start_new_session=True,
                preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, blocked - {signal.SIGTERM, signal.SIGINT}),
            )
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
        return child.wait(timeout=timeout)
    finally:
        try:
            if child is not None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait(timeout=5)
        finally:
            signal.signal(signal.SIGTERM, previous)


def validate_receipt(receipt, request, identity, root):
    if set(receipt) != {"requestId", "cycle", "phase", "state", "identity", "checks", "artifacts"}:
        raise ValueError("receipt fields differ from the sanitized contract")
    if any(receipt[field] != request[field] for field in ("requestId", "cycle", "phase")):
        raise ValueError("receipt belongs to another request")
    if receipt["state"] != "SUCCEEDED":
        raise ValueError("hook did not prove terminal success")
    if set(receipt["checks"]) != set(checks_for(request["phase"], request.get("routingProof", "host-canary"))) or any(value is not True for value in receipt["checks"].values()):
        raise ValueError("required check did not pass")
    artifacts = receipt["artifacts"]
    if not isinstance(artifacts, list) or not 1 <= len(artifacts) <= 32:
        raise ValueError("independent artifact references are required")
    for artifact in artifacts:
        if set(artifact) != {"path", "sha256"} or not isinstance(artifact["path"], str):
            raise ValueError("invalid artifact reference")
        if artifact_digest(root, artifact["path"]) != artifact["sha256"]:
            raise ValueError("artifact hash mismatch")
    observed = receipt["identity"]
    if request["phase"] in ("preflight", "denied_credentials"):
        if observed != {}:
            raise ValueError("pre-create identity must be empty")
    elif set(observed) != set(IDENTITY) or any(not isinstance(value, str) or not value for value in observed.values()):
        raise ValueError("incomplete guest identity")
    elif identity and observed != identity:
        raise ValueError("guest identity changed within the cycle")
    return observed or identity


def run(config, root):
    validate_config(config)
    # Exclusive directory prevents concurrent runs and automatic replay after
    # an interrupted hook. Even a failed run needs a new reviewed sequence.
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    sync_directory(root.parent)
    journal = {"sequenceId": config["sequenceId"], "sourceCommit": config["sourceCommit"],
               "bundleSha256": config["bundleSha256"], "state": "RUNNING", "steps": []}
    if "routingProof" in config:
        journal["routingProof"] = config["routingProof"]
    journal_path = root / "journal.json"
    publish(journal_path, journal)
    used_identities = {field: set() for field in IDENTITY}
    try:
        for cycle in range(1, config["cycles"] + 1):
            identity = {}
            for phase in phases_for(config, cycle):
                request = {"requestId": str(uuid.uuid4()), "cycle": cycle, "phase": phase,
                           "sequenceId": config["sequenceId"], "identity": identity,
                           "sourceCommit": config["sourceCommit"], "bundleSha256": config["bundleSha256"]}
                if "routingProof" in config:
                    request["routingProof"] = config["routingProof"]
                request_path = root / f"{cycle:02d}-{phase}-request.json"
                publish(request_path, request)
                step = {"cycle": cycle, "phase": phase, "requestId": request["requestId"], "state": "ADMITTED"}
                journal["steps"].append(step)
                publish(journal_path, journal)
                # Keep output private and bounded in memory by redirecting to
                # files. Never print hook diagnostics, which may contain secrets.
                with (root / f"{cycle:02d}-{phase}.stdout").open("xb") as output, (root / f"{cycle:02d}-{phase}.stderr").open("xb") as error:
                    exit_code = supervise(config["hooks"][phase] + [str(request_path)], output, error, config["timeoutSeconds"])
                step["exitCode"] = exit_code
                if exit_code != 0:
                    raise ValueError("hook failed; inspect saved state before any continuation")
                output_path = root / f"{cycle:02d}-{phase}.stdout"
                if output_path.stat().st_size > 65536:
                    raise ValueError("receipt exceeds 64 KiB")
                receipt = json.loads(output_path.read_text())
                identity = validate_receipt(receipt, request, identity, root)
                if phase == "create":
                    if any(identity[field] in used_identities[field] for field in IDENTITY):
                        raise ValueError("cycle reuses a prior guest identity")
                    for field in IDENTITY:
                        used_identities[field].add(identity[field])
                step["state"] = "SUCCEEDED"
                step["receiptSha256"] = hashlib.sha256(output_path.read_bytes()).hexdigest()
                publish(journal_path, journal)
        journal["state"] = "SUCCEEDED"
        publish(journal_path, journal)
        return journal
    except BaseException:
        journal["state"] = "BLOCKED"
        # The ADMITTED step remains unresolved. No new mutation or cleanup is
        # issued here: the operator must inspect its exact saved request.
        publish(journal_path, journal)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        run(json.loads(arguments.config.read_text()), arguments.output.resolve())
    except BaseException:
        print("BLOCKED: inspect the private journal and exact saved request; no automatic replay.")
        return 2
    print("Coordinator completed. Live proof requires independent review of hook artifacts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
