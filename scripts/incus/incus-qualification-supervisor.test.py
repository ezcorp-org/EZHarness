#!/usr/bin/env python3
"""Process-level proof of the Linux control socket and restart handoff."""

import importlib.util
import base64
import hashlib
import json
import os
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest import mock
from pathlib import Path


SOURCE = Path(__file__).with_name("incus-qualification-supervisor.py")
SPEC = importlib.util.spec_from_file_location("incus_supervisor", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


APP = r'''
import json, os, socket, subprocess, sys, tempfile, time
from pathlib import Path
def publish_json(path, value):
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
root = Path(sys.argv[1]); control = sys.argv[2]
stat = Path('/proc/self/stat').read_text(); ticks = stat[stat.rfind(')')+2:].split()[19]
index = len(list(root.glob('app-*.json')))
publish_json(root / f'app-{index}.json', {'pid': os.getpid(), 'startTicks': ticks})
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
    publish_json(root / 'accepted.json', call(request))
else:
    receipt = {'version':1,'action':'receipt','runId':request['runId'],
               'nonce':request['nonce'],'afterDigest':'b'*64}
    stale = dict(receipt, afterDigest='c'*64)
    publish_json(root / 'stale.json', call(stale))
    publish_json(root / 'receipt.json', call(receipt))
    publish_json(root / 'replay.json', call(receipt))
    if (root / 'fault.json').exists():
        arm = json.loads((root / 'fault.json').read_text())
        for label, phase, value in [('presence', 'presence', None),
                ('premature', 'readback', arm), ('arm', 'arm', arm),
                ('same-arm', 'arm', arm), ('changed-arm', 'arm', dict(arm, bindingId='user-binding')),
                ('readback', 'readback', arm)]:
            message = {'version':1,'action':'fault','phase':phase}
            if value is not None: message['arm'] = value
            publish_json(root / f'fault-{label}.json', call(message))
    if index == 1 and (root / 'terminal-client-source').exists():
        while not (root / 'terminal-go').exists(): time.sleep(0.01)
        payload = json.loads((root / 'receipt.json').read_text())['receipt']['payload']
        attestation = {key: payload[key] for key in ['runId','nonce','scope','connectionRevision']}
        attestation.update(process=payload['newProcess'], claimedProcess=payload['newProcess'], state='COMPLETED')
        publish_json(root/'terminal-python-readiness.json', call({'version':1,'action':'readiness'}))
        os.execvpe('bun', ['bun', '-e', """
const { writeFileSync, renameSync, existsSync, readFileSync } = await import('node:fs');
const client = await import(process.env.CLIENT_SOURCE);
try {
const attestation = JSON.parse(process.env.TERMINAL_ATTESTATION);
let activeDenied = false;
try { await client.requestIncusSupervisorReadiness(process.env.CONTROL); }
catch { activeDenied = true; }
await client.requestIncusSupervisorTerminal(process.env.CONTROL, attestation);
await client.requestIncusSupervisorTerminal(process.env.CONTROL, attestation);
const ready = await client.requestIncusSupervisorReadiness(process.env.CONTROL);
writeFileSync(process.env.RESULT + '.tmp', JSON.stringify({exit:0,result:{activeDenied,ready},error:''}));
} catch (error) {
writeFileSync(process.env.RESULT + '.tmp', JSON.stringify({exit:1,result:null,error:String(error)}));
}
renameSync(process.env.RESULT + '.tmp', process.env.RESULT);
while (!existsSync(process.env.NEXT_GO)) await Bun.sleep(10);
const next = {...JSON.parse(readFileSync(process.env.REQUEST, 'utf8')),
  runId:'run-next',nonce:'nonce-next',bindingId:'binding-next',fixtureOperationId:'fixture-next',
  deadlineMs:Date.now()+30000};
writeFileSync(process.env.REQUEST, JSON.stringify(next));
await client.requestIncusSupervisorRestart(process.env.CONTROL, next);
setInterval(() => {}, 1000);
"""], dict(os.environ, CLIENT_SOURCE=(root/'terminal-client-source').read_text(),
              TERMINAL_ATTESTATION=json.dumps(attestation), CONTROL=control, RESULT=str(root/'terminal-client.json'),
              NEXT_GO=str(root/'next-go'), REQUEST=str(root/'request.json')))
while True: time.sleep(0.1)
'''

AUTH = r'''
import json, sys
from pathlib import Path
root = Path(sys.argv[1]); request=json.loads(sys.stdin.read())
expected = {'run':('binding','app-0.json'),'run-next':('binding-next','app-1.json')}.get(request['runId'])
if expected is None or request['bindingId'] != expected[0]: sys.exit(1)
old=json.loads((root/expected[1]).read_text())
print(json.dumps({'authorized': True, 'oldProcess': old}))
'''

RECEIPT_AUTH = r'''
import json, sys
input=json.loads(sys.stdin.read())
if input['phase'] == 'snapshot':
    print(json.dumps({'snapshot':{'fixture':input['request']['bindingId']}}))
elif input['phase'] == 'verify':
    if input['snapshot'] not in ({'fixture':'binding'},{'fixture':'binding-next'}): sys.exit(1)
    print(json.dumps({'afterDigest':'b'*64}))
elif input['phase'] == 'readiness':
    print(json.dumps({'ready':'receipt.v1'}, separators=(',',':')))
else: sys.exit(1)
'''

FAULT_AUTH = r'''
import hashlib, json, sys
message=json.loads(sys.stdin.read())
if message['phase'] == 'readiness':
    print(json.dumps({'ready':'fault.v1'}, separators=(',',':'))); sys.exit(0)
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


def signed_failed_handoff(root, key, *, new_process=None):
    payload = {"version": 1, "runId": "failed-run", "nonce": "saved-nonce",
               "deadlineMs": 1, "scope": {"installationId": "installation", "releaseId": "release",
               "connectionId": "connection", "presetId": "preset"},
               "fixtureOperationId": "qual-primary-failed-run", "bindingId": "primary-binding",
               "generation": 3, "connectionRevision": 2, "lastOperationId": "saved-stop",
               "beforeDigest": "a" * 64, "afterDigest": "b" * 64,
               "oldProcess": {"pid": 99999997, "startTicks": "1"},
               "newProcess": new_process or {"pid": 99999998, "startTicks": "1"}}
    (root / "payload").write_bytes(MODULE.canonical(payload))
    signed = subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(key),
                             "-in", str(root / "payload")], check=True, capture_output=True)
    terminal_row = {key: payload[key] for key in ("runId", "nonce", "scope", "connectionRevision")}
    handoff = {"version": 1, "terminalRow": {**terminal_row, "state": "FAILED"}, "receipt": {"payload": payload,
               "signature": base64.b64encode(signed.stdout).decode()}}
    path = root / "failed-claim.json"
    path.write_bytes(MODULE.canonical(handoff) + b"\n")
    path.chmod(0o600)
    return path, handoff


def handoff_supervisor(root, key, handoff_path, run_id="failed-run"):
    supervisor = MODULE.Supervisor(str(root / "control.sock"), ["true"], os.getuid(), os.getgid(),
                                    key, ["true"], ["true"], enforce_distinct_uid=False)
    supervisor.terminal_handoff_path = handoff_path
    supervisor.terminal_handoff_sha256 = hashlib.sha256(handoff_path.read_bytes()).hexdigest()
    supervisor.terminal_handoff_run_id = run_id
    return supervisor


class TerminalClaimHandoffTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="incus-claim-handoff-", dir="/tmp")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.key = self.root / "key.pem"
        subprocess.run(["openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(self.key)],
                       check=True, capture_output=True)
        self.key.chmod(0o600)
        self.path, self.handoff = signed_failed_handoff(self.root, self.key)

    def supervisor(self, run_id="failed-run"):
        return handoff_supervisor(self.root, self.key, self.path, run_id)

    def terminal(self, process):
        payload = self.handoff["receipt"]["payload"]
        return {"version": 1, "action": "terminal", "state": "FAILED", "process": process,
                "claimedProcess": payload["newProcess"],
                **{key: payload[key] for key in ("runId", "nonce", "scope", "connectionRevision")}}

    def test_config_requires_exact_path_hash_and_run_together(self):
        config = {"socket": str(self.root / "control.sock"), "appCommand": ["app"],
                  "appUid": 1001, "appGid": 1001, "key": str(self.key),
                  "authorityCommand": ["authority"], "receiptAuthorityCommand": ["receipt"],
                  "terminalClaimHandoffPath": str(self.path),
                  "terminalClaimHandoffSha256": hashlib.sha256(self.path.read_bytes()).hexdigest(),
                  "terminalClaimHandoffRunId": "failed-run"}
        path = self.root / "config.json"
        for missing in ("terminalClaimHandoffPath", "terminalClaimHandoffSha256", "terminalClaimHandoffRunId"):
            path.write_text(json.dumps({key: value for key, value in config.items() if key != missing}))
            with mock.patch.object(sys, "argv", ["supervisor", "--config", str(path)]):
                with self.assertRaisesRegex(ValueError, "invalid terminal claim handoff configuration"):
                    MODULE.main()
        path.write_text(json.dumps(config))
        with mock.patch.object(sys, "argv", ["supervisor", "--config", str(path)]), \
                mock.patch.object(MODULE, "Supervisor") as constructor:
            MODULE.main()
        chosen = constructor.return_value
        self.assertEqual(chosen.terminal_handoff_path, self.path)
        self.assertEqual(chosen.terminal_handoff_sha256, config["terminalClaimHandoffSha256"])
        self.assertEqual(chosen.terminal_handoff_run_id, "failed-run")
        chosen.serve.assert_called_once()

    def test_signed_failed_claim_restores_before_child_and_consumes_durably(self):
        supervisor = self.supervisor()
        supervisor.load_terminal_claim_handoff()
        self.assertEqual(supervisor.claimed["newProcess"], self.handoff["receipt"]["payload"]["newProcess"])
        self.assertIn("failed-run", supervisor.used_runs)
        with self.assertRaisesRegex(ValueError, "already active"):
            supervisor.readiness({"version": 1, "action": "readiness"})
        with mock.patch.object(supervisor, "assert_exclusive_app_uid") as exclusive:
            with self.assertRaisesRegex(ValueError, "already active"):
                supervisor.restart_authorized({"runId": "other-run"})
            exclusive.assert_not_called()
        current = MODULE.identity(os.getpid())
        supervisor.child_identity = current
        message = self.terminal(current)
        with self.assertRaisesRegex(ValueError, "terminal claim changed"):
            supervisor.terminal({**message, "runId": "other-run"})
        self.assertFalse(self.path.with_name(self.path.name + ".consumed").exists())
        self.assertEqual(supervisor.terminal(message), {"released": True})
        marker = self.path.with_name(self.path.name + ".consumed")
        self.assertEqual(json.loads(marker.read_text())["terminal"], message)
        self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
        self.assertEqual(supervisor.terminal(message), {"released": True})
        restarted = self.supervisor()
        restarted.load_terminal_claim_handoff()
        self.assertIsNone(restarted.claimed)
        self.assertIn("failed-run", restarted.used_runs)

    def test_missing_changed_and_unrelated_handoffs_fail_before_start(self):
        self.root.chmod(0o750)
        with self.assertRaisesRegex(ValueError, "not private"):
            self.supervisor().load_terminal_claim_handoff()
        self.root.chmod(0o700)
        missing = self.supervisor()
        self.path.unlink()
        with mock.patch.object(missing, "start_child") as start:
            with self.assertRaises(FileNotFoundError):
                missing.serve()
            start.assert_not_called()
        self.path, self.handoff = signed_failed_handoff(self.root, self.key)
        changed = self.supervisor()
        self.path.write_bytes(self.path.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "hash changed"):
            changed.load_terminal_claim_handoff()
        with self.assertRaisesRegex(ValueError, "identity changed"):
            self.supervisor("other-run").load_terminal_claim_handoff()
        mixed = json.loads(self.path.read_text())
        mixed["terminalRow"]["nonce"] = "other-nonce"
        self.path.write_bytes(MODULE.canonical(mixed) + b"\n")
        with self.assertRaisesRegex(ValueError, "saved row changed"):
            self.supervisor().load_terminal_claim_handoff()
        mixed["terminalRow"]["nonce"] = self.handoff["receipt"]["payload"]["nonce"]
        mixed["terminalRow"]["state"] = "COMPLETED"
        self.path.write_bytes(MODULE.canonical(mixed) + b"\n")
        with self.assertRaisesRegex(ValueError, "saved row changed"):
            self.supervisor().load_terminal_claim_handoff()
        self.path, self.handoff = signed_failed_handoff(self.root, self.key)
        forged = json.loads(self.path.read_text())
        forged["receipt"]["payload"]["scope"]["presetId"] = "other-preset"
        forged["terminalRow"]["scope"]["presetId"] = "other-preset"
        self.path.write_bytes(MODULE.canonical(forged) + b"\n")
        with self.assertRaisesRegex(ValueError, "signature changed"):
            self.supervisor().load_terminal_claim_handoff()

    def test_live_claimed_process_and_changed_consumption_are_rejected(self):
        self.path, self.handoff = signed_failed_handoff(self.root, self.key,
                                                        new_process=MODULE.identity(os.getpid()))
        with self.assertRaisesRegex(ValueError, "still alive"):
            self.supervisor().load_terminal_claim_handoff()
        self.path, self.handoff = signed_failed_handoff(self.root, self.key)
        supervisor = self.supervisor()
        supervisor.load_terminal_claim_handoff()
        current = MODULE.identity(os.getpid())
        supervisor.child_identity = current
        self.assertEqual(supervisor.terminal(self.terminal(current)), {"released": True})
        marker = self.path.with_name(self.path.name + ".consumed")
        recorded = json.loads(marker.read_text())
        recorded["terminal"]["nonce"] = "other"
        marker.write_bytes(MODULE.canonical(recorded) + b"\n")
        with self.assertRaisesRegex(ValueError, "consumption changed"):
            self.supervisor().load_terminal_claim_handoff()

    def test_consumption_write_failure_keeps_claim_and_readiness_fenced(self):
        supervisor = self.supervisor()
        supervisor.load_terminal_claim_handoff()
        current = MODULE.identity(os.getpid())
        supervisor.child_identity = current
        with mock.patch.object(supervisor, "persist_abort_file", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                supervisor.terminal(self.terminal(current))
        self.assertIsNotNone(supervisor.claimed)
        self.assertFalse(self.path.with_name(self.path.name + ".consumed").exists())
        with self.assertRaisesRegex(ValueError, "already active"):
            supervisor.readiness({"version": 1, "action": "readiness"})

    def test_real_socket_child_releases_then_restart_keeps_consumed_fence(self):
        app = r'''
import json, os, socket, sys, time
from pathlib import Path
root=Path(sys.argv[1]); control=sys.argv[2]; phase=sys.argv[3]
def call(message):
    with socket.socket(socket.AF_UNIX) as peer:
        peer.connect(control); peer.sendall(json.dumps(message).encode()+b'\n')
        answer=b''
        while not answer.endswith(b'\n'): answer+=peer.recv(4096)
        return json.loads(answer)
stat=Path('/proc/self/stat').read_text(); ticks=stat[stat.rfind(')')+2:].split()[19]
process={'pid':os.getpid(),'startTicks':ticks}
if phase=='second':
    os.execvpe('bun',['bun','-e',r"""
const fs=await import('node:fs');
const root=process.env.HANDOFF_ROOT, socket=process.env.HANDOFF_SOCKET;
const client=await import(process.env.HANDOFF_CLIENT_SOURCE);
const witness=await import(process.env.HANDOFF_WITNESS_SOURCE);
const payload=JSON.parse(fs.readFileSync(root+'/failed-claim.json','utf8')).receipt.payload;
const stat=fs.readFileSync('/proc/self/stat','utf8');
const processId={pid:process.pid,startTicks:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]};
const report=Object.fromEntries(['runId','nonce','scope','connectionRevision'].map(key=>[key,payload[key]]));
Object.assign(report,{process:processId,claimedProcess:payload.newProcess,state:'FAILED'});
const env={EZCORP_INCUS_CONTROL_PROBE_ROOT:root,EZCORP_INCUS_SUPERVISOR_SOCKET:socket,
 EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID:'reviewed-project',
 EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF:'registry.example/proof@sha256:'+ 'a'.repeat(64),
 EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64:process.env.HANDOFF_PUBLIC_KEY_B64};
let releases=0;
const ready=await witness.incusHostLiveWitnessReady({env,terminalRelease:async()=>{
 releases++;await client.requestIncusSupervisorTerminal(socket,report);}});
let wrongRunDenied=false;
try{await client.requestIncusSupervisorTerminal(socket,{...report,runId:'other-run'});}catch{wrongRunDenied=true;}
fs.writeFileSync(root+'/result-second.tmp',JSON.stringify({process:processId,ready,releases,wrongRunDenied}));
fs.renameSync(root+'/result-second.tmp',root+'/result-second.json');
setInterval(()=>{},1000);
"""],dict(os.environ,HANDOFF_ROOT=str(root),HANDOFF_SOCKET=control))
before=call({'version':1,'action':'readiness'})
result={'process':process,'before':before}
if phase=='first':
    payload=json.loads((root/'failed-claim.json').read_text())['receipt']['payload']
    report={key:payload[key] for key in ('runId','nonce','scope','connectionRevision')}
    report.update(version=1,action='terminal',process=process,claimedProcess=payload['newProcess'],state='FAILED')
    result['terminal']=call(report)
    result['after']=call({'version':1,'action':'readiness'})
temporary=root/('result-'+phase+'.tmp')
temporary.write_text(json.dumps(result)); temporary.replace(root/('result-'+phase+'.json'))
while True:time.sleep(.1)
'''
        runner_code = r'''
import importlib.util,sys
s=importlib.util.spec_from_file_location('supervisor',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=sys.argv[2]; path=sys.argv[3]; phase=sys.argv[4]
supervisor=m.Supervisor(root+'/control.sock',[sys.executable,'-c',sys.argv[5],root,root+'/control.sock',phase],
 int(sys.argv[6]),int(sys.argv[7]),root+'/key.pem',[sys.executable,'-c','pass'],
 [sys.executable,'-c',sys.argv[8]],enforce_distinct_uid=False)
supervisor.fault_authority_command=[sys.executable,'-c',sys.argv[9]]
supervisor.terminal_handoff_path=m.Path(path)
supervisor.terminal_handoff_sha256=sys.argv[10]
supervisor.terminal_handoff_run_id='failed-run'
supervisor.serve()
'''
        pin = hashlib.sha256(self.path.read_bytes()).hexdigest()
        public = subprocess.run(["openssl", "pkey", "-in", str(self.key), "-pubout"],
                                check=True, capture_output=True).stdout
        environment = dict(os.environ,
            HANDOFF_PUBLIC_KEY_B64=base64.b64encode(public).decode(),
            HANDOFF_CLIENT_SOURCE=str(SOURCE.parents[2] / "src/infrastructure/incus-qualification-supervisor-client.ts"),
            HANDOFF_WITNESS_SOURCE=str(SOURCE.parents[2] / "src/infrastructure/incus-host-live-witness.ts"))
        for phase in ("first", "second"):
            with self.subTest(phase=phase):
                runner = subprocess.Popen([sys.executable, "-c", runner_code, str(SOURCE), str(self.root),
                    str(self.path), phase, app, str(os.getuid()), str(os.getgid()),
                    RECEIPT_AUTH, FAULT_AUTH, pin], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env=environment)
                try:
                    result = wait_file(self.root / f"result-{phase}.json")
                    if phase == "first":
                        self.assertEqual(result["before"], {"error": "qualification run is already active"})
                        self.assertEqual(result["terminal"], {"released": True})
                        self.assertEqual(result["after"], {"ready": True, "protocol": "incus-qualification.v1"})
                    else:
                        self.assertTrue(result["ready"])
                        self.assertEqual(result["releases"], 1)
                        self.assertTrue(result["wrongRunDenied"])
                    self.assertIsNone(runner.poll(), runner.stderr.read().decode() if runner.poll() is not None else "")
                finally:
                    runner.terminate()
                    try: runner.wait(timeout=5)
                    except subprocess.TimeoutExpired: runner.kill(); runner.wait()
                    runner.stdout.close(); runner.stderr.close()
                self.assertFalse(process_live(result["process"]["pid"]))



class SupervisorTest(unittest.TestCase):
    def test_terminal_claim_release_requires_exact_host_report_and_preserves_replay_fences(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / "key.pem"
            key.write_text("private fixture")
            key.chmod(0o600)
            supervisor = MODULE.Supervisor(str(Path(directory) / "control.sock"), ["true"],
                os.getuid(), os.getgid(), key, ["authority"], ["receipt"], enforce_distinct_uid=False)
            supervisor.fault_authority_command = ["fault"]
            process = MODULE.identity(os.getpid())
            request = {"runId": "completed-run", "nonce": "nonce", "scope": {
                "installationId": "installation", "releaseId": "release", "connectionId": "connection", "presetId": "preset"},
                "connectionRevision": 1, "deadlineMs": 1}
            supervisor.child_identity = process
            supervisor.claimed = {"request": request, "newProcess": process}
            supervisor.used_runs.add(request["runId"])
            supervisor.fault_armed = b"retained-fault"
            with self.assertRaisesRegex(ValueError, "already active"):
                supervisor.readiness({"version": 1, "action": "readiness"})
            terminal = {"version": 1, "action": "terminal", "state": "COMPLETED", "process": process,
                        "claimedProcess": process, **{key: request[key] for key in ("runId", "nonce", "scope", "connectionRevision")}}
            for field, value in (("runId", "other"), ("nonce", "other"), ("connectionRevision", 2),
                                 ("scope", {**request["scope"], "presetId": "other"}), ("process", {"pid": 1, "startTicks": "1"}),
                                 ("claimedProcess", {"pid": 1, "startTicks": "1"}), ("state", "CLAIMED"), ("reauthorizeAbort", True)):
                with self.assertRaises(ValueError):
                    supervisor.terminal({**terminal, field: value})
                self.assertIsNotNone(supervisor.claimed)
            supervisor.pending = {"active": True}
            with self.assertRaisesRegex(ValueError, "pending"):
                supervisor.terminal(terminal)
            supervisor.pending = None
            self.assertEqual(supervisor.terminal(terminal), {"released": True})
            self.assertEqual(supervisor.terminal(terminal), {"released": True})
            self.assertEqual(supervisor.used_runs, {"completed-run"})
            self.assertEqual(supervisor.fault_armed, b"retained-fault")
            with mock.patch.object(MODULE.subprocess, "run", side_effect=[
                    subprocess.CompletedProcess([], 0, stdout=b'{"ready":"receipt.v1"}\n'),
                    subprocess.CompletedProcess([], 0, stdout=b'{"ready":"fault.v1"}\n')]):
                self.assertEqual(supervisor.readiness({"version": 1, "action": "readiness"}),
                                 {"ready": True, "protocol": "incus-qualification.v1"})
            with self.assertRaises(ValueError):
                supervisor.terminal({**terminal, "nonce": "forged"})
            # A later managed engine can recover a missed post-commit report.
            # Historical PID reuse is distinguished by kernel start ticks.
            supervisor.claimed = {"request": request, "newProcess": process}
            current = {"pid": process["pid"] + 1, "startTicks": "replacement"}
            supervisor.child_identity = current
            recovered = {**terminal, "process": current, "state": "FAILED"}
            with mock.patch.object(MODULE, "identity", return_value=process):
                with self.assertRaisesRegex(ValueError, "still alive"):
                    supervisor.terminal(recovered)
            with mock.patch.object(MODULE, "identity", return_value={**process, "startTicks": "reused"}):
                self.assertEqual(supervisor.terminal(recovered), {"released": True})
            supervisor.claimed = {"request": request, "newProcess": process}
            with mock.patch.object(MODULE, "identity", side_effect=ProcessLookupError):
                self.assertEqual(supervisor.terminal(recovered), {"released": True})
            self.assertEqual(supervisor.used_runs, {"completed-run"})
            self.assertEqual(supervisor.fault_armed, b"retained-fault")

    def test_child_json_publication_is_complete_before_visible(self):
        for interrupted in (False, True):
            with self.subTest(interrupted=interrupted), tempfile.TemporaryDirectory(
                    prefix="incus-publish-", dir="/tmp") as directory:
                child = subprocess.Popen([sys.executable, "-c", textwrap.dedent(r"""
    import os, sys
    from pathlib import Path
    original_replace = os.replace
    def paused_write(path, text, *args, **kwargs):
        with path.open('w') as output:
            output.flush()
            print('publication paused', flush=True)
            sys.stdin.readline()
            output.write(text)
    def paused_replace(source, target):
        print('publication paused', flush=True)
        sys.stdin.readline()
        return original_replace(source, target)
    Path.write_text = paused_write
    os.replace = paused_replace
    source = sys.argv[2]
    sys.argv = ['fixture', sys.argv[1], 'unused-control']
    exec(source)
    """), directory, APP.split("def call(data):")[0]],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.assertEqual(child.stdout.readline().strip(), "publication paused")
                    destination = Path(directory) / "app-0.json"
                    self.assertFalse(destination.exists(), "partial JSON must not be published")
                    temporary = list(Path(directory).glob(".app-0.json.*"))
                    self.assertEqual(len(temporary), 1)
                    self.assertEqual(json.loads(temporary[0].read_text())["pid"], child.pid)
                    if interrupted:
                        child.kill()
                finally:
                    _, errors = child.communicate("publish\n", timeout=5)
                if interrupted:
                    self.assertLess(child.returncode, 0)
                    self.assertFalse(destination.exists())
                else:
                    self.assertEqual(child.returncode, 0, errors)
                    published = wait_file(destination)
                    self.assertEqual(published["pid"], child.pid)
                    self.assertGreater(int(published["startTicks"]), 0)

    def test_json_reader_does_not_hide_malformed_published_receipt(self):
        with tempfile.TemporaryDirectory(prefix="incus-invalid-", dir="/tmp") as directory:
            path = Path(directory) / "receipt.json"
            path.write_text("{")
            with self.assertRaises(json.JSONDecodeError):
                wait_file(path)

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

    def test_selected_readiness_forwards_closed_trusted_pin_to_both_verifiers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); key = root / "key.pem"
            key.write_text("private fixture"); key.chmod(0o600)
            supervisor = MODULE.Supervisor(str(root / "control.sock"), ["true"],
                os.getuid(), os.getgid(), key, ["authority"], ["receipt"], enforce_distinct_uid=False)
            supervisor.fault_authority_command = ["fault"]
            pin = {"scope": {"installationId": "installation", "releaseId": "release",
                "connectionId": "connection", "presetId": "preset"}, "connectionRevision": 1,
                "presetDigest": "a"*64, "effectiveSettingsDigest": "b"*64,
                "imageFingerprint": "c"*64, "helperSha256": "d"*64}
            message = {"version": 1, "action": "readiness", "expectedPin": pin}
            with mock.patch.object(MODULE.subprocess, "run", side_effect=[
                    subprocess.CompletedProcess([], 0, stdout=b'{"ready":"receipt.v1"}\n'),
                    subprocess.CompletedProcess([], 0, stdout=b'{"ready":"fault.v1"}\n')]) as run:
                self.assertEqual(supervisor.readiness(message), {"ready": True, "protocol": "incus-qualification.v1"})
                self.assertEqual(json.loads(run.call_args_list[0].kwargs["input"]), {"phase": "readiness", "expectedPin": pin})
                self.assertEqual(json.loads(run.call_args_list[1].kwargs["input"]), {"phase": "readiness", "expectedScope": pin["scope"]})
                self.assertEqual([c.kwargs["timeout"] for c in run.call_args_list], [5, 5])
            for changed in [None, [], {}, dict(pin, extra=True), dict(pin, scope="wrong"),
                    dict(pin, scope=dict(pin["scope"], extra=True)),
                    dict(pin, scope=dict(pin["scope"], releaseId="../wrong")),
                    dict(pin, connectionRevision=True), dict(pin, connectionRevision=0),
                    dict(pin, connectionRevision=9007199254740992), dict(pin, helperSha256="bad")]:
                with mock.patch.object(MODULE.subprocess, "run") as run:
                    with self.assertRaisesRegex(ValueError, "selected readiness"):
                        supervisor.readiness(dict(message, expectedPin=changed))
                    run.assert_not_called()
            for changed in [dict(message, extra=True), dict(message, action="restart"), dict(message, version=2)]:
                with self.assertRaisesRegex(ValueError, "invalid readiness"):
                    supervisor.readiness(changed)
            supervisor.pending = {"run": "active"}
            with self.assertRaisesRegex(ValueError, "already active"):
                supervisor.readiness(message)

    def test_operator_noeffect_recovery_requires_fence_and_two_independent_reads(self):
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            key.write_text("private test key")
            key.chmod(0o600)
            supervisor = MODULE.Supervisor(str(root / "control.sock"), ["true"],
                os.getuid(), os.getgid(), key, ["true"], ["true"],
                enforce_distinct_uid=False)
            config = root / "noeffect.json"
            config.write_text("{}")
            config.chmod(0o600)
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
            supervisor.child = object()
            supervisor.assert_exclusive_app_uid = lambda: (_ for _ in ()).throw(
                ValueError("app UID is shared outside the managed process group"))
            with self.assertRaisesRegex(ValueError, "app UID is shared"):
                supervisor.recover_noeffect(request)
            self.assertEqual(events, [], "shared UID preflight killed the app")
            supervisor.assert_exclusive_app_uid = lambda: None
            def stop_child():
                events.append("stop")
                supervisor.child = None
                return {"pid": 123, "startTicks": "456"}
            def start_child():
                events.append("start")
                supervisor.child = object()
            supervisor.stop_child = stop_child
            supervisor.start_child = start_child
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
            with mock.patch.dict(os.environ, {"EZCORP_INCUS_NOEFFECT_CONFIG": str(config)}), \
                 mock.patch.object(MODULE.time, "sleep", lambda _seconds: None):
                # The test clock must advance across the required quiet windows.
                with mock.patch.object(MODULE.time, "time",
                        side_effect=[1000, 1000, 1066, 1066, 1072]), \
                     mock.patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess(
                         [], 0, stdout=b"public key")):
                    request["deadlineMs"] = 1_160_000
                    result = supervisor.recover_noeffect(request)
            self.assertEqual(events, ["stop", "fence", "durable", "backend", "durable", "backend",
                                      "sign", "fence", "apply", "start"])
            self.assertFalse(supervisor.recovery_hold_path.exists())
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
            with mock.patch.dict(os.environ, {"EZCORP_INCUS_NOEFFECT_CONFIG": str(config)}), \
                 mock.patch.object(MODULE.time, "sleep", lambda _seconds: None), \
                 mock.patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess(
                     [], 0, stdout=b"public key")):
                with self.assertRaisesRegex(ValueError, "runner restarted"):
                    supervisor.recover_noeffect(request)
            self.assertEqual(events[-2:], ["sign", "fence"])
            self.assertNotIn("apply", events)
            self.assertTrue(supervisor.recovery_hold_path.exists())
            self.assertIsNone(supervisor.child)
            request["deadlineMs"] = int(time.time() * 1000) + 160000
            with self.assertRaisesRegex(ValueError, "replayed"):
                supervisor.recover_noeffect(request)
            altered = dict(request, nonce="fresh", allClientsFenced=False)
            with self.assertRaisesRegex(ValueError, "invalid operator recovery"):
                supervisor.recover_noeffect(altered)

    def test_missing_recovery_config_keeps_managed_app_running(self):
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            key.write_text("private test key")
            key.chmod(0o600)
            supervisor = MODULE.Supervisor(str(root / "control.sock"),
                [sys.executable, "-c", "import time; time.sleep(60)"],
                os.getuid(), os.getgid(), key, ["true"], ["true"],
                enforce_distinct_uid=False)
            supervisor.recovery_command = ["verifier"]
            supervisor.recovery_fence_command = ["checker"]
            supervisor.start_child()
            child = supervisor.child
            request = {"version": 1, "action": "recover-noeffect", "nonce": "nonce",
                "reviewId": "review", "scope": {"installationId": "installation",
                    "releaseId": "release", "connectionId": "connection", "presetId": "preset"},
                "fixtureOperationId": "fixture", "bindingId": "binding",
                "operationId": "unknown-create", "generation": 1, "connectionRevision": 1,
                "allClientsFenced": True, "fenceEvidence": "reviewed stopped clients",
                "deadlineMs": int(time.time() * 1000) + 160000}
            try:
                with mock.patch.dict(os.environ, {"EZCORP_INCUS_NOEFFECT_CONFIG": ""}):
                    with self.assertRaisesRegex(ValueError, "config requires an absolute path"):
                        supervisor.recover_noeffect(request)
                config = root / "noeffect.json"
                config.write_text("{}")
                config.chmod(0o644)
                with mock.patch.dict(os.environ, {"EZCORP_INCUS_NOEFFECT_CONFIG": str(config)}):
                    with self.assertRaisesRegex(ValueError, "private operator-owned regular file"):
                        supervisor.recover_noeffect(request)
                config.chmod(0o600)
                alias = root / "noeffect-link.json"
                alias.symlink_to(config)
                with mock.patch.dict(os.environ, {"EZCORP_INCUS_NOEFFECT_CONFIG": str(alias)}):
                    with self.assertRaisesRegex(ValueError, "private operator-owned regular file"):
                        supervisor.recover_noeffect(request)
                self.assertIs(supervisor.child, child)
                self.assertIsNone(child.poll())
                self.assertFalse(supervisor.recovery_hold_path.exists())
                self.assertNotIn(request["nonce"], supervisor.used_recoveries)
            finally:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)

    def test_real_failed_operator_fence_keeps_managed_app_stopped(self):
        with tempfile.TemporaryDirectory(prefix="incus-supervisor-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / "key.pem"
            subprocess.run(["openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(key)],
                           check=True, capture_output=True)
            key.chmod(0o600)
            config = root / "noeffect.json"
            config.write_text("{}")
            config.chmod(0o600)
            socket_path = root / "control.sock"
            operator_path = root / "operator.sock"
            app_pids = root / "app-pids"
            child_code = "import os,sys,time; open(sys.argv[1],'a').write(str(os.getpid())+'\\n'); time.sleep(120)"
            command = [sys.executable, "-c", """
import importlib.util, os, sys
s=importlib.util.spec_from_file_location('supervisor',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
supervisor=m.Supervisor(sys.argv[2],[sys.executable,'-c',sys.argv[5],sys.argv[6]],
 os.getuid(),os.getgid(),sys.argv[4],['true'],['true'],enforce_distinct_uid=False)
supervisor.operator_socket_path=m.Path(sys.argv[3])
supervisor.recovery_command=['true']
supervisor.recovery_fence_command=[sys.executable,'-c','raise SystemExit(1)']
supervisor.serve()
""", str(SOURCE), str(socket_path), str(operator_path), str(key), child_code,
                str(app_pids)]
            runner = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={**os.environ, "EZCORP_INCUS_NOEFFECT_CONFIG": str(config)})
            try:
                for _ in range(100):
                    if operator_path.exists() and app_pids.exists(): break
                    time.sleep(0.05)
                self.assertTrue(operator_path.exists())
                old_pid = int(app_pids.read_text().strip())
                request = {"version": 1, "action": "recover-noeffect", "nonce": "nonce",
                    "reviewId": "review", "scope": {"installationId": "installation",
                        "releaseId": "release", "connectionId": "connection", "presetId": "preset"},
                    "fixtureOperationId": "fixture", "bindingId": "binding",
                    "operationId": "unknown-create", "generation": 1, "connectionRevision": 1,
                    "allClientsFenced": True, "fenceEvidence": "reviewed stopped clients",
                    "deadlineMs": int(time.time() * 1000) + 160000}
                with socket.socket(socket.AF_UNIX) as operator:
                    operator.connect(str(operator_path))
                    operator.sendall(json.dumps(request).encode() + b"\n")
                    response = operator.recv(4096).decode()
                self.assertIn("independent runner client fence verification failed", response)
                for _ in range(100):
                    if not Path(f"/proc/{old_pid}").exists(): break
                    time.sleep(0.05)
                self.assertFalse(Path(f"/proc/{old_pid}").exists())
                time.sleep(0.15)
                self.assertEqual(app_pids.read_text().splitlines(), [str(old_pid)])
                self.assertIsNone(runner.poll(), "supervisor must hold without systemd restarting it")
                self.assertTrue(key.with_name(key.name + ".noeffect-hold").exists())
                request["nonce"] = "new-nonce"
                with socket.socket(socket.AF_UNIX) as operator:
                    operator.connect(str(operator_path))
                    operator.sendall(json.dumps(request).encode() + b"\n")
                    self.assertIn("held for operator review", operator.recv(4096).decode())
                runner.terminate()
                runner.wait(timeout=5)
                runner.stdout.close(); runner.stderr.close()
                runner = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env={**os.environ, "EZCORP_INCUS_NOEFFECT_CONFIG": str(config)})
                for _ in range(100):
                    if operator_path.exists(): break
                    time.sleep(0.05)
                self.assertIsNone(runner.poll(), "held supervisor must survive service restart")
                self.assertEqual(app_pids.read_text().splitlines(), [str(old_pid)],
                                 "service restart must not start the app while held")
                with socket.socket(socket.AF_UNIX) as operator:
                    operator.connect(str(operator_path))
                    operator.sendall(json.dumps(request).encode() + b"\n")
                    self.assertIn("held for operator review", operator.recv(4096).decode())
            finally:
                runner.terminate()
                try: runner.wait(timeout=5)
                except subprocess.TimeoutExpired: runner.kill(); runner.wait()
                runner.stdout.close(); runner.stderr.close()

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
            with self.assertRaisesRegex(RuntimeError, "operator-owned and private"):
                MODULE.Supervisor(str(root / "control.sock"), ["true"],
                                  os.getuid(), os.getgid(), key, ["true"], ["true"],
                                  enforce_distinct_uid=False).serve()

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
                "scope": request["scope"], "fixtureOperationId": "qual-recovery-run",
                "bindingId": "recovery-binding",
                "destroyOperationId": "e3a94f88-c426-4bc3-8cd3-263681049a1b",
                "generation": 1, "providerGeneration": 2, "connectionRevision": 2}))
            (root / "hold-restart").write_text("1")
            (root / 'terminal-client-source').write_text(str(SOURCE.parents[2] /
                'src/infrastructure/incus-qualification-supervisor-client.ts'))
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
                                 {"error": "different fault already armed"})
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
                (root / 'terminal-client-source').write_text(str(SOURCE.parents[2] /
                    'src/infrastructure/incus-qualification-supervisor-client.ts'))
                # Tell the already managed child to use the real TypeScript client.
                (root / 'terminal-go').touch()
                terminal = wait_file(root / 'terminal-client.json')
                self.assertEqual(wait_file(root/'terminal-python-readiness.json'),
                                 {'error':'qualification run is already active'})
                if runner.poll() is not None:
                    self.fail(runner.stderr.read().decode())
                self.assertEqual(terminal['exit'], 0, terminal['error'])
                self.assertEqual(terminal['result'], {'activeDenied':True, 'ready':True})
                (root/'next-go').touch()
                third = wait_file(root/'app-2.json')
                self.assertNotEqual(third, new)
                self.assertFalse(process_live(new['pid']))
                new_pid = third['pid']
            finally:
                runner.terminate()
                try: runner.wait(timeout=5)
                except subprocess.TimeoutExpired: runner.kill(); runner.wait()
                runner.stdout.close(); runner.stderr.close()
                if new_pid is not None:
                    self.assertFalse(Path(f"/proc/{new_pid}").exists(),
                                     "supervisor left its managed app running after shutdown")


class FencedCleanupSignerTest(unittest.TestCase):
    """Exercise the real signer orchestration with sealed private inputs.

    Process fencing and TLS observations are separate integration surfaces.
    This suite pins their replies and proves the supervisor cannot widen them.
    """

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="incus-cleanup-signer-", dir="/tmp")
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        key = root / "key.pem"
        key.write_text("private test key")
        key.chmod(0o600)
        self.supervisor = MODULE.Supervisor(str(root / "control.sock"), ["true"],
            os.getuid(), os.getgid(), key, ["true"], ["true"], enforce_distinct_uid=False)
        self.supervisor.recovery_command = ["verifier"]
        self.supervisor.recovery_fence_command = ["fence"]
        self.supervisor.child = object()
        self.events = []
        self.request = {"version": 1, "action": "recover-fenced-cleanup", "nonce": "nonce",
            "reviewId": "review", "scope": {"installationId": "installation",
                "releaseId": "release", "connectionId": "connection", "presetId": "preset"},
            "fixtureOperationId": "fixture", "bindingId": "binding", "operationId": "unknown-start",
            "generation": 1, "connectionRevision": 1, "allClientsFenced": True,
            "fenceEvidence": "independently fenced app and runner", "deadlineMs": 1_160_000}
        self.pins = {"installationGeneration": 4, "releaseDigest": "a" * 64,
            "grantsDigest": "b" * 64, "endpoint": "https://server:8443", "project": "ezharness",
            "providerOperationId": "incus-setPower-182045d2-7795-4fdb-81de-faf6c6a744c3",
            "nativeOperationId": "182045d2-7795-4fdb-81de-faf6c6a744c3",
            "operationTag": "ezh-setPower-" + "c" * 32 + "-" + "d" * 32,
            "payloadHash": "e" * 64, "presetDigest": "f" * 64,
            "effectiveSettingsDigest": "1" * 64, "imageFingerprint": "2" * 64,
            "helperVersion": "0.1.0", "serverCertificateSha256": "3" * 64}
        self.target = {key: self.request[key] for key in
            ("scope", "fixtureOperationId", "bindingId", "operationId", "generation", "connectionRevision")}
        self.config = root / "sealed.json"
        self.write_config()
        self.supervisor.assert_exclusive_app_uid = lambda: None
        def stop():
            self.events.append("stop")
            self.supervisor.child = None
            return {"pid": 123, "startTicks": "456"}
        self.supervisor.stop_child = stop
        self.supervisor.start_child = lambda: self.events.append("start")
        clear_hold = self.supervisor.clear_recovery_hold
        def clear():
            self.events.append("clear")
            clear_hold()
        self.supervisor.clear_recovery_hold = clear
        self.supervisor.verify_recovery_fence = lambda _r, _p: self.events.append("fence")
        self.supervisor.sign_payload = mock.Mock(side_effect=lambda p: {"payload": p, "signature": "signed"})
        self.observation = {"instanceState": "stopped", "nativeOperationAbsent": True,
            "activeOperations": [], "providerGeneration": 2, "pins": self.pins}
        self.durable = {"verified": True, "pins": self.pins}

    def write_config(self, **changes):
        self.config.write_text(json.dumps({"version": 1, "action": "recover-fenced-cleanup",
            "target": self.target, "pins": self.pins, "observation": {"oldCertificateSha256": "5" * 64}, **changes}))
        self.config.chmod(0o600)

    def execute(self, observations=None, durable=None, restore="valid"):
        observations = iter(observations or [self.observation, self.observation])
        durable = durable or self.durable
        def stage(phase, value, _deadline):
            self.events.append(phase)
            if phase == "durable":
                self.assertEqual(value["target"]["pins"], self.pins)
                return durable
            if phase == "backend":
                return next(observations)
            if phase == "restore":
                self.assertEqual(value, {"cleanupOperationId": "cleanup",
                    "target": {**self.target, "action": "recover-fenced-cleanup", "pins": self.pins},
                    "clientCertificateSha256": "5" * 64})
                self.assertTrue(self.supervisor.recovery_held())
                self.assertIsNone(self.supervisor.child)
                if isinstance(restore, Exception):
                    raise restore
                return {"transportReady": True, **value} if restore == "valid" else restore
            self.assertEqual(phase, "apply")
            return {"cleanupOperationId": "cleanup"}
        self.supervisor.recovery_stage = stage
        clock = [1000.0]
        with mock.patch.dict(os.environ, {"EZCORP_INCUS_FENCED_CLEANUP_CONFIG": str(self.config)}), \
                mock.patch.object(MODULE.time, "time", lambda: clock[0]), \
                mock.patch.object(MODULE.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
                mock.patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=b"public key")):
            return self.supervisor.recover_noeffect(self.request)

    def test_exact_sealed_pins_and_stopped_observations_sign_one_cleanup(self):
        result = self.execute()
        payload = result["receipt"]["payload"]
        self.assertEqual(payload["action"], "recover-fenced-cleanup")
        self.assertEqual(payload["scope"], self.request["scope"])
        self.assertEqual({key: payload[key] for key in self.pins}, self.pins)
        self.assertEqual(payload["first"]["observedAtMs"], 1_065_000)
        self.assertEqual(payload["second"]["observedAtMs"], 1_070_000)
        self.assertEqual(payload["oldProcess"], {"pid": 123, "startTicks": "456"})
        self.assertEqual(result["cleanupOperationId"], "cleanup")
        self.assertEqual(self.events, ["stop", "fence", "durable", "backend", "durable", "backend", "fence", "apply", "restore", "clear", "start"])
        self.supervisor.sign_payload.assert_called_once()

    def test_restore_failure_keeps_hold_and_never_starts_child(self):
        with self.assertRaisesRegex(ValueError, "restore refused"):
            self.execute(restore=ValueError("restore refused"))
        self.assertEqual(self.events[-2:], ["apply", "restore"])
        self.assertTrue(self.supervisor.recovery_held())
        self.assertIsNone(self.supervisor.child)
        self.assertNotIn("clear", self.events)
        self.assertNotIn("start", self.events)

    def test_restore_timeout_keeps_admitted_cleanup_held_without_startup(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.execute(restore=subprocess.TimeoutExpired(["root-restore"], 5))
        self.assertEqual(self.events[-2:], ["apply", "restore"])
        self.assertTrue(self.supervisor.recovery_held())
        self.assertIsNone(self.supervisor.child)
        self.assertNotIn("clear", self.events)
        self.assertNotIn("start", self.events)

    def test_missing_malformed_or_changed_restore_reply_keeps_hold(self):
        valid = {"transportReady": True, "cleanupOperationId": "cleanup",
            "target": {**self.target, "action": "recover-fenced-cleanup", "pins": self.pins},
            "clientCertificateSha256": "5" * 64}
        for reply in (None, {}, {**valid, "transportReady": False},
                {**valid, "cleanupOperationId": "other"},
                {**valid, "target": {**valid["target"], "pins": {**self.pins, "imageFingerprint": "4" * 64}}},
                {**valid, "clientCertificateSha256": "6" * 64}, {**valid, "extra": True}):
            with self.subTest(reply=reply):
                with self.assertRaises(ValueError):
                    self.execute(restore=reply)
                self.assertTrue(self.supervisor.recovery_held())
                self.assertIsNone(self.supervisor.child)
                self.assertNotIn("clear", self.events)
                self.assertNotIn("start", self.events)
                self.supervisor.clear_recovery_hold()
                self.supervisor.used_recoveries.clear()
                self.supervisor.child = object()
                self.events.clear()


    def test_restore_is_root_phase_while_durable_and_apply_drop_privileges(self):
        with mock.patch.object(MODULE.time, "time", return_value=1000.0), \
                mock.patch.object(MODULE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=b"{}")) as run:
            for phase in ("durable", "apply", "restore"):
                self.supervisor.recovery_stage(phase, {"fixed": True}, self.request["deadlineMs"])
                call = run.call_args
                self.assertEqual(json.loads(call.kwargs["input"]), {"phase": phase, "fixed": True})
                self.assertEqual(call.args[0], self.supervisor.recovery_command)
                self.assertEqual(call.kwargs["preexec_fn"],
                    None if phase == "restore" else self.supervisor.drop_app_privileges)

    def test_missing_or_invalid_sealed_client_certificate_denies_before_stop(self):
        for observation in (None, {}, {"oldCertificateSha256": "short"}, {"oldCertificateSha256": "A" * 64}):
            with self.subTest(observation=observation):
                self.write_config(observation=observation)
                with self.assertRaises(ValueError):
                    self.execute()
                self.assertEqual(self.events, [])
                self.supervisor.sign_payload.assert_not_called()

    def test_changed_sealed_target_refuses_before_stopping(self):
        self.write_config(target={**self.target, "bindingId": "other"})
        with self.assertRaisesRegex(ValueError, "sealed cleanup target changed"):
            self.execute()
        self.assertEqual(self.events, [])
        self.supervisor.sign_payload.assert_not_called()

    def test_caller_extra_scope_field_refuses_before_stopping(self):
        self.request["scope"] = {**self.request["scope"], "forged": "scope"}
        with self.assertRaisesRegex(ValueError, "invalid operator recovery"):
            self.execute()
        self.assertEqual(self.events, [])
        self.supervisor.sign_payload.assert_not_called()

    def test_sealed_action_cannot_cross_into_create_recovery(self):
        self.write_config(action="recover-noeffect")
        with self.assertRaisesRegex(ValueError, "sealed cleanup config action invalid"):
            self.execute()
        self.assertEqual(self.events, [])
        self.supervisor.sign_payload.assert_not_called()

    def test_signer_refuses_extra_public_pin_fields(self):
        self.pins["arbitraryAuthority"] = True
        self.write_config()
        with self.assertRaisesRegex(ValueError, "operator durable recovery pins invalid"):
            self.execute()
        self.supervisor.sign_payload.assert_not_called()
        self.assertNotIn("apply", self.events)

    def test_unverified_backend_evidence_never_signs_or_applies(self):
        for changes in ({"instanceState": "running"}, {"nativeOperationAbsent": False},
                {"activeOperations": ["pending"]}, {"providerGeneration": True},
                {"pins": {**self.pins, "imageFingerprint": "4" * 64}}):
            with self.subTest(changes=changes):
                bad = {**self.observation, **changes}
                with self.assertRaisesRegex(ValueError, "owned stopped state"):
                    self.execute([self.observation, bad])
                self.assertNotIn("apply", self.events)
                self.supervisor.sign_payload.assert_not_called()
                self.supervisor.clear_recovery_hold()
                self.supervisor.used_recoveries.clear()
                self.supervisor.child = object()
                self.events.clear()

    def test_durable_and_observer_cannot_replace_sealed_pins(self):
        changed = {**self.pins, "imageFingerprint": "4" * 64}
        with self.assertRaisesRegex(ValueError, "operator durable recovery verification failed"):
            self.execute([{**self.observation, "pins": changed}] * 2,
                {"verified": True, "pins": changed})
        self.supervisor.sign_payload.assert_not_called()
        self.assertNotIn("apply", self.events)


class StableStartCleanupSignerTest(FencedCleanupSignerTest):
    def setUp(self):
        super().setUp()
        self.pins.pop("nativeOperationId")
        connection, binding, operation = self.request["scope"]["connectionId"], self.request["bindingId"], self.request["operationId"]
        resource = hashlib.sha256((connection+"\0"+binding).encode()).hexdigest()[:32]
        intent = hashlib.sha256((connection+"\0"+binding+"\0"+operation+"\0"+operation+"\0setPower").encode()).hexdigest()[:32]
        tag = "ezh-setPower-"+resource+"-"+intent
        self.pins.update(operationHandleKind="stable-start-intent", expectedProviderGeneration=2,
                         providerOperationId=tag, operationTag=tag)
        self.observation = {"instanceState": "stopped", "noActiveOperations": True,
                            "providerGeneration": 2, "pins": self.pins}
        self.durable = {"verified": True, "pins": self.pins}
        self.write_config()

    def write_config(self, **changes):
        FencedCleanupSignerTest.write_config(self, **{"version": 2 if "operationHandleKind" in self.pins else 1, **changes})

    def test_exact_v2_shape_never_claims_native_absence(self):
        result = self.execute()
        payload = result["receipt"]["payload"]
        self.assertEqual(payload["version"], 2)
        self.assertNotIn("nativeOperationId", payload)
        self.assertNotIn("nativeOperationAbsent", payload["first"])
        self.assertNotIn("activeOperations", payload["first"])
        self.assertTrue(payload["first"]["noActiveOperations"])
        self.assertEqual(payload["expectedProviderGeneration"], 2)

    def test_invalid_stable_pin_modes_reject_before_stop(self):
        for changes in ({"nativeOperationId": "182045d2-7795-4fdb-81de-faf6c6a744c3"},
                        {"operationHandleKind": "stable-stop-intent"}, {"providerOperationId": "foreign"},
                        {"operationTag": "foreign"}, {"expectedProviderGeneration": True},
                        {"expectedProviderGeneration": 1}, {"expectedProviderGeneration": 9007199254740992}):
            with self.subTest(changes=changes):
                self.write_config(pins={**self.pins, **changes})
                with self.assertRaises(ValueError):
                    self.execute()
                self.assertEqual(self.events, [])
                self.supervisor.sign_payload.assert_not_called()

    def test_v1_config_cannot_carry_v2_pins(self):
        self.write_config(version=1)
        with self.assertRaisesRegex(ValueError, "pin version changed"):
            self.execute()
        self.assertEqual(self.events, [])

    def test_v2_observer_generation_and_activity_are_exact(self):
        for changes in ({"providerGeneration": 3}, {"noActiveOperations": False}, {"nativeOperationAbsent": True}):
            with self.subTest(changes=changes):
                with self.assertRaisesRegex(ValueError, "owned stopped state"):
                    self.execute([self.observation, {**self.observation, **changes}])
                self.supervisor.sign_payload.assert_not_called()
                self.assertNotIn("apply", self.events)
                self.supervisor.clear_recovery_hold()
                self.supervisor.used_recoveries.clear()
                self.supervisor.child = object()
                self.events.clear()

    def test_changed_sealed_target_refuses_before_stopping(self):
        self.write_config(target={**self.target, "bindingId": "other"})
        with self.assertRaisesRegex(ValueError, "original intent changed"):
            self.execute()
        self.assertEqual(self.events, [])
        self.supervisor.sign_payload.assert_not_called()

    def test_signer_refuses_extra_public_pin_fields(self):
        self.write_config(pins={**self.pins, "arbitraryAuthority": True})
        with self.assertRaisesRegex(ValueError, "stable cleanup pins invalid"):
            self.execute()
        self.assertEqual(self.events, [])
        self.supervisor.sign_payload.assert_not_called()


ABORT_CLI = r"""
import hashlib,json,os,subprocess,sys,tempfile,uuid
from pathlib import Path
root=Path(sys.argv[1]); value=json.load(sys.stdin); receipt=value['receipt']
assert value['phase'] in ('abort','inspect-abort')
assert value['publicKeyPem']==(root/'public.pem').read_text()
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
with tempfile.TemporaryDirectory(dir=root) as directory:
    data=Path(directory)/'data'; signature=Path(directory)/'signature'
    import base64
    data.write_bytes(canonical(receipt['payload']));signature.write_bytes(base64.b64decode(receipt['signature']))
    verified=subprocess.run(['openssl','pkeyutl','-verify','-pubin','-inkey',str(root/'public.pem'),'-rawin','-in',str(data),'-sigfile',str(signature)],capture_output=True)
    assert verified.returncode==0
proof_path=root/'committed.json'
if value['phase']=='abort':
    assert not proof_path.exists()
    payload=receipt['payload']
    proof={'abortId':'12345678-1234-4123-8123-123456789abc','nonce':payload['originalRequest']['nonce'],
        'requestSha256':payload['requestSha256'],'holdSha256':payload['holdSha256'],
        'receiptSha256':hashlib.sha256(canonical(receipt)).hexdigest()}
    fd=os.open(proof_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as out:out.write(canonical(proof));out.flush();os.fsync(out.fileno())
else:
    if proof_path.exists():
        proof=json.loads(proof_path.read_text())
        assert proof['receiptSha256']==hashlib.sha256(canonical(receipt)).hexdigest()
    else:
        payload=receipt['payload']
        proof={'status':'uncommitted','nonce':payload['originalRequest']['nonce'],'requestSha256':payload['requestSha256'],'holdSha256':payload['holdSha256'],'receiptSha256':hashlib.sha256(canonical(receipt)).hexdigest()}
with (root/'phases').open('a') as out:out.write(value['phase']+'\n')
print(json.dumps(proof))
"""


class FencedCleanupAbortTests(unittest.TestCase):
    write_config = FencedCleanupSignerTest.write_config

    def setUp(self):
        FencedCleanupSignerTest.setUp(self)
        self.supervisor.child = None
        self.supervisor.abort_offline = True
        units = ['supervisor.service', 'runner.service', 'user@65003.service']
        stopped = ('\n\n'.join('Id='+unit+'\nActiveState=inactive\nSubState=dead\nMainPID=0' for unit in units)+'\n').encode()
        def guard():
            # Controlled host unit/process observations, not a replacement for
            # the stopped-actor validator. Real signer/CLI calls stay unmocked.
            with mock.patch.object(MODULE.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=stopped, stderr=b'')), mock.patch.object(MODULE.Path, 'iterdir', return_value=iter([])):
                self.supervisor.assert_abort_actors_stopped(units, 65003)
        self.supervisor.abort_stopped_guard = guard
        self.root = self.config.parent
        self.request['deadlineMs'] = 1
        self.saved = self.root/'original.json'
        self.saved.write_text(json.dumps(self.request, indent=2)+'\n')
        self.saved.chmod(0o600)
        self.supervisor.recovery_request_path = self.saved
        key = self.supervisor.key_path
        subprocess.run(['openssl','genpkey','-algorithm','Ed25519','-out',str(key)],check=True,capture_output=True)
        key.chmod(0o600)
        public=subprocess.run(['openssl','pkey','-in',str(key),'-pubout'],check=True,capture_output=True).stdout
        (self.root/'public.pem').write_bytes(public)
        self.supervisor.sign_payload = MODULE.Supervisor.sign_payload.__get__(self.supervisor)
        self.supervisor.recovery_abort_command = [sys.executable,'-c',ABORT_CLI,str(self.root)]
        self.supervisor.set_recovery_hold(self.request)
        self.message={'version':1,'action':'abort-fenced-cleanup-before-admission','originalRequest':self.request,
            'requestFileSha256':hashlib.sha256(self.saved.read_bytes()).hexdigest(),
            'requestSha256':hashlib.sha256(MODULE.canonical(self.request)).hexdigest(),
            'holdSha256':hashlib.sha256(self.supervisor.recovery_hold_path.read_bytes()).hexdigest()}
        self.environment=mock.patch.dict(os.environ,{'EZCORP_INCUS_FENCED_CLEANUP_CONFIG':str(self.config)})
        self.environment.start();self.addCleanup(self.environment.stop)

    def test_real_signer_cli_and_archive_never_start_app(self):
        proof=self.supervisor.abort_recovery(self.message)
        self.assertEqual(proof['nonce'],self.request['nonce'])
        self.assertEqual((self.root/'phases').read_text().splitlines(),['abort','inspect-abort'])
        self.assertFalse(self.supervisor.recovery_hold_path.exists())
        self.assertEqual(self.events,[])
        self.assertIn(self.request['nonce'],self.supervisor.used_recoveries)
        archives=list(self.root.glob('*.aborted.*'))
        self.assertEqual(len(archives),1)
        self.assertEqual(archives[0].stat().st_mode&0o777,0o600)
        self.assertEqual(json.loads(archives[0].read_text()),{'nonce':'nonce','reviewId':'review'})
        original=self.saved.read_bytes()
        self.assertEqual(self.supervisor.abort_recovery(self.message),proof)
        self.assertEqual(self.saved.read_bytes(),original)
        self.assertEqual((self.root/'phases').read_text().splitlines(),['abort','inspect-abort','inspect-abort'])

    def test_commit_before_archive_crash_reuses_signed_receipt_after_expiry(self):
        persist=self.supervisor.persist_abort_file
        def crash(path,value):
            if '.abort-proof.' in str(path):raise OSError('injected archival failure')
            persist(path,value)
        with mock.patch.object(self.supervisor,'persist_abort_file',side_effect=crash):
            with self.assertRaisesRegex(OSError,'injected archival failure'):
                self.supervisor.abort_recovery(self.message)
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        receipt=list(self.root.glob('*.abort-receipt.*'))[0].read_bytes()
        stored=json.loads(receipt)['receipt']
        with mock.patch.object(MODULE.time,'time',return_value=(stored['payload']['expiresAtMs']+100000)/1000), mock.patch.object(self.supervisor,'sign_payload',side_effect=AssertionError('must not sign again')):
            self.supervisor.abort_recovery(self.message)
        self.assertEqual(list(self.root.glob('*.abort-receipt.*'))[0].read_bytes(),receipt)
        self.assertFalse(self.supervisor.recovery_hold_path.exists())
        self.assertEqual((self.root/'phases').read_text().splitlines(),['abort','inspect-abort','inspect-abort'])

    def test_receipt_persisted_before_commit_crash_retries_identical_fresh_abort(self):
        original_stage=self.supervisor.recovery_stage
        with mock.patch.object(self.supervisor,'recovery_stage',side_effect=OSError('before DB invocation')):
            with self.assertRaisesRegex(OSError,'before DB invocation'):
                self.supervisor.abort_recovery(self.message)
        receipt=list(self.root.glob('*.abort-receipt.*'))[0].read_bytes()
        with mock.patch.object(self.supervisor,'sign_payload',side_effect=AssertionError('must not sign again')):
            proof=self.supervisor.abort_recovery(self.message)
        self.assertEqual(proof['nonce'],'nonce')
        self.assertEqual(list(self.root.glob('*.abort-receipt.*'))[0].read_bytes(),receipt)
        self.assertFalse(self.supervisor.recovery_hold_path.exists())
        self.assertEqual((self.root/'phases').read_text().splitlines(),['inspect-abort','abort','inspect-abort'])

    def test_expired_uncommitted_receipt_never_retries_write(self):
        with mock.patch.object(self.supervisor,'recovery_stage',side_effect=OSError('before DB invocation')):
            with self.assertRaises(OSError):self.supervisor.abort_recovery(self.message)
        receipt=json.loads(list(self.root.glob('*.abort-receipt.*'))[0].read_text())['receipt']
        with mock.patch.object(MODULE.time,'time',return_value=(receipt['payload']['expiresAtMs']+1)/1000), mock.patch.object(self.supervisor,'recovery_stage',side_effect=ValueError('uncommitted')) as stage:
            with self.assertRaisesRegex(ValueError,'uncommitted'):self.supervisor.abort_recovery(self.message)
        self.assertEqual([call.args[0] for call in stage.call_args_list],['inspect-abort'])
        self.assertTrue(self.supervisor.recovery_hold_path.exists())

    def test_expired_uncommitted_requires_explicit_authorization_and_archives_old_signature(self):
        with mock.patch.object(self.supervisor,'recovery_stage',side_effect=OSError('before DB invocation')):
            with self.assertRaises(OSError):self.supervisor.abort_recovery(self.message)
        receipt_path=list(self.root.glob('*.abort-receipt.*'))[0]
        old=receipt_path.read_bytes(); old_receipt=json.loads(old)['receipt']
        with mock.patch.object(MODULE.time,'time',return_value=(old_receipt['payload']['expiresAtMs']+1)/1000):
            with self.assertRaisesRegex(ValueError,'explicit reauthorization'):
                self.supervisor.abort_recovery(self.message)
            proof=self.supervisor.abort_recovery({**self.message,'reauthorizeAbort':True})
        self.assertEqual(proof['nonce'],'nonce')
        self.assertEqual(receipt_path.read_bytes(),old)
        renewed=list(self.root.glob('*.reauthorized.*'))
        self.assertEqual(len(renewed),1)
        self.assertNotEqual(json.loads(renewed[0].read_text())['receipt']['signature'],old_receipt['signature'])
        with mock.patch.object(self.supervisor,'sign_payload',side_effect=AssertionError('no renewed authority on retry')):
            self.assertEqual(self.supervisor.abort_recovery(self.message),proof)
        self.assertEqual(self.events,[])

    def test_late_old_receipt_winner_requires_exact_committed_old_proof(self):
        with mock.patch.object(self.supervisor,'recovery_stage',side_effect=OSError('before DB invocation')):
            with self.assertRaises(OSError):self.supervisor.abort_recovery(self.message)
        old=json.loads(list(self.root.glob('*.abort-receipt.*'))[0].read_text())['receipt']
        stage=self.supervisor.recovery_stage
        def old_wins(phase,arguments,deadline):
            if phase=='abort' and arguments['receipt']!=old and not (self.root/'committed.json').exists():
                stage('abort',{**arguments,'receipt':old},deadline)
            return stage(phase,arguments,deadline)
        with mock.patch.object(MODULE.time,'time',return_value=(old['payload']['expiresAtMs']+1)/1000),mock.patch.object(self.supervisor,'recovery_stage',side_effect=old_wins):
            proof=self.supervisor.abort_recovery({**self.message,'reauthorizeAbort':True})
        self.assertEqual(proof['receiptSha256'],hashlib.sha256(MODULE.canonical(old)).hexdigest())
        self.assertFalse(self.supervisor.recovery_hold_path.exists())
        self.assertEqual(self.supervisor.abort_recovery(self.message),proof)
        self.assertEqual(self.events,[])

    def test_archive_link_before_unlink_crash_is_recoverable(self):
        unlink=Path.unlink
        def crash(path,*args,**kwargs):
            if path==self.supervisor.recovery_hold_path:raise OSError('injected unlink failure')
            return unlink(path,*args,**kwargs)
        with mock.patch.object(Path,'unlink',new=crash):
            with self.assertRaisesRegex(OSError,'injected unlink failure'):
                self.supervisor.abort_recovery(self.message)
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        self.supervisor.abort_recovery(self.message)
        self.assertFalse(self.supervisor.recovery_hold_path.exists())
        self.assertEqual(self.events,[])

    def test_changed_request_hash_hold_target_and_peer_state_refuse_before_cli(self):
        for field in ('requestFileSha256','requestSha256','holdSha256'):
            with self.subTest(field=field),mock.patch.object(self.supervisor,'recovery_stage') as stage:
                with self.assertRaises(ValueError):self.supervisor.abort_recovery({**self.message,field:'0'*64})
                stage.assert_not_called()
        changed=json.loads(json.dumps(self.message));changed['originalRequest']['bindingId']='other'
        with self.assertRaises(ValueError):self.supervisor.abort_recovery(changed)
        self.write_config(target={**self.target,'bindingId':'other'})
        with self.assertRaisesRegex(ValueError,'sealed target changed'):self.supervisor.abort_recovery(self.message)
        self.write_config()
        self.supervisor.child=object()
        with mock.patch.object(self.supervisor,'child_exited',return_value=False):
            with self.assertRaisesRegex(ValueError,'stopped app'):self.supervisor.abort_recovery(self.message)
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        self.assertFalse((self.root/'committed.json').exists())

    def test_actual_operator_socket_rejects_abort_and_retains_hold(self):
        runner_code = r"""
import importlib.util,json,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('supervisor',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[2]);commands=json.loads((root/'commands.json').read_text())
s=m.Supervisor(str(root/'control.sock'),[sys.executable,'-c',"raise AssertionError('must not start app')"],os.getuid(),os.getgid(),root/'key.pem',['true'],['true'],enforce_distinct_uid=False)
s.operator_socket_path=root/'operator.sock';s.recovery_command=['true'];s.recovery_abort_command=commands;s.recovery_request_path=root/'original.json';s.serve()
"""
        (self.root/'commands.json').write_text(json.dumps(self.supervisor.recovery_abort_command))
        process=subprocess.Popen([sys.executable,'-c',runner_code,str(SOURCE),str(self.root)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            for _ in range(200):
                if (self.root/'operator.sock').exists():break
                if process.poll() is not None:self.fail('supervisor exited before operator socket')
                time.sleep(0.01)
            self.assertTrue((self.root/'operator.sock').exists())
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(5);connection.connect(str(self.root/'operator.sock'))
                MODULE.send_message(connection,self.message)
                response=MODULE.read_message(connection)
            self.assertEqual(response,{'error':'invalid operator recovery request'})
            self.assertTrue(self.supervisor.recovery_hold_path.exists())
            self.assertFalse((self.root/'committed.json').exists())
            self.assertIsNone(process.poll())
        finally:
            process.terminate()
            try:stdout,stderr=process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill();stdout,stderr=process.communicate()
        self.assertNotIn(b'must not start app',stdout+stderr)

    def test_unsafe_saved_request_and_changed_receipt_refuse(self):
        raw=self.saved.read_bytes()
        self.saved.unlink();other=self.root/'other';other.write_bytes(raw);other.chmod(0o600)
        self.saved.symlink_to(other)
        with self.assertRaises(OSError):self.supervisor.abort_recovery(self.message)
        self.saved.unlink();self.saved.write_bytes(raw);self.saved.chmod(0o644)
        with self.assertRaisesRegex(ValueError,'file changed'):self.supervisor.abort_recovery(self.message)
        self.saved.chmod(0o600)
        self.supervisor.abort_recovery(self.message)
        receipt_path=list(self.root.glob('*.abort-receipt.*'))[0]
        receipt=json.loads(receipt_path.read_text());receipt['receipt']['payload']['originalRequest']['bindingId']='other'
        receipt_path.write_bytes(MODULE.canonical(receipt)+b'\n')
        with self.assertRaisesRegex(ValueError,'receipt changed'):self.supervisor.abort_recovery(self.message)
        self.assertEqual((self.root/'phases').read_text().splitlines(),['abort','inspect-abort'])

    def test_database_rejection_does_not_archive_hold(self):
        self.supervisor.recovery_abort_command=[sys.executable,'-c',"import sys;sys.stderr.write('PRIVATE_DENIAL');sys.exit(1)"]
        with self.assertRaisesRegex(ValueError,'independent operator recovery verifier failed') as error:
            self.supervisor.abort_recovery(self.message)
        self.assertNotIn('PRIVATE_DENIAL',str(error.exception))
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        self.assertEqual(list(self.root.glob('*.aborted.*')),[])
        self.assertEqual(self.events,[])

    def test_offline_actor_guard_requires_all_units_and_real_credentials(self):
        units=['supervisor.service','runner.service','user@65003.service']
        def output(change=None):
            blocks=[]
            for unit in units:
                values={'Id':unit,'ActiveState':'inactive','SubState':'dead','MainPID':'0'}
                if unit=='runner.service' and change:values.update(change)
                blocks.append('\n'.join(key+'='+value for key,value in values.items()))
            return ('\n\n'.join(blocks)+'\n').encode()
        for changed in ({'ActiveState':'active'},{'MainPID':'42'},{'SubState':'running'}):
            with self.subTest(changed=changed),mock.patch.object(MODULE.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout=output(changed),stderr=b'')):
                with self.assertRaisesRegex(ValueError,'requires stopped units'):
                    self.supervisor.assert_abort_actors_stopped(units,65003)
        with mock.patch.object(MODULE.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout=output(),stderr=b'')):
            # The current test process is a real app-UID actor. Directory inode
            # ownership is not used to establish its process credentials.
            with self.assertRaisesRegex(ValueError,'live app or runner actor'):
                self.supervisor.assert_abort_actors_stopped(units,65003)
        with mock.patch.object(MODULE.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout=output(),stderr=b'')),mock.patch.object(MODULE.Path,'iterdir',return_value=iter([])):
            self.supervisor.assert_abort_actors_stopped(units,65003)

    def test_offline_main_routes_same_handler_without_daemon_or_child(self):
        config={'socket':str(self.root/'control.sock'),'appCommand':['true'],'appUid':1234,'appGid':1234,
            'key':str(self.supervisor.key_path),'authorityCommand':['true'],'receiptAuthorityCommand':['true'],
            'operatorSocket':str(self.root/'operator.sock'),'recoveryCommand':['true'],
            'recoveryAbortCommand':['fixed-cli'],'recoveryRequestPath':str(self.saved),
            'recoveryAbortStoppedUnits':['supervisor.service','runner.service','user@65003.service'],
            'recoveryAbortRunnerUid':65003}
        config_path=self.root/'supervisor.json';config_path.write_bytes(MODULE.canonical(config));config_path.chmod(0o600)
        abort_path=self.root/'abort.json';abort_path.write_bytes(MODULE.canonical(self.message));abort_path.chmod(0o600)
        def dispatch(message):
            self.supervisor.abort_stopped_guard()
            return {'abortId':'committed'}
        with mock.patch.object(MODULE.sys,'argv',['supervisor','--config',str(config_path),'--abort-request',str(abort_path)]),mock.patch.object(MODULE.os,'geteuid',return_value=0),mock.patch.object(MODULE,'Supervisor',return_value=self.supervisor),mock.patch.object(self.supervisor,'private_recovery_bytes',side_effect=lambda path,**kwargs:Path(path).read_bytes()),mock.patch.object(self.supervisor,'assert_abort_actors_stopped') as stopped,mock.patch.object(self.supervisor,'abort_recovery',side_effect=dispatch) as handler,mock.patch.object(self.supervisor,'serve') as serve,mock.patch.object(self.supervisor,'start_child') as start,mock.patch('builtins.print'):
            MODULE.main()
        stopped.assert_called_once_with(config['recoveryAbortStoppedUnits'],65003)
        self.assertTrue(self.supervisor.abort_offline)
        handler.assert_called_once_with(self.message)
        serve.assert_not_called();start.assert_not_called()

    def test_late_actor_restart_preserves_committed_abort_and_hold(self):
        self.supervisor.abort_stopped_guard=mock.Mock(side_effect=[None,ValueError('runner restarted')])
        with self.assertRaisesRegex(ValueError,'runner restarted'):
            self.supervisor.abort_recovery(self.message)
        self.assertTrue((self.root/'committed.json').exists())
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        self.supervisor.abort_stopped_guard=mock.Mock(return_value=None)
        self.supervisor.abort_recovery(self.message)
        self.assertEqual((self.root/'phases').read_text().splitlines(),['abort','inspect-abort','inspect-abort'])
        self.assertEqual(self.events,[])

    def test_abort_handler_requires_explicit_offline_entry(self):
        self.supervisor.abort_offline = False
        with self.assertRaisesRegex(ValueError, "offline control"):
            self.supervisor.abort_recovery(self.message)
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        self.assertFalse((self.root / "committed.json").exists())

    def test_authorization_archive_modified_parent_and_chain_limit_fail_closed(self):
        with mock.patch.object(self.supervisor,'recovery_stage',side_effect=OSError('before DB invocation')):
            with self.assertRaises(OSError):self.supervisor.abort_recovery(self.message)
        base=list(self.root.glob('*.abort-receipt.*'))[0]
        node=json.loads(base.read_text());current=node['receipt']
        for index in range(8):
            following=base.with_name(base.name+'.reauthorized.'+hashlib.sha256(MODULE.canonical(current)).hexdigest())
            payload={**current['payload'],'issuedAtMs':current['payload']['issuedAtMs']+index+1,'expiresAtMs':current['payload']['expiresAtMs']+index+1}
            current=self.supervisor.sign_payload(payload)
            self.supervisor.persist_abort_file(following,{'requestFileSha256':self.message['requestFileSha256'],'receipt':current})
        with self.assertRaisesRegex(ValueError,'archive limit reached'):
            self.supervisor.abort_recovery(self.message)
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        self.assertFalse((self.root/'committed.json').exists())
        for path in self.root.glob('*.reauthorized.*'):path.unlink()
        changed=json.loads(base.read_text());changed['receipt']['payload']['pins']['payloadHash']='0'*64
        base.write_bytes(MODULE.canonical(changed)+b'\n')
        with self.assertRaisesRegex(ValueError,'receipt changed'):
            self.supervisor.abort_recovery(self.message)

    def test_two_control_actions_are_rejected_before_config_read(self):
        with mock.patch.object(MODULE.sys, "argv", ["supervisor", "--config", "/does-not-exist", "--abort-request", "/abort", "--recover-request", "/recover"]):
            with self.assertRaisesRegex(ValueError, "single action"):
                MODULE.main()

    def test_bad_committed_proof_keeps_hold(self):
        for proof in ({}, {'abortId':'bad','nonce':'nonce','requestSha256':'a'*64,'holdSha256':'b'*64,'receiptSha256':'c'*64}):
            with self.subTest(proof=proof),mock.patch.object(self.supervisor,'recovery_stage',return_value=proof):
                with self.assertRaisesRegex(ValueError,'committed proof invalid'):self.supervisor.abort_recovery(self.message)
            self.assertTrue(self.supervisor.recovery_hold_path.exists())
            self.assertEqual(self.events,[])


class ProcessCredentialTests(unittest.TestCase):
    def test_actual_credentials_and_changed_start_identity(self):
        credentials = MODULE.process_credentials(os.getpid())
        self.assertEqual(credentials[:3], os.getresuid())
        self.assertEqual(credentials[3], os.geteuid())
        with mock.patch.object(MODULE, "identity", side_effect=[{"pid": 1, "startTicks": "1"}, {"pid": 1, "startTicks": "2"}]), mock.patch.object(MODULE.Path, "read_text", return_value="Uid:\t1\t2\t3\t4\n"):
            with self.assertRaisesRegex(ValueError, "credentials unavailable or changed"):
                MODULE.process_credentials(1)

    def test_malformed_uid_fields_fail_closed(self):
        for status in ("Uid: 1 2 3", "Uid: 1 2 3 x", "Uid: 1 2 3 4\nUid: 1 2 3 4"):
            with self.subTest(status=status), mock.patch.object(MODULE, "identity", return_value={"pid": 1, "startTicks": "1"}), mock.patch.object(MODULE.Path, "read_text", return_value=status):
                with self.assertRaises(ValueError): MODULE.process_credentials(1)


class RecoveryDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ezh-diag-")
        self.root = Path(self.tmp.name)
        self.root.chmod(0o700)
        key = self.root / "key"
        key.write_text("disposable key")
        key.chmod(0o600)
        self.supervisor = MODULE.Supervisor(str(self.root / "socket"), ["true"],
            os.getuid(), os.getgid(), key, ["true"], ["true"], enforce_distinct_uid=False)
        self.log = self.root / "key.recovery-stage-diagnostics.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def invoke(self, script):
        self.supervisor.recovery_command = [sys.executable, "-c", script]
        return self.supervisor.recovery_stage("backend", {"privateInput": "NEVER_RECORD_INPUT"},
            int(time.time() * 1000) + 30000)

    def record(self):
        self.assertEqual(self.log.stat().st_uid, os.geteuid())
        self.assertEqual(self.log.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("NEVER_RECORD_INPUT", self.log.read_text())
        return json.loads(self.log.read_text())

    def test_real_verifier_failure_retains_private_output_only(self):
        with self.assertRaisesRegex(ValueError, "independent operator recovery verifier failed") as error:
            self.invoke("import sys,json; assert json.load(sys.stdin)['phase']=='backend'; print('PRIVATE_CANARY'); sys.stderr.write('PRIVATE_CANARY'); sys.exit(7)")
        self.assertNotIn("PRIVATE_CANARY", str(error.exception))
        record = self.record()
        self.assertEqual((record["stage"], record["outcome"], record["exitCode"]), ("backend", "nonzero", 7))
        self.assertIn("PRIVATE_CANARY", record["stdout"])
        self.assertIn("PRIVATE_CANARY", record["stderr"])

    def test_real_invalid_json_and_success(self):
        with self.assertRaisesRegex(ValueError, "independent operator recovery verifier failed"):
            self.invoke("print('PRIVATE_CANARY')")
        self.assertEqual(self.record()["outcome"], "invalid_json")
        self.log.unlink()
        self.assertEqual(self.invoke("print('{\"verified\":true}')"), {"verified": True})
        self.assertEqual(self.record()["outcome"], "returned")

    def test_timeout_partial_output_and_spawn_failure(self):
        self.supervisor.recovery_command = ["not-used"]
        with mock.patch.object(MODULE.subprocess, "run", side_effect=subprocess.TimeoutExpired("private command", 1, output=b"PRIVATE_CANARY", stderr=b"partial")):
            with self.assertRaisesRegex(ValueError, "independent operator recovery verifier failed") as error:
                self.supervisor.recovery_stage("backend", {}, int(time.time()*1000)+30000)
        self.assertNotIn("private command", str(error.exception))
        self.assertEqual(self.record()["outcome"], "timeout")
        self.assertEqual(self.record()["stderr"], "partial")
        self.log.unlink()
        self.supervisor.recovery_command = [str(self.root / "missing")]
        with self.assertRaisesRegex(ValueError, "independent operator recovery verifier failed"):
            self.supervisor.recovery_stage("backend", {}, int(time.time()*1000)+30000)
        self.assertEqual(self.record()["outcome"], "spawn_failed")

    def test_real_preexec_failure_is_private_spawn_failure(self):
        def denied():
            raise ValueError("PRIVATE_CANARY")
        self.supervisor.drop_app_privileges = denied
        self.supervisor.recovery_command = [sys.executable, "-c", "print('{}')"]
        with self.assertRaisesRegex(ValueError, "independent operator recovery verifier failed") as error:
            self.supervisor.recovery_stage("durable", {}, int(time.time()*1000)+30000)
        self.assertNotIn("PRIVATE_CANARY", str(error.exception))
        self.assertEqual(self.record()["outcome"], "spawn_failed")

    def test_failed_private_write_has_static_warning(self):
        with mock.patch.object(MODULE.os, "write", return_value=0), mock.patch.object(MODULE.sys.stderr, "write") as warning:
            self.supervisor.recovery_diagnostic("backend", "nonzero", 1, b"PRIVATE_CANARY", b"")
        warning.assert_called_once_with("Private recovery stage diagnostic unavailable\n")
        self.assertEqual(self.log.read_bytes(), b"")

    def test_invalid_phase_has_no_command_or_file_effect(self):
        with mock.patch.object(MODULE.subprocess, "run") as command:
            with self.assertRaisesRegex(ValueError, "invalid operator recovery stage"):
                self.supervisor.recovery_stage("invented", {}, 1)
        command.assert_not_called()
        self.assertFalse(self.log.exists())

    def test_symlinked_ancestor_cannot_receive_output(self):
        alias = self.root / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        self.supervisor.key_path = alias / "key"
        with mock.patch.object(MODULE.sys.stderr, "write") as warning:
            self.supervisor.recovery_diagnostic("backend", "nonzero", 1, b"PRIVATE_CANARY", b"")
        warning.assert_called_once_with("Private recovery stage diagnostic unavailable\n")
        self.assertFalse(self.log.exists())

    def test_prefix_and_total_file_bounds(self):
        self.supervisor.recovery_diagnostic("backend", "nonzero", 1, b"x"*5000, b"y"*5000)
        record = self.record()
        self.assertEqual(len(record["stdout"]), 4096)
        self.assertTrue(record["stdoutTruncated"])
        self.assertTrue(record["stderrTruncated"])
        self.log.write_bytes(b"z"*65536)
        with mock.patch.object(MODULE.sys.stderr, "write") as warning:
            self.supervisor.recovery_diagnostic("backend", "nonzero", 1, b"PRIVATE_CANARY", b"")
        self.assertEqual(self.log.read_bytes(), b"z"*65536)
        warning.assert_called_once_with("Private recovery stage diagnostic unavailable\n")

    def test_unsafe_file_or_parent_cannot_receive_output(self):
        target = self.root / "target"
        target.write_text("unchanged")
        for kind in ("symlink", "mode", "hardlink", "parent"):
            with self.subTest(kind=kind):
                if kind == "symlink": self.log.symlink_to(target)
                elif kind == "hardlink": os.link(target, self.log)
                else:
                    self.log.write_text("unchanged")
                    self.log.chmod(0o644 if kind == "mode" else 0o600)
                    if kind == "parent": self.root.chmod(0o777)
                with mock.patch.object(MODULE.sys.stderr, "write") as warning:
                    self.supervisor.recovery_diagnostic("backend", "nonzero", 1, b"PRIVATE_CANARY", b"")
                warning.assert_called_once_with("Private recovery stage diagnostic unavailable\n")
                self.assertEqual(target.read_text(), "unchanged")
                if not self.log.is_symlink(): self.assertEqual(self.log.read_text(), "unchanged")
                self.root.chmod(0o700)
                self.log.unlink()


class AdmittedRestorationTests(unittest.TestCase):
    write_config = FencedCleanupSignerTest.write_config
    def setUp(self):
        FencedCleanupAbortTests.setUp(self)
        self.supervisor.restore_offline = True
        self.supervisor.recovery_restore_command = ['fixed-restoration-consumer']
        self.journal = self.root/'held-journal.json'
        target={k:self.request[k] for k in ('scope','fixtureOperationId','bindingId','operationId','generation','connectionRevision')}
        target.update(action='recover-fenced-cleanup',pins=self.pins)
        self.restore_config=self.root/'restore-config.json'
        config={'target':target,'clientCertificateSha256':'a'*64,'holdSha256':self.message['holdSha256']}
        self.restore_config.write_bytes(MODULE.canonical(config));self.restore_config.chmod(0o600)
        request={'cleanupOperationId':'81570000-1234-4123-8123-123456789abc','target':target,'clientCertificateSha256':'a'*64}
        self.journal.write_bytes(MODULE.canonical({'configSha256':hashlib.sha256(self.restore_config.read_bytes()).hexdigest(),'request':request}));self.journal.chmod(0o600)
        self.supervisor.recovery_restore_journal_path=self.journal
        self.supervisor.recovery_restore_config_path=self.restore_config
        self.message={**self.message,'action':'restore-already-admitted-cleanup','cleanupOperationId':request['cleanupOperationId'],'journalSha256':hashlib.sha256(self.journal.read_bytes()).hexdigest(),'configSha256':hashlib.sha256(self.restore_config.read_bytes()).hexdigest(),'originalReceiptSha256':'b'*64,'currentSourceCommit':'c'*40,'currentManifestSha256':'d'*64}
        self.calls=[]
        def command(phase,value,deadline):
            self.calls.append(phase)
            if phase=='inspect-admitted-restoration':return {'admitted':True,**request,**{k:self.message[k] for k in ('originalReceiptSha256','currentSourceCommit','currentManifestSha256')}}
            return {'transportReady':True,**request}
        self.supervisor.restoration_stage=mock.Mock(side_effect=command)
    def test_expired_original_gets_distinct_authority_without_admission(self):
        with mock.patch.object(self.supervisor,'start_child') as start:
            result=self.supervisor.restore_admitted(self.message)
        self.assertEqual(result['cleanupOperationId'],self.message['cleanupOperationId'])
        self.assertEqual(self.calls,['inspect-admitted-restoration','restore-admitted'])
        self.assertFalse(self.supervisor.recovery_hold_path.exists());start.assert_not_called()
        self.assertEqual(self.request['deadlineMs'],1)
        with self.assertRaises((ValueError, OSError)):self.supervisor.restore_admitted(self.message)
    def test_exclusive_statement_refuses_identical_concurrent_publication(self):
        path=self.root/'statement.json'
        self.supervisor.persist_abort_file(path,{'same':True},exclusive=True)
        with self.assertRaisesRegex(ValueError,'already exists'):
            self.supervisor.persist_abort_file(path,{'same':True},exclusive=True)
        self.assertEqual(json.loads(path.read_bytes()),{'same':True})
    def test_offline_cli_restore_only_configuration_never_serves(self):
        config={'socket':str(self.root/'socket'),'appCommand':['fixed-app'],'appUid':65002,'appGid':65002,'key':str(self.supervisor.key_path),'authorityCommand':['fixed-authority'],'receiptAuthorityCommand':['fixed-receipt'],'recoveryRestoreCommand':['fixed-restore'],'recoveryRequestPath':str(self.saved),'recoveryRestoreJournalPath':str(self.journal),'recoveryRestoreConfigPath':str(self.restore_config),'recoveryAbortStoppedUnits':['supervisor.service','runner.service','user@65003.service'],'recoveryAbortRunnerUid':65003}
        path=self.root/'offline-config.json';path.write_bytes(MODULE.canonical(config));path.chmod(0o600)
        req=self.root/'fresh-restore.json';req.write_bytes(MODULE.canonical(self.message));req.chmod(0o600)
        with mock.patch.object(MODULE.sys,'argv',['supervisor','--config',str(path),'--restore-admitted-request',str(req)]),mock.patch.object(MODULE.os,'geteuid',return_value=0),mock.patch.object(MODULE,'Supervisor',return_value=self.supervisor),mock.patch.object(self.supervisor,'private_recovery_bytes',side_effect=lambda p,**kw:Path(p).read_bytes()),mock.patch.object(self.supervisor,'restore_admitted',return_value={'transportReady':True}) as handler,mock.patch.object(self.supervisor,'serve') as serve,mock.patch.object(self.supervisor,'start_child') as start,mock.patch('builtins.print'):
            MODULE.main()
        handler.assert_called_once_with(self.message);serve.assert_not_called();start.assert_not_called()
        self.assertTrue(self.supervisor.restore_offline)
        self.assertEqual(self.supervisor.recovery_request_path,str(self.saved))
        self.assertEqual(self.supervisor.recovery_restore_command,['fixed-restore'])
    def test_closed_history_and_source_pin_negatives(self):
        from copy import deepcopy
        for key,value in (("currentSourceCommit",123),("currentManifestSha256","wrong"),("originalReceiptSha256","wrong"),("journalSha256","0"*64),("configSha256","0"*64),("holdSha256","0"*64),("requestSha256","0"*64)):
            with self.subTest(key=key),mock.patch.object(self.supervisor,'sign_payload') as sign:
                bad=deepcopy(self.message);bad[key]=value
                with self.assertRaises(ValueError):self.supervisor.restore_admitted(bad)
                sign.assert_not_called()
        for bad in ({**self.message,'extra':True},{**self.message,'action':'recover-fenced-cleanup'}):
            with self.assertRaises(ValueError):self.supervisor.restore_admitted(bad)
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
    def test_offline_and_stopped_guard_are_required(self):
        self.supervisor.restore_offline=False
        with self.assertRaisesRegex(ValueError,'offline'):self.supervisor.restore_admitted(self.message)
        self.supervisor.restore_offline=True
        self.supervisor.abort_stopped_guard=mock.Mock(side_effect=ValueError('active actor'))
        with self.assertRaisesRegex(ValueError,'active actor'):self.supervisor.restore_admitted(self.message)
        self.supervisor.restoration_stage.assert_not_called()
    def test_expiry_after_transport_keeps_hold_and_records_attempt(self):
        real=self.supervisor.restoration_stage.side_effect
        def stage(phase,value,deadline):
            result=real(phase,value,deadline)
            if phase=='restore-admitted':self.clock.return_value=100000000000
            return result
        with mock.patch.object(MODULE.time,'time',return_value=1000) as self.clock:
            self.supervisor.restoration_stage.side_effect=stage
            with self.assertRaises(ValueError):self.supervisor.restore_admitted(self.message)
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        self.assertTrue(self.supervisor.recovery_hold_path.with_name(self.supervisor.recovery_hold_path.name+'.restoration-receipt').exists())
    def test_wrong_link_or_hold_refuses_before_signature(self):
        with mock.patch.object(self.supervisor,'sign_payload') as sign:
            self.message['cleanupOperationId']='wrong'
            with self.assertRaises(ValueError):self.supervisor.restore_admitted(self.message)
            sign.assert_not_called();self.assertTrue(self.supervisor.recovery_hold_path.exists())
    def test_failed_transport_retains_hold_and_no_implicit_retry(self):
        self.supervisor.restoration_stage.side_effect=[{'admitted':True,**json.loads(self.journal.read_bytes())['request'],**{k:self.message[k] for k in ('originalReceiptSha256','currentSourceCommit','currentManifestSha256')}},ValueError('private canary')]
        with self.assertRaises(ValueError):self.supervisor.restore_admitted(self.message)
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        with self.assertRaises(ValueError):self.supervisor.restore_admitted(self.message)


RESTORATION_BOUNDARY_CONSUMER = r'''
"""Disposable command-boundary verifier; no DB, server or service effects."""
import base64
import json
import subprocess
import sys
import time
from pathlib import Path

root = Path(sys.argv[1])
expected = json.loads((root / 'expected.json').read_bytes())
value = json.loads(sys.stdin.buffer.read())
phase = value['phase']
mode = (root / 'consumer-mode').read_text() if (root / 'consumer-mode').exists() else ''
with (root / 'command-phases').open('a') as output:
    output.write(phase + '\n')
authority = {key: expected['history'][key] for key in (
    'originalReceiptSha256', 'currentSourceCommit', 'currentManifestSha256')}
if phase == 'inspect-admitted-restoration':
    assert value == {'phase': phase, **expected}
    if mode == 'malformed':
        print('not JSON')
        sys.exit(0)
    if mode == 'nonzero':
        sys.exit(7)
    if mode == 'wrong-authority':
        authority['currentSourceCommit'] = '0' * 40
    print(json.dumps({'admitted': True, **expected['request'], **authority}))
elif phase == 'restore-admitted':
    assert set(value) == {'phase', 'receipt'}
    receipt = value['receipt']
    payload = receipt['payload']
    assert set(payload) == {*expected['history'], 'restoration', 'issuedAtMs', 'expiresAtMs'}
    assert {key: payload[key] for key in expected['history']} == expected['history']
    assert payload['restoration'] == expected['request']
    now = int(time.time() * 1000)
    assert payload['issuedAtMs'] <= now < payload['expiresAtMs']
    assert 0 < payload['expiresAtMs'] - payload['issuedAtMs'] <= 30000
    data = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    (root / 'verify-data').write_bytes(data)
    (root / 'verify-signature').write_bytes(base64.b64decode(receipt['signature'], validate=True))
    subprocess.run(['openssl', 'pkeyutl', '-verify', '-rawin', '-pubin', '-inkey',
                    str(root / 'public.pem'), '-in', str(root / 'verify-data'),
                    '-sigfile', str(root / 'verify-signature')], check=True, capture_output=True)
    # A local record of the command effect, not a claim about real transport.
    (root / 'restoration-verified').write_text(payload['restoration']['cleanupOperationId'])
    response = {'transportReady': True, **expected['request']}
    if mode == 'extra-ready':
        response['extra'] = True
    print(json.dumps(response))
else:
    raise AssertionError('No admission or other command phase is permitted')
'''


class RestorationCommandBoundary(unittest.TestCase):
    write_config = FencedCleanupSignerTest.write_config

    def setUp(self):
        AdmittedRestorationTests.setUp(self)
        self.supervisor.restoration_stage = MODULE.Supervisor.restoration_stage.__get__(self.supervisor)
        self.supervisor.recovery_restore_command = [sys.executable, '-c', RESTORATION_BOUNDARY_CONSUMER, str(self.root)]
        self.expected = {'request': json.loads(self.journal.read_bytes())['request'], 'history': self.message}
        (self.root / 'expected.json').write_bytes(MODULE.canonical(self.expected))

    def test_expired_history_real_signature_and_exact_existing_cleanup(self):
        original = self.saved.read_bytes()
        with mock.patch.object(self.supervisor, 'start_child') as start:
            result = self.supervisor.restore_admitted(self.message)
        self.assertTrue(result['holdArchived'])
        self.assertEqual((self.root / 'command-phases').read_text().splitlines(),
                         ['inspect-admitted-restoration', 'restore-admitted'])

        self.assertEqual((self.root / 'restoration-verified').read_text(), self.message['cleanupOperationId'])
        self.assertEqual(self.saved.read_bytes(), original)
        self.assertEqual(self.request['deadlineMs'], 1)
        start.assert_not_called()
        with self.assertRaises((ValueError, OSError)):
            self.supervisor.restore_admitted(self.message)

    def test_bad_hash_refuses_before_command_or_signature(self):
        self.message['journalSha256'] = '0' * 64
        with mock.patch.object(self.supervisor, 'sign_payload') as sign:
            with self.assertRaises(ValueError):
                self.supervisor.restore_admitted(self.message)
        sign.assert_not_called()
        self.assertFalse((self.root / 'command-phases').exists())
        self.assertTrue(self.supervisor.recovery_hold_path.exists())

    def test_target_mismatch_refuses_before_command(self):
        self.message['originalRequest'] = {**self.request, 'bindingId': 'different'}
        with self.assertRaises(ValueError):
            self.supervisor.restore_admitted(self.message)
        self.assertFalse((self.root / 'command-phases').exists())

    def test_valid_signature_with_expired_new_authority_refuses_effect(self):
        signer = self.supervisor.sign_payload
        def stale(payload):
            return signer({**payload, 'issuedAtMs': 1, 'expiresAtMs': 30001})
        with mock.patch.object(self.supervisor, 'sign_payload', side_effect=stale):
            with self.assertRaises(ValueError):
                self.supervisor.restore_admitted(self.message)
        self.assertFalse((self.root / 'restoration-verified').exists())
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        self.assertEqual((self.root / 'command-phases').read_text().splitlines(),
                         ['inspect-admitted-restoration', 'restore-admitted'])

    def test_inspection_protocol_failures_never_sign_or_restore(self):
        for mode in ('malformed', 'nonzero', 'wrong-authority'):
            with self.subTest(mode=mode):
                (self.root / 'consumer-mode').write_text(mode)
                with mock.patch.object(self.supervisor, 'sign_payload') as sign:
                    with self.assertRaises(ValueError):
                        self.supervisor.restore_admitted(self.message)
                sign.assert_not_called()
                self.assertTrue(self.supervisor.recovery_hold_path.exists())
                self.assertFalse((self.root / 'restoration-verified').exists())

    def test_future_signed_authority_refuses_effect(self):
        signer = self.supervisor.sign_payload
        def future(payload):
            return signer({**payload, 'issuedAtMs': 9999999999999, 'expiresAtMs': 10000000029999})
        with mock.patch.object(self.supervisor, 'sign_payload', side_effect=future):
            with self.assertRaises(ValueError):
                self.supervisor.restore_admitted(self.message)
        self.assertFalse((self.root / 'restoration-verified').exists())
        self.assertTrue(self.supervisor.recovery_hold_path.exists())

    def test_bad_signature_refuses_effect(self):
        signer = self.supervisor.sign_payload
        def altered(payload):
            receipt = signer(payload)
            receipt['payload'] = {**payload, 'currentSourceCommit': '0' * 40}
            return receipt
        with mock.patch.object(self.supervisor, 'sign_payload', side_effect=altered):
            with self.assertRaises(ValueError):
                self.supervisor.restore_admitted(self.message)
        self.assertFalse((self.root / 'restoration-verified').exists())
        self.assertTrue(self.supervisor.recovery_hold_path.exists())

    def test_extra_ready_field_keeps_hold_and_forbids_replay(self):
        (self.root / 'consumer-mode').write_text('extra-ready')
        with self.assertRaises(ValueError):
            self.supervisor.restore_admitted(self.message)
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        phases = (self.root / 'command-phases').read_bytes()
        with self.assertRaises(ValueError):
            self.supervisor.restore_admitted(self.message)
        self.assertEqual((self.root / 'command-phases').read_bytes(), phases)

    def test_self_consistent_history_cannot_change_original_target(self):
        config = json.loads(self.restore_config.read_bytes())
        config['target']['bindingId'] = 'changed-binding'
        self.restore_config.write_bytes(MODULE.canonical(config))
        self.message['configSha256'] = hashlib.sha256(self.restore_config.read_bytes()).hexdigest()
        journal = json.loads(self.journal.read_bytes())
        journal['configSha256'] = self.message['configSha256']
        journal['request']['target'] = config['target']
        self.journal.write_bytes(MODULE.canonical(journal))
        self.message['journalSha256'] = hashlib.sha256(self.journal.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'target changed'):
            self.supervisor.restore_admitted(self.message)
        self.assertFalse((self.root / 'command-phases').exists())

    def test_invalid_phase_refuses_before_subprocess(self):
        with self.assertRaisesRegex(ValueError, 'invalid admitted restoration stage'):
            self.supervisor.restoration_stage('apply', {}, int(time.time()*1000)+30000)
        self.assertFalse((self.root / 'command-phases').exists())

    def test_hold_changed_after_inspection_refuses_signature(self):
        guard = self.supervisor.abort_stopped_guard
        count = 0
        def changing_guard():
            nonlocal count
            guard()
            count += 1
            if count == 2:
                self.supervisor.recovery_hold_path.write_bytes(b'changed hold')
        with mock.patch.object(self.supervisor, 'abort_stopped_guard', side_effect=changing_guard), \
                mock.patch.object(self.supervisor, 'sign_payload') as sign:
            with self.assertRaisesRegex(ValueError, 'hold changed before signing'):
                self.supervisor.restore_admitted(self.message)
        sign.assert_not_called()
        self.assertEqual((self.root / 'command-phases').read_text().splitlines(),
                         ['inspect-admitted-restoration'])

    def test_hold_changed_after_real_transport_command_is_not_archived(self):
        stage = self.supervisor.restoration_stage
        def changed_after_command(phase, value, deadline):
            result = stage(phase, value, deadline)
            if phase == 'restore-admitted':
                self.supervisor.recovery_hold_path.write_bytes(b'changed hold')
            return result
        with mock.patch.object(self.supervisor, 'restoration_stage', side_effect=changed_after_command):
            with self.assertRaisesRegex(ValueError, 'hold changed before archive'):
                self.supervisor.restore_admitted(self.message)
        self.assertTrue(self.supervisor.recovery_hold_path.exists())
        self.assertEqual(list(self.root.glob('*.restored.*')), [])
        self.assertTrue((self.root / 'restoration-verified').exists())

    def test_offline_cli_invalid_configuration_and_nonroot_never_dispatch(self):
        config = {'socket': str(self.root/'socket'), 'appCommand': ['fixed-app'],
                  'appUid': 65002, 'appGid': 65002, 'key': str(self.supervisor.key_path),
                  'authorityCommand': ['fixed-authority'], 'receiptAuthorityCommand': ['fixed-receipt'],
                  'recoveryRestoreCommand': ['fixed-restore'], 'recoveryRequestPath': str(self.saved),
                  'recoveryRestoreJournalPath': str(self.journal),
                  'recoveryRestoreConfigPath': str(self.restore_config),
                  'recoveryAbortStoppedUnits': ['supervisor.service', 'runner.service', 'user@65003.service'],
                  'recoveryAbortRunnerUid': 65003}
        path = self.root/'offline-config.json'
        req = self.root/'fresh-restore.json'
        req.write_bytes(MODULE.canonical(self.message))
        req.chmod(0o600)
        for bad_config, uid, expected in (
                ({**config, 'recoveryRestoreConfigPath': ''}, 0, 'invalid admitted restoration configuration'),
                (config, 65002, 'requires root and exact private config')):
            path.write_bytes(MODULE.canonical(bad_config))
            path.chmod(0o600)
            with self.subTest(uid=uid), \
                    mock.patch.object(MODULE.sys, 'argv', ['supervisor', '--config', str(path), '--restore-admitted-request', str(req)]), \
                    mock.patch.object(MODULE.os, 'geteuid', return_value=uid), \
                    mock.patch.object(MODULE, 'Supervisor', return_value=self.supervisor), \
                    mock.patch.object(self.supervisor, 'restore_admitted') as handler, \
                    mock.patch.object(self.supervisor, 'serve') as serve:
                with self.assertRaisesRegex(ValueError, expected):
                    MODULE.main()
                handler.assert_not_called()
                serve.assert_not_called()


if __name__ == "__main__":
    unittest.main()
