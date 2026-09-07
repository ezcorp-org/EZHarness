Prior hosted ledger: /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/terra-flow-validation/parent/ci-followup/prior-gate-integrity.log
SHA-256: f422566531cfe1f771e5bb36d1a5cd7792d1c0d6494e438ac042cf7cbd5ff0dd

The comparison extracts only findings after the last `Gate integrity FAILED (…):`
header. On hosted log lines it removes the leading GitHub timestamp with:
`^\ufeff?\d{4}-\d\d-\d\dT[^ ]+Z\s+`.

It then retains only these policy forms: `threshold key removed:`, `test file
DELETED:`, `test file RENAMED`, and `: test file GUTTED in place:`. It
compares the resulting finding sets, so CI wrapper lines and ordering do not
change the result.

This is the later hosted 84-item ledger at the path above. It is distinct from
the earlier handoff that described 27 deleted and 25 renamed findings. The
later hosted ledger and current run both contain 28 deleted and 24 renamed.
