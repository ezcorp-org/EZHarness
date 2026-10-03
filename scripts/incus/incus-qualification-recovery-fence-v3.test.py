"""Process tests for the composed local and server recovery fence."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


WRAPPER = Path(__file__).with_name("incus-qualification-recovery-fence-v3.py")


class RecoveryFenceV3Test(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.local_state = self.root / "local_state"
        self.local_state.write_text("valid")
        self.local = self.root / "local.py"
        self.local.write_text("""#!/usr/bin/env python3
import json,sys
if open(%r).read() == 'error': sys.exit(1)
request=json.load(sys.stdin)['request']
print(json.dumps({'fenced':True,'evidence':request['fenceEvidence']}))
""" % str(self.local_state))
        self.local.chmod(0o700)
        self.ssh = self.root / "ssh.py"
        self.state = self.root / "state"
        self.state.write_text("valid")
        self.ssh_called = self.root / "ssh_called"
        self.ssh.write_text("""#!/usr/bin/env python3
import json,os,sys,time
open(%r,'w').write('called')
assert '-F' in sys.argv and '/dev/null' in sys.argv
assert 'StrictHostKeyChecking=yes' in sys.argv
assert 'root' in sys.argv and 'sandbox-server.taile1c5b0.ts.net' in sys.argv
assert 'frozen-until' in sys.argv[-1] and %r in sys.argv[-1]
deadline=int(sys.argv[-1].split()[-1])
state=open(%r).read()
if state == 'error': sys.exit(1)
if state == 'malformed': print('not-json'); sys.exit(0)
print(json.dumps({'frozen':state != 'thawed',
                  'nowMs':int(time.time()*1000)+(20000 if state == 'skew' else 0),
                  'timerDeadlineMs':deadline+120000+(0 if state == 'short' else 10000)}))
""" % (str(self.ssh_called), "612e01761586d4f76fa573f1e9875e1f9e4767e3f28342b88e48ce5f5343942e", str(self.state)))
        self.ssh.chmod(0o700)
        self.identity = self.root / "identity"
        self.known_hosts = self.root / "known_hosts"
        for file in (self.identity, self.known_hosts):
            file.write_text("fixture")
            file.chmod(0o600)
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({
            "localFenceCommand": [sys.executable, str(self.local)],
            "sshExecutable": str(self.ssh),
            "serverHost": "sandbox-server.taile1c5b0.ts.net",
            "serverUser": "root",
            "identityFile": str(self.identity),
            "knownHostsFile": str(self.known_hosts),
            "serverAuditPath": "/root/ezh-admin-fence-44ae3dc/source/scripts/ezh-incus-admin-route-audit.py",
            "serverAuditSha256": "612e01761586d4f76fa573f1e9875e1f9e4767e3f28342b88e48ce5f5343942e",
            "observerConfig": str(self.identity),
        }))
        self.config.chmod(0o600)

    def run_wrapper(self, state="valid"):
        self.state.write_text(state)
        request = {"request": {"action": "recover-noeffect", "allClientsFenced": True,
                               "fenceEvidence": "reviewed local and server fences",
                               "deadlineMs": int(time.time() * 1000) + 160000},
                   "oldProcess": {"pid": 123, "startTicks": "456"}}
        return subprocess.run([sys.executable, str(WRAPPER), "--config", str(self.config)],
                              input=json.dumps(request), text=True, capture_output=True,
                              timeout=10)

    def test_local_and_server_fences_both_pass_before_supervisor_receipt(self):
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout),
                         {"fenced": True, "evidence": "reviewed local and server fences"})

    def test_thawed_short_timer_skew_or_unavailable_server_denies(self):
        for state in ("thawed", "short", "skew", "error", "malformed"):
            with self.subTest(state=state):
                result = self.run_wrapper(state)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")

    def test_local_denial_does_not_call_server(self):
        self.local_state.write_text("error")
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertFalse(self.ssh_called.exists())


if __name__ == "__main__":
    unittest.main()
