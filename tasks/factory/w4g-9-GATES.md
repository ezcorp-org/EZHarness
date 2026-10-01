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
| ip-address (root) | `logs/root-ip-address-before.log`: 10.4.0, four moderate (<=10.5.0) | `logs/root-ip-address-after.log` names no ip-address; 10.4.0 to 10.7.2; `root-ip-address-lockfile-diff.txt`: one line | this commit |
| qs (root) | `logs/root-qs-before.log`: 6.15.3, two moderate (<=6.15.3, <6.16.0) | `logs/root-qs-after.log` names no qs; 6.15.3 to 6.16.0, same dependencies; `root-qs-lockfile-diff.txt`: one line | this commit |
| dompurify (web) | `logs/web-dompurify-before.log`: 3.4.13 (isomorphic-dompurify > dompurify), one low (>=3.4.13 <=3.4.15) | `logs/web-dompurify-after.log` names no dompurify; 3.4.13 to 3.4.16 inside ^3.4.12, same dependencies; `web-dompurify-lockfile-diff.txt`: one line | this commit |
| fast-uri (web) | `logs/web-fast-uri-before.log`: 3.1.7, one moderate (>=3.0.0 <3.1.8) | `logs/web-fast-uri-after.log` names no fast-uri; 3.1.7 to 3.1.8 inside ^3.0.1; `web-fast-uri-lockfile-diff.txt`: one line | this commit |

## Not upgraded: the parent's declared range admits no fixed version (for the user)

| Package (lockfile) | Installed | Fixed in | Chain and the range that holds it | Advisory |
| --- | --- | --- | --- | --- |
| yaml (root) | 2.8.2 | >= 2.8.3 | workspace `@ezcorp/factory-sdk` > yaml, declared exactly `2.8.2` in packages/@ezcorp/factory-sdk/package.json (a package.json change, outside this package's rules) | moderate, stack overflow via deeply nested collections (>=2.0.0 <2.8.3) |
| uuid (root) | 8.3.2 | >= 11.1.1 | exceljs 4.4.0 > uuid `^8.3.0` (the 11.1.1 copy under @temporalio/client is already fixed) | moderate, missing buffer bounds check in v3/v5/v6 (<11.1.1) |
| esbuild (root) | 0.18.20 | >= 0.24.3 | drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils 3.3.2 > esbuild `~0.18.20` (the 0.25.12 and 0.28.1 copies are outside the range) | moderate, the development server answers any website (<=0.24.2) |
| cookie (web) | 0.6.0 | >= 0.7.0 | @sveltejs/kit > cookie `^0.6.0` | low, out-of-bounds characters in name, path and domain (<0.7.0) |
| qs (web) | 6.15.1 | >= 6.16.0 | @stryker-mutator/core > typed-rest-client > qs, declared exactly `6.15.1` | moderate x3 (array-limit bypass, isBuffer DoS, stringify TypeError) |

Covered by W4G-3, not here: fast-uri's moderate at the root (W4G-3 moves it to 3.1.8) and undici's moderate in web
(W4G-3 moves it to 8.11.2). A `bun update esbuild` moved only the unaffected tsx copy (0.28.1 to 0.28.2, 27 entries) and
fixed nothing, so it was reverted rather than committed.
