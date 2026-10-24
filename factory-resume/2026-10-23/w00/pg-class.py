#!/usr/bin/env python3
# pg-class.py <repo> <unit.txt> <pg.txt> <lane-bound list> [--write <dir>] (integrator-5, 2026-10-23; validator-8 H1 / team-lead ruling after
# the W4H-35 hold REJECT 140d80ad6e954716, where the lane-bound alert-evaluator.integration ran in the unit list without PostgreSQL).
# The hold's unit/pg split by PATH misses suites that need PostgreSQL outside tests/postgres/. A suite NEEDS PG when it
#   - lives under tests/postgres/, or
#   - imports the factory test-database helper (tests/postgres/helpers/factory-test-database, setupFactoryPostgres), or
#   - reads process.env.FACTORY_TEST_POSTGRES_URL or process.env.DATABASE_URL (a direct read; a string that only NAMES the variable is no read).
# Each unit.txt entry that needs pg is a FINDING. Its place: a lane-bound suite (the lane list: scripts/check-factory-lanes.ts
# laneBoundTestFiles at the merge) needs more than pg (Podman, pinned images), so it goes to lane-pg.txt for its own extra leg; any other
# goes to pg.txt. Without --write: exit 1 when there is a finding (the red case), 0 when none. With --write <dir>: writes unit.txt, pg.txt
# and lane-pg.txt there (order kept, de-duplicated) and exits 0. Paths in the lists may carry a leading "./"; the output keeps "./".
import os, re, sys

PG = re.compile(r"""(from\s+["'][^"']*factory-test-database["']|\bsetupFactoryPostgres\b|process\.env(\.|\[["'])(FACTORY_TEST_POSTGRES_URL|DATABASE_URL)\b)""")


def norm(p):
    return p[2:] if p.startswith("./") else p


def lines(path):
    return [l.strip() for l in open(path) if l.strip()]


def needs_pg(repo, f):
    if f.startswith("tests/postgres/"):
        return "tests/postgres/"
    m = PG.search(open(os.path.join(repo, f), errors="replace").read())
    return m.group(1) if m else None


def main(argv):
    write = None
    if "--write" in argv:
        i = argv.index("--write"); write = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
    if len(argv) != 4:
        print(__doc__ or "usage: pg-class.py <repo> <unit.txt> <pg.txt> <lane-bound list> [--write <dir>]"); return 2
    repo, unit_p, pg_p, lane_p = argv
    unit, pg, lane = [norm(x) for x in lines(unit_p)], [norm(x) for x in lines(pg_p)], set(norm(x) for x in lines(lane_p))
    keep, move_pg, move_lane = [], [], []
    for f in unit:
        why = needs_pg(repo, f)
        if why is None:
            keep.append(f); continue
        (move_lane if f in lane else move_pg).append(f)
        print(f"FINDING {f}: needs pg ({why}) -> {'lane-pg.txt (lane-bound)' if f in lane else 'pg.txt'}")
    for f in pg:
        if f in lane:
            print(f"FINDING {f}: lane-bound suite in pg.txt -> lane-pg.txt"); move_lane.append(f)
    print(f"unit {len(unit)} -> {len(keep)}; pg {len(pg)} -> {len([f for f in pg if f not in lane]) + len(move_pg)}; lane-pg {len(move_lane)}")
    if write is None:
        return 1 if (move_pg or move_lane) else 0
    dedup = lambda xs: list(dict.fromkeys(xs))
    for name, xs in (("unit.txt", keep), ("pg.txt", [f for f in pg if f not in lane] + move_pg), ("lane-pg.txt", move_lane)):
        with open(os.path.join(write, name), "w") as fh:
            fh.write("".join(f"./{x}\n" for x in dedup(xs)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
