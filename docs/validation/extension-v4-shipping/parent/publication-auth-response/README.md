# Publication receipt — auth response

Successful retry receipt: `.cache/terra-shipping/parent/publish-auth-response-retry-20260907T2155Z`.
Published commit: `0733ca51daf570227bd801b14991700ad0ca0c12`.

The retry ran from 2026-09-07T21:54:17.983925Z through 2026-09-07T21:56:56.783003Z. Normal hook, authored-whitespace, checksum, commit, push, outer controller, expanded scan, exact-index scan controller, and exact-index cleanup all exited 0. The exact scan returned `[]` findings.

The exact scanned index tree is `dc7f9056855707518f0d02b299b47422811f765e`; it equals the published commit tree. `feat/extension-v4` was at `8ae7f0860728741c0918729452a8ec846cf6ed29` before publication and at the published commit afterward. The scanner reported approximately 5,051,851,928 bytes (5.05 GB) scanned in 1m29.6s.

The first attempt failed before commit or push. It found two false positives where generic API-key detection matched source SHA-256 strings in the auth-response evidence index. The retry used a format-only JSON conversion; it added no scanner exception. `metadata/first-scan-failure.json` preserves this classification without finding values.

All copied logs, exits, identity files, and empty findings are byte-exact safe receipt data. Raw archive inputs and `expanded-inputs.json` remain private. `metadata/raw-mapping.json` maps every copied file to its private source hash and path; scanner source is linked only by hash.
