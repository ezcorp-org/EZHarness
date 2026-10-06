# Memory qualification failed; cleanup verified

One qualification ran against installed source
`301e88e9316447881abf00006eea4b42c25ccb08` in the isolated app. Its operation ID was
`incus-final-301e88-resource-20261006-3f33c6fd-755f-4e86-b7bf-9b49b4263975`.
This was a diagnostic attempt, not a qualification pass.

## Observed failure

The caller stopped waiting after 45 seconds. The server continued; its handler
does not propagate that disconnect to qualification preparation. There was no
second qualification request.

At 08:07:05.528 UTC, the guest helper logged `helper.process.inspect`, phase
`output`, error kind `deadline`. The Incus log recorded an exec WebSocket EOF
one millisecond later. That EOF can be timeout teardown and does not establish
the cause.

At 08:08:13.562 UTC, the server logged the terminal preparation failure:

- Stage: `limit_loads`.
- Resource: `memory`.
- Cause: `guest_processes_inspect_deadline_exceeded`.
- Cleanup at that checkpoint: `unverified`.

The private journal receipt is SHA-256
`cf2a0c97915b6b14c4dd437dc3179e0821ab1882d5072f2c384ebc624e5a19dd`.
The finite diagnostic receipt is
`3f50ccd2ae26969826e96e11f81463a289cf0170b939d423e71176dfccb78e4f`.
No out-of-memory or swap cause is proven. The counter reader reached the guest
after it stopped and correctly refused to read counters using PID 0.

## Cleanup and accounting

Primary STOP `64bd71e8-5706-4d3c-93ed-b744faa22d1e` initially became UNKNOWN,
with a real native operation handle. It later settled through normal
reconciliation at 08:11:40.377 UTC. The exact owned guest was STOPPED at
generation 3 with the same STOP tag. No STOP replay or fenced recovery occurred.

One normal distinct DESTROY, `a5e61d9c-4be5-499e-985e-defb29b37cb1`, succeeded.
Both primary and neighbor bindings are ABSENT and the backend inventory is
empty. The same run's probe controls were cleaned using their original saved
plan; cleanup receipt SHA-256 is
`d99b235cb8663785f80c99ee7e4ab718b0abc54ec42884a544b1d22b6cfddd29`.

A fresh detached-copy check passed the full production validation. Its first
report exceeded the existing output limit and was preserved as a failed
capture. A finite report on that same copy then returned 3,583 bytes without
truncation, keeping the validation and output bound unchanged. It proves zero
scoped charges, no actionable operations, and a false production drain result.
The old c7/069 UNKNOWN history remains preserved and compensated.

Completion SHA-256:
`a61bf2feef186dd47d76d3d13a464a1ca20b6aaa2a2f8a4a173f7644e34c05a9`.
Independent review passed. The app resumed normally; no live database read or
database restore was used for this accounting check.

## Next evidence

Reproduce the actual `readOutput` then `inspect` polling sequence under the
memory load. Earlier local output-only tests did not reproduce this sequence.
Capture effective guest memory and swap controls during the next live load,
before cleanup removes the guest. Correct the diagnostic caller's wait period
to match the bounded server preparation workflow; preserve unknown replies
without replay. Qualification and the full user workflow remain unverified.
