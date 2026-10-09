"""Mixed management/ordinary CREATE through real managed-client/socket boundaries."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

import importlib.util

spec = importlib.util.spec_from_file_location('consumer', Path(__file__).with_name('incus-admission-readiness-consumer.test.py'))
consumer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(consumer)
CLIENT = 'await import('+json.dumps(str(Path(__file__).with_name('__tests__')/'admission-contention-client.ts'))+');'

class ContentionTests(unittest.TestCase):
    def test_management_and_reserved_create_share_one_fresh_socket_observation(self):
        with tempfile.TemporaryDirectory(prefix='incus-contention-') as directory:
            process = subprocess.Popen([sys.executable, '-B', __file__, '--server', directory], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                result_path = Path(directory)/'result'
                until = time.monotonic()+40
                while not result_path.exists() and process.poll() is None and time.monotonic()<until:
                    time.sleep(0.01)
                self.assertTrue(result_path.exists(), 'managed consumer did not publish a result')
                result = json.loads(result_path.read_text())
                result['stages'] = [json.loads(line) for line in (Path(directory)/'stages').read_text().splitlines()]
                print(json.dumps(result), flush=True)
                self.assertTrue(result.get('managementReady'), result)
                self.assertEqual(result['dispatch'], {'ok':True, 'result':{'ok':True}})
                self.assertEqual(result['transportCalls'], 1)
                self.assertEqual(result['socketCalls'], 4)
                self.assertEqual(sum(stage['phase']=='readback' for stage in result['stages']), 4)
                self.assertEqual(sum(stage['phase']=='authority' for stage in result['stages']), 8)
                self.assertLess(result['elapsedMs'], 12000)
            finally:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
                stderr = process.stderr.read().decode()
                if stderr: print(stderr, file=sys.stderr)
                process.stdout.close(); process.stderr.close()

if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--server': consumer.server(sys.argv[2], 0, 'contention', CLIENT)
    else: unittest.main()
