# SDK tarball transport evidence

The canonical backend controller at source `adbba8a693cdcd4410c51023dfca93517f9db1e8`
reproduced the SDK tarball hook timeout. The runner probe passed. Coverage exited 1
only because `packages/@ezcorp/sdk/test/integration/tarball.test.ts` timed out at
120002.85 ms. Residual, new-file coverage, and patch coverage exited 0. The failed
coverage run has no authoritative LCOV result; its LCOV copy was skipped.

The monitor began after the 1555-file host pool and recorded the tarball `bun add`
child in `do_epoll_wait`. The safe snapshot records its fixture working directory,
FD classes, and only named non-secret environment values. It deliberately omits
network addresses, request contents, and all raw environment data. The local raw
receipt remains at:

`.cache/terra-shipping/backend/final-sdk-monitored-adbba8a6-20260907T051254Z`

The focused replacement proof retains packed SDK and extension-contract tarballs,
then registers each exact resolved direct dependency from those package manifests
in a temporary `BUN_INSTALL` directory. Its install uses the closed registry
`http://127.0.0.1:9`; success therefore proves this fixture did not request the
public registry. It does not test public registry availability or a fresh public
registry dependency graph. The focused command exited 0 with one passing test.
Its local raw receipt is:

`.cache/terra-shipping/backend/sdk-tarball-offline-all-direct-adbba8a6-20260907T054230Z`

The canonical SDK coverage leg was then run with `CONMON=/tmp/ez-audit-ci-conmon`
and `EZCORP_RUN_PODMAN_TESTS=1`. It passed 1029 tests across 55 files with exit 0.
The receipt includes its command, complete output, provenance, and the size and
SHA-256 digest of its generated LCOV file. The raw LCOV stays in the local receipt.
