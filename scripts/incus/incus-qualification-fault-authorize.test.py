#!/usr/bin/env python3
"""No network or Incus write: check exact SP05 backend observation rules."""

import importlib.util
import hashlib
import json
import time
import unittest
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).with_name("incus-qualification-fault-authorize.py")
SPEC = importlib.util.spec_from_file_location("incus_fault_authorize", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SCOPE = {"installationId": "installation", "releaseId": "release",
         "connectionId": "connection", "presetId": "preset"}
CONFIG = {"scope": SCOPE}


def arm():
    return {"runId": "run", "nonce": "nonce", "deadlineMs": int(time.time()*1000)+20000,
            "scope": SCOPE, "fixtureOperationId": "fixture", "bindingId": "binding",
            "destroyOperationId": "e3a94f88-c426-4bc3-8cd3-263681049a1b",
            "generation": 3, "providerGeneration": 2, "connectionRevision": 4}


def instance(request):
    return {"name": MODULE.instance_name(request), "status": "Stopped", "config": {
        "user.ezharness.managed_by": "ezharness-incus-sandbox",
        "user.ezharness.connection_id": "connection", "user.ezharness.sandbox_id": "binding",
        "user.ezharness.preset_id": "preset", "user.ezharness.generation": "2"}}


class FaultVerifierTest(unittest.TestCase):
    def test_stopped_exact_instance_arms_and_absence_reads_back(self):
        request = arm()
        armed = MODULE.verify({"phase": "arm", "arm": request}, CONFIG, instance(request))
        self.assertEqual(armed, MODULE.verify({"phase": "readback", "arm": request}, CONFIG, None))
        self.assertEqual(len(armed["armDigest"]), 64)

    def test_mutated_scope_tags_and_state_deny(self):
        request = arm()
        observed = instance(request)
        for key, value in [("status", "Running"), ("name", "other")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                MODULE.verify({"phase": "arm", "arm": request}, CONFIG,
                              {**observed, key: value})
        for tag in observed["config"]:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                MODULE.verify({"phase": "arm", "arm": request}, CONFIG,
                              {**observed, "config": {**observed["config"], tag: "other"}})
        with self.assertRaises(ValueError):
            MODULE.verify({"phase": "readback", "arm": request}, CONFIG, observed)
        with self.assertRaises(ValueError):
            MODULE.verify({"phase": "arm", "arm": {**request, "scope": {**SCOPE,
                "connectionId": "other"}}}, CONFIG, observed)

    def test_bad_or_expired_arm_denies(self):
        request = arm()
        for changed in [{**request, "deadlineMs": 1},
                        {**request, "deadlineMs": int(time.time()*1000)+40000},
                        {**request, "providerGeneration": True},
                        {**request, "destroyOperationId": "user-operation"},
                        {**request, "extra": "value"}]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                MODULE.verify({"phase": "arm", "arm": changed}, CONFIG, instance(request))

    def test_pinned_tls_leaf_is_checked_before_http(self):
        request = arm()
        expected = instance(request)
        sent = []

        class Connection:
            def __init__(self, *_args, **_kwargs):
                self.sock = self

            def connect(self):
                pass

            def getpeercert(self, *, binary_form):
                self.assert_binary_form = binary_form
                return b"server leaf"

            def request(self, method, path, headers):
                sent.append((method, path, headers))

            def getresponse(self):
                return self

            status = 200

            def read(self, _limit):
                return json.dumps({"type": "sync", "metadata": expected}).encode()

            def close(self):
                pass

        config = {"endpoint": "https://incus.example:8443", "project": "ezharness",
                  "serverCertificateSha256": "0"*64,
                  "clientCertificate": "/operator/cert", "clientKey": "/operator/key"}
        with patch.object(MODULE.ssl, "SSLContext") as context, \
                patch.object(MODULE.http.client, "HTTPSConnection", Connection):
            with self.assertRaisesRegex(ValueError, "leaf does not match pin"):
                MODULE.query_instance(config, request)
            self.assertEqual(sent, [])
            config["serverCertificateSha256"] = hashlib.sha256(b"server leaf").hexdigest()
            self.assertEqual(MODULE.query_instance(config, request), expected)
            self.assertEqual(sent, [("GET", "/1.0/instances/" + MODULE.instance_name(request)
                                    + "?project=ezharness", {"Accept": "application/json"})])


if __name__ == "__main__":
    unittest.main()
