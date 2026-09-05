# Service workflow release consent

- [x] Reproduce the existing delegated service failure with an approved private release: 4 pass, 2 fail in `/tmp/ez-service-release-red.log`.
- [ ] Store a server-built, versioned exact release and consented workflow closure. Never infer old approval from current state.
- [ ] Require the live service, live delegation, active consenting release owner, current project membership, and exact acknowledged release at execution.
- [ ] Keep service execution without a human user identity.
- [ ] Preserve nested workflows through the exact consented closure and persisted host lineage.
- [ ] Lock transaction authority reads against concurrent revocation; do not use a second database connection inside an effect transaction.
- [ ] Prove revocation, stale release, owner and scope changes, legacy unbound refusal, and explicit re-consent with real SQL tests.
- [ ] Pass focused backend and HTTP tests, type checks, and changed-source coverage.

## Compatibility

Existing human or service delegation consent without a release binding cannot authorize a private extension workflow. A human must consent again. A replacement release needs new delegation consent even when its workflow graph is unchanged. Plain database and YAML workflow consent rules do not change. Human execution identity is not assigned to the service.

## Review

Validation is in progress. This document does not claim completion.
