# First merged-backend checkpoint: `aa248563`

This is a failed historical full-backend checkpoint for merge commit
`aa2485639e052569f997a30ff36a93d3436e1daa`, tree
`aa18ac61ab491d110af8f98209491fa208f00bfd`. It is not a green backend result.

## Terminal result

The outer controller exited 1 after 582 seconds. The backend coverage command
exited 2 because its pass/fail-set contained one real failure. Its isolated,
plain rerun failed too, so this was not treated as a pooled-only failure:

- `src/__tests__/memory-list-derived-owner.integration.test.ts`
- Expected the owner list to contain `derived-owner`; received only
  `direct-owner`.

The coverage threshold computation itself passed: 1,260 enforced files met
their thresholds. Since the test result failed, no authoritative LCOV copy was
made (`lcov-copy` is explicitly `skipped-after-coverage-failure`).

## Recorded checks

| Check | Exit | Result |
| --- | ---: | --- |
| Extension runner probe | 0 | Kernel controls verified |
| Coverage producer | 2 | 26,028 pass, 1 fail, 1,563 shards |
| Residual tests | 0 | 179 pass, 0 fail, 15 files |
| New-file coverage | 0 | 134 new source files gated |
| Patch coverage | 0 | 392 changed executable files covered |
| Authored whitespace | 0 | No reported whitespace error |

The coverage output separately records SDK: 1,018 pass, 0 fail, 55 files; and
component Vitest: 4,706 pass in 291 files. These are constituent leg results,
not sums that can be added to the aggregate 26,028 count. Other package leg
counts are intentionally omitted here because this checkpoint is failed and
its aggregate accounting is controller-owned.

## Provenance and limits

- Started: `2026-09-07T15:11:02Z`; completed: `2026-09-07T15:20:45Z`.
- Base ref: `origin/main` at `bd7364388d0106364864e18a3d321b13ba978c36`.
- Tools: Bun 1.3.14, Node 22.22.2, and the pinned `CONMON` path recorded in
  `metadata/provenance.txt`.
- `controllers/` and `inputs/` contain byte-for-byte inert copies from the
  original private receipt, including the hidden backend controller snapshot.
  `metadata/log-hashes.json` identifies all raw logs without publishing them.

Raw test logs, LCOV archives, database state, authenticated data, and runtime
traces remain in the private receipt
`.cache/terra-shipping/parent/merged-backend-aa248563`.
