# Gates: W4G-9, the moderate and low advisories below the audit floor

Brief: the coordinator's order after W4G-3 (the 19 moderate and low advisories W4G-3 left: root esbuild, hono,
ip-address, qs, uuid, yaml; web cookie, dompurify, fast-uri, qs). Base integ/w00 `84a9ef717`, branch `wp/w4g-9`.
Evidence: `/tmp/factory-platform-evidence/w4g-9/`. Pinned Bun 1.4.2.
Rules: upgrade inside each parent's declared range, one commit per package per lockfile, no allowlist entry, no
package.json change; a package whose parent range admits no fixed version is not upgraded and is listed below with its
chain. The HIGH advisories at this base (brace-expansion, devalue, fast-uri at the root, undici) are W4G-3's.

| Package (lockfile) | Red (`bun audit` before) | Green (`bun audit` after, lockfile diff) | Commit |
| --- | --- | --- | --- |
| hono (root) | `logs/root-hono-before.log`: 4.13.0, four moderate (<4.13.5 three, <4.13.7 one) | `logs/root-hono-after.log` names no hono; 4.13.0 to 4.13.12; `root-hono-lockfile-diff.txt`: one line | this commit |
