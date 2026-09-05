# Service workflow release consent

## Mixed Release Consent

Version 2 records the exact initiating release separately from the releases reached by the consented workflow graph. The server builds this record. It accepts no caller-supplied binding. Each target keeps its exact installation, release, owner, scope, and workflow names. Limits are 32 target releases, 256 names, and 64 KiB of canonical JSON. The builder refuses excess data before the route can save consent.

Version 1 remains limited to its stored single release. Missing or malformed bindings cannot authorize extension targets. Legacy host-only consent keeps its existing principal rules. A missing delegation is not treated as legacy consent. Budget-only host runs do not acquire a false delegated identity.

`/tmp/v2-mixed-execution3.log` proves both human host-root to private extension and extension A to owned extension B with the real executor, nested resolver, and SQL persistence. Target revocation, owner changes, and forged origin identity deny access. Service identities use the verified initiating release, not a fabricated human user or a YAML child release.

At `ea5806bb` plus the final legacy-host regression test, `/tmp/v2-complete-coverage.log` records 153 passing tests and 674 assertions. `/tmp/v2-complete-coverage/lcov.info` records release authority 160/160 lines and consent parsing/building 53/53 lines. The resumed YAML child test passes with the integrated service-origin proof. `/tmp/v2-web-final.log` records 136 passing web tests. These include mixed service consent, omitted foreign metadata, and an oversized map refused with HTTP 400. `/tmp/v2-source-types-final.log` records a passing backend source type check.

These are focused results, not a claim that every provider effect or the complete repository suite has passed.

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
