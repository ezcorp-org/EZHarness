# Incus PR #303 live closure contract

The isolated app saved a reviewed, ready Incus setup plan. User approved its exact digest `adc0a93ba4a18122ca98ad50f387b06954819b7af8d2ca5f2dfcd039e7a6fb5b`. The first Apply request returned HTTP 409 before claiming the plan or changing the server. The candidate sandbox qualification expired one hour after release build; `resolveActiveRelease()` rechecks that short validity on every call. This blocks the provider and server setup even though live, connection-specific qualification has a separate expiry.

Pre-apply inspection also found the installed release's preset `imageDigest` is all zeros. Its own live qualification rejects that value, and the setup Plan had not compared the preset to the reviewed guest image. Do not execute the approved old plan after the candidate-lifetime repair: it would trust a connection for an unusable release. Pin the published image in a new reviewed release, regenerate the setup Plan, and obtain approval for the new digest before any server write.

## Shared contract

- Candidate qualification checks that an immutable release and all declared presets passed the host's candidate cases. Require current evidence when build, review, or activation consumes it. After activation, verify the saved evidence's identity, case set, and valid interval without treating its one-hour candidate deadline as the running release's lifetime. Never bypass a missing or forged candidate result.
- Live qualification remains connection-specific and time-bound at every feature admission. No synthetic witness may make a feature ready.
- The expiry fix alone does not change the old setup plan or its binding. The separately found all-zero image digest makes that old release unusable. Build and review a corrected release, then generate and review a new exact setup plan.
- Do not write to the server with either old digest. After any unknown result, reconcile saved state and backend inventory before another request.
- The isolated app owns its own PGlite database; do not open it from a second process while the app runs. Provider and fixture calls must use the app process or a deliberate stopped-app recovery path.

## Leaves and file ownership

1. Candidate lifetime repair: contract validator, v4 sandbox qualification helpers, release-runtime and publication call sites, and their focused tests. No operator-route or live-server edits.
2. Released image pin and fail-closed setup Plan: Incus manifest and operator planning code, then rebuild/review/activate the release in the isolated app. This changes the setup digest and needs a new review.
3. Operator Apply, probe, and server readback: isolated app and new approved Incus plan only. No contract or release-runtime source edits.
4. Live host fixture and SP01–SP08 witness: infrastructure and operator API files after the setup verifies. No weakening of feature readiness.
5. Root integration: tests, CI, security/resource checks, evidence, PR description and final review.

## Newly measured gaps

- The live witness now checks reviewed image/helper identity and exact guest scope, but its production readiness gate stays closed until controlled admission, resource-load, restart, and cleanup probes have operator-owned inputs and live readback. Offline 100% coverage of a probe does not qualify its server behavior.
- The selected `4 GiB` memory and `20 GiB` disk preset needs a dedicated, reviewed high-load budget and independently healthy neighbor to prove containment. A smaller test profile proves only that smaller profile. The Incus create path now sets a hard CPU allowance and the readback checks it; actual `cpu.max` still needs a guest measurement.
- The live route must be in the API registry with session scope. Hosted CI caught its omission; the route contract and session-scope tests now pass locally.
- SP06 needs an actual isolated-app restart and a lost-cleanup response with durable reconciliation. Reconstructing an object in one process is not proof of an app restart.

The [root gate ledger](../../gates/incus-live-pr303.md) is authoritative. Each leaf records actual commands and results. A test fixture is not a user feature proof.
