# Gate integrity checkpoint

This safe policy checkpoint records the gate-integrity command at source
`2c542bace8f13c58eefa2db715fe54aab4111a62` against main
`bd7364388d0106364864e18a3d321b13ba978c36`.

The command exits 1 with 83 findings. The ordered finding list is byte-equal
to the final lists at `79108f9d` and `da6bc4db`: one removed threshold key,
28 deleted tests, 24 renamed tests, and 30 gutted tests. There are no added or
removed findings in either comparison.

This is a failed historical policy checkpoint. It records neither an approval
nor a label. `check.log` is the exact private-receipt output; the source copy
is inert. `SHA256SUMS` covers all retained safe files.
