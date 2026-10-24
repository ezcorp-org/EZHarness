# Gates: sandbox admission and reservations wave 3

Scope: durable capacity configuration, admission decisions and reservation accounting for the host controller. This gate covers the B01/B03 slice listed below. It does not close B01 or B03.

- [x] A1: Host and project limits are explicit and bounded.
  EVIDENCE: `sandbox_host_capacities` requires allocatable memory bytes, CPU millicores, PIDs, disk bytes and execution slots plus a smaller non-negative safety margin for every resource. `sandbox_project_quotas` requires all five project limits and binds them to one configured provider connection. The API rejects missing, zero, fractional, negative and unsafe integers. SQL checks enforce positive values through `9007199254740991`.

- [x] A2: Admission reserves capacity atomically before returning `ADMITTED`.
  EVIDENCE: `SandboxAdmissionStore` locks the binding and provider-connection capacity row, reads the project quota and current reservations, then creates or updates the reservation and admission receipt in one transaction. The receipt's request fields remain fixed; a queued receipt can change state on retry. PGlite and real PostgreSQL concurrency tests submit two requests for one remaining execution slot; exactly one is admitted and one is queued.

- [x] A3: Queue and rejection results are durable and deterministic.
  EVIDENCE: The decision checks resources in the fixed order memory, CPU, PIDs, disk and execution slots, with project limits before host limits. Permanent configuration/request failures are `REJECTED`; temporary aggregate exhaustion is `QUEUED`. Every non-admitted receipt stores its reason. Exact idempotency replay returns the original receipt; changed resource payloads return `IDEMPOTENCY_CONFLICT`; a queued receipt keeps its ID when retried.

- [x] A4: Stop, start and cleanup accounting is conservative.
  EVIDENCE: Stop intent changes compute to `RELEASE_REQUESTED`, which remains charged until `STOPPED` is observed. Confirmed stop releases memory, CPU, PIDs and the execution slot while disk remains `RESERVED`. START requires the retained disk reservation and passes admission again. Cleanup intent keeps compute and disk charged until `ABSENT` is observed. A stop or absence observation without its matching durable intent cannot release capacity. A late `RUNNING` observation cannot restore released compute without a new admission.

- [x] A5: Generations and database locks fence races.
  EVIDENCE: Admission, stop/cleanup intent and observed-state updates lock the binding and check both binding and reservation generations. Same-binding start/stop races serialize. Stale observations cannot release current capacity, including a delayed same-generation `STOPPED` result after START cleared its stop intent. Host admissions serialize on the provider-connection capacity row. Initial host configuration creates that row before reading usage, and capacity/quota updates cannot shrink below durable reservations.

- [x] A6: Migration and reopen behavior is additive.
  EVIDENCE: The migration uses PostgreSQL/PGlite-compatible tables, checks, foreign keys and named indexes. Persistent PGlite reopen preserves the local project, admission receipt and reservation. Real PostgreSQL reapplies the migration, reconnects, validates checks/indexes and runs the concurrent admission test. Projects without a sandbox binding remain unchanged.

## Verification

- Pinned Bun 1.3.14: `bun test ./src/sandboxes/admission.test.ts ./src/sandboxes/controller.test.ts ./src/sandboxes/migration-reopen.test.ts ./src/sandboxes/migration-postgres.test.ts` — 22 pass, 0 fail, 104 assertions, including real PostgreSQL. The cached Bun 1.3.14 executable was used directly because `bunx` could not write its temporary files in this environment.
- Pinned Bun 1.3.14: `bun run typecheck` — backend, web, backend-test and web-E2E typechecks pass.
- Pinned Bun 1.3.14: `bun run lint` — passes; eight informational findings are outside the admission-owned files.
- `bunx bun@1.3.14 x biome check src/sandboxes/admission.ts src/sandboxes/admission.test.ts src/sandboxes/controller.ts src/sandboxes/controller.test.ts src/sandboxes/migration-reopen.test.ts src/sandboxes/migration-postgres.test.ts src/db/migrations/add-sandbox-controller.ts src/db/schema.ts src/db/migrate.ts tasks/todo.md` — clean.
- `git diff --check` — clean for the complete shared worktree.

## Remaining work

This slice does not enforce resources in Incus or another backend. It does not reconcile untracked external host usage, measure live headroom, dispatch queued work automatically, connect the admission store to the live provider adapter, or prove OOM/disk isolation with a healthy neighbor. Processes, endpoints, workspace leases and other B01 records are also outside this slice. B01 and B03 remain open until their full plan acceptance tests pass.

## Independent review

The review checked admission and release lock order, host and project accounting, duplicate requests, same-generation stop/start observations, missing release intent, generation bounds, and migration behavior. The four corrected defects have focused regression tests. No further admission-scope defect was found in this pass. The tests prove durable accounting and admission decisions; they do not prove live resource enforcement or complete B01/B03 acceptance.
