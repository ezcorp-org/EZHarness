"""Real managed Bun client and SO_PEERCRED socket, with controlled remote latency."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]

def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

SUPERVISOR = load("incus-qualification-supervisor.py")
FIXTURE = load("incus-admission-authority.test.py")

CLIENT = r'''
import { writeFileSync } from 'node:fs';
const { requestIncusAdmissionReadiness } = await import(process.env.CLIENT_SOURCE);
const { admissionPin } = await import(process.env.FIXTURE_SOURCE);
const started = performance.now();
let result;
try { await requestIncusAdmissionReadiness(process.env.CONTROL, admissionPin); result = {ready:true}; }
catch(error) { result = {ready:false, code:error.code ?? null, message:error.message, reason:error.reason}; }
if (process.env.CHECK_PRIVATE_REPLY === 'yes') {
  const {createConnection} = await import('node:net');
  result.privateReply = await new Promise((resolve, reject) => {
    const socket = createConnection(process.env.CONTROL);
    let data = '';
    socket.on('connect', () => socket.write(JSON.stringify({version:2, action:'admissionReadiness', expectedPin:admissionPin})+'\n'));
    socket.on('error', reject);
    socket.on('data', chunk => { data += chunk; if(data.includes('\n')) { socket.destroy(); resolve(JSON.parse(data)); } });
  });
}
writeFileSync(process.env.RESULT, JSON.stringify({...result, elapsedMs:performance.now()-started}));
while(true) await Bun.sleep(100);
'''

def server(directory, delay, scenario):
    fixture = FIXTURE.AdmissionAuthorityTests()
    fixture.setUp()
    try:
        authority = fixture.authority()
        real_observe = authority.observe
        count = 0
        def observe(*args, **kwargs):
            nonlocal count
            started = time.monotonic()
            try:
                # Retain old measured scan delays only for the slow refusal arm.
                # The positive control uses real fixture scans without a floor.
                delay = (2.575, 2.502)[count % 2] if scenario == 'latency' else 0
                # Simulate work which checks the same cooperative scan deadline.
                time.sleep(min(delay, max(0, args[0]-time.monotonic())) if args else delay)
                count += 1
                return real_observe(*args, **kwargs)
            finally:
                with (Path(directory)/'stages').open('a') as log:
                    log.write(json.dumps({'phase':'authority', 'seconds':time.monotonic()-started})+'\n')
        authority.observe = observe
        root = Path(directory)
        key = root / 'key'
        key.write_text('fixture-only'); key.chmod(0o600)
        receipt = root / 'receipt.py'
        receipt.write_text("import json,sys,time\nm=json.load(sys.stdin)\nassert m['phase']=='admissionReadiness'\ntime.sleep(" + str(delay) + ")\nprint(json.dumps({'ready':'admission.v2','observation':" + repr({
            'hostPolicyDigest':'4'*64,
            'backend':{'backendApi':'incus.v1','backendVersion':'6.0.6','architecture':'amd64','storageDriver':'zfs','isolation':'container','nestedCompose':True},
            'capacity':{'hostId':'host','capturedAt':'2026-10-08T12:00:00Z','availableMemoryBytes':100000,'poolFreeBytes':100000,'availablePids':1000,'cpuThreads':8}}) + "}))\n")
        if scenario == 'mutation':
            receipt.write_text('from pathlib import Path\nPath(' + repr(str(fixture.root/'web/build/index.js')) + ').write_text("private credential")\n' + receipt.read_text())
        if scenario == 'malformed':
            receipt.write_text('print("private credential: malformed subconsumer output")\n')
        receipt.write_text('import json,time\nstarted=time.monotonic()\n'+receipt.read_text()+
            '\nwith open('+repr(str(root/'stages'))+',"a") as log: log.write(json.dumps({"phase":"readback","seconds":time.monotonic()-started})+"\\n")\n')
        environment = dict(os.environ, CLIENT_SOURCE=str(ROOT/'src/infrastructure/incus-qualification-supervisor-client.ts'),
            FIXTURE_SOURCE=str(ROOT/'src/infrastructure/__tests__/incus-admission-observation.ts'),
            CONTROL=str(root/'control'), RESULT=str(root/'result'),
            CHECK_PRIVATE_REPLY='no' if scenario in ('latency', 'normal') else 'yes')
        supervisor = SUPERVISOR.Supervisor(str(root/'control'),
            [shutil.which('bun'), '-e', CLIENT], os.getuid(), os.getgid(), key,
            ['unused'], [sys.executable, '-B', str(receipt)], enforce_distinct_uid=False)
        supervisor.admission_authority = authority
        os.environ.update(environment)
        supervisor.serve()
    finally:
        fixture.tearDown()

class ConsumerTests(unittest.TestCase):
    def test_complete_managed_consumer_budget_and_safe_failure(self):
        for delay, ready, scenario, reason in ((7.5, False, 'latency', 'deadline_exceeded'),
                (5.468, True, 'normal', None), (0, False, 'mutation', 'authority_rejected'),
                (0, False, 'malformed', 'unavailable')):
            with self.subTest(receiptDelay=delay, scenario=scenario), tempfile.TemporaryDirectory(prefix='incus-ready-') as directory:
                process = subprocess.Popen([sys.executable, '-B', __file__, '--server', directory, str(delay), scenario],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    result_path = Path(directory)/'result'
                    until = time.monotonic()+20
                    while not result_path.exists() and process.poll() is None and time.monotonic()<until:
                        time.sleep(0.01)
                    self.assertTrue(result_path.exists(), 'managed consumer did not publish a result')
                    result = json.loads(result_path.read_text())
                    result['stages'] = [json.loads(line) for line in (Path(directory)/'stages').read_text().splitlines()]
                    print(json.dumps({'receiptDelay':delay, 'scenario':scenario, 'result':result}), flush=True)
                    self.assertEqual(result['ready'], ready)
                    if scenario in ('latency', 'normal'):
                        self.assertEqual([stage['phase'] for stage in result['stages']], ['authority','readback','authority'])
                    if not ready:
                        self.assertEqual(result['code'], 'readiness_unavailable')
                        self.assertEqual(result['message'], 'readiness_unavailable')
                        self.assertEqual(result['reason'], reason)
                        if scenario not in ('latency', 'normal'):
                            self.assertEqual(result['privateReply'], {'error':'readiness_unavailable:'+reason})
                        self.assertNotIn('private credential', json.dumps(result))
                    self.assertIsNone(process.poll())
                finally:
                    process.terminate()
                    try: process.wait(timeout=5)
                    except subprocess.TimeoutExpired: process.kill(); process.wait()
                    process.stdout.close(); process.stderr.close()

if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--server': server(sys.argv[2], float(sys.argv[3]), sys.argv[4])
    else: unittest.main()
