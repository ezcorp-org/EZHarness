# Gate integrity at the final verifier commit

Pinned Bun 1.3.14 ran the policy check at `d2222840cf3d2b4963075ffc0f5cf0bdec5ef621`, with approval unset and base `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`. The actual command exits 1 and reports 84 findings.

The parent compares every finding with the [prior d4ffe706 receipt](../gate-integrity-d4ffe706/README.md), which already matches the retained later hosted ledger. All 84 findings match exactly: one threshold removal, 28 deleted tests, 24 renamed tests, and 31 gutted tests. No finding was added or removed. This is local policy evidence, not an approval or a new hosted result.
