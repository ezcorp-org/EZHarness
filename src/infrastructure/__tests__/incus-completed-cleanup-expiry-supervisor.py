"""Run the unchanged real supervisor for a scratch PGlite reconciliation child."""
import hashlib
import importlib.util
import os
from pathlib import Path
import sys

root, phase, bun = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
source = Path(__file__).resolve().parents[3] / 'scripts/incus/incus-qualification-supervisor.py'
spec = importlib.util.spec_from_file_location('supervisor', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
worker = Path(__file__).with_name('incus-completed-cleanup-expiry.worker.ts')
receipt = [sys.executable, '-c', 'print(\'{"ready":"receipt.v1"}\')']
supervisor = module.Supervisor(str(root / 'control.sock'), [bun, str(worker), str(root), phase],
    os.getuid(), os.getgid(), root / 'key.pem', [sys.executable, '-c', 'raise SystemExit(1)'],
    receipt, enforce_distinct_uid=False)
supervisor.fault_authority_command = [sys.executable, '-c', 'print(\'{"ready":"fault.v1"}\')']
if phase == 'second':
    supervisor.terminal_handoff_path = root / 'handoff.json'
    supervisor.terminal_handoff_sha256 = hashlib.sha256(supervisor.terminal_handoff_path.read_bytes()).hexdigest()
    supervisor.terminal_handoff_run_id = 'expired-run'
supervisor.serve()
