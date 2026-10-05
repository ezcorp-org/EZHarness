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
import subprocess
import tempfile
import uuid


PHASES = (
    "preflight", "denied_credentials", "create", "checkout", "native_work",
    "compose_test", "retain", "stopped_refusal", "resume", "restart",
    "work_after_restart", "stop", "cleanup_fault", "recover_cleanup",
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
    "cleanup_fault": ("knownFailure", "reservationsRetained"),
    "recover_cleanup": ("terminalSuccess", "linkedRecovery", "noManualRepair"),
    "independent_absence": ("instanceAbsent", "inventoryEmpty", "hostCanaryUnchanged"),
    "accounting": ("bindingAbsent", "computeReleased", "diskReleased", "cleanupConfirmed"),
}


def publish(path, value):
    """Atomic private journal; file existence means complete JSON."""
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".journal-")
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(value, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_config(config):
    if set(config) != {"sequenceId", "sourceCommit", "bundleSha256", "cycles", "timeoutSeconds", "hooks"}:
        raise ValueError("config fields differ from the reviewed contract")
    if not isinstance(config["cycles"], int) or isinstance(config["cycles"], bool) or not 1 <= config["cycles"] <= 10:
        raise ValueError("cycles must be 1 through 10")
    if not isinstance(config["timeoutSeconds"], int) or isinstance(config["timeoutSeconds"], bool) or not 1 <= config["timeoutSeconds"] <= 1800:
        raise ValueError("timeout must be 1 through 1800 seconds")
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


def validate_receipt(receipt, request, identity):
    if set(receipt) != {"requestId", "cycle", "phase", "state", "identity", "checks", "artifacts"}:
        raise ValueError("receipt fields differ from the sanitized contract")
    if any(receipt[field] != request[field] for field in ("requestId", "cycle", "phase")):
        raise ValueError("receipt belongs to another request")
    if receipt["state"] != "SUCCEEDED":
        raise ValueError("hook did not prove terminal success")
    if set(receipt["checks"]) != set(CHECKS[request["phase"]]) or any(value is not True for value in receipt["checks"].values()):
        raise ValueError("required check did not pass")
    artifacts = receipt["artifacts"]
    if not isinstance(artifacts, list) or not artifacts:
        raise ValueError("independent artifact references are required")
    for artifact in artifacts:
        if set(artifact) != {"path", "sha256"} or not isinstance(artifact["path"], str):
            raise ValueError("invalid artifact reference")
        if hashlib.sha256(Path(artifact["path"]).read_bytes()).hexdigest() != artifact["sha256"]:
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
    journal = {"sequenceId": config["sequenceId"], "sourceCommit": config["sourceCommit"],
               "bundleSha256": config["bundleSha256"], "state": "RUNNING", "steps": []}
    journal_path = root / "journal.json"
    publish(journal_path, journal)
    try:
        for cycle in range(1, config["cycles"] + 1):
            identity = {}
            for phase in PHASES:
                request = {"requestId": str(uuid.uuid4()), "cycle": cycle, "phase": phase,
                           "sequenceId": config["sequenceId"], "identity": identity,
                           "sourceCommit": config["sourceCommit"], "bundleSha256": config["bundleSha256"]}
                request_path = root / f"{cycle:02d}-{phase}-request.json"
                publish(request_path, request)
                step = {"cycle": cycle, "phase": phase, "requestId": request["requestId"], "state": "ADMITTED"}
                journal["steps"].append(step)
                publish(journal_path, journal)
                # Keep output private and bounded in memory by redirecting to
                # files. Never print hook diagnostics, which may contain secrets.
                with (root / f"{cycle:02d}-{phase}.stdout").open("xb") as output, (root / f"{cycle:02d}-{phase}.stderr").open("xb") as error:
                    result = subprocess.run(config["hooks"][phase] + [str(request_path)],
                                            stdout=output, stderr=error, timeout=config["timeoutSeconds"], check=False)
                step["exitCode"] = result.returncode
                if result.returncode != 0:
                    raise ValueError("hook failed; inspect saved state before any continuation")
                output_path = root / f"{cycle:02d}-{phase}.stdout"
                if output_path.stat().st_size > 65536:
                    raise ValueError("receipt exceeds 64 KiB")
                receipt = json.loads(output_path.read_text())
                identity = validate_receipt(receipt, request, identity)
                step["state"] = "SUCCEEDED"
                step["receiptSha256"] = hashlib.sha256(output_path.read_bytes()).hexdigest()
                publish(journal_path, journal)
        journal["state"] = "SUCCEEDED"
        publish(journal_path, journal)
        return journal
    except Exception:
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
    except Exception:
        print("BLOCKED: inspect the private journal and exact saved request; no automatic replay.")
        return 2
    print("Coordinator completed. Live proof requires independent review of hook artifacts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
