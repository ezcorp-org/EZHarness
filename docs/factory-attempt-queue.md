# Factory attempt queue

The factory attempt queue stores only an immutable attempt reference. The execution journal remains the source of truth for the runner request. The queue never stores a broker token or a copy of caller input.

Admission calls `FactoryExecutionJournal.admitInTransaction` before it inserts the queue row. The journal row and queue row therefore commit or roll back together. A repeated attempt ID must match the same canonical runner request and attempt authority.

A claimant first reads a candidate without a row lock. It then locks and checks the run, journal request, grant, cancellation epoch, and execution fence. Only after those checks does it lease that exact queue row through `DurableDeliveryQueue`. This lock order prevents a claimant from holding a queue row while it waits for the run or execution lock.

Dispatchers can settle a lease as:

- `delivered` after a proven runner acknowledgement;
- `retry` only after a proven failure before execution started; or
- `outcome_unknown` when the external result cannot be proved.

An expired dispatched lease becomes `outcome_unknown`. It is not claimed again, and its budget stays retained for reconciliation. Revoked or cancelled queued attempts become `cancelled`; leased attempts require their current owner or reconciliation path to settle them.

The PGlite integration test and the trusted PostgreSQL lane run the same conformance verifier. The verifier covers atomic rollback, exact-request retry, concurrent claim, stale lease recovery, revocation, cancellation, corrupt records, and foreign scope.
