#!/usr/bin/env python3
"""lane-forms-leg.py --table <lane-table.tsv> --diff-files <file> --covdir <dir> (integrator-5, 2026-10-17; team-lead's hold leg (b)):
the REQUIRED-LANE FORMS of a merge's changed test files. Run from the repo root of the tree under test (python3 -I).
1. drift: every row's script pin and ci pin (file:line=exact trimmed text, or v8 file@job=text: the exact trimmed text inside that job of the workflow) is read in THIS tree; a mismatch is "RED drift <id> ...".
2. ownership: the classifier functions (every '<name>_files()' in scripts/lib/test-file-sets.sh of this tree, sourced, never copied)
   and vitest's own list (web/: npx vitest list --filesOnly) say which sets own each changed *.test.ts; a file no set owns is
   "RED orphan <file>"; a file owned only by sets without a lane row is "RED no lane row for <file> (sets ...)".
3. runs: each (row, file) pair runs the row's command, with the row's env, from the row's cwd ('whole' rows run once when any of their
   files changed); a non-zero exit or zero tests is "RED run <id> <file> ...". A Podman row (runner install) is refused outside the heavy
   lock ("RED podman lane outside the lock <id>"); the lock probe is LANE_LOCK_PROBE (default: flock -n on the heavy lock succeeding = NOT
   in the lock). The base env of every run is the caller's env WITHOUT CI, EZCORP_RUN_PODMAN_TESTS and every variable that any row sets
   (validator-8 R2: a caller's lane variable never leaks into another row); the row's own env is then applied on top (R1).
   A podman=no row runs as the hosted lane without the extension runner does (validator-8 R3): a leg-private `podman` that exits 127 first
   on PATH, and no runner env (the XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS that setup-extension-runner-ci.sh exports, CONTAINER_HOST,
   CONTAINERS_CONF, CONTAINERS_CONF_OVERRIDE); its run line ends "[no podman]".
   v6 (team-lead's ruling 2026-10-17, the D2 class): with --base <rev>, a *.test.ts whose LANE SET (the lane-row sets that own it: the
   product's test-file-sets.sh functions plus vitest's own list) differs between the base rules and the head rules joins the selection as
   "MOVED <file>: base [...] -> head [...]", unchanged or not. Base side: test-file-sets.sh in a bare detached base worktree (no install;
   it sources its own helpers by path), vitest list with the base web/vitest.config.ts as a run-scoped temp file in the head web/ (the head
   install); both removed in a finally. The list comes from the product's own binary web/node_modules/.bin/vitest (its node shebang
   runs under the pinned node on PATH), never npx/bunx; its --version must equal the vitest pin in web/package.json, else RED by name
   (condition A). A relative import of the base web/vitest.config.ts whose file differs between base and head is RED by name "base vitest
   config depends on changed helper(s): ..." (condition B: never a silent mix of base rules and head helpers). "lane moves: N[: files]"; without --base "lane moves: not checked (no --base)"; a base side that
   cannot be read is RED by name.
   v7 (team-lead's ruling a8b7283108caee00, after the W4H-34 hold's leg (b) red): two more OWNER kinds in a row's sets column, each
   modelling the hosted CI form exactly: "lane:<job>" = the product's own lane manifest (bun scripts/check-factory-lanes.ts --lane-tests
   <job>); "workflow:<path>" = the ONE workflow reader w00/ci-workflow-steps.ts (file -> step -> env). A "step" mode row runs, once per
   step, that step's own run with the workflow+job+step env. A CI service PostgreSQL URL (localhost) in that env, and a "{pg}" value in a
   row env, become the hold's own server (the caller's FACTORY_TEST_POSTGRES_URL: run the leg under heavy-lib's pg()); none = RED by name.
   DATABASE_URL and FACTORY_TEST_POSTGRES_URL are dropped from every row's base env (a hosted lane without a database never gets one).
   Output paths (a COV_OUT value, a --coverage-dir) and a "{covdir}" value go to the leg-private covdir. Bun for the owner readers:
   LANE_BUN (default "bun", the pinned one on PATH); LANE_READER (default the installed w00/ci-workflow-steps.ts). Lane moves (v6) compare the classifier and vitest sets only. --plan: drift, ownership
   and row resolution, then "PLAN <id> ...: <command>" lines and no run. node's "ℹ pass N" counts as passes.
   Exit 1 on any RED; a named PASS line when no changed test file exists."""
import argparse, atexit, json, os, re, shutil, subprocess, sys, tempfile
ap = argparse.ArgumentParser(); ap.add_argument("--table"); ap.add_argument("--diff-files"); ap.add_argument("--covdir"); ap.add_argument("--base"); ap.add_argument("--plan", action="store_true"); a = ap.parse_args()
red = []
def R(msg): red.append(msg); print("RED " + msg, flush=True)
rows = []
for line in open(a.table):
    if not line.strip() or line.startswith("#"): continue
    c = line.rstrip("\n").split("\t")
    if len(c) != 10: R(f"table row malformed ({len(c)} columns): {c[0] if c else ''}"); continue
    rows.append(dict(id=c[0], job=c[1], env=c[2], sets=c[3].split(","), mode=c[4], cwd=c[5], cmd=c[6], spin=c[7], cpin=c[8], podman=c[9] == "yes"))
def job_block(f, job):
    """v8 text anchor: the lines of `jobs:` -> `  <job>:` in workflow f, up to the next 2-space job key; None when f or the job is missing"""
    try: lines = open(f).read().split("\n")
    except OSError: return None
    try: i = lines.index("jobs:")
    except ValueError: return None
    for k in range(i + 1, len(lines)):
        if re.fullmatch(r"  " + re.escape(job) + r":\s*", lines[k]):
            out = []
            for l in lines[k + 1:]:
                if l.strip() and not l.startswith("   "): break
                out.append(l.strip())
            return out
    return None
def pin_ok(pin):
    loc, _, text = pin.partition("=")
    if "@" in loc:   # v8 (team-lead H2 after the W4H-35 hold RED: 5 line pins moved +4): file@job=text, found in that job's block
        f, _, job = loc.partition("@"); block = job_block(f, job)
        if block is None: return False, f"no job '{job}' in {f}"
        return text.strip() in block, "found in the job" if text.strip() in block else f"not found in job '{job}'"
    f, _, n = loc.rpartition(":")
    try: got = open(f).read().split("\n")[int(n) - 1].strip()
    except (OSError, IndexError, ValueError): got = None
    return got == text.strip(), got
for r in rows:
    for which in ("spin", "cpin"):
        ok, got = pin_ok(r[which])
        if not ok: R(f"drift {r['id']} {r[which].split('=')[0]}: expected {r[which].partition('=')[2]!r}, found {got!r}")
lanevars = {"CI", "EZCORP_RUN_PODMAN_TESTS", "DATABASE_URL", "FACTORY_TEST_POSTGRES_URL"} | {kv.partition("=")[0] for r in rows if r["env"] != "-" for kv in r["env"].split(";")}
HOLD_PG = os.environ.get("FACTORY_TEST_POSTGRES_URL", "")
LANE_BUN = os.environ.get("LANE_BUN", "bun")
READER = os.environ.get("LANE_READER", "evidence/w00/ci-workflow-steps.ts")   # the INSTALLED reader; a staged run names the .new
SERVICE_PG = re.compile(r"^postgres(?:ql)?://[^@/]*@(?:localhost|127\.0\.0\.1)(?::\d+)?/")
base_env = {k: v for k, v in os.environ.items() if k not in lanevars}
RUNNER_ENV = ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "CONTAINER_HOST", "CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE")
NOPODMAN = tempfile.mkdtemp(prefix="lane-forms-nopodman."); atexit.register(shutil.rmtree, NOPODMAN, True)
with open(os.path.join(NOPODMAN, "podman"), "w") as fh: fh.write('#!/bin/sh\necho "podman: not installed in this lane (lane-forms podman=no row)" >&2\nexit 127\n')
os.chmod(os.path.join(NOPODMAN, "podman"), 0o755)
changed = [l.strip() for l in open(a.diff_files) if l.strip().endswith(".test.ts") and os.path.isfile(l.strip())]
print("lane-forms: base env without " + ",".join(sorted(lanevars)), flush=True)
rowsets = {s for r in rows for s in r["sets"]}
want_vitest = "vitest:list" in rowsets
def classify(root, side):
    """the product's own classifier of the tree at <root>: {set function: {repo-relative file}}; a failing source or function is RED by
    name with its side (validator-8 F3: no silent empty set)"""
    fns = re.findall(r"(?m)^([a-z_]+_files)\(\)", open(os.path.join(root, "scripts/lib/test-file-sets.sh")).read())
    errf = tempfile.mkstemp(prefix="lane-forms-classify.")[1]
    try:
        p = subprocess.run(["bash", "-c", 'E=$1; shift; . scripts/lib/test-file-sets.sh >/dev/null 2>"$E" || { r=$?; printf "\n=== SOURCE %s %s\n" $r "$(tail -c 200 "$E" | tr "\n" " ")"; exit 0; }; for fn in "$@"; do echo "=== $fn"; ( "$fn" ) 2>"$E"; r=$?; printf "\n=== RC %s %s %s\n" "$fn" $r "$(tail -c 200 "$E" | tr "\n" " ")"; done', "_", errf, *fns], cwd=root, capture_output=True, text=True)
    finally: os.remove(errf)
    dump = p.stdout
    if p.returncode != 0 and "\n=== RC " not in dump: R(f"{side} classifier sourcing scripts/lib/test-file-sets.sh failed (exit {p.returncode}): the shell ended before any function reported")
    out, cur, reported = {}, None, set()
    for l in dump.split("\n"):
        if l.startswith("=== SOURCE "): _, _, rc, *tail = l.split(" "); R(f"{side} classifier sourcing scripts/lib/test-file-sets.sh failed (exit {rc}): {' '.join(tail).strip()}"); cur = None
        elif l.startswith("=== RC "):
            _, _, fn, rc, *tail = l.split(" "); cur = None; reported.add(fn)
            if rc != "0": R(f"{side} classifier {fn} failed (exit {rc}): {' '.join(tail).strip()}")
        elif l.startswith("=== "): cur = l[4:]; out[cur] = set()
        elif cur and l.strip(): out[cur].add(l.strip().removeprefix("./"))
    if "\n=== SOURCE " not in dump:
        for fn in fns:
            if fn not in reported: R(f"{side} classifier {fn} did not finish (no RC line)")
    return out
VITEST = os.path.abspath("web/node_modules/.bin/vitest"); vitest_ok = []
def vitest_pinned():
    """condition A, checked once: the product's own binary, its version equal to the web/package.json pin"""
    if vitest_ok: return vitest_ok[0]
    try:
        pkg = json.load(open("web/package.json")); pin = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}.get("vitest", "").lstrip("^~=")
        got = re.match(r"vitest/(\S+)", subprocess.run([VITEST, "--version"], cwd="web", capture_output=True, text=True).stdout or "")
    except (OSError, ValueError) as e: R(f"vitest binary unusable: {e}"); vitest_ok.append(False); return False
    ver = got.group(1) if got else None
    if not pin or ver != pin: R(f"vitest binary version {ver} differs from the web/package.json pin {pin or None}"); vitest_ok.append(False); return False
    print(f"lane-forms: vitest list by web/node_modules/.bin/vitest {ver} (the web/package.json pin)", flush=True); vitest_ok.append(True); return True
def vitest_list(cfg=None):
    """vitest's own list in the head web/ (the head install), with <cfg> (relative to web/) when given: (files, rc, stderr tail)"""
    if not vitest_pinned(): return set(), 97, "vitest binary not usable (condition A)"
    v = subprocess.run([VITEST, "list", "--filesOnly"] + (["--config", cfg] if cfg else []), cwd="web", capture_output=True, text=True)
    root = os.getcwd()
    files = {os.path.relpath(os.path.join("web", p.strip()) if not os.path.isabs(p.strip()) else p.strip(), root) for p in v.stdout.split("\n") if p.strip().endswith(".test.ts")}
    return files, v.returncode, v.stderr.strip()[-300:]
def owners(smap, f): return sorted(s for s, members in smap.items() if f in members and s in rowsets and not s.startswith(("lane:", "workflow:")))
STEPS = {}   # workflow path -> {file: [step dicts]} from the ONE reader
def owner_sources(smap):
    """v7: the "lane:<job>" and "workflow:<path>" owners named in the table, read from the tree under test; a failure is RED by name"""
    for s in sorted(rowsets):
        if s.startswith("lane:"):
            p = subprocess.run([LANE_BUN, "scripts/check-factory-lanes.ts", "--lane-tests", s[5:]], capture_output=True, text=True)
            if p.returncode != 0: R(f"owner {s}: check-factory-lanes.ts --lane-tests failed (exit {p.returncode}): {p.stderr.strip()[-200:]}"); continue
            smap[s] = {l.strip().removeprefix("./") for l in p.stdout.split("\n") if l.strip()}
        elif s.startswith("workflow:"):
            p = subprocess.run([LANE_BUN, READER, s[9:]], capture_output=True, text=True)
            if p.returncode != 0: R(f"owner {s}: the workflow reader failed (exit {p.returncode}): {p.stderr.strip()[-200:]}"); continue
            steps = {}
            for l in p.stdout.split("\n"):
                if l.strip(): d = json.loads(l); steps.setdefault(d["file"], []).append(d)
            STEPS[s[9:]] = steps; smap[s] = set(steps)
def lane_moves(rev, head):
    ok = subprocess.run(["git", "rev-parse", "--verify", "-q", rev + "^{commit}"], capture_output=True, text=True)
    if ok.returncode != 0: R(f"lane moves: base {rev} is not a commit"); return []
    sha = ok.stdout.strip(); tmp = tempfile.mkdtemp(prefix="lane-forms-base."); cfg = f".lane-forms-base-{os.getpid()}.vitest.config.ts"
    try:
        w = subprocess.run(["git", "worktree", "add", "--detach", "-q", tmp, sha], capture_output=True, text=True)
        if w.returncode != 0: R(f"lane moves: base {rev} worktree failed: {w.stderr.strip()[-200:]}"); return []
        base = classify(tmp, "base")
        if not base: R(f"lane moves: base {rev} has no classifier functions"); return []
        if want_vitest:
            c = subprocess.run(["git", "show", f"{sha}:web/vitest.config.ts"], capture_output=True, text=True)
            if c.returncode == 0:
                deps = []
                for rel in re.findall(r"""(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](\.{1,2}/[^"']+)["']""", c.stdout):
                    p0 = os.path.normpath(os.path.join("web", rel))
                    hit = next((q for q in (p0, p0 + ".ts", p0 + ".js", p0 + ".mjs", os.path.join(p0, "index.ts"))
                                if subprocess.run(["git", "cat-file", "-e", f"{sha}:{q}"], capture_output=True).returncode == 0), p0)
                    if subprocess.run(["git", "diff", "--quiet", sha, "--", hit], capture_output=True).returncode != 0 or not os.path.exists(hit): deps.append(hit)
                if deps: R(f"base vitest config depends on changed helper(s): {' '.join(sorted(set(deps)))}"); return []
                with open(os.path.join("web", cfg), "w") as fh: fh.write(c.stdout)
                files, rc, err = vitest_list(cfg)
                if rc != 0: R(f"lane moves: base {rev} vitest list failed (exit {rc}): {err}"); return []
                base["vitest:list"] = files
            else: base["vitest:list"] = set()
    finally:
        if os.path.exists(os.path.join("web", cfg)): os.remove(os.path.join("web", cfg))
        subprocess.run(["git", "worktree", "remove", "--force", tmp], capture_output=True); shutil.rmtree(tmp, True)
    cands = {f for smap in (head, base) for members in smap.values() for f in members if f.endswith(".test.ts") and os.path.isfile(f)}
    moved = []
    for f in sorted(cands):
        b, h = owners(base, f), owners(head, f)
        if b != h: moved.append(f); print(f"MOVED {f}: base {b} -> head {h}", flush=True)
    print(f"lane moves: {len(moved)}" + (": " + " ".join(moved) if moved else ""), flush=True)
    return moved
sets, moved = {}, []
if changed or a.base:
    sets = classify(".", "head")
    if want_vitest and (a.base or any(f.startswith("web/") for f in changed)):
        files, rc, err = vitest_list()
        sets["vitest:list"] = files
        if rc != 0: R(f"vitest list failed (exit {rc})")
if changed or a.base: owner_sources(sets)
if a.base: moved = lane_moves(a.base, sets); changed += [f for f in moved if f not in changed]
else: print("lane moves: not checked (no --base)", flush=True)
if not changed:
    print(f"lane-forms: no changed test file, {len(red)} red" if red else "lane-forms: PASS (no changed test file)"); sys.exit(1 if red else 0)
probe = os.environ.get("LANE_LOCK_PROBE", "flock -n /tmp/ezcorp-validation-heavy.lock true")
in_lock = subprocess.run(["bash", "-c", probe]).returncode != 0
def count(out):
    m = re.findall(r"(?m)^\s*(\d+) pass$", out) or re.findall(r"Tests\s+(\d+) passed", out) or re.findall(r"(?m)^ℹ pass (\d+)$", out)
    return sum(int(x) for x in m)
todo = []
for f in changed:
    owners = [s for s, members in sets.items() if f in members]
    if not owners: R(f"orphan {f}: no classifier set and no vitest list owns it"); continue
    lanes = [r for r in rows if any(s in owners for s in r["sets"])]
    if not lanes: R(f"no lane row for {f} (sets {sorted(owners)})"); continue
    for r in lanes: todo.append((r, f))
def pg_value(v, where):
    """a CI service PostgreSQL URL or a "{pg}" value -> the hold's own server; None when the caller gave none (RED by name)"""
    if v != "{pg}" and not SERVICE_PG.match(v): return v
    if not HOLD_PG: R(f"{where} needs the hold's PostgreSQL (no FACTORY_TEST_POSTGRES_URL: run the leg under heavy-lib's pg())"); return None
    return HOLD_PG
runs = []   # (row, file, label, cmd, env-additions, cwd)
done_whole, done_step = set(), set()
for r, f in todo:
    if r["mode"] == "whole":
        if r["id"] in done_whole: continue
        done_whole.add(r["id"])
    if r["podman"] and not in_lock and not a.plan: R(f"podman lane outside the lock {r['id']} ({f})"); continue
    cwd = "web" if r["cwd"] == "web" else "."
    rel = os.path.relpath(f, "web") if cwd == "web" else f
    covdir = os.path.join(a.covdir, r["id"] + "-" + re.sub(r"[^A-Za-z0-9]+", "-", f)); os.makedirs(covdir, exist_ok=True)
    if r["mode"] == "step":
        for st in [d for w in r["sets"] if w.startswith("workflow:") for d in STEPS.get(w[9:], {}).get(f, [])]:
            key = (r["id"], st["workflow"], st["job"], st["line"])
            if key in done_step: continue
            done_step.add(key)
            add, ok = {}, True
            for k, v in st["env"].items():
                v2 = pg_value(v, f"workflow step {st['job']} '{st['step']}'")
                if v2 is None: ok = False; break
                add[k] = covdir if k == "COV_OUT" else v2
            if not ok: continue
            cmd = re.sub(r"--coverage-dir=\S+", "--coverage-dir=" + covdir, re.sub(r"\bCOV_OUT=\S+", "COV_OUT=" + covdir, st["run"]))
            runs.append((r, f, f"{st['workflow']} {st['job']} step '{st['step']}' line {st['line']}", cmd, add, cwd))
        continue
    cmd = r["cmd"].replace("{f}", f).replace("{rel}", rel).replace("{covdir}", covdir)
    add, ok = {}, True
    if r["env"] != "-":
        for kv in r["env"].split(";"):
            k, _, v = kv.partition("="); v = v.replace("{covdir}", covdir); v2 = pg_value(v, f"row {r['id']} {k}")
            if v2 is None: ok = False; break
            add[k] = v2
    if ok: runs.append((r, f, f"{r['job']}, env {r['env']}", cmd, add, cwd))
if a.plan:
    for r, f, label, cmd, add, cwd in runs: print(f"PLAN {r['id']} {f} ({label}): {cmd}  [cwd {cwd}]" + ("" if r["podman"] else " [no podman]"), flush=True)
    print(f"lane-forms: PLAN {len(changed)} changed test file(s), {len(runs)} lane run(s), {len(red)} red"); sys.exit(1 if red else 0)
for r, f, label, cmd, add, cwd in runs:
    env = dict(base_env); env.update(add)
    if not r["podman"]:
        for k in RUNNER_ENV: env.pop(k, None)
        env["PATH"] = NOPODMAN + os.pathsep + env.get("PATH", "")
    print(f"== {r['id']} ({label}): {cmd}  [cwd {cwd}]" + ("" if r["podman"] else " [no podman]") + (" [moved]" if f in moved else ""), flush=True)
    p = subprocess.run(["bash", "-c", cmd], cwd=cwd, env=env, capture_output=True, text=True)
    out = p.stdout + p.stderr; print(out[-3000:], flush=True); n = count(out)
    if p.returncode != 0: R(f"run {r['id']} {f}: exit {p.returncode}")
    elif n == 0 and r["mode"] in ("perfile", "step"): R(f"run {r['id']} {f}: zero tests")
    else: print(f"PASS {r['id']} {f}: {n} pass", flush=True)
print(f"lane-forms: {len(changed)} changed test file(s), {len(runs)} lane run(s), {len(red)} red")
sys.exit(1 if red else 0)
