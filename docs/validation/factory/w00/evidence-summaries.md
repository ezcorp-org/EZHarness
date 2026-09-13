# W00 evidence curation summary

Scope: files named in `docs/plans/2026-09-13-composable-factory-platform-completion.md`
section 2, plus receipts cited by `tasks/factory/run-controls-GATES.md` at `b6cfa4798`
and the Terra C02 note in `tasks/todo.md` at `6c500113a`. Integration head checked:
`33cab8657` (composable-factory-platform).

All checks below use `git merge-base --is-ancestor <commit> 33cab8657`.

## Task 1 — Curated files

### Quick reference

| # | Path | Bytes | SHA-256 | Head(s) recorded inside | Head in integration branch? | Verdict |
|---|------|------:|---------|--------------------------|------------------------------|---------|
| 1 | root-package-outcome-partition-merge-combined-integration-results.json | 5197 | bfbaff3a…7f4a2 (see JSON) | `57751b80b` | Yes | PASS — 10/10 checks exit 0 |
| 2 | root-protected-effects-parent-combined-integration-results.json | 4253 | 13f9dbe8… | `84cfd2a99` | Yes | PASS — 6/6 checks exit 0 |
| 3 | root-protected-effects-parent-coverage-results.json | 1604 | 026af4ea… | `84cfd2a99` (product, postgres); `57751b80b` (sdk, node); base `644987ada` | Yes (all three) | MIXED — merge & new-file exit 0; **patch exit 1** |
| 4 | root-protected-effects-parent-coverage-patch.log | 567 | 38048461… | none embedded; same run as #3 | Yes, by association | FAIL (expected) — 3 files with uncovered changed lines |
| 5 | root-provider-receipt-parent-combined-integration-results.json | 1984 | f1f0f938… | `1ba2b6763` | Yes | PASS — 6/6 checks exit 0 |
| 6 | root-provider-receipt-s3-live.json | 266 | 9e2d6d43… | none embedded | N/A | PASS — 10 publish/verify, 40 forged-receipt rejections |
| 7 | root-github-transport-committed-coverage-results.json | 214 | bc7cc1c0… | `bd36bd7fa` | **No** | PASS at branch level only — parent checks not yet run |
| 8 | sol-run-controls-postgres-s3.log | 4501 | 6978d432… | none embedded; receipt of GATES.md at `b6cfa4798` | **No** | PASS — 43 pass / 0 fail / 635 assertions |
| 9 | sol-control-authority-checkpoint/temporal-replay-corrected.log | 4164 | 54b0d9f0… | none embedded; receipt of GATES.md at `b6cfa4798` | **No** | PASS — 1 pass / 0 fail (canonical Node replay) |
| 10 | sol-run-controls-final-cov.path (+ envB3F LCOV dir) | 65 | 97ee945c… | none embedded; receipt of GATES.md at `b6cfa4798` | **No** | PASS — all 6 GATES.md coverage numbers verified exactly |
| 11 | terra-c02-attempt-runtime-coverage/lcov.info | 825271 | 79d6c05d… | none embedded; receipt of Terra note at `6c500113a` | **No** | PASS — 177/177 and 9/9 verified exactly |
| 12 | assembled-platform-results.json | 2686 | bbfce2d3… | `8a21a81d9` | Yes | PASS — 7/7 checks exit 0 |
| 13 | attempt-token-final-results.json | 2183 | 3df22aeb… | `8a000803300` | Yes | PASS — 8/8 checks exit 0 |
| 14 | assurance-integrated-results.json | 1458 | c8cd3e51… | **none recorded — gap** | Unknown | PASS test-wise; provenance gap |
| 15 | authoring-integration-results.json | 840 | bc422ac4… | **none recorded — gap** | Unknown | PASS test-wise; provenance gap; earlier attempt failed |
| 16 | terra-c02-command-postgres-s3.log | 877 | 85c6131f… | none embedded; same Terra C02 checkpoint | **No** | PASS — 7 pass / 0 fail / 31 assertions |
| 17 | terra-c02-postmerge-types.log | 302 | 71363350… | none embedded | **No** | PASS — typecheck clean |
| 18 | terra-c02-command-coverage.log | 1760 | 685b771b… | none embedded | **No** | PASS — 15 pass / 0 fail / 61 assertions |
| 19 | terra-c02-command-types-lint.log | 6952 | 4161e926… | none embedded | **No** | PASS — typecheck clean; lint 0 errors, 8 infos |
| 20 | terra-c02-command-coverage.lcov | 829852 | 50912318… | none embedded | **No** | PASS-shaped data; see note below |

Full 64-character SHA-256 values are in `evidence-checksums.json`; the table above
shows a short prefix so the table stays readable.

### Detail notes, file by file

**1–2 — package-outcome-partition-merge and protected-effects parent (`57751b80b`, `84cfd2a99`).**
Both files list `bun` commands (sdk build, focused suite, PostgreSQL/S3 suite, types,
lint, gate-integrity, boundaries, plus SDK-only build/test and orchestrator build for
file 1). Every entry has `exitCode: 0`. Both heads are ancestors of `33cab8657`. These
two match the plan text in section 2 word for word.

**3 — protected-effects coverage.** This file is a provenance + checks wrapper, not a
raw test run. It cites four coverage producers (product, postgres, sdk, node) and three
gate checks: `merge` (pass), `new-file` (pass), `patch` (**fail**, base `644987ada`,
which is also an ancestor of the integration head). The plan's own text says to
"preserve the failure and prove its correction after integration" — this record is
that preserved failure, not a bug in curation.

**4 — the patch-coverage failure log.** Plain text, no JSON, no commit hash. Names three
files with uncovered changed lines: `kernel-types.ts` (no LCOV data at all — needs a
test or an explicit exclude), `kernel.ts` line 1396, `command-authority.ts` line 128.
Any task note that marks protected-command-effects "fully covered" without a newer,
passing patch-coverage record is stale.

**5–6 — provider receipt parent and S3-live.** File 5's head (`1ba2b6763`) is an
ancestor of `33cab8657`; all 6 checks pass. File 6 has no head field but its numbers —
10 tenants, 10 publications, 10 archives, 3 foreign denials, 10 verified receipts, 40
rejected forged receipts, endpoints `127.0.0.1:18333`/`18334`, `failureDomain:
"same-host-not-independent"` — match the plan's description exactly, including the
explicit same-host caveat (this is not an independent-provider proof).

**7 — GitHub transport coverage.** Head `bd36bd7fa` is **not** an ancestor of
`33cab8657`. The plan itself says "parent checks remain" for this work — the branch
passed its own patch/new-file checks, but nobody has yet proven it against the
integration parent. Treat any claim that GitHub publication is "done" as unverified
until a parent-level result exists.

**8–10 — Sol run-controls receipts (GATES.md at `b6cfa4798`).** `b6cfa4798` is **not**
an ancestor of `33cab8657`, so this whole GATES.md checkpoint is unmerged. Its three
receipts hold up on their own terms, though:
- File 8 matches GATES.md's claim of "PostgreSQL/S3 lifecycle … 43 passed, 635
  assertions" exactly (43 pass, 0 fail, 635 `expect()` calls, one file, 18.09 s).
- File 9 matches "Canonical real Temporal repair replay: 1 passed" exactly (Node test
  runner: 1 pass, 0 fail). A sibling `temporal-replay.log` (no "-corrected" suffix)
  also exists in the same directory — GATES.md explains this is the earlier ad hoc
  Bun-covered full-suite run that timed out on one long case; the corrected file is
  the canonical one and was not rerun after that fix.
- File 10 is a pointer (`sol-run-controls-final-cov.envB3F`). That directory holds two
  merge stages (`merged.lcov`, `merged-final.lcov`) and per-component LCOV
  (`sdk`, `sdk-final`, `backend`, `backend-final`, `web`, `orchestrator`,
  `orchestrator-validation`). All six coverage lines GATES.md cites were checked
  against `merged-final.lcov` and match exactly:
  `run-controls.ts` 70/70, `transition-authority.ts` 40/40, `run-inputs.ts` 32/32,
  `run-lifecycle.ts` 235/235, `client.ts` 86/86, `_shared.ts` 231/231.
  One housekeeping note: `orchestrator/lcov.failed` is an earlier orchestrator
  coverage pass that still included `dispatcher.ts` and `worker.ts`; the corrected
  `orchestrator-validation/lcov.info` (without those two files) is what feeds
  `merged-final.lcov`. This does not affect the six cited numbers.

**11 — Terra C02 attempt-runtime coverage.** No head field (raw LCOV). Both figures the
Terra note cites are exact: `src/factory/runner/attempt-runtime.ts` 177/177,
`src/db/migrations/add-factory-attempt-launches.ts` 9/9. The Terra checkpoint commit
`6c500113a` is **not** an ancestor of `33cab8657` — matches the plan's statement that
this checkpoint plus uncommitted fixes needs to be committed and rerun. Factory-scoped
LF/LH pairs for the rest of this LCOV file (SDK, migrations, extensions, boot) are in
`evidence-checksums.json` under this file's entry.

**12–13 — assembled-platform and attempt-token final.** Both carry a `revision`/`head`
field on every entry (`8a21a81d9…` and `8a000803300…`), both ancestors of `33cab8657`,
all checks exit 0. These are the cleanest-provenance files in the set.

**14 — assurance-integrated-results.json.** **Gap:** none of its five entries carry a
head or revision field, only `finishedAt` timestamps (2026-09-13T06:47–06:48Z). The
companion `assurance-integrated.log` independently confirms 21 pass / 0 fail / 67
`expect()` calls across 4 files, which matches the JSON's `assurance-integrated` entry.
The test result is real; the commit it was run against is not recorded anywhere in
this file. This is exactly the kind of hole section 2 of the plan asks W00 to flag.

**15 — authoring-integration-results.json.** Same gap: no head/revision field on any of
its four entries. A companion file, `authoring-integration-attempt1-results.json`,
records an **earlier attempt** where `authoring-browser` (the Playwright e2e spec)
**failed** (`exitCode: 1`, finished 07:46:56Z); the final file's `authoring-browser`
entry passes (`exitCode: 0`, finished 07:50:44Z) — a genuine retry-until-green, not a
fabricated result, but worth knowing the first attempt is on file.

**16–20 — remaining terra-c02-* files.** None carry a head field. They read as a
consistent, passing snapshot for the same C02 checkpoint family: PostgreSQL/S3 (7
pass / 31 assertions), post-merge typecheck (clean), a second coverage suite (15 pass
/ 61 assertions), a combined types+lint pass (typecheck clean; Biome: 0 errors, 8 info
findings, 4805 files checked — this matches GATES.md's "lint passed with eight
existing information findings and no errors" exactly, and confirms the lint run is
repo-wide, not factory-scoped, so those 8 infos are pre-existing and unrelated to
factory code). File 20, `terra-c02-command-coverage.lcov`, is a **different** coverage
snapshot from file 11 (`terra-c02-attempt-runtime-coverage/lcov.info`) — e.g.
`kernel.ts` shows 13/939 lines here versus 14/1085 there — these are two distinct
command-controls test runs under the same `terra-c02-` naming prefix, not duplicates
of one another. Do not treat one as a redundant copy of the other.

## Task 2 — Redaction scan

### Real secrets found

1. **`/run/user/1001/ezcorp-factory-storage.4m3wJHaP/{archive.json,ordinary.json}`**
   and **`/run/user/1001/ezcorp-factory-storage.8yWJyCIQ/{archive.json,ordinary.json}`**
   — each holds 10 tenant identities with a live `accessKey`/`secretKey` pair for a
   local S3-compatible store (matches the two endpoints named in
   `root-provider-receipt-s3-live.json`, `127.0.0.1:18333`/`18334`). Real credential
   material, not a placeholder. Values shown as first 4 characters only, e.g. one
   `secretKey` begins `<redacted>`. Confirmed by search: **these values do not appear
   anywhere under `/tmp/factory-platform-evidence`** — evidence files reference only
   the directory *path*, never its contents. Exposure is also bounded by filesystem
   permissions: the parent `/run/user/1001` is mode 700 (owner-only), so the more
   permissive 755/644 modes inside it are not reachable by another user.
2. **`postgres.env`** — `POSTGRES_PASSWORD=<redacted>` (real value, shown truncated here).
   Confirmed by search: this exact value **does not appear in any other file** under
   `/tmp/factory-platform-evidence`.

### Likely false positives

- **`ezcorp:ezcorp@127.0.0.1:5432`** — appears in 3 files (`root-authority-restart-red.log`,
  `root-boot-phases-integration-focused.log`, `root-migration-restart-focused.log`).
  This is a literal, hardcoded string baked into a source warning message (a
  developer hint: "set `DATABASE_URL=postgres://ezcorp:ezcorp@127.0.0.1:5432/ezcorp`
  for local dev"), not a value pulled from a live secret store. It is a real
  plaintext username/password pair, but it is a known, static, local-only default —
  flagged below as "needs human look" out of caution rather than closed out silently.
- **`jwtSecret: "test-secret"`** (`attempt-token-purpose-red.log`) and
  **`allocationToken: "first-allocation"` / `"snapshot-allocation"`**
  (`root-budget-allocation-red.log`) — literal test-fixture constants in test source,
  not real credentials.
- **`accessKeyId: "ordinary-id", secretAccessKey: "ordinary-secret"`**
  (`root-provider-receipt-final-source.json`, `root-provider-s3-verification-red.log`)
  — literal placeholder test-fixture values, not real AWS-style keys.
- **Temporal task tokens**, e.g. `Token: 'AAdkZWZhdWx0…'` (dozens of hits across
  `terra-*-temporal-replay*.log`, `*-node-coverage/test-progress.log`, and similar).
  Decoded, these are protobuf-framed local workflow routing tokens (namespace
  `default`, a workflow ID, a run-ID UUID) — internal addressing for the local test
  Temporal server, not access-granting secrets.
- **`SF:` path names** inside the two large LCOV files that contain "password",
  "secret", or "token" as part of a *filename* (e.g. `src/auth/password.ts`,
  `src/extensions/secrets-store.ts`, `src/extensions/webhook-secret.ts`,
  `src/db/queries/extension-secrets.ts`) — these are source-file paths being measured
  for coverage, not secret values.
- **Long hex strings matching the base64 character class** (SHA-256 content hashes in
  `initial-manifest.json` and similar) — these are commit/content digests, not
  encoded key material. None of the ~330 base64-shaped strings found evidence-wide sit
  next to a key-like field name.
- The ~2,900 bare, unqualified hits for "password" / "secret" / "token" across roughly
  300 files evidence-wide are, on sampling, overwhelmingly domain vocabulary: this
  system's own nouns are things like `factory-service-token`, `attempt-token`,
  `service-credentials`, `webhook-secret` test names and file names. No AKIA-style AWS
  key, `ghp_`/`github_pat_` GitHub token, PEM/`-----BEGIN`/`PRIVATE KEY` block, or
  `Bearer <value>` literal was found anywhere in the ~1,400-file evidence root.

### Needs human look

- The 3 files carrying the hardcoded `ezcorp:ezcorp@127.0.0.1:5432` local-dev default
  (listed above) — almost certainly an intentional, low-risk developer default, but a
  human should confirm this default was never meant to guard anything beyond a local
  loopback database before it is copied into any public-facing doc.

### None of the 20 curated files (Task 1 list) contain a real secret

Every curated file was searched individually for all listed patterns. The only hits
inside the curated set are the false-positive class above (test-fixture strings,
`SF:` filenames, and domain-vocabulary words like "token"/"password" in coverage
directory names such as `attempt-token-auth-coverage`). No curated file contains an
access key, a private key, a live password, or a `user:pass@` URL.

## Task 3 — Copy readiness

**Safe to copy into `docs/validation/factory/` as-is (no redaction needed):**
All 20 curated files listed in the Task 1 table (#1–20), including both large LCOV
files and the `sol-run-controls-final-cov.envB3F` directory. None contain real
secret material.

**Needs redaction or a human decision before copying:** none of the 20 curated files.
The only redaction-relevant material found in this whole exercise — the S3
access/secret keys in `/run/user/1001/ezcorp-factory-storage.*` and the PostgreSQL
password in `postgres.env` — lives **outside** the curated set and outside the
evidence root entirely, and was confirmed not to have leaked into any curated or
non-curated evidence file. Do not copy `postgres.env` or anything from
`/run/user/1001/ezcorp-factory-storage.*` into the repository; they were not part of
the requested curation list and are live local credentials, not evidence artifacts.
