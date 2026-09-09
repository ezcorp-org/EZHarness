# Hosted browser review — first attempt

Head: `0733ca51daf570227bd801b14991700ad0ca0c12`  
CI run: `34164945893`

Valid terminal results:

- E2E mock: 255 passed, 13 skipped; zero structured `hooks.server` 500 records.
- Firefox lifecycle: 3 passed.
- WebKit lifecycle: 3 passed.
- Visual evidence: 191 passed, then 13 passed; zero structured `hooks.server` 500 records. Its single structured 404 is the deliberate `/this-route-does-not-exist` hydration-marker control.
- Web Bun: 4,084 passed, zero failed, 220 files.
- Component Vitest: shard test totals 2,415, 2,418, and 2,314; all terminal-success.
- Web security: terminal-success.
- E2E real auth: failed before the third setup test body because Chromium crashed during Playwright context creation. See `failure/real-auth-context-crash.txt`.

`metadata/raw-input-mapping.tsv` maps every private job log and the private real-auth artifact to byte count and SHA-256. Raw logs, browser traces, archives, cookies, screenshots, and auth state are excluded.

This is the first attempt only and is separate from any later rerun.
