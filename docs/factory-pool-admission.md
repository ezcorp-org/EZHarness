# C03 pool admission — reservation vocabulary and admission limits

This note records two W03 decisions for the pool admission ledger
(`src/factory/pool/ledger.ts`): the reservation state names, and how the
outstanding-request bounds are configured. Requirement-index discrepancies 11
and 16 point here.

## Reservation state names

The C03 contract table names six reservation states. The ledger stores seven.
The ledger keeps its own names. It does not rename them.

| Ledger state | C03 contract state | Meaning |
| --- | --- | --- |
| `queued` | `requested` | The request is durable and waits for budget or capacity. |
| `held` | `held` | Capacity is assigned. No process has acknowledged a start. |
| `running` | `running` | The holder renews the lease and accounts for actual use. |
| `revoking` | `revoking` | New effects are refused. The previous holder must stop or reconcile. |
| `uncertain` | `uncertain` | The affected capacity stays held. It is never offered to another holder. |
| `settled` | `settled` | Confirmed unused capacity is released exactly once. |
| `rejected` | `requested` | The request failed at admission. It never held capacity. |

`POOL_STATE_CONTRACT_MAPPING` in `src/factory/pool/ledger.ts` is the executable
copy of this table. `POOL_LEASE_STATES` is the only source of the seven durable
names: the `factory_pool_requests` CHECK constraint, the `PoolLeaseState` type,
and the pool client decoder are all built from it. A test in
`src/__tests__/helpers/factory-pool-suite.ts` compares the exported constants,
the durable CHECK constraint, and the rows of this table, and fails if any of
them drift apart. That test runs on PGlite and on real PostgreSQL.

### Why the names stay

Two states differ from the contract, and both differences are name-only.

1. `queued` is the contract's `requested`. The contract's allowed action for
   `requested` is "wait for budget/capacity or fail by the admission deadline".
   That is exactly what a `queued` row does.
2. `rejected` is a terminal outcome of the same contract row. A request that is
   larger than the configured pool maximum, that misses its admission deadline,
   or that arrives at a full queue, fails at admission. It never receives
   capacity, so it releases none and it cannot reach `settled`, whose contract
   action is to "release confirmed unused capacity and budget exactly once".
   Recording the failure as a distinct durable state keeps a rejection separate
   from a cancellation that did hold capacity.

A rename is not free and buys nothing:

- `queued` is a value in the `factory_pool_requests` CHECK constraint and in
  about a dozen SQL statements. Existing rows carry it, so the rename needs a
  data migration of a live independent database.
- `queued` is also the wire value of `PoolDecision.status`. That decision
  crosses the private HTTPS boundary and is read by `src/factory/compute-admissions.ts`
  and by the gateway suites. A rename is a wire break for every consumer, in
  files that W03 does not own.

The cost is a migration plus a wire break across several work packages. The
benefit is one word. The mapping above, held by a test, removes the ambiguity
at no risk.

## Outstanding admission request bounds

C03 bounds outstanding admission requests at 10,000 per tenant and 100,000 per
pool, and rejects a new start with HTTP 429 and `Retry-After` when the queue is
full.

`POOL_DEFAULT_QUEUE_LIMITS` holds the two contract values. `FactoryPoolLedger`
accepts a third constructor argument that may **tighten** either bound. A value
that is not a whole number in the range 1 to the contract maximum is refused, so
a deployment or a test can never raise or bypass a bound. The ledger compares
the real queue counts against `queueLimits`, whatever those are configured to
be. Tests therefore prove the real comparison at a small configured bound, and
prove separately that the defaults are the contract values.

A full queue produces the decision
`{ status: "rejected", reason: "queue-full", retryAfterSeconds: 1 }` and writes
no row. Work that was not durably queued is never acknowledged.

## HTTP 429 and the `Retry-After` header

`createPoolAdmissionRouteHandler` answers a `queue-full` decision with HTTP 429
(`POOL_QUEUE_FULL_HTTP_STATUS`). Every other admission decision stays HTTP 200.
The decision body carries `retryAfterSeconds`.

The `Retry-After` response header is **not** sent yet. `FactoryPrivateResponse`
in `src/factory/private-https.ts` carries only `status`, `body`, and
`contentType`, and the server writes a fixed header block (`content-type`,
`content-length`, `cache-control`, `connection`). There is no seam for a
response header, and that file belongs to W09.

The minimal change W09 must make:

1. Add `readonly headers?: Readonly<Record<string, string>>` to
   `FactoryPrivateResponse`.
2. In `respond()`, append each entry to the status line, after validating the
   name and value against the same grammar the request parser already uses, and
   refusing any name the server sets itself (`content-type`, `content-length`,
   `cache-control`, `connection`).

When that seam exists, the route adds
`headers: { "retry-after": String(decision.retryAfterSeconds) }` to the 429.
`createPoolAdmissionClient` already reads a `Retry-After` delta-seconds header
and prefers it over the body value, so no client change is needed.
