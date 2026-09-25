# Gates: W19b graph-proof harness keeps a failed pass's diagnostics

Branch `wp/w19b-harness-logs`, cut from `integ/w00` at `27d957531` (the W19a merge head).
Evidence: `/tmp/factory-platform-evidence/w19b/`.

## Why

The W19a merge batch had one failed pass (a runner defect, now W01h), and the harness lost its
diagnostics: process output lived only in memory, and the stack directory was deleted when the pass
stopped. The pool and the supervisor print almost nothing to stdout or stderr; their own last word is
their readiness file in the stack directory, which went with it.

## What changed

- `scripts/factory-graph-proof/diagnostics.ts` (new): every process's output streams to
  `<label>.process-<name>.log` in the pass's output directory as it arrives, between a
  `[w19-harness]` header (command, pid) and an exit line (code or signal). A failed pass, and a
  failed start, copies the stack's `readiness/*.json` and `*.log` to `<label>.stack/` before the
  stack directory is deleted. `secrets/` is never copied.
- Nothing kept carries a secret. Every credential is collected first: each non-JSON file under
  `secrets/`, each value under a credential key in a JSON file there, each URL password, the
  database URL, and the web server's own secrets. A stack file carrying one is refused (recorded by
  path); a streamed log has each occurrence replaced by `[redacted]` (counted). The record keeps
  both under `diagnostics`.
- The in-memory tails and `<label>.server.log` are gone from the record; the streamed files replace them.
- A forced-failure control (`W19A_CONTROL=forced-failure`, mock mode) runs the whole proof, fails by a
  named check, and `verify-diagnostics.ts` proves what it left behind. `run.sh all` runs it;
  `summarize.ts` requires it.
- `docs/factory-graph-proof.md` says where each file is.

## Gates

- [x] G1: Every process log is streamed, non-empty, and ends with its exit line; every readiness file
  is carried out of a failed pass's stack.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 scripts/factory-graph-proof/run.sh all` (the forced-failure control and `verify-diagnostics.ts`)
  EXPECT: `control-forced-failure` fails by its named check; `control-forced-failure.diagnostics-check.json` `ok: true`; the seven process logs non-empty with exit lines; `readiness/pool.json`, `supervisor.json`, `orchestration.json` copied; no product database retained
  EVIDENCE: `receipts/campaign-2.json`, `proof/control-forced-failure.json`, `proof/control-forced-failure.diagnostics-check.json`, `proof/control-forced-failure.stack/`

- [x] G2: The proof itself is unchanged: both modes three of three, both W19a controls, summary passed.
  CHECK: the same campaign
  EXPECT: `summary.json` verdict `passed`
  EVIDENCE: `proof/summary.json`, `receipts/campaign-2.json`

- [x] G3: Nothing kept carries a credential, and configuration is not mistaken for one.
  CHECK: `bun test ./src/factory/graph-proof-diagnostics.test.ts`; `credential-scan.sh` over the tree and the evidence
  EXPECT: 8 pass; the scan finds none of the PostgreSQL password or the storage keys
  EVIDENCE: `receipts/cov-w19b.json`, `receipts/credential-scan.json`

- [x] G4: 100 percent of the new module; boundary suites; coverage gates against `27d957531`; static checks.
  CHECK: the coverage leg (`graph-proof-diagnostics`, `graph-proof-definition`, `factory-process-boundaries`); `BASE_REF=27d957531` new-file and patch gates; `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`, `bun scripts/gate-integrity.ts`
  EXPECT: `diagnostics.ts` 100 percent lines and functions in the leg; both gates exit 0 (they gate no file here: `scripts/factory-graph-proof/` is outside the coverage source globs); all static checks exit 0
  EVIDENCE: `receipts/cov-w19b.json`, `receipts/gate-*.json`, `receipts/final-*.json`

## History

Campaign 1 at `69ec1817f` (kept as `proof-campaign-1-69ec1817f/`): the streamed logs worked, but every
readiness file was refused and the Temporal namespace and a home path were redacted, because the
configuration documents in `secrets/` were collected as secrets. Fixed at `aea3e3ea1`: only
credentials are secrets.
