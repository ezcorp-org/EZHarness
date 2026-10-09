# Isolated app updated; sandbox recovery remains pending

The guarded update installed source
`301e88e9316447881abf00006eea4b42c25ccb08` in the isolated app. Startup and
health checks passed. This does not establish sandbox qualification or a full
feature workflow pass.

The build fixes pre-transport failure classification and persists a once-only
dispatch timestamp. It also adds signed reconciliation for a retained DELETE
outcome, with ordinary cleanup after that proof. The saved live outcome has
not yet been reconciled.

## Build and update evidence

- Fresh pinned-Bun builds, bundle verification, dependency checks and non-root
  health smoke passed. Manifest SHA-256:
  `5aa56f6f6a741d2aa2f92b2424d8a7363a2499b48ef7d0214d0000d1ccab0b88`.
- The exact combined source passed typechecking. Focused source tests,
  independent review, changed-line coverage and complexity checks passed.
  Full final-source repository and browser gates remain open.
- Independent review approved the exact guarded update within the continuing
  authorized task. Installer SHA-256:
  `85c22b497c3c4e27180bab69aed6a93748c2cf9306d963f400dfee8d7b6662a1`.
- Actual read-only preflight, quiesce, swap preflight, one swap, start
  preflight and one start each exited 0. The old 508 build remains available
  for rollback. No database restore occurred.
- Fresh stopped-copy accounting before and after the swap matched. The two
  projection hashes are
  `a158331bfb352fe4fdd014cabe75a7897ad798320a42600c8a3ea181232bce76`
  and `fffc381499676842245598e7bbb29db9bb893a3ab14317daf0d9fd0032ccdd94`;
  their semantic accounting data is equal. This comparison precedes startup
  and migration; it is not a claim that database bytes never change on startup.
- Receipts 315–317 confirm the saved cleanup remains UNKNOWN, management
  responds successfully, the installed source and manifest match, and the
  five original configurations remain unchanged.
- Independent post-update review passed. Receipt 318 finds only the same
  stopped guest. Historical-operation and reservation proofs are from the
  stopped snapshots before startup. The next guarded clone must directly
  recheck those facts after migration before signed recovery starts.

Cleanup `8720a719-b3cd-44d7-a00d-5a57f4262fca` still has no provider handle.
Its binding remains STOPPED. The stopped snapshots show memory and disk
RESERVED, and the older 069/8157 history preserved and released. No sandbox was created, started or
deleted by this update. Signed reconciliation, real cleanup, diagnosis of the
earlier resource-load timeout, qualification and feature workflow proof remain
required.
