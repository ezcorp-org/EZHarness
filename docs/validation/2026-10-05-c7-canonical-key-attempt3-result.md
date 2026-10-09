# c7 attempt 3: access passed, continuation safely stopped

The user's continuation instruction authorized the shown attempt-3 packet
`f37463a56809dc3aea9f0f3da264c1405d8a6f0f390a64d2c418ae690509bdc6`.
The sole operator executed one attempt; that attempt cannot be replayed.

## Verified live progress

Actual timer configuration, pre-key absence, exact key installation, the forced
root route, operator-slice freeze, and verification passed in one batch. The
independent reviewer verified the actual files, timer, scope, proof receipts,
fixed deadline and rollback margin. Capture had 409,619 ms of recovery time
remaining; the independent review check had 351,805 ms remaining.

The guarded continuation then refused the review receipt because it was more
than 30 seconds old. Receipt 203 records 46,895 ms between its sampled review
timestamp and persistence. Receipt arrival timing was not instrumented; the
exact source of that delay is not established. No certificate-fence, management
start, recovery request, signing or admission occurred.

## Restoration

The approved expiry path returned all three required facts: user thawed,
temporary key removed, prior key-file absence restored. Independent receipts
202–207 verify both key paths absent, the user unfrozen, the unchanged restricted
Incus certificate, all five original config hashes, and healthy source
`5080f3792dbbedcdae17b81368ed9ee83ba41b80` with manifest
`f935dbb456db40581cf1642f1f6bd2049e28062f605298ea395dff0195191748`.

The empty runner marker again has its original root:62040, mode-0600 semantics,
with new inode 3257285. The original inode is not claimed to be restored.
START `c7b5f35d-aa75-421f-aa6b-0741840c8c39` remains UNKNOWN, with the same
STOPPED guest and reservation. The backend inventory contains only that guest.
Earlier cleanup 8157 remains SUCCEEDED/ABSENT. No database restore or c7 cleanup
is claimed.

At these readbacks the fallback timer remained active with its service inactive.
Subsequent independent receipts 208–209 close that window: both units are now
not-found/inactive, both key paths are absent, and the slice is unfrozen. The
exact-unit natural-expiry journal confirms `devThawed: true` and
`priorAbsenceRestored: true`. Its `temporaryKeyRemoved: false` correctly records
that the earlier manual expiry call had already removed the key. No second
removal or cleanup is claimed.

## Required handoff correction

Retain the 30-second freshness check and all fixed-window limits. Publish the
independent review receipt once, atomically, with its timestamp sampled inside
that publication call after the review passes. Never refresh or replace a
receipt. A bounded operator waiter must consume the exact receipt and call the
existing guarded continuation immediately, without a separate model/message
handoff. No receipt or an invalid/stale receipt must admit no authority.

Reproduce the delayed-publication refusal in a deterministic test; cover exact
proof binding, single publication/continuation, timeout, duplicates, malformed
or rejected review, and uncertainty. Preserve this attempt and use a new ledger
for any independently reviewed successor under the active E2E completion goal.
