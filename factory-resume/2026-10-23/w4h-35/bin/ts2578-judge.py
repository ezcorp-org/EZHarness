#!/usr/bin/env python3
# ts2578-judge.py <typecheck log> <typecheck exit> <file> <line> (validator-8 condition 3; team-lead pre-ruling on the in-lock type
# steps of commit 04): exit 0 only when the typecheck FAILED and its only TypeScript errors are TS2578 (an unused @ts-expect-error)
# at <file>(<line>,...): the red step of the type requirement. scripts/typecheck.sh runs more than one tsc leg, so the same error
# may print once per leg. Any other error, line or file, or a passing typecheck, is a mismatch.
import re, sys


def main(log, rc, path, line):
    errors = re.findall(r"^(\S+)\((\d+),\d+\): error (TS\d+): .*$", open(log, encoding="utf-8").read(), re.M)
    named = [e for e in errors if e == (path, line, "TS2578")]
    other = [e for e in errors if e != (path, line, "TS2578")]
    ok = rc != "0" and named and not other
    print(f"ts2578 judge: {'MATCH' if ok else 'NO MATCH'}: typecheck exit {rc}; TS2578 at {path}:{line} x{len(named)}; other errors {other}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:5]))
