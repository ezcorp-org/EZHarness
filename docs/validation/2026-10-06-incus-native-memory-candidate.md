# Incus native memory candidate — 6 October 2026

This is candidate evidence for the isolated Incus deployment. Live qualification,
the ten-cycle run, negative controls and final CI remain release gates. This
document does not claim guest secret delivery, Infisical parity, independent
provider portability, or optional native CLI runtime support.

## Candidate

| Item | Exact value |
| --- | --- |
| Code revision | `2bde0375ef617fd0a529901b418c55c599bdfabb` |
| Bundle manifest | `ada643a7e46fc272d7d9edff34a5fe62fde8ff9eb5dbeb8cdff58db6d8974d04` |
| Native executable | 59,704 bytes; `be1051effa23cd55790a7ad070eded71f3702fe22c54fb8f56e0cd97c28c5247` |
| Prior installed code | `6d2572d9f179d14c9912618981be993accdc9219` |
| Prior manifest | `b8efab47997cc92b839586e0792e888c656a1d4ae98be6a94b8ec8ce3545c229` |
| Provider authority | Existing reviewed provider 0.1.5; generation 7; connection revision 1 |

The native program replaces the qualification test's memory load. It does not
change memory targets, process deadlines, required OOM evidence, bounded logs,
terminal-state checks, or host and neighbor health requirements. It uses the
existing 64 KiB guest file limit. No new guest image or provider release is needed.

## Source and bundle checks

- A clean rebuild reproduced the executable byte for byte. Five native tests
  passed, and GCC/gcov measured 129 of 129 executable C lines.
- Independent review passed the native program and 55 integration tests with
  645 assertions. The coverage integration guard passed 47 tests.
- The initial production bundle omitted the executable. Its actual built
  consumer failed with `ENOENT`. Revision `2bde0375e` fixes this by embedding
  the checked bytes in the server bundle. Six asset tests and full typecheck pass.
- Independent production-build inspection found the exact executable in the
  server bundle and no copy in the client bundle. The built consumer loaded
  the exact bytes under both UID 1001 and the app's UID 62040 through a mock
  guest transport. This check did not create a guest.
- The clean staged bundle passed its full manifest check and a separate
  non-root startup smoke with HTTP 200.
- The preceding revision `07a4bd4e5` passed the supported fast local gate:
  27,648 backend tests, 3,638 web Bun tests and 7,729 web Vitest tests, plus
  typecheck, lint, gate checks and build. The earlier run is not final-source
  coverage evidence.
- The later `2bde0375e` backend pool found two actual-Python fixture failures
  caused by a global fake clock affecting real subprocess waits. The isolated
  test correction passed all 88 tests in that file and independent review.
  The incomplete full gate was stopped; no full pass is claimed.
- The merged `cd5dedea1` backend pool exposed a separate raw-Bun source-loader
  failure: the native executable was parsed as JavaScript. The actual deployed
  server-bundle consumer works, but the source consumer still needs correction.
  Browser coverage also rejected progress-document changes in the integration
  worktree. The final combined gate must run in a clean, fixed worktree.

## Isolated installation

The update preflight and quiesce passed. Independent checks established a
separate database baseline with identical bytes and metadata, zero current
and global resource charges, and preserved historical compensation records.

The first maintenance wrapper timed out at 300 seconds after copying the new
bundle. It was not replayed. The old app remained installed, the separate new
directory was intact, and the database remained unchanged. Independent checks
confirmed that no copy or installer process remained and verified the new bundle.

A reviewed continuation reused the original swap function and omitted only
the completed copy step. It retained every original state transition, rename,
bundle check and database check, with durable progress receipts. Five tests
passed, including termination of a delayed child write on timeout. Its
900-second limit applies only to local package maintenance; sandbox test
deadlines remain unchanged.

The continuation passed in 615 seconds. Receipt:
`dc67d8069306ea463873bf7359a044fe4fe89bb334d220c48eb2d841edfa6732`.
Independent checks confirmed the new active bundle, retained old bundle,
absent temporary directory, and unchanged database. The startup preflight
also passed; receipt:
`0e9aa6d7abbd6451ea26d2e486fa7de8a80e50a1bb6029a880781465616a7e1e`.
Captured startup passed with no timeout; receipt:
`aacaa8a185d99f9944a846a9b157141a405d39fb8759c67ebc757b36437d46f5`.
Both isolated services are active, and health and readiness return HTTP 200.
The selected receipt and fault verifiers returned their exact readiness values,
with no error, timeout or truncation; receipt:
`8d04b1a09d83f19f529012e4d7064b01b9fd69575146059d2bc657e280f405b5`.
Independent authenticated reads confirmed generation 7, revision 1, the
verified setup and applied capacity.

Fresh probe plan and apply returned HTTP 200 and ready state. Qualification
`incus-final-native-release-20261006-39bebb58-2c28-4d88-95ac-e09d9f69d1a8`
was submitted once with a separate read-only resource collector. It returned
HTTP 202 at the restart boundary. The replacement app completed the run at
01:20:24 UTC on 7 October. A fresh authenticated management response reports
the exact Compose environment qualified through 02:20:24.741 UTC; receipt:
`4e5417bb3fb5f30e7feb5e7d586e38dbd471bf7639dda3ceb34bc28b3d7c57dc`.
Independent read-only status checks found all three qualification guests
ABSENT with successful DESTROY operations. The exact negative-control plan
was cleaned through the product; receipt:
`152bedef166b2265054ecd8d1aee02c3beaf946de48ed168ba97d8737aae9a1d`.
Fresh project-scoped and whole-server inventories are empty. A stopped,
detached database copy proves zero current and global charges, released
reservations and no unfinished provider work. Completion receipt:
`dd0c2e663e2a465ae1aa0a1edff4a32970223ab5167e38611625a52c4769dba0`.
Its projection result is:
`7f1b74665f73b4e2a4003f6fa91deb02b08f0e3e4e9655b4759ae3d3a8d47484`.
The live database bytes and metadata remained unchanged, all clone handles
closed, and the normal app resumed. Independent review passed these checks.

The diagnostic collector recorded the intended 4 GiB limit, zero swap and
one kernel OOM kill. It stopped when status became unavailable during the
restart. This diagnostic is not the qualification result and does not prove
resource absence by itself.

The integration branch has since merged main and its hook test correction
through `cd5dedea1`. Incus source is unchanged, but the MCP SDK dependency,
shipping checks and bundle closure differ. The live result above belongs to
installed revision `2bde0375e`; final branch checks must name their own revision.

## Remaining checks

The first ten-cycle attempt stopped during the hook's manifest check before
any API or subprocess call. Its old 1 MiB limit rejected the valid 15.9 MB
manifest. The blocked journal is retained. An independent no-effect replay of
the validation prefix confirms zero external calls; a corrected helper and
fresh sequence are required. No numbered feature cycle passed in that attempt.

- [x] Confirm healthy startup on the exact candidate and fresh verifier readiness.
- [x] Run the new qualification once, including actual resource and isolation controls.
- [x] Preserve its result, clean its fixtures, and prove zero charges and empty inventory.
- [ ] Complete ten real feature workflows with restart, retention, denial and cleanup recovery.
- [ ] Finish final-source local and hosted gates, update PR #303, and complete review.

The earlier successful native prototype used different bytes. Its server result
does not qualify this executable. Prior successful feature workflows do not
replace the remaining final-source tests.
