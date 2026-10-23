#!/usr/bin/env python3
# r2-repro-judge.py (W4H-35 session 6; team-lead 2026-10-20 16:10Z): the red-first reproduction of the session-5 unit-cov red (R2).
# The cause (proven lock-free, scratch/r2-mock-leak): guest-broker-composition.test.ts mocks db/connection through test-pglite's
# mockDbConnection(); in ONE bun process that mock leaks, so withPostgresMigrateLock (src/db/connection.ts:621) gets the PGlite
# drizzle and the tag call at :593 fails ("N is not a function"); factory-gateway-process.test.ts:22 needs DATABASE_URL at start.
#   r2-repro-judge.py --emit <bun log>            print the signature of a bun test log as JSON
#   r2-repro-judge.py <bun log> <signature.json>  exit 0 only when the log's signature equals the recorded one
# The signature: every "(fail)" name per test file (timings dropped), the files with an unhandled error between tests, and the
# count of the two cause lines. Pass counts are not in it. A log with no test file at all never matches.
import json, re, sys

CAUSES = {"leak": "TypeError: N is not a function", "no-database-url": "error: DATABASE_URL must name the gateway's database"}


def signature(text):
    current, fails, unhandled = None, [], []
    counts = {k: 0 for k in CAUSES}
    for line in text.splitlines():
        m = re.match(r"^(\S+\.test\.ts):$", line)
        if m:
            current = m.group(1)
            continue
        m = re.match(r"^\(fail\) (.*) \[[\d.]+m?s\]$", line)
        if m:
            fails.append([current, m.group(1)])
        if line.startswith("# Unhandled error between tests"):
            unhandled.append(current)
        for key, text_ in CAUSES.items():
            if line.startswith(text_):
                counts[key] += 1
    return {"fails": sorted(fails, key=lambda f: (f[0] or "", f[1])), "unhandled": sorted(set(u or "" for u in unhandled)), "causes": counts}


def main(argv):
    if len(argv) == 3 and argv[1] == "--emit":
        print(json.dumps(signature(open(argv[2]).read()), indent=1))
        return 0
    if len(argv) != 3:
        print("usage: r2-repro-judge.py --emit <log> | <log> <signature.json>")
        return 2
    got, want = signature(open(argv[1]).read()), json.load(open(argv[2]))
    if not got["fails"] and not got["unhandled"]:
        print("r2 repro: NO MATCH: the log has no fail and no unhandled error")
        return 1
    if got == want:
        print(f"r2 repro: MATCH: {len(got['fails'])} fails, unhandled in {got['unhandled']}, causes {got['causes']}")
        return 0
    for key in ("fails", "unhandled", "causes"):
        if got[key] != want[key]:
            print(f"r2 repro: NO MATCH on {key}: got {got[key]} want {want[key]}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
