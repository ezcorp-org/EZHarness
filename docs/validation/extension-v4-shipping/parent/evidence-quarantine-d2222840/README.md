# Browser artifact quarantine: d2222840

Fourteen current-tree artifacts were moved to a private local quarantine: 11 raw
browser report/trace archives and three browser server-state JSON files. Their
original public paths, private local paths, SHA-256 values, and byte counts are
listed in `private-artifact-inventory.json`. The files were removed from the
current published tree and are private. All 11 raw archives already exist in
remote history at `86784b67`; the three server-state
JSON files do not. Seven of the raw archives were flagged by the expanded scan.
This action does not erase earlier repository history.

`parent-private-byte-verification.json` records the parent byte comparison against
the pre-quarantine staged tree. It confirms all 14 private originals and their
absence from the current published tree.

`failed-scan-safe-summary.json`, `scanner-config.sha256`, `scanned-head.txt`, and
`scanned-index-tree.txt` identify the failed expanded scan without copying its raw
findings, raw logs, or member payloads. Safe PNG evidence and existing non-browser
source/SDK archives remain published.
