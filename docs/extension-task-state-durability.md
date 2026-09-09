# Task state and event durability

The host owns task snapshot persistence. `TaskEvents.emitSnapshot` commits the snapshot, an optional matching assignment batch, and all eligible extension deliveries in one SQL transaction. The host emits UI bus events only after commit. A failed delivery admission leaves the previous snapshot intact and returns an error.

The task-tracking extension does not write its snapshot through `Storage.set`. It reads a revision, then submits the next snapshot with that revision. The host rejects a stale revision rather than overwriting another writer. Fresh workers use host-owned conversation locks; the SQL transaction also verifies the captured lock fence. HTTP task changes and host assignment callbacks use the same snapshot writer. Single assignment changes merge into the current stored snapshot.

Child execution is not part of the SQL transaction. The host does not automatically repeat a spawn or cancellation after an uncertain result. If a terminal child run is stored but its task update cannot commit, the callback logs the failure. Boot recovery and live maintenance read the stored terminal run and retry only the task-state update with revision checks. Successful runs restore a completed assignment and stored result; failed, cancelled, or missing runs produce an interrupted assignment. A concurrent task edit is not overwritten.

Live maintenance runs once per hour by default and scans at most 50 conversation snapshots per tick. A larger installation can require multiple ticks to complete a scan; this is not immediate recovery. It does not restart child work, resume autonomous retry cycles, or reconstruct transient callback-only structured validation data. The queued assignment event lets the task extension finish its normal task roll-up after the state commit. Receivers must tolerate a previously committed terminal assignment.

## Proof

- `src/__tests__/task-state-publication.test.ts`: actual SQL rollback before commit, frozen inputs, restart delivery, stale reader rejection, and same-boot repair after a rejected terminal publication. A second maintenance tick does not publish another update.
- `src/__tests__/task-state-isolated.integration.test.ts`: two fresh rootless workers change one conversation concurrently through the production SDK and broker. Both changes persist with distinct revisions.
- `src/__tests__/boot-reconcile-assignments.test.ts`: saved success results, interrupted runs, concurrent revision conflicts, and explicit database failures.
- Task writer, task RPC handler, and reconciliation module each have 100% line coverage in the focused SQL suite.
