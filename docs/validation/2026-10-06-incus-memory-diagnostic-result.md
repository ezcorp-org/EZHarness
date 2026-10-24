# Memory qualification failed; cleanup verified

The first diagnostic qualification ran against installed source
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

## Second diagnostic and actual memory controls

A second single request used the corrected bounded caller and returned HTTP
409 with the same memory/inspect-deadline failure and unverified cleanup.
There was no lost reply this time. Response SHA-256:
`eb6f448ea663c1b8d56fd76f13df6ffadd7c4b50f80d309bc0397c2a11bdeb8c`.

The concurrent collector saved 15 valid readings from the init-service cgroup.
Those readings did not represent the outer container's enforced limit. A
separate guarded read of the exact parent group then established:

- Memory maximum: 4 GiB; swap maximum: zero; memory high: unlimited.
- Current memory: 4,294,889,472 bytes, close to the maximum.
- Memory maximum events: 538,230; recorded OOM and OOM-kill events: zero.
- Ten-second memory pressure: some 98.95%, full 92.93%.
- CPU ceiling: two CPUs, with no recorded throttling.
- Process count: 39 of 1,024, with no limit events.

Exact-parent receipt SHA-256:
`d294d7c580ab0d469af62e609a5a5176e3070d2c800d30b70f4989a44da0091e`.
This establishes severe reclaim pressure at the sampled limit, not its cause.
The memory-breakdown read reached the guest after it stopped and correctly
refused. No process-score evidence was captured.

The same STOP later succeeded through normal reconciliation at 08:40:44.541
UTC. One normal distinct DESTROY removed the primary. Both bindings and the
backend inventory are absent; the same run's controls are cleaned. Control
cleanup receipt SHA-256:
`1467a40b1d1368649f811bce8e2408f78b65fef8d7536f1434f3ef8c932743a5`.
Fresh accounting for this second run also passed: zero scoped charges, no
actionable operations, and a false production drain result. Independent review
confirmed the untruncated result, preserved operation history, and healthy
normal app startup. No operation was replayed or database restored.

## Local control and next evidence

One local rootless control passed with the actual `readOutput` then `inspect`
sequence: one test, 24 assertions, and four real TLS/WebSocket polling cycles.
Its effective memory limit was 4 GiB, swap limit zero and OOM group setting
zero. The kernel OOM-kill count rose from zero to one, the load process exited
with signal 9, and the control reported containment. Its owned container was
stopped. Independent review passed; attestation SHA-256:
`dc60f2a8b6f1bd254cef3a18a1b64c8bac93575a507f156e26e132d716675969`.
This did not reproduce the timeout and does not establish Incus policy parity.
Earlier output-only local tests did not exercise the full polling sequence.

## Third diagnostic: preparation passed, continuation failed

Run `incus-final-301e88-outer-20261006-2b4d64ed-be36-421d-8975-aac01c3869cd`
used the corrected caller and sampled the actual outer container cgroup.
Its baseline showed a 4 GiB limit, zero swap, and about 277 MB used. During
the memory load, the recorded OOM-kill count rose from zero to one. A scoped
kernel record identifies a Python process killed within this guest's memory
cgroup at 08:52:11.167 UTC. This is not evidence of a host-wide OOM.
The collector did not capture the peak or establish the load process's exact
PID linkage. Kernel receipt SHA-256:
`f17787f352c0e2584e26d59665b244732e9fe80bdd2e6326d0750b7caf872de6`.

The unchanged installed app completed preparation and returned HTTP 202 /
AWAITING_RESTART. Response SHA-256:
`74d8bdaf4f1d5e69f94996ca763956e390cf5de9d1c5002ff2a5774013111926`.
The supervisor restarted automatically. Continuation then failed independent
backend receipt verification. This is a failed qualification, not a pass.

The verifier's saved operator configuration referenced an older provider
release and connection. An isolated regression using the installed production
verifier reproduced rejection before any backend GET. Changing only the scope
to the current connection passed the fixture. A read-only query against the
existing detached database copy then confirmed the current connection's
release, revision, endpoint, settings and certificate hashes. No secret bytes
were exposed. Metadata completion SHA-256:
`c3b3b8d11d24f93991d3bd4490ec740d1acbf139bc1e9007d840ee23a8d5e778`.
The exact configuration repair and an early scope-readiness check are being
validated separately.

Both guests were stopped and destroyed through normal actions. The same
run's controls were cleaned, scoped backend inventory is empty, and a fresh
detached-copy check proves zero charges and a false production drain result.
Historical UNKNOWN operations remain preserved and compensated. The app
resumed normally; no database restore occurred. Inventory receipt SHA-256:
`f7ec023819fa3076c90fcf368aa02dabdb48d7bcd85633bc842b35b93f263de0`.

The two memory-load failures and the later preparation pass remain distinct
results. No causal memory fix has been established. Further qualification must
test reliability with the corrected receipt scope. The full user workflow
remains unverified.

## Repaired receipt scope: next continuation boundary reached

Run `incus-final-301e88-repaired-20261006-5a68bad2-4792-49c2-a15f-45627327ce70`
used the corrected receipt configuration. Preparation passed again and returned
HTTP 202 / AWAITING_RESTART. Response SHA-256:
`27e38858b1af855e25b425e86eaaf75d181823a223c511276ed80ec8850a4b6d`.
During the memory load, the outer cgroup recorded one OOM kill and subsequent
memory use of about 104 MB. This is a second preparation pass, not a causal
explanation for the earlier inspection timeouts.

After automatic restart, receipt verification passed. The later lost-delete-
response test failed with `stage=dispatch state=unavailable`. Journal SHA-256:
`6f2d5ff85c7d40e27846b5e4433bc09a54c084c3e2212343522dfdab5aa32413`.
The qualification remains failed. Its generic stage does not establish that
the failed call had no effect.

The separate fault verifier still referenced the old provider scope. The
unchanged installed verifier rejected the current scope before any transport
call in an isolated regression. A scope-only fixture then passed its strict
stopped-instance verification. This proves a required rejection in that
configuration; the live inner stderr was not preserved. The configuration
repair and early check now cover both verifier scopes.

The normal continuation cleanup deleted all three guests automatically.
Each saved DESTROY succeeded, each binding is ABSENT, and scoped backend
inventory is empty. The same run's remaining negative-test controls were
cleaned through their saved plan. Fresh detached-copy accounting proves zero
charges, no actionable operations and a false production drain result.
Completion SHA-256:
`aee6c9e958401b1e985e1b4442e877aad8571703a0df27d3cdb43bbd0654e006`.
Normal 301 startup passed, with no database restore. Resume SHA-256:
`3b364ff454634b0efebb31dbf43878ed80c06a2733cd0b11ef3618d69ca73a0e`.
Independent review passed. No failed qualification was replayed.
