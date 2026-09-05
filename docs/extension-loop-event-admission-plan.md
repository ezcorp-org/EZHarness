# Loop notice admission

## Contract

Loop notices report extension-owned state. They do not create human approval authority and cannot commit atomically with an earlier extension storage update.

Conversation-scoped notices must use the host invocation's conversation. A different supplied conversation is rejected. The host checks its current active owner before admission. Accepted notices commit one immutable receipt, audit entry, and subscriber delivery set in one transaction. The bus emits only after commit, and repeat admission does not emit again.

Approval receipt identity is a hash of emitting extension, loop, loop run, and notice type. Decision is part of the immutable payload, not the key: a changed decision conflicts. Scoped auto-disable needs a host run identity, so repeated disable cycles do not collapse into one permanent receipt.

Global notices contain only bounded loop/run identifiers and status fields. They remain explicitly ephemeral UI invalidations; the existing dispatcher rejects notices without a conversation. They must not claim durable delivery or human approval evidence. Their audit remains best effort.

## Gates

- [x] Reproduce forged conversation scope before changing the handler.
- [x] Reproduce emission when durable audit/admission fails.
- [x] Use existing receipt, transactional audit, and domain outbox helpers.
- [x] Prove scoped rollback, retry deduplication, decision conflict, and current ownership checks with real database transactions.
- [x] Prove global notice behavior stays functional and explicitly non-durable.
- [x] Run focused tests, line coverage, and type checks before commit.

## Review evidence

- Before the fix, both real-database regressions failed: forged conversation scope and an audit-write failure still allowed emission. Log: `/tmp/ez-loop-admission-red.log`.
- After the fix: 32 tests passed with 92 assertions; all 171 measured handler lines were covered. Tests include queue and audit rollback, concurrent retries, immutable decision conflicts, current active ownership, host-run auto-disable identity, and explicit non-durable global behavior.
- Full backend, web, backend-test, and E2E type checks passed. Scoped Biome check passed.
- Scoped auto-disable without a live host run fails explicitly. The current SDK's global auto-disable path remains an ephemeral notice; the extension storage latch is its durable state, not this receipt.
