# Final backend closure — 156fd9a4

This receipt records one canonical backend closure from source
`156fd9a46c3666e711e54f71350a53b6646e997f` and tree
`ff4cdbf35f58b49935fa89bf25099e86443a8299`.

All controller gates exited 0: runner probe, coverage, P-minus-C residual,
new-file coverage, and patch coverage. The coverage producer ran 25,975 tests
with zero failures over 1,557 shards, merged 1,400 source files, and met the
threshold on 1,251 enforced files. The residual suite ran 178 tests with zero
failures. New-file coverage gated 133 source files. Patch coverage covered every
changed executable line in 389 files.

The copied LCOV is authoritative because the coverage producer exited 0. The raw
LCOV remains in the local cache receipt; this directory keeps its size and SHA-256.
The canonical Vitest leg ran 4,617 tests with zero failures. The generated-parser
scan has zero matches. LCOV retains 223 `web/src/routes/api` source records.

The script helper is outside the threshold, new-file, and patch gate policy, so
those counts do not claim it was newly threshold-gated. Its four tests are in the
canonical producer and its LCOV record reports 30 of 30 executable lines hit. The
separate focused helper receipt reports 100% functions and lines.

`git-status-at-start.txt` is the exact working-tree status captured by the
controller. It includes unrelated browser, R4 diagnostic, planning, and report
work; this receipt proves the listed backend producers at the recorded source,
not a clean-whole-tree equivalence.
