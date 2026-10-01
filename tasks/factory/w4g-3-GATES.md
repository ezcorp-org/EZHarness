# Gates: W4G-3, undici advisories in web

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4g.md` (W4G-3). Base integ/w00 `842ad9fe1`, branch `wp/w4g-3`.
Evidence: `/tmp/factory-platform-evidence/w4g-3/`. Pinned Bun 1.4.2 (`use_pinned_bun`, pipelining flag set), Node 24.14.1.

| Requirement | Red | Green | Commit |
| --- | --- | --- | --- |
| (1) the three HIGH undici advisories (>=8.0.0 <8.10.2) in web | `logs/red-audit-deps.log` (the workflow's `bun scripts/audit-deps.ts`: 12 unallowlisted HIGH, three of them undici, root web); `logs/red-web-audit.log` | `logs/green-web-audit.log` names no undici; `logs/after-undici-audit-deps.log`: the three undici findings gone (12 to 9) | this commit |
| (2) fix inside jsdom's range, no allowlist entry | — | `bun update undici` in web: undici 8.10.0 to 8.11.2 (jsdom 30.0.1 requires ^8.9.0); `scripts/audit-allowlist.json` unchanged; `web/package.json` unchanged | this commit |
| (3) web legs | — | `bun install --frozen-lockfile` clean in web and at the root; typecheck 0 (`bun run typecheck`, all four legs); `bunx svelte-check --tsgo` 603 files, 0 errors, 0 warnings; web vitest 631 files, 7843 tests passed; web build exit 0 | this commit |
| (5) the lockfile diff | — | `lockfile-diff.txt`: one line in `web/bun.lock`, the undici entry's version and integrity | this commit |
| W (widened) brace-expansion in web | `logs/web-brace-expansion-before.log`: 5.0.9, high GHSA-qhr7-859c-m2p7 (>=4.0.0 <5.0.11), high GHSA-6j4f-fj2g-mc7p (>=4.0.0 <5.0.10), moderate GHSA-q2hr-2g5m-vwhr (>=4.0.0 <5.0.12) | `logs/web-brace-expansion-after.log` names no brace-expansion; `bun update brace-expansion` in web: 5.0.9 to 5.0.12 inside the parent's ^5.0.8; `web-brace-expansion-lockfile-diff.txt`: one line | this commit |
| W devalue in web | `logs/web-devalue-before.log`: 5.9.0, high (<=5.9.2) quadratic expansion in uneval, high (>=5.8.0 <=5.9.2) stringifyAsync unhandled rejection, high (>=5.1.0 <=5.9.2) shared memory, plus three moderate and one low | `logs/web-devalue-after.log` names no devalue; `bun update devalue` in web: 5.9.0 to 5.9.4 inside the parents' ^5.8.1; `web-devalue-lockfile-diff.txt`: one line | this commit |
| W brace-expansion at the root | `logs/root-brace-expansion-before.log`: 5.0.9, 2.1.4 and 1.1.18 (chains extension-contract > ts-json-schema-generator > glob > minimatch, and exceljs > archiver > archiver-utils > glob > minimatch), highs GHSA-qhr7-859c-m2p7 and GHSA-6j4f-fj2g-mc7p in each range, moderate GHSA-q2hr-2g5m-vwhr | `logs/root-brace-expansion-after.log` names no brace-expansion; `bun update brace-expansion`: 5.0.9 to 5.0.12 (^5.0.8), 2.1.4 to 2.1.7 (^2.0.1), 1.1.18 to 1.1.21 (^1.1.7, three entries); `root-brace-expansion-lockfile-diff.txt`: five lines, all brace-expansion | this commit |
| W fast-uri at the root | `logs/root-fast-uri-before.log`: 3.1.6 (extension-contract > ajv > fast-uri), high authority injection (>=3.0.0 <3.1.7), high host confusion (=3.1.6), moderate host case normalization (>=3.0.0 <3.1.8) | `logs/root-fast-uri-after.log` names no fast-uri; `bun update fast-uri`: 3.1.6 to 3.1.8 inside ajv's ^3.0.1; `root-fast-uri-lockfile-diff.txt`: one line | this commit |
| (4) the deps-audit workflow command passes (widened scope: every unallowlisted HIGH) | `logs/red-audit-deps.log`: 12 unallowlisted HIGH at 842ad9fe1 | `logs/green-audit-deps.log` at 4ded1fd9f: exit 0, "dependency audit clean at the high floor (0 allowlisted, 19 below floor)"; `scripts/audit-allowlist.json` unchanged | the five commits above |

## Final legs at the head (4ded1fd9f)

- `bun scripts/audit-deps.ts` (the deps-audit.yml command, pinned Bun 1.4.2, pipelining flag set): exit 0.
- Raw `bun audit` still exits 1 at the root and in web on 19 moderate and low advisories below the gate's floor
  (esbuild, hono, ip-address, qs, uuid, yaml at the root; cookie, dompurify, fast-uri 3.1.7's moderate, qs in web).
  They are outside the widened scope, which is every unallowlisted HIGH.
- Frozen installs clean at the root and in web. Typecheck 0 (all four legs) and lint 0. svelte-check: 603 files,
  0 errors, 0 warnings. Web build exit 0.
- Web vitest in the hosted job's shape (`scripts/web-vitest-coverage.sh`, three shards under Node): 211, 210 and 210
  files, 2604, 2727 and 2512 tests, all passed (631 files, 7843 tests).
- Root legs on the upgraded paths (glob, minimatch, ajv): extension-contract schema and validation tests, the
  factory-sdk schema test, the schema-generate drift test, the excel example tests: 81/0 over 10 files.
- Flake seen, not caused here: `web/src/__tests__/context-initialization.server.test.ts` fails 3 or 4 tests at the
  5-second default timeout when the whole suite runs in one process on a loaded host (load average 16 to 30). It
  passes alone 3/3, in all three hosted-shape shards, and failed equally at d01c26915, which passed earlier under
  lower load, so the timing follows host load, not these upgrades. Each test re-imports the real server context after
  `vi.resetModules()`. Follow-up for its owner: give the file an explicit test timeout or a lighter import.
