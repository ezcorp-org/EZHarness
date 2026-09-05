# Release transaction authority

- [ ] Reproduce production release resolution inside an existing SQL effect transaction.
- [ ] Thread the exact supplied transaction through release state, migration pause and narrow principal authority reads without starting another transaction.
- [ ] Hold shared installation, user and membership row locks until the admitted effect commits.
- [ ] Prove transaction-local reads and PostgreSQL cross-connection revocation ordering.
- [ ] Run focused lifecycle regressions, TypeScript and lint; report final-suite proof separately.
