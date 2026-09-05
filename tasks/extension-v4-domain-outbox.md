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

Each recipient's sanitized event representation has a 256 KiB limit. Events without recipients do not have a queue payload limit. Default tool events omit input/output; default terminal run events omit run logs and result output, retaining identity, status, timestamps, and result metadata. The full source record and original host/UI bus payload are not truncated. Explicit full-payload approval retains those fields and fails clearly if its representation exceeds the limit; it is never silently truncated. The immutable event digest binds the complete serialized host DTO, including fields omitted from a recipient.

Each installation has a 10,000 pending delivery limit. Representation or capacity overflow aborts the source transaction with an explicit error; it is not a dropped event. Failed tool event persistence prevents stream-chat from announcing successful completion. Operators must resolve a persistent database/capacity failure; this leaf does not claim that such a failure can be hidden while preserving both atomicity and availability.

Large-payload proof: `/tmp/lifecycle-payload-sized.log`, 22 tests and 90 assertions pass, including actual SQL multi-MiB tool output with metadata-only/no subscribers, full stored terminal result plus unchanged UI object, and explicit full-payload overflow rollback. Existing SIGKILL tests remain green.

## Reconciled producer guarantees

Event subscriptions currently have no time-to-live policy: `mapGrantKeyToExpiryKind("eventSubscriptions")` returns `null`. Their current installed and conversation-scoped allowlists are both checked before admission and again before a worker receives the event. Project membership is rechecked before dispatch, including owned conversations. Other capability expiry never grants permission to receive event data.

This matrix replaces the initial remaining-work inventory using recorded follow-up proof. It does not mark final integrated coverage or the complete extension reliability plan done.

| Retained event kinds | Current guarantee and proof |
| --- | --- |
| `run:complete`, `run:error`, `run:cancel` outside stream-chat finalization | Terminal source transactions cover executor, watchdog, row finalization, orphan recovery and active-run routes. `/tmp/terminal-final.log`:118 tests,380 assertions. |
| `tool:complete` from preview detection | `src/runtime/preview/preview-detection-bridge.ts`; synthetic preview notification, not a persisted tool call |
| `task:snapshot`, `task:assignment_update` | Shared transactional snapshot/assignment writer and bounded same-boot repair. `/tmp/lifecycle-task-writer-final.log`:52 tests,161 assertions; `/tmp/lifecycle-task-isolated-serialized.log`:1 real worker test,15 assertions. Recovery can take an hourly maintenance interval; no automatic child spawn replay. |
| `ask-user:answer` | Completed by `src/runtime/ask-user-answer.ts`: durable accepted-answer receipt and queue transaction; pending question process resumption remains transient. See `tasks/extension-v4-event-receipts.md`. |
| Extension-owned `<name>:<event>` | Generic conversation/Hub actions use owner receipts and production delivery. `/tmp/lifecycle-custom-isolated.log`:5 tests,37 assertions; namespace, payload conflicts and restart are covered. Specialized host file-organizer actions are not covered by these receipts. |
| `run:turn_saved` | Message/session append and outbox share a transaction. `/tmp/v4-turn-source-sql.log`:4 tests,13 assertions including queue backpressure preserving the old leaf. Extension append uses the same publisher; this audit does not invent a new isolated append proof. |
| `goal:update` | Durable goal transition CAS plus outbox. `/tmp/ez-goal-durable-green2.log`:5 tests,24 assertions. |
| `tool:start`, `tool:permission_request`, `tool:permission_mode_change`, `obs:turn` | Transient runtime/permission observations remain explicitly best effort, not durable terminal state. |
| `extensions:installed`, `conversation:created`, `briefing:delivered`, `conversation:tree-changed` | Conversationless install notices remain outside extension delivery. Briefing completion intents commit scoped creation/delivery events once: `/tmp/v4-briefing-intents-pipeline.log`,9 tests,35 assertions. Rewind route proof: `/tmp/v4-rewind-route-final.log`,9 passing tests. |
| `loops:approval_pending`, `loops:approval_resolved`, `loops:auto_disabled` | Scoped notices commit receipt/audit/outbox; global notices remain ephemeral and do not prove human approval. `/tmp/ez-loop-final-tests.log`:32 tests,92 assertions. See `docs/extension-loop-event-admission-plan.md`. |

External tool effects, and entity writes performed before their tool-call record, are not made atomic with that record by this change. The queue never automatically retries an uncertain worker effect. This is not an exactly-once external-effects claim.
