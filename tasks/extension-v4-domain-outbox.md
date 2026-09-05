# Durable domain event gate

- [x] Reuse delivery rows as a transaction-bound outbox.
- [x] Resolve event recipients, owner, release, and sanitized payload from trusted database state.
- [x] Persist stream-chat terminal run state and its event together; never publish a failed transaction.
- [x] Persist builtin and extension tool call records and their completion/error events together.
- [x] Keep UI bus delivery after commit; suppress duplicate extension fan-out.
- [x] Revalidate wiring and event grants at dispatch.
- [x] Test rollback, actual process SIGKILL before/after commit, restart, replay, changed payload, and revoked authority.
- [x] List retained event kinds and producer groups not yet moved to an atomic transaction.

## Design

The existing delivery queue is the outbox. Queue insertion accepts the caller's transaction, never opens a second connection. A host event publisher binds a stable domain event identity to approved recipients in that transaction. Domain rows prevent repeated publication of the same transition. UI listeners remain on the existing in-memory bus. Durable rows recover through the existing delivery drain and never automatically repeat uncertain worker effects.

## Review

The four authority modules have 100% measured line coverage. The SQL, process-crash, queue, and delivery suites pass 33 tests with 120 assertions. The eight affected producer and real isolated lessons integration suites pass 39 tests with 163 assertions. Changed-file TypeScript checks pass. Global TypeScript still reports unrelated web alias and fixture errors.

Commands:

```sh
bun test ./src/extensions/domain-event-outbox.test.ts ./src/extensions/domain-event-outbox-crash.test.ts ./src/extensions/v4/deliveries.test.ts ./src/extensions/__tests__/delivery-runtime.test.ts
bun test src/__tests__/finalize-success-cancel-guard.test.ts src/__tests__/finalize-fallback-parent.test.ts src/__tests__/finalize-provider-connection-error.test.ts src/__tests__/finalize-error-persist-slot.test.ts src/__tests__/runs-finalize.test.ts src/__tests__/subscribe-bridge-cardlayout.test.ts src/__tests__/entities-e2e.test.ts src/__tests__/lessons-distiller-host-integration.test.ts
```

The transaction API is `ExtensionDeliveryQueue.enqueueInTransaction(transaction, input)` and `publishDomainEvent(transaction, event)`. The producer must hold the domain row's transition guard. It must not publish a transition again after that row is terminal, including when the original event had zero subscribers. `updateRun(run, event)` enforces this guard. Tool events use a host-minted tool-row ID, never a provider-controlled call ID. Replaying a queue insertion compares immutable payload identity, including a digest of fields hidden from the subscriber.

Payloads have a 256 KiB limit. Each installation has a 10,000 pending delivery limit. Overflow aborts the source transaction with an explicit error; it is not a dropped event. Failed tool event persistence prevents stream-chat from announcing successful completion. Operators must resolve a persistent database/capacity failure; this leaf does not claim that such a failure can be hidden while preserving both atomicity and availability.

## Remaining producer work

Event subscriptions currently have no time-to-live policy: `mapGrantKeyToExpiryKind("eventSubscriptions")` returns `null`. Their current installed and conversation-scoped allowlists are both checked before admission and again before a worker receives the event. Project membership is rechecked before dispatch, including owned conversations. Other capability expiry never grants permission to receive event data.

These paths retain their previous bus behavior, not a new no-loss guarantee. Do not mark the complete extension reliability plan done from this leaf.

| Retained event kinds | Producers still outside a shared state/outbox transaction |
| --- | --- |
| `run:complete`, `run:error`, `run:cancel` outside stream-chat finalization | `src/runtime/executor.ts`, `src/runtime/executor-watchdog.ts`, `src/db/queries/runs.ts` (`finalizeRunRow`, `terminalizeOrphanedRuns`), `web/src/routes/api/conversations/[id]/active-run/+server.ts` |
| `tool:complete` from preview detection | `src/runtime/preview/preview-detection-bridge.ts`; synthetic preview notification, not a persisted tool call |
| `task:snapshot`, `task:assignment_update` | `src/extensions/task-events-handler.ts`, `src/runtime/start-assignment.ts`, `src/runtime/boot-reconcile-assignments.ts`, `web/src/lib/server/task-helpers.ts`; terminal assignment notifications are high-priority follow-up work |
| `ask-user:answer` | Completed by `src/runtime/ask-user-answer.ts`: durable accepted-answer receipt and queue transaction; pending question process resumption remains transient. See `tasks/extension-v4-event-receipts.md`. |
| Extension-owned `<name>:<event>` | `web/src/routes/api/extensions/[name]/events/[event]/+server.ts`; keep existing namespace/provenance checks when moving its accepted event into a transaction |
| `run:turn_saved` | `src/runtime/stream-chat/subscribe-bridge.ts`, extension event route above; combine message/tree changes and delivery insertion |
| `goal:update` | `src/runtime/goal-host.ts` |
| `tool:start`, `tool:permission_request`, `tool:permission_mode_change`, `obs:turn` | Existing transient runtime/permission bus producers; decide which need durable domain records, rather than inventing a successful state write |
| `extensions:installed`, `conversation:created`, `briefing:delivered`, `conversation:tree-changed` | Existing lifecycle/conversation/briefing producers; user-only payloads without a conversation are not delivered by the current extension dispatcher |
| `loops:approval_pending`, `loops:approval_resolved`, `loops:auto_disabled` | Existing loop approval/disable producers; bind the approved scope and state transaction before publication |

External tool effects, and entity writes performed before their tool-call record, are not made atomic with that record by this change. The queue never automatically retries an uncertain worker effect. This is not an exactly-once external-effects claim.
