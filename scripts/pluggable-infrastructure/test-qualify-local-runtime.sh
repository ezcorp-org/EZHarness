#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/ezpi-test-XXXXXXXX")"
trap 'rm -r "$work"' EXIT INT TERM

python3 "$script_dir/qualify-local-runtime.py" --profile canary --receipt "$work/pass.json" >/dev/null
python3 - "$work/pass.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1], encoding="utf-8"))
assert r["qualified"] is True
assert not r["missingControls"]
assert r["controls"]["cleanup"]["passed"] is True
PY

set +e
python3 "$script_dir/qualify-local-runtime.py" --profile canary --simulate-missing-control cpu-ceiling --receipt "$work/denied.json" >/dev/null
denied_status=$?
python3 "$script_dir/qualify-local-runtime.py" --profile linux-exec.v1 --receipt "$work/linux.json" >/dev/null
linux_status=$?
python3 "$script_dir/qualify-local-runtime.py" --profile persistent-web-compose.v1 --receipt "$work/compose.json" >/dev/null
compose_status=$?
set -e

[[ "$denied_status" -eq 2 && "$linux_status" -eq 0 && "$compose_status" -eq 2 ]]
python3 - "$work/denied.json" "$work/linux.json" "$work/compose.json" <<'PY'
import json, sys
denied, linux, compose = (json.load(open(p, encoding="utf-8")) for p in sys.argv[1:])
assert denied["missingControls"] == ["cpu-ceiling"]
assert linux["qualified"] is True
assert linux["missingControls"] == []
assert set(compose["missingControls"]) == {
    "isolated-nested-engine", "nested-compose", "nested-resource-accounting"
}
assert all(r["controls"]["cleanup"]["passed"] for r in (denied, linux, compose))
PY
echo "local runtime qualification tests passed"
