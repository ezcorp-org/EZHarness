# Gate-integrity policy receipt

Pinned Bun 1.3.14 ran `env -u GATE_CHANGE_APPROVED BASE_REF=origin/main bun scripts/gate-integrity.ts` at source `d4ffe706c86049ee15515c79377234765ee86208`, after a fresh fetch resolved `origin/main` to `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`.

The policy command exited 1 as required with approvals unset. It reported exactly 84 findings: one removed threshold key, 28 deleted tests, 24 renamed tests, and 31 gutted tests. `reconciliation.json` shows an exact finding-set match with the prior 84-item hosted ledger: no new or removed finding exists. These findings remain maintainer-review work; this receipt does not waive them.
