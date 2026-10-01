# Gates: W4G-3, undici advisories in web

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4g.md` (W4G-3). Base integ/w00 `842ad9fe1`, branch `wp/w4g-3`.
Evidence: `/tmp/factory-platform-evidence/w4g-3/`. Pinned Bun 1.4.2 (`use_pinned_bun`, pipelining flag set), Node 24.14.1.

| Requirement | Red | Green | Commit |
| --- | --- | --- | --- |
| (1) the three HIGH undici advisories (>=8.0.0 <8.10.2) in web | `logs/red-audit-deps.log` (the workflow's `bun scripts/audit-deps.ts`: 12 unallowlisted HIGH, three of them undici, root web); `logs/red-web-audit.log` | `logs/green-web-audit.log` names no undici; `logs/after-undici-audit-deps.log`: the three undici findings gone (12 to 9) | this commit |
| (2) fix inside jsdom's range, no allowlist entry | — | `bun update undici` in web: undici 8.10.0 to 8.11.2 (jsdom 30.0.1 requires ^8.9.0); `scripts/audit-allowlist.json` unchanged; `web/package.json` unchanged | this commit |
| (3) web legs | — | `bun install --frozen-lockfile` clean in web and at the root; typecheck 0 (`bun run typecheck`, all four legs); `bunx svelte-check --tsgo` 603 files, 0 errors, 0 warnings; web vitest 631 files, 7843 tests passed; web build exit 0 | this commit |
| (5) the lockfile diff | — | `lockfile-diff.txt`: one line in `web/bun.lock`, the undici entry's version and integrity | this commit |
| (4) the deps-audit workflow command passes | — | NOT YET: 9 HIGH advisories published after the hosted run remain (brace-expansion at the root and in web, fast-uri at the root, devalue in web). The coordinator decides whether W4G-3 also fixes them. | — |
