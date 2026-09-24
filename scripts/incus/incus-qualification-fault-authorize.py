#!/usr/bin/env python3
"""Operator-owned, read-only Incus evidence for one SP05 destroy fault.

The supervisor invokes this command with a private pinned connection config.
It never opens the app database or accepts an app-provided backend response.
"""

import argparse
import hashlib
import http.client
import json
import os
import re
import ssl
import stat
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlsplit


IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
DIGEST = re.compile(r"^[a-f0-9]{64}$")
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
SCOPE_KEYS = {"installationId", "releaseId", "connectionId", "presetId"}
ARM_KEYS = {"runId", "nonce", "deadlineMs", "scope", "fixtureOperationId", "bindingId",
            "destroyOperationId", "generation", "providerGeneration", "connectionRevision"}
CONFIG_KEYS = {"endpoint", "project", "serverCertificateSha256", "clientCertificate",
               "clientKey", "scope"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def owned_file(path):
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("operator file is not private")


def validate(message, config):
    if not isinstance(message, dict) or set(message) != {"phase", "arm"} \
            or message["phase"] not in ("arm", "readback"):
        raise ValueError("invalid fault verification request")
    arm = message["arm"]
    if not isinstance(arm, dict) or set(arm) != ARM_KEYS or not isinstance(arm["scope"], dict) \
            or set(arm["scope"]) != SCOPE_KEYS or arm["scope"] != config["scope"]:
        raise ValueError("fault scope mismatch")
    for name in ("runId", "nonce", "fixtureOperationId", "bindingId"):
        if not isinstance(arm[name], str) or not IDENTIFIER.fullmatch(arm[name]):
            raise ValueError("invalid fault identity")
    if not isinstance(arm["destroyOperationId"], str) or not UUID.fullmatch(arm["destroyOperationId"]):
        raise ValueError("invalid destroy operation identity")
    for name in ("generation", "providerGeneration", "connectionRevision", "deadlineMs"):
        if type(arm[name]) is not int or arm[name] <= 0:
            raise ValueError("invalid fault number")
    now = int(time.time() * 1000)
    if not now < arm["deadlineMs"] <= now + 30000:
        raise ValueError("fault deadline expired or excessive")
    return arm


def instance_name(arm):
    seed = (arm["scope"]["connectionId"] + "\0" + arm["bindingId"]).encode()
    return "ezh-" + hashlib.sha256(seed).hexdigest()[:32]


def query_instance(config, arm):
    endpoint = urlsplit(config["endpoint"])
    if endpoint.scheme != "https" or not endpoint.hostname or endpoint.username \
            or endpoint.password or endpoint.path not in ("", "/") or endpoint.query or endpoint.fragment:
        raise ValueError("invalid pinned Incus endpoint")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    context.load_cert_chain(config["clientCertificate"], config["clientKey"])
    connection = http.client.HTTPSConnection(endpoint.hostname, endpoint.port or 443,
                                             context=context, timeout=5)
    try:
        # Check the exact pinned server leaf before sending the HTTP request.
        connection.connect()
        leaf = connection.sock.getpeercert(binary_form=True)
        if not leaf or hashlib.sha256(leaf).hexdigest() != config["serverCertificateSha256"]:
            raise ValueError("Incus server leaf does not match pin")
        path = "/1.0/instances/" + instance_name(arm) + "?project=" + quote(config["project"], safe="")
        connection.request("GET", path, headers={"Accept": "application/json"})
        response = connection.getresponse()
        body = response.read(262145)
        if len(body) > 262144:
            raise ValueError("Incus response is too large")
        if response.status == 404:
            return None
        if response.status != 200:
            raise ValueError("Incus readback failed")
        envelope = json.loads(body)
        if not isinstance(envelope, dict) or envelope.get("type") != "sync" \
                or not isinstance(envelope.get("metadata"), dict):
            raise ValueError("Incus readback is invalid")
        return envelope["metadata"]
    finally:
        connection.close()


def verify(message, config, observed):
    arm = validate(message, config)
    if message["phase"] == "readback":
        if observed is not None:
            raise ValueError("Incus instance is still present")
    else:
        if not isinstance(observed, dict) or observed.get("name") != instance_name(arm) \
                or observed.get("status") != "Stopped" or not isinstance(observed.get("config"), dict):
            raise ValueError("stopped Incus fixture is unavailable")
        tags = observed["config"]
        expected = {"user.ezharness.managed_by": "ezharness-incus-sandbox",
                    "user.ezharness.connection_id": arm["scope"]["connectionId"],
                    "user.ezharness.sandbox_id": arm["bindingId"],
                    "user.ezharness.preset_id": arm["scope"]["presetId"],
                    "user.ezharness.generation": str(arm["providerGeneration"])}
        if any(tags.get(key) != value for key, value in expected.items()):
            raise ValueError("Incus fixture identity mismatch")
    return {"authorized": True, "armDigest": hashlib.sha256(canonical(arm)).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    owned_file(args.config)
    config = json.loads(Path(args.config).read_text())
    if not isinstance(config, dict) or set(config) != CONFIG_KEYS \
            or not isinstance(config["scope"], dict) or set(config["scope"]) != SCOPE_KEYS \
            or any(not isinstance(value, str) or not IDENTIFIER.fullmatch(value)
                   for value in config["scope"].values()) \
            or not isinstance(config["project"], str) or not IDENTIFIER.fullmatch(config["project"]) \
            or not isinstance(config["serverCertificateSha256"], str) \
            or not DIGEST.fullmatch(config["serverCertificateSha256"]):
        raise ValueError("invalid operator fault config")
    for name in ("clientCertificate", "clientKey"):
        if not isinstance(config[name], str) or not config[name].startswith("/"):
            raise ValueError("invalid operator client file")
        owned_file(config[name])
    message = json.loads(sys.stdin.buffer.readline(16385))
    arm = validate(message, config)
    result = verify(message, config, query_instance(config, arm))
    sys.stdout.buffer.write(canonical(result) + b"\n")


if __name__ == "__main__":
    main()
