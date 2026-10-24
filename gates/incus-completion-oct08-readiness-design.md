# Daily Incus admission contract proposal

Source: c11eae2cf5ed8e7ea961d4377f716e83f2c01a66. Review before code changes.

Current boundary: `IncusQualificationStore.load()` rejects expired full SP01–SP09
receipts. `IncusFeatureService.approved()` and `assertSandboxPresetReady()` require
that same receipt. STOP/DESTROY do not require it. Existing service tests reproduce
this boundary, including rollback and cleanup after expiry.

Proposed v1 contract:

- A baseline is a separate record. It contains the original full proof unchanged,
  source run ID, captured exact selection, and three authority digests: application
  security source, supervisor/service, and protected host policy. Legacy rows cannot
  acquire these pins after the fact. A new full qualification must capture pins
  before the run and compare them before commit. Baseline validation applies the
  existing SP validator at its original verified time; this does not renew receipt
  expiry or issue a new full proof. A distinct combined admission validator checks
  the baseline and fresh readiness.
- Reuse existing protected supervisor socket; do not add another authority server.
  `requestIncusSupervisorReadiness()` currently returns only boolean protocol v1.
  Extend its versioned response to return operator-issued authority digests and
  exact selection, protected inventory/control digest, observed backend identity,
  and fresh bounded capacity. The supervisor must calculate these from actual
  managed app source/service/config/policy files and protected host inspection.
  Request values must never become authority. Existing build SHA env/OCI labels
  are claimed provenance and cannot alone prove active security code. Current
  SO_PEERCRED authenticates the client, not host-policy revisions. Existing receipt
  verifier checks selected image/settings; it does not issue these three digests.
- Store baseline and readiness separately, keyed by all exact pins. Readiness
  lifetime: at most 15 seconds from probe start; timeout: 12 seconds. Coalesce only
  identical scopes with an in-flight map. Persist success/failure and deadline;
  do not retain failed readiness as success. No fixture CREATE, restart, or mutation
  is permitted in this path.
- Recheck exact scope and authority after probe and immediately before durable
  intent/admission. Dispatch must compare the captured authority too. Current
  `ProviderConnectionStore.assertCurrentScope()` covers connection/release scope
  inside the existing transaction; extend the protected dispatch boundary for
  authority matching rather than trusting a check before the transaction. Existing
  quota/reservation generation locking remains the capacity admission authority.
- `prepareProject`, CREATE and START require combined admission. STOP, DESTROY,
  fixture cleanup, recovery, and old receipt validation keep current semantics.
  No SP cases are copied, no expiry is extended, no COMPLETED run is synthesized.

Proof: real service/route expiry reproduction; stable baseline plus fresh readonly
check; legacy baseline rejection; each release/connection/cert/project/profile/
image/helper/backend/security/service/host-policy drift; timeout and partial data;
coalescing exact scope only; drift between probe and journal/dispatch; locked quota
and capacity refusal; cleanup after expiry. Cover each source line and max complexity
30. Parent owns final broad gates and live server. This leaf performs no live work.

Remaining authority boundary: the existing deployed supervisor cannot currently
prove active security source or protected policy/service revisions. Implementing
only a backend table with dependency-injected pins would not deliver daily use.
Parent review must allocate supervisor/protected-dispatch ownership before runtime
integration. If that authority is not in scope, retain full qualification expiry
and ship explicit manual renewal UX only.

## Independent design review

Review lane accepted direction, with these requirements: exact source/dependency
closure, canonical version 2 response, rejection of version 1/partial responses,
original-run pin capture before fixtures and comparison after restart, and fresh
checks at durable admission plus delayed dispatch. Root assigned this leaf the
existing supervisor and protected dispatch changes too. Guarded host staging and
all live actions remain with root.

A file hash plus matching argv does not prove already loaded bytes. The supervisor
must hash the protected immutable app closure before launch, retain that digest
with the actual child start identity, and deny readiness if that closure changes.
The existing root supervisor is the issuer; app-supplied file lists are forbidden.
