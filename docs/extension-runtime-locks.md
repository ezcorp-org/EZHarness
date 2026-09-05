# Runtime locks

Inside a v4 worker, `withLock(key, action)` and `createMutex(key)` acquire a
host-held lock. Use a stable key shared by all calls that change the same data.
The lock namespace is the installation, not the worker, caller or conversation.
Different keys can run together. Standalone SDK calls retain local sequencing.

Each invocation can hold eight keys. Each key has 1–128 safe characters. The
host permits 128 keys per installation and 4096 total. Waiting is bounded by
30 seconds and the invocation deadline. Avoid acquiring different keys in
different orders: nested cycles time out instead of making progress.

The host stores ownership and a random fence in SQL. It does not steal an
expired lock. It tracks admitted host effects and waits for them before release.
Storage mutations check the fence while holding the ownership row in their
transaction. No database transaction waits for worker RPC.

An uncertain effect or a five-second drain timeout quarantines the key. Use
`extensions_inspect` with `locks: true` to inspect it. A human administrator can
disable the installation, reconcile the effect, and use `extensions_release`
with `action: "recoverLock"`, `lockKey`, `expectedFence`, and
`acknowledgeUncertainEffects: true`. Recovery checks current administrator status,
disabled installation state, exact fence, and absence of admitted effects. It
records an audit entry in the same transaction as recovery.

Recovery refuses a persisted nonzero effect count even when no local session
exists. A host crash during an admitted effect can therefore leave a blocked
quarantine. There is not yet a proven cross-host stop-and-reconcile mechanism for
that case. Acknowledgement and elapsed time do not override this safety check.

## Verification

- Actual rootless workers reproduced a lost SQL counter update before the fix.
- The same two-worker test now retains both increments.
- SQL tests cover ownership, stale fences, drain, quarantine and audited recovery.
- SDK tests cover host acquisition, exact release, stable keys and cancellation.
