# Gate integrity — final merged source

`da6bc4db6326696347d76a2225677954b31d3a2b` was checked against its current
main base, `bd7364388d0106364864e18a3d321b13ba978c36`. The local gate exited
1 with approval unset and retained 83 ordered findings.

The prior public checkpoint had 84 findings against the older main base
`537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`. The exact comparison is in
[metadata/comparison.json](metadata/comparison.json),
[metadata/delta.txt](metadata/delta.txt), and
[metadata/diff-attribution.txt](metadata/diff-attribution.txt). Two old example-test findings no
longer apply with the new main base. One `define-extension-unit` finding has
updated line counts. One `scaffold-deterministic-gate` finding is new against
the new base. These are scan classifications, not approval decisions.

The complete ordered scan output is retained in `gate-integrity.log`. The
check does not grant `gate-change-approved`; manual policy review remains
required for all findings.
