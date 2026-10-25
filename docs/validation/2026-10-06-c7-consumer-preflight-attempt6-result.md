# Attempt 6: app restored; cleanup outcome unknown

Status: cleanup `8720a719-b3cd-44d7-a00d-5a57f4262fca` is admitted. Restoration
initially failed before the held engine resumed. A later [restoration-only
request](2026-10-06-admitted-c7-restoration-review.md) succeeded, with independently
verified runner readiness and exact hold archive. Normal app startup passed;
the queued DESTROY then reported `OUTCOME_UNKNOWN`, without a provider handle
or saved diagnostic. DESTROY completion remains required. No released
reservation is claimed.
Do not repeat recovery or use a no-admission abort.

The [sealed packet](2026-10-06-c7-consumer-preflight-attempt6-review.md) passed
actual access, rollback and freeze checks. Receipt 288 proves the exact owned
guest and current restricted certificate passed the real server verifier.
Receipt 289 proves the installed production audit command passed through the
temporary SSH gate. The independent reviewer published once, receipt SHA-256
`e17d1b62c362ac073205051be04028729f053e4eb1a73be6392517ece47cac4a`.

The exact request's backend and APPLY phases returned exit 0. APPLY returned
only the cleanup ID above. The saved held-restore request links that ID to
the attempt 6 configuration, original request, target and certificate.
The unchanged restoration sequence also completed its offline committed-row
admission check before restoring the certificate and starting the runner.
This is admission evidence, not proof that the queued DESTROY has run.

An independently reviewed detached-database projection later confirmed the
cleanup is `JOURNALED`, with original receipt SHA-256
`e59e2caf33034aba63e63a601aa3eef5313bee4eb52e9bf4abbbd4afeee01061`.
The exact global unsettled set contains the older 069 UNKNOWN operation,
this queued cleanup, and the original c7 UNKNOWN START. The completion
evidence SHA-256 is
`b29bc3a72e81e6b22d8a488236e800fc37f96245e6a23a8873cc95d744f1abbb`.
Live database bytes and identity were preserved. The first projection failed
before querying because Bun required directory-read permission; the reviewed
correction changed only the detached-copy directory from 0710 to 0750 for
group 62040 and preserved that failure. No live database was restored.

RESTORE failed at `verify_transport`, with `runner UID changed`. Later actual
readback finds the runner on the expected UID 62041, with the expected command
and socket. Its unit uses `Type=simple`, which can report activation before
the final process identity is ready. The initial mismatching UID was not
captured; that startup explanation is not a measurement of the missing UID.

A second, definite defect blocks the old held-resume route: marker creation
inherits group 62040, while its later guard requires group 0. The marker has
the expected owner, mode and empty contents. The old route also binds its
budget to the consumed recovery deadline. Do not edit the old packet, loosen
identity checks, extend that deadline or manually remove the hold.

The separately reviewed restoration-only request through the existing
supervisor `restore-admitted` capability completed. It verified the committed
cleanup and current authority, used a fresh restoration receipt, checked the
restored certificate and strict runner identity, and archived the exact hold.
Receipt 303 independently confirms normal source `5080f3792` startup, the five
original configurations, active units and no recovery hold. No database was
restored.
Natural temporary-access rollback passed independent review in receipts
296–297: both temporary key paths are absent, the server slice is thawed,
the timer/service are inactive, and the final invocation reports all three
cleanup checks true with exit 0.

Receipt 299 records the new cleanup's UNKNOWN result. Receipt 305 finds the
exact guest STOPPED at backend generation 2, with its original START tags and
no active backend operations. This observation alone does not prove no effect.
The saved cleanup must not be replayed.

A production-chain database fixture reproduces a matching failure: the host
rejects an expired observation budget before any backend request, but the
unclassified transport error becomes UNKNOWN. A guarded read of a fresh copy
of the immutable admitted-state snapshot establishes cleanup creation time
`2026-10-06T04:32:26.625Z` and its ordinary qualification idempotency key. The
normal runner began starting at `2026-10-06T05:04:52.039501Z`, over 22 minutes
after that ten-minute budget expired. The bounded startup journal has SHA-256
`317b6d29c9000385e01cb0c7f17759b9013014c4d534ef047b5e5f027d09d8ad`.
The signed restoration result at `04:59:05.275745Z` ran the actual inspector
before and after transport restoration. That inspector requires this cleanup
to remain JOURNALED. The supervisor was stopped at `04:42:22.002331Z` and next
started at `05:04:53.542168Z`. These checks establish that the request remained
queued after expiry and before normal dispatch. The actual code and fixture
explain the pre-transport rejection; no raw provider reply was retained.
This causal evidence does not itself settle the live UNKNOWN row.

An exact saved-row/time replay also passed: seven tests, 43 assertions. It
loads the installed 508 broker only after verifying its source hash, uses the
saved release, grants, binding, payload, queue time and normal startup time,
and observes zero transport-factory calls and zero HTTP calls. The old host
reply is `unavailable / effect: unknown`; the adapter converts it to INTERNAL
and the dispatcher to UNKNOWN without a handle. The corrected broker returns
FAILED/UNAVAILABLE instead. The replay fixture SHA-256 is
`6c733d45e74cd2c68c3d61b52433cc67d7d108d34e7556fe3565642e51036f88`.
This is a reproduction, not a mutation or settlement of the saved live row.
