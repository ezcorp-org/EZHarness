#!/usr/bin/env python3
"""Exact one-run fault authority with a mocked independent verifier."""

import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


SOURCE = Path(__file__).with_name("incus-qualification-supervisor.py")
SPEC = importlib.util.spec_from_file_location("incus_supervisor", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SCOPE = {"installationId": "installation", "releaseId": "release",
         "connectionId": "connection", "presetId": "preset"}


def request():
    return {"version": 1, "action": "restart", "runId": "run", "nonce": "nonce",
            "deadlineMs": int(time.time()*1000)+60000, "scope": SCOPE,
            "fixtureOperationId": "fixture", "bindingId": "binding", "generation": 3,
            "connectionRevision": 2, "lastOperationId": "stopped", "beforeDigest": "a"*64}


def arm(restart):
    return {"runId": restart["runId"], "nonce": restart["nonce"],
            "deadlineMs": int(time.time()*1000)+20000, "scope": restart["scope"],
            "fixtureOperationId": restart["fixtureOperationId"],
            "bindingId": restart["bindingId"],
            "destroyOperationId": "e3a94f88-c426-4bc3-8cd3-263681049a1b",
            "generation": restart["generation"], "providerGeneration": 2,
            "connectionRevision": restart["connectionRevision"]}


class FaultSupervisorTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="incus-fault-supervisor-", dir="/tmp")
        key = Path(self.directory.name) / "key.pem"
        key.write_text("private test key")
        key.chmod(0o600)
        self.supervisor = MODULE.Supervisor(str(Path(self.directory.name) / "control.sock"),
            ["true"], os.getuid(), os.getgid(), key, ["true"], ["true"],
            enforce_distinct_uid=False)
        self.restart = request()
        self.arm = arm(self.restart)
        self.supervisor.child_identity = {"pid": 123, "startTicks": "456"}
        self.supervisor.claimed = {"request": self.restart,
                                   "newProcess": self.supervisor.child_identity}

    def tearDown(self):
        self.directory.cleanup()

    def test_default_deny_and_claim_binding(self):
        presence = {"version": 1, "action": "fault", "phase": "presence"}
        with self.assertRaisesRegex(ValueError, "unavailable"):
            self.supervisor.fault(presence)
        self.supervisor.fault_authority_command = ["verifier"]
        self.assertEqual(self.supervisor.fault(presence), {"authorized": True})
        self.supervisor.claimed = None
        with self.assertRaisesRegex(ValueError, "unavailable"):
            self.supervisor.fault(presence)
        self.supervisor.claimed = {"request": self.restart,
                                   "newProcess": {"pid": 999, "startTicks": "456"}}
        with self.assertRaisesRegex(ValueError, "unavailable"):
            self.supervisor.fault(presence)

    def test_exact_arm_duplicate_and_readback(self):
        self.supervisor.fault_authority_command = ["verifier"]
        # SP05 may follow the signed restart after its short handoff deadline.
        self.restart["deadlineMs"] = int(time.time()*1000)-1000
        phases = []

        def verifier(_command, *, input, **_kwargs):
            message = json.loads(input)
            phases.append(message["phase"])
            digest = hashlib.sha256(MODULE.canonical(message["arm"])).hexdigest()
            return subprocess.CompletedProcess([], 0, stdout=json.dumps({
                "authorized": True, "armDigest": digest}).encode())

        with mock.patch.object(MODULE.subprocess, "run", side_effect=verifier):
            for phase in ("arm", "arm", "readback"):
                self.assertEqual(self.supervisor.fault({"version": 1, "action": "fault",
                    "phase": phase, "arm": self.arm}), {"authorized": True})
            different = {**self.arm, "destroyOperationId":
                "f1b23a71-4b98-4ca5-8f54-adc91c1fd900"}
            with self.assertRaisesRegex(ValueError, "different fault already armed"):
                self.supervisor.fault({"version": 1, "action": "fault",
                    "phase": "arm", "arm": different})
        self.assertEqual(phases, ["arm", "arm", "readback"])

    def test_no_readback_before_arm_or_with_wrong_verifier_digest(self):
        self.supervisor.fault_authority_command = ["verifier"]
        with self.assertRaisesRegex(ValueError, "not armed"):
            self.supervisor.fault({"version": 1, "action": "fault",
                "phase": "readback", "arm": self.arm})
        wrong = subprocess.CompletedProcess([], 0, stdout=json.dumps({
            "authorized": True, "armDigest": "0"*64}).encode())
        with mock.patch.object(MODULE.subprocess, "run", return_value=wrong):
            with self.assertRaisesRegex(ValueError, "independent fault readback rejected"):
                self.supervisor.fault({"version": 1, "action": "fault",
                    "phase": "arm", "arm": self.arm})
        self.assertIsNone(self.supervisor.fault_armed)

    def test_cross_run_scope_and_deadline_are_rejected_before_verifier(self):
        self.supervisor.fault_authority_command = ["verifier"]
        changed = [{**self.arm, "runId": "another"},
                   {**self.arm, "bindingId": "user-binding"},
                   {**self.arm, "scope": {**SCOPE, "connectionId": "another"}},
                   {**self.arm, "deadlineMs": int(time.time()*1000)+40000},
                   {**self.arm, "providerGeneration": True}]
        with mock.patch.object(MODULE.subprocess, "run") as verifier:
            for value in changed:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    self.supervisor.fault({"version": 1, "action": "fault",
                        "phase": "arm", "arm": value})
            verifier.assert_not_called()


if __name__ == "__main__":
    unittest.main()
