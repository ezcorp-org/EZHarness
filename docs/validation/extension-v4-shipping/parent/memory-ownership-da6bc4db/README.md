# Memory ownership checkpoint — da6bc4db

This is a safe evidence checkpoint for final memory-ownership source
`da6bc4db6326696347d76a2225677954b31d3a2b` (tree
`be66104272e97354db0f54d8aa5e614ddff5d0ba`). It contains summaries, exact
private-artifact hashes, inert input copies, and two parent-opened UI images.
It does not contain raw logs, browser archives, credentials, database state, or
authentication state.

## Red and green behavior

- Query-boundary red: exit 1; 2 passed and 1 failed. A member list omitted
  `derived-owner`.
- Query-boundary green: exit 0; 4 passed, 0 failed, and 11 assertions.
- Item-route red: exit 1; 6 passed and 2 failed. A conversation owner received
  404 for a derived memory item.
- Final validated run: exit 0. Parent review records 45 backend passes (8 real
  integration and 37 H3), 119 assertions, 17 web PATCH passes, and all
  typecheck sections passed. `metadata/parent-review.json` is authoritative.

## Final static source check

The retained static controller ran with HEAD
`aa2485639e052569f997a30ff36a93d3436e1daa` and ten uncommitted changed files.
It exited 0; those ten files were then committed unchanged in `da6bc4db`. Its four checks all
exited 0: typecheck, lint boundaries, manifest lock, and authored whitespace.
The ten retained inputs are byte-equal to final commit `da6bc4db`; see
`metadata/committed-input-verification.json` and
`metadata/final-input-check.txt`. Copied inputs are inert `.txt` files.

## Browser evidence

- First real-auth run: exit 1 because a strict locator matched both the collapsed
  preview and the expanded paragraph. This checkpoint keeps its private-log hash only.
- Rerun: exit 0 with 3 passed tests. Parent review records matching source
  inputs, a copied private blob hash, unchanged fixture inventory, and absent
  auth state before and after. It includes the member-scoped denial flow.
- Theme run: exit 0 with 3 passed tests and 6 byte-verified PNG attachments. The two selected
  parent-opened light and dark memory-owner images are in `browser-images/`.
  Its recorded post-run source delta only widened `baseURL` from `string` to
  `string | undefined`; the later static controller passed.
- The focused theme controller recorded no cleanup inventory. This checkpoint
  makes no cleanup claim for it. A complete browser controller owns cleanup
  verification.

Raw browser logs and archives stay private. `raw-hashes/` gives their private
paths, byte counts, and SHA-256 values without publishing content.
