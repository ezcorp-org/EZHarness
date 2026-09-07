# File Organizer action-authority validation evidence

Integrated source commit: `6c05453edbb4148d53cbc37b67d05907b5459c67`.

This directory contains focused File Organizer test, typecheck, and normalized coverage receipts. It has no request credentials, session data, or raw authorization traces.

## Results

- `direct-pdp-final-23-tests-87-assertions.log`: real non-bundled PermissionEngine/DB authority suite, 23 passing tests and 87 assertions.
- `real-route-final-18-tests-93-assertions.log`: authenticated event-route/applier suite, 18 passing tests and 93 assertions.
- `access-components-84-tests.log`: web access-component suite in the precursor worktree, 84 passing tests with bytes matching the integrated commit.
- `integrated-typecheck.log`: integrated backend, web, backend-test, and web-e2e typechecks passed.
- `file-organizer-runtime-coverage.lcov`: normalized runtime coverage for the three changed File Organizer runtime files. Each has full line coverage: applier 393/393, events 120/120, state 462/462.
- `file-organizer-action-authority-coverage.lcov`: parent focused helper coverage, 83/83 lines and 23/23 functions.

## Source provenance

The following backend/helper files have identical SHA-256 bytes in the precursor File Organizer worktree and the integrated commit above. The hashes below are calculated from committed integrated blobs and checked against both worktrees.

- `src/extensions/file-organizer-action-authority.ts`: `217a975191ebbd94ed3140d047901060ebbbf7c259fe9abbe15c7dfdbd009715`
- `src/extensions/file-organizer-applier.ts`: `6c0ffde4a0c1b68ea8ac86d2969dae102fceb4ceeb888e67c75fc27695df3f4c`
- `src/extensions/file-organizer-events.ts`: `e68ffcc6c1a0a5fff17cb630b07be03f77ce37b44e33a734e5f389d077512d23`
- `src/extensions/file-organizer-state.ts`: `f4c0ecd63cb89024d3c873ac39d26e4d34d32304fe8b1dce9a113dcaf377c2ef`
- `src/extensions/permission-engine.ts`: `897fa21234502cb7fc0df8e5edbb87af459cf23be94b8d3587ca100608fe487c`
- `src/extensions/file-organizer-action-authority.test.ts`: `30223d1191cd7d694ba02d0496caf6252ba0694b1d55548f7e42bfb82f993009`

The parent independently compared the tested UI, UI test and route test bytes with the integrated commit; `ui-source-equivalence.json` retains those hashes. The component tests ran in the precursor worktree. The typecheck ran in the integration worktree before committing those unchanged source bytes.

## Pre-repair reproduction

`prior-consent-red-pre-repair-wip.log` is deliberately retained as a pre-repair WIP failure record. It reproduced the prior always-allow replay defect before the integrated repair; it is not a result from commit `6c05453edbb4148d53cbc37b67d05907b5459c67`.
