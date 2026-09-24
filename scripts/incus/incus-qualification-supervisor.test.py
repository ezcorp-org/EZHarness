#!/usr/bin/env python3
"""Process-level proof of the Linux control socket and restart handoff."""

import importlib.util
import json
import os
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path


SOURCE = Path(__file__).with_name("incus-qualification-supervisor.py")
SPEC = importlib.util.spec_from_file_location("incus_supervisor", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


APP = r'''
import json, os, socket, sys, time
from pathlib import Path
root = Path(sys.argv[1]); control = sys.argv[2]
stat = Path('/proc/self/stat').read_text(); ticks = stat[stat.rfind(')')+2:].split()[19]
index = len(list(root.glob('app-*.json')))
(root / f'app-{index}.json').write_text(json.dumps({'pid': os.getpid(), 'startTicks': ticks}))
def call(data):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.connect(control); sock.sendall(json.dumps(data).encode()+b'\n')
        reply=b''
        while not reply.endswith(b'\n'): reply += sock.recv(4096)
        return json.loads(reply)
request = json.loads((root / 'request.json').read_text())
if index == 0:
    if (root / 'hold-restart').exists():
        while not (root / 'allow-restart').exists(): time.sleep(0.01)
    (root / 'accepted.json').write_text(json.dumps(call(request)))
else:
    receipt = {'version':1,'action':'receipt','runId':request['runId'],
               'nonce':request['nonce'],'afterDigest':'b'*64}
    stale = dict(receipt, afterDigest='c'*64)
    (root / 'stale.json').write_text(json.dumps(call(stale)))
    (root / 'receipt.json').write_text(json.dumps(call(receipt)))
    (root / 'replay.json').write_text(json.dumps(call(receipt)))
    if (root / 'fault.json').exists():
        arm = json.loads((root / 'fault.json').read_text())
        for label, phase, value in [('presence', 'presence', None),
                ('premature', 'readback', arm), ('arm', 'arm', arm),
                ('same-arm', 'arm', arm), ('changed-arm', 'arm', dict(arm, bindingId='user-binding')),
                ('readback', 'readback', arm)]:
            message = {'version':1,'action':'fault','phase':phase}
            if value is not None: message['arm'] = value
            (root / f'fault-{label}.json').write_text(json.dumps(call(message)))
while True: time.sleep(0.1)
'''

AUTH = r'''
import json, sys
from pathlib import Path
root = Path(sys.argv[1]); request=json.loads(sys.stdin.read())
old=json.loads((root/'app-0.json').read_text())
if request['runId'] != 'run' or request['bindingId'] != 'binding': sys.exit(1)
print(json.dumps({'authorized': True, 'oldProcess': old}))
'''

RECEIPT_AUTH = r'''
import json, sys
input=json.loads(sys.stdin.read())
if input['phase'] == 'snapshot':
    print(json.dumps({'snapshot':{'fixture':input['request']['bindingId']}}))
elif input['phase'] == 'verify':
    if input['snapshot'] != {'fixture':'binding'}: sys.exit(1)
    print(json.dumps({'afterDigest':'b'*64}))
else: sys.exit(1)
'''

FAULT_AUTH = r'''
import hashlib, json, sys
message=json.loads(sys.stdin.read())
arm=message['arm']
canonical=json.dumps(arm,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
print(json.dumps({'authorized':True,'armDigest':hashlib.sha256(canonical).hexdigest()}))
'''


def wait_file(path):
    for _ in range(200):
        if path.exists(): return json.loads(path.read_text())
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {path}")


def process_live(pid):
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        return stat[stat.rfind(")") + 2] != "Z"
    except FileNotFoundError:
        return False


class SupervisorTest(unittest.TestCase):
    def test_restart_refuses_snapshot_if_app_uid_stays_live(self):
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            key.write_text("private test key")
            key.chmod(0o600)
            supervisor = MODULE.Supervisor(str(root / "control.sock"),
                [sys.executable, "-c", "import time; time.sleep(60)"],
                os.getuid(), os.getgid(), key, ["true"], ["true"],
                enforce_distinct_uid=False)
            supervisor.start_child()
            snapshot = mock.Mock()
            supervisor.authorize = snapshot
            try:
                with mock.patch.object(supervisor, "remaining_app_processes", return_value=[999]):
                    with self.assertRaisesRegex(ValueError, "client fence failed"):
                        supervisor.restart_authorized({"runId": "run"})
                snapshot.assert_not_called()
                self.assertIsNotNone(supervisor.child)
            finally:
                if supervisor.child and supervisor.child.poll() is None:
                    os.killpg(supervisor.child.pid, signal.SIGKILL)
                    supervisor.child.wait(timeout=5)

    def test_restart_fences_stubborn_descendant_before_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            key.write_text("private test key")
            key.chmod(0o600)
            app = r'''
import os, signal, subprocess, sys, time
from pathlib import Path
root=Path(sys.argv[1]); marker=root/'generation'
if not marker.exists():
    marker.write_text('first')
    child=subprocess.Popen([sys.executable,'-c',
        'import signal,time,sys; from pathlib import Path; '
        'signal.signal(signal.SIGTERM,signal.SIG_IGN); '
        'Path(sys.argv[1]).write_text("ready"); time.sleep(60)',
        str(root/'stubborn-ready')])
    (root/'stubborn.pid').write_text(str(child.pid))
while True: time.sleep(.1)
'''
            snapshot = r'''
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); pid=int((root/'stubborn.pid').read_text())
stat=Path(f'/proc/{pid}/stat')
alive=stat.exists() and stat.read_text()[stat.read_text().rfind(')')+2] != 'Z'
(root/'snapshot-alive').write_text(str(alive))
print(json.dumps({'snapshot':{'alive':alive}}))
'''
            supervisor = MODULE.Supervisor(str(root / "control.sock"),
                [sys.executable, "-c", app, directory], os.getuid(), os.getgid(),
                key, ["true"], [sys.executable, "-c", snapshot, directory],
                enforce_distinct_uid=False)
            supervisor.authorize = lambda _request: None
            supervisor.start_child()
            try:
                for _ in range(100):
                    if (root / "stubborn.pid").exists() and (root / "stubborn-ready").exists(): break
                    time.sleep(0.05)
                pid = int((root / "stubborn.pid").read_text())
                request = {"runId": "run", "deadlineMs": int(time.time()*1000)+30000}
                supervisor.restart_authorized(request)
                self.assertEqual((root / "snapshot-alive").read_text(), "False")
                self.assertFalse(process_live(pid))
            finally:
                if supervisor.child and supervisor.child.poll() is None:
                    os.killpg(supervisor.child.pid, signal.SIGKILL)
                    supervisor.child.wait(timeout=5)
                if (root / "stubborn.pid").exists():
                    try: os.kill(int((root / "stubborn.pid").read_text()), signal.SIGKILL)
                    except ProcessLookupError: pass

    def test_readiness_requires_both_independent_verifiers_and_no_active_run(self):
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            key.write_text("private test key")
            key.chmod(0o600)
            supervisor = MODULE.Supervisor(str(root / "control.sock"), ["true"],
                os.getuid(), os.getgid(), key, ["authority"], ["receipt"],
                enforce_distinct_uid=False)
            request = {"version": 1, "action": "readiness"}
            with self.assertRaisesRegex(ValueError, "fault verifier"):
                supervisor.readiness(request)
            supervisor.fault_authority_command = ["fault"]
            with mock.patch.object(MODULE.subprocess, "run", side_effect=[
                    subprocess.CompletedProcess([], 0, stdout=b'{"ready":"receipt.v1"}\n'),
                    subprocess.CompletedProcess([], 0, stdout=b'{"ready":"fault.v1"}\n')]) as run:
                self.assertEqual(supervisor.readiness(request),
                                 {"ready": True, "protocol": "incus-qualification.v1"})
                self.assertEqual([call.args[0] for call in run.call_args_list],
                                 [["receipt"], ["fault"]])
            with mock.patch.object(MODULE.subprocess, "run", side_effect=[
                    subprocess.CompletedProcess([], 0, stdout=b'{"ready":"receipt.v1"}\n'),
                    subprocess.CompletedProcess([], 1, stdout=b'')]):
                with self.assertRaisesRegex(ValueError, "fault verifier"):
                    supervisor.readiness(request)
            supervisor.pending = {"run": "active"}
            with self.assertRaisesRegex(ValueError, "already active"):
                supervisor.readiness(request)
            with self.assertRaisesRegex(ValueError, "invalid readiness"):
                supervisor.readiness({**request, "scope": "forged"})

    def test_operator_noeffect_recovery_requires_fence_and_two_independent_reads(self):
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            key.write_text("private test key")
            key.chmod(0o600)
            supervisor = MODULE.Supervisor(str(root / "control.sock"), ["true"],
                os.getuid(), os.getgid(), key, ["true"], ["true"],
                enforce_distinct_uid=False)
            supervisor.recovery_command = ["verifier"]
            with self.assertRaisesRegex(ValueError, "independent runner client fence verifier"):
                supervisor.verify_recovery_fence({"fenceEvidence": "evidence",
                                                  "deadlineMs": int(time.time()*1000)+10000},
                                                 {"pid": 123, "startTicks": "456"})
            supervisor.recovery_fence_command = ["checker"]
            with mock.patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess(
                    [], 0, stdout=b'{"fenced":true,"evidence":"different"}')):
                with self.assertRaisesRegex(ValueError, "client fence verification failed"):
                    supervisor.verify_recovery_fence({"fenceEvidence": "reviewed evidence",
                                                      "deadlineMs": int(time.time()*1000)+10000},
                                                     {"pid": 123, "startTicks": "456"})
            request = {"version": 1, "action": "recover-noeffect",
                "nonce": "nonce", "reviewId": "review", "scope": {
                    "installationId": "installation", "releaseId": "release",
                    "connectionId": "connection", "presetId": "preset"},
                "fixtureOperationId": "fixture", "bindingId": "binding",
                "operationId": "unknown-create", "generation": 1,
                "connectionRevision": 1, "allClientsFenced": True,
                "fenceEvidence": "all app and runner clients stopped by operator",
                "deadlineMs": int(time.time() * 1000) + 160000}
            with self.assertRaisesRegex(ValueError, "operator recovery deadline invalid"):
                MODULE.validate_recovery(dict(request,
                    deadlineMs=int(time.time() * 1000) + 120000))
            events = []
            supervisor.assert_exclusive_app_uid = lambda: (_ for _ in ()).throw(
                ValueError("app UID is shared outside the managed process group"))
            with self.assertRaisesRegex(ValueError, "app UID is shared"):
                supervisor.recover_noeffect(request)
            self.assertEqual(events, [], "shared UID preflight killed the app")
            supervisor.assert_exclusive_app_uid = lambda: None
            supervisor.stop_child = lambda: events.append("stop") or {"pid": 123, "startTicks": "456"}
            supervisor.start_child = lambda: events.append("start")
            supervisor.verify_recovery_fence = lambda _request, _old: events.append("fence")
            def stage(phase, value, _deadline):
                events.append(phase)
                if phase == "durable":
                    return {"verified": True}
                if phase == "backend":
                    return {"absent": True, "activeOperations": []}
                return {"cleanupOperationId": "cleanup"}
            supervisor.recovery_stage = stage
            supervisor.sign_payload = lambda payload: events.append("sign") or {
                "payload": payload, "signature": "signed"}
            with mock.patch.object(MODULE.time, "sleep", lambda _seconds: None):
                # The test clock must advance across the required quiet windows.
                with mock.patch.object(MODULE.time, "time",
                        side_effect=[1000, 1000, 1066, 1066, 1072]), \
                     mock.patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess(
                         [], 0, stdout=b"public key")):
                    request["deadlineMs"] = 1_160_000
                    result = supervisor.recover_noeffect(request)
            self.assertEqual(events, ["stop", "fence", "durable", "backend", "durable", "backend",
                                      "sign", "fence", "apply", "start"])
            self.assertEqual(result["receipt"]["payload"]["oldProcess"],
                             {"pid": 123, "startTicks": "456"})
            events.clear()
            request["nonce"] = "late-fail"
            request["deadlineMs"] = int(time.time() * 1000) + 160000
            def late_fence(_request, _old):
                events.append("fence")
                if events.count("fence") == 2:
                    raise ValueError("runner restarted")
            supervisor.verify_recovery_fence = late_fence
            with mock.patch.object(MODULE.time, "sleep", lambda _seconds: None), \
                 mock.patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess(
                     [], 0, stdout=b"public key")):
                with self.assertRaisesRegex(ValueError, "runner restarted"):
                    supervisor.recover_noeffect(request)
            self.assertEqual(events[-3:], ["sign", "fence", "start"])
            self.assertNotIn("apply", events)
            request["deadlineMs"] = int(time.time() * 1000) + 160000
            with self.assertRaisesRegex(ValueError, "replayed"):
                supervisor.recover_noeffect(request)
            altered = dict(request, nonce="fresh", allClientsFenced=False)
            with self.assertRaisesRegex(ValueError, "invalid operator recovery"):
                supervisor.recover_noeffect(altered)

    def test_receipt_never_signs_after_run_deadline(self):
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            key.write_text("private test key")
            key.chmod(0o600)
            supervisor = MODULE.Supervisor(str(root / "control.sock"), ["true"],
                os.getuid(), os.getgid(), key, ["true"], ["true"],
                enforce_distinct_uid=False)
            supervisor.child_identity = {"pid": 2, "startTicks": "2"}
            original = {"runId": "run", "nonce": "nonce", "deadlineMs": int(time.time() * 1000) + 100,
                "scope": {}, "fixtureOperationId": "fixture", "bindingId": "binding",
                "generation": 1, "connectionRevision": 1, "lastOperationId": "operation",
                "beforeDigest": "a" * 64}
            supervisor.pending = {"request": original, "oldProcess": {"pid": 1, "startTicks": "1"},
                                  "snapshot": {}}
            claim = {"version": 1, "action": "receipt", "runId": "run", "nonce": "nonce",
                     "afterDigest": "b" * 64}
            def delayed_verify(_command, **_kwargs):
                time.sleep(0.2)
                return subprocess.CompletedProcess([], 0, stdout=json.dumps({"afterDigest": "b" * 64}).encode())
            with mock.patch.object(MODULE.subprocess, "run", side_effect=delayed_verify) as run:
                with self.assertRaisesRegex(ValueError, "receipt expired"):
                    supervisor.receipt(claim)
                self.assertEqual(run.call_count, 1, "expired receipt reached signing")

    def test_disabled_example_verifier_does_not_sign_receipt(self):
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            subprocess.run(["openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(key)],
                           check=True, capture_output=True)
            key.chmod(0o600)
            socket_path = root / "control.sock"
            request = {"version": 1, "action": "restart", "runId": "run", "nonce": "nonce",
                       "deadlineMs": int(time.time()*1000)+30000,
                       "scope": {"installationId": "installation", "releaseId": "release",
                                 "connectionId": "connection", "presetId": "preset"},
                       "fixtureOperationId": "fixture", "bindingId": "binding",
                       "generation": 3, "connectionRevision": 2,
                       "lastOperationId": "stop-operation", "beforeDigest": "a"*64}
            (root / "request.json").write_text(json.dumps(request))
            runner = subprocess.Popen([sys.executable, "-c", """
import importlib.util, sys
s=importlib.util.spec_from_file_location('supervisor',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.Supervisor(sys.argv[2],[sys.executable,'-c',sys.argv[3],sys.argv[4],sys.argv[2]],
 int(sys.argv[5]),int(sys.argv[6]),sys.argv[7],[sys.executable,'-c',sys.argv[8],sys.argv[4]],
 [sys.argv[9]],
 enforce_distinct_uid=False).serve()
""", str(SOURCE), str(socket_path), APP, directory, str(os.getuid()), str(os.getgid()), str(key),
                  AUTH, shutil.which("false")], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                wait_file(root / "app-1.json")
                self.assertEqual(wait_file(root / "receipt.json"), {"error": "receipt unavailable"})
            finally:
                runner.terminate()
                try: runner.wait(timeout=5)
                except subprocess.TimeoutExpired: runner.kill(); runner.wait()
                runner.stdout.close(); runner.stderr.close()

    def test_unexpected_app_exit_ends_supervisor_with_failure(self):
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            subprocess.run(["openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(key)],
                           check=True, capture_output=True)
            key.chmod(0o600)
            socket_path = root / "control.sock"
            runner = subprocess.run([sys.executable, "-c", """
import importlib.util, sys
s=importlib.util.spec_from_file_location('supervisor',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.Supervisor(sys.argv[2],[sys.executable,'-c','raise SystemExit(7)'],
 int(sys.argv[3]),int(sys.argv[4]),sys.argv[5],['true'],['true'],
 enforce_distinct_uid=False).serve()
""", str(SOURCE), str(socket_path), str(os.getuid()), str(os.getgid()), str(key)],
                capture_output=True, timeout=5)
            self.assertNotEqual(runner.returncode, 0)
            self.assertIn(b"managed app exited unexpectedly", runner.stderr)
            self.assertFalse(socket_path.exists())

    def test_group_writable_control_directory_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            subprocess.run(["openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(key)],
                           check=True, capture_output=True)
            key.chmod(0o600)
            root.chmod(0o770)
            supervisor = MODULE.Supervisor(str(root / "control.sock"), ["true"],
                                           os.getuid(), os.getgid(), key, ["true"], ["true"],
                                           enforce_distinct_uid=False)
            with self.assertRaisesRegex(RuntimeError, "operator-owned and private"):
                supervisor.serve()

    def test_real_restart_kernel_peer_and_one_use_receipt(self):
        # AF_UNIX paths are short; do not inherit a nested CI TMPDIR.
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            subprocess.run(["openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(key)],
                           check=True, capture_output=True)
            key.chmod(0o600)
            socket_path = root / "control.sock"
            request = {"version": 1, "action": "restart", "runId": "run", "nonce": "nonce",
                       "deadlineMs": int(time.time()*1000)+30000,
                       "scope": {"installationId": "installation", "releaseId": "release",
                                 "connectionId": "connection", "presetId": "preset"},
                       "fixtureOperationId": "fixture", "bindingId": "binding",
                       "generation": 3, "connectionRevision": 2,
                       "lastOperationId": "stop-operation", "beforeDigest": "a"*64}
            (root / "request.json").write_text(json.dumps(request))
            (root / "fault.json").write_text(json.dumps({
                "runId": "run", "nonce": "nonce", "deadlineMs": int(time.time()*1000)+20000,
                "scope": request["scope"], "fixtureOperationId": "fixture", "bindingId": "binding",
                "destroyOperationId": "e3a94f88-c426-4bc3-8cd3-263681049a1b",
                "generation": 3, "providerGeneration": 2, "connectionRevision": 2}))
            (root / "hold-restart").write_text("1")
            # Production constructor rejects a shared app/operator UID.
            with self.assertRaisesRegex(RuntimeError, "distinct UIDs"):
                MODULE.Supervisor(str(socket_path), ["true"], os.getuid(), os.getgid(), key,
                                  ["true"], ["true"])
            # Exercise the real accept loop in a separate supervisor process.
            runner = subprocess.Popen([sys.executable, "-c", """
import importlib.util, sys
s=importlib.util.spec_from_file_location('supervisor',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
supervisor=m.Supervisor(sys.argv[2],[sys.executable,'-c',sys.argv[3],sys.argv[4],sys.argv[2]],
 int(sys.argv[5]),int(sys.argv[6]),sys.argv[7],[sys.executable,'-c',sys.argv[8],sys.argv[4]],
 [sys.executable,'-c',sys.argv[9]],
 enforce_distinct_uid=False)
supervisor.fault_authority_command=[sys.executable,'-c',sys.argv[10]]
supervisor.serve()
""", str(SOURCE), str(socket_path), APP, directory, str(os.getuid()), str(os.getgid()), str(key),
                  AUTH, RECEIPT_AUTH, FAULT_AUTH],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            new_pid = None
            try:
                for _ in range(100):
                    if socket_path.exists(): break
                    time.sleep(0.05)
                self.assertTrue(socket_path.exists())
                with socket.socket(socket.AF_UNIX) as rogue:
                    rogue.connect(str(socket_path))
                    rogue.sendall(json.dumps(request).encode()+b"\n")
                    self.assertIn("unauthorized control peer", rogue.recv(4096).decode())
                with socket.socket(socket.AF_UNIX) as rogue:
                    rogue.connect(str(socket_path))
                    try:
                        rogue.sendall(b'{"version":1,"action":"fault","phase":"presence"}\n')
                        self.assertIn("unauthorized control peer", rogue.recv(4096).decode())
                    except BrokenPipeError:
                        # The peer check can close before this client sends.
                        pass
                (root / "allow-restart").write_text("1")
                old = wait_file(root / "app-0.json")
                new = wait_file(root / "app-1.json")
                new_pid = new["pid"]
                self.assertNotEqual(old, new)
                self.assertFalse(Path(f"/proc/{old['pid']}").exists())
                response = wait_file(root / "receipt.json")
                self.assertIn("receipt", response, response)
                self.assertEqual(wait_file(root / "stale.json"),
                                 {"error": "independent backend receipt verification failed"})
                self.assertEqual(response["receipt"]["payload"]["oldProcess"], old)
                self.assertEqual(response["receipt"]["payload"]["newProcess"], new)
                self.assertEqual(wait_file(root / "replay.json"), {"error": "receipt unavailable"})
                self.assertEqual(wait_file(root / "fault-presence.json"), {"authorized": True})
                self.assertEqual(wait_file(root / "fault-premature.json"), {"error": "fault was not armed"})
                self.assertEqual(wait_file(root / "fault-arm.json"), {"authorized": True})
                self.assertEqual(wait_file(root / "fault-same-arm.json"), {"authorized": True})
                self.assertEqual(wait_file(root / "fault-changed-arm.json"),
                                 {"error": "fault claim mismatch"})
                self.assertEqual(wait_file(root / "fault-readback.json"), {"authorized": True})
                public = subprocess.run(["openssl", "pkey", "-in", str(key), "-pubout"],
                                        check=True, capture_output=True).stdout
                signature = __import__("base64").b64decode(response["receipt"]["signature"])
                signed = MODULE.canonical(response["receipt"]["payload"])
                pub = root / "public.pem"; pub.write_bytes(public)
                data = root / "payload"; data.write_bytes(signed)
                sig = root / "signature"; sig.write_bytes(signature)
                verified = subprocess.run(["openssl", "pkeyutl", "-verify", "-rawin",
                    "-pubin", "-inkey", str(pub), "-sigfile", str(sig), "-in", str(data)],
                    capture_output=True)
                self.assertEqual(verified.returncode, 0, verified.stderr)
                receipt_file = root / "handoff.json"
                receipt_file.write_text(json.dumps(response["receipt"]))
                app_verified = subprocess.run(["bun", "-e", """
import { verifyRestartHandoff } from './src/infrastructure/incus-qualification-checkpoint.ts';
const receipt = await Bun.file(process.argv[1]).json();
const key = await Bun.file(process.argv[2]).text();
verifyRestartHandoff(receipt, key);
""", str(receipt_file), str(pub)], cwd=SOURCE.parents[2], capture_output=True)
                self.assertEqual(app_verified.returncode, 0, app_verified.stderr)
            finally:
                runner.terminate()
                try: runner.wait(timeout=5)
                except subprocess.TimeoutExpired: runner.kill(); runner.wait()
                runner.stdout.close(); runner.stderr.close()
                if new_pid is not None:
                    self.assertFalse(Path(f"/proc/{new_pid}").exists(),
                                     "supervisor left its managed app running after shutdown")


if __name__ == "__main__":
    unittest.main()
