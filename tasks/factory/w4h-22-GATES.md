# Gates: W4H-22 — the file-organizer refused-add case must await the outcome, not a 5 s clock

Scope: hosted run 38001537073 failed the production-proof content shard. In `web/e2e/file-organizer-real.spec.ts` the case
"UI: a refused add surfaces a real error toast in the browser" failed after 5.9 s; 8 passed and 4 did not run (serial file).
Branch `wp/w4h-22-toast-outcome` from integ/w00 `fe445d241`. Evidence directory: `/tmp/factory-platform-evidence/w4h-22/`,
written `w4h-22/` below. validator-8 validates; integrator-5 merges.

## Root cause

The brief named the toast wait. The hosted log shows a different line: the case failed at `:521`, the Hub page title wait
(`toBeVisible()` with the default 5000 ms), "element(s) not found". The click and the toast wait were never reached. The lead
accepted this correction. The title appears only after the client GETs `/api/hub/pages/ext%3Afile-organizer%3Aoverview`, a live
render. Locally that render took 3113 ms, and the case took 3.5-3.7 s of its 5 s. The same title wait elsewhere in the file has
20 s (beforeAll) or 10 s. The toast wait had the same defect: a fixed 5000 ms over a live round-trip. The toast store also removes
a toast 5000 ms after the shell adds it (`web/src/lib/toast.svelte.ts`, default duration). The shell has no defect.

## Fix (spec only)

The case awaits each outcome, never a clock: the Hub page GET response (status 200), then the title; the prompt dialog; the
add-folder POST response (matched by method and path) with status 200 and body exactly `{ ok: false, message: <refusal> }`; then
the toast at once, with a 4 s bound inside its 5 s life. Each live round-trip has a 20 s bound, the same as the beforeAll title
wait. No sleep. No production, helper, config or other-case change.

## Gates

Commit note: the gate file and `tasks/todo.md` are force-added (`-f`) because of the bare `tasks` rule at .gitignore:8.

- [x] G1 (R1, red first): the hosted shape reproduced with the OLD case, the refusal correct. CHECK: `w00/gated-flock.sh w4h-22 …
  bash w4h-22/heavy.sh fe445d241 r1 fo:base fo:r1-page-hold fo:r1-dispatch-hold` (a runner-shaped container copied from W4H-18 and
  W4H-11; the file-organizer proof run as the content shard runs it; only the spec file changes per leg). EXPECT: base green; each
  hold red at its 5000 ms wait. EVIDENCE: `w4h-22/r1/R1-receipt.txt` (69aedb99…). Base: 13 passed, case 3.7 s. Hub page response
  held 8 s (proof/w4h-22-r1-page-hold 80784c6495b2): red at the title, 5000 ms, element(s) not found, 8 passed, 4 did not run, as
  hosted. Dispatch response held 8 s (proof/w4h-22-r1-dispatch-hold 24dca81ffc85): the real body was
  `{"ok":false,"message":"Path must be an absolute, valid filesystem path."}`; red at the toast, 5000 ms. Try 1 is void (my job
  scripts had mode 0600; setup exit 126; nothing ran).
- [x] G2 (R2): the fixed case passes under each hold. CHECK: `bash w4h-22/heavy.sh b5bd72672 r2 …` with W4H22_BASE=r2-head.
  EXPECT: 13 passed in each. EVIDENCE: `w4h-22/r2/R2-receipt.txt` (4edf8f9c…). No hold: case 3.5 s. Hub page held 8 s: 11.5 s.
  Dispatch held 8 s: 11.6 s. Dispatch held 4.5 s, near the toast's 5 s life: 8.1 s.
- [x] G3 (R2 mutants): each mutant is red by assertion, not by timeout. EVIDENCE: the same receipt. A body without ok:false (the
  shell adds no toast): red at the body `toEqual`. The relative path accepted, `{ok:true}`: red at the body `toEqual`. The real
  refusal served but every role=alert node removed as it appears: red at the toast assertion (4000 ms) after the response checks
  passed. Proof refs: proof/w4h-22-r2-mutant-no-refusal 72e7141de725, proof/w4h-22-r2-mutant-accepted f636e1d699d8,
  proof/w4h-22-r2-mutant-no-toast 6db27d65665e.
- [x] G4 (R3): the production-proof content shard as CI runs it, at b5bd72672, under the lock. CHECK: `w00/gated-flock.sh w4h-22 …
  bash w4h-22/r3.sh b5bd72672` (job-proof.sh content: scripts/verify-shipping-production-suite.sh with EZ_SHIPPING_SHARD=content).
  EXPECT: both proofs exit 0. EVIDENCE: `w4h-22/r3/hold-20261010T011754Z/proof-content.log` (47d62009…), playwright.log
  (107460e5…): file-organizer 0, 13 passed, the case 3.5 s; the other 12 cases within the base run's times; legacy-adoption 0
  (485 s). No PostgreSQL: the shard starts its own stack in the container. Disclosed: app ids 0:0 under rootless Podman, as W4H-18.
- [x] G5: light legs at b5bd72672. CHECK: `bash w4h-22/final-legs.sh`. EVIDENCE: `w4h-22/logs/final-legs.log` (82a2e0fb…). Lint
  rc=0, 0 warnings (56c6d557…). Boundaries, lanes, prune scan (49b6008e…) pass; src/__tests__/e2e-lanes.test.ts 32 pass. New-file
  and patch vs integ/w00 rc=0 and vacuous ("no new source files", "0 file(s)"): web/e2e is outside SOURCE_GLOBS. CRAP --changed vs
  integ/w00: 0 functions, rc=0 (`logs/final-crap-changed-lcov.log`, 7bc8bad2…; the first try had no lcov file, the rerun used an
  lcov of the e2e-lanes test, removed after). Not required and red from inherited integ files: new-file and patch vs origin/main.
- [x] G6: gate-integrity, both legs. EXPECT: integ rc=0; main exactly the 8 known coverage-tool findings, no new line. EVIDENCE:
  `logs/final-gate-integrity-integ_w00.log` (b1a02975…), `logs/final-gate-integrity-origin_main.log` (258f14da…, byte-identical to
  W4H-17's main leg log).
- [x] G7: typecheck and the guard set, in the R3 hold. EVIDENCE: `w4h-22/r3/host-legs.log` (51c35d00…). Guard set: 41 files, 511
  pass, 2 skip, 0 fail (`r3/guard-set.log`, c3a9c212…). Typecheck rc=0 including web/e2e (`r3/typecheck.log`, 38db2e0b…),
  MemAvailable 18 GiB at start, lowest 15 GiB, no other typecheck. Lock-free typecheck was refused first (w4h-21 held the lock).

Hook per commit: b5bd72672 0 suites (no test file maps to the spec), biome passed (`w4h-22/commit-1.log`). This gate commit: docs only.
Toolchain: Bun 1.4.2 (bun and bunx, the tree's .bun-version), Node 24.14.1. My runner image was removed by name after R3.

Leftover candidate (no change here): the content shard's artifact keeps no Playwright trace or screenshot on failure, so a hosted
red in this file cannot be inspected beyond the log.
