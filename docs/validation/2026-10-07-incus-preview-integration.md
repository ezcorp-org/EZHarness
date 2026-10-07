# Incus preview integration: validation boundary

Status: implementation under verification. No full-profile live pass is claimed.

## Accepted baseline

The API verification team completed all 14 local gates on clean revision
`2912ff9ba236c5212bbbc16eca5a98515fa4dc6c`, with independent receipt review.
Results: backend 27,653 passed; browser 2,265 passed; coverage tests 28,459 passed;
Web Vitest 7,729 passed; 1,802 threshold checks, 94 new-file checks, and 163 patch
checks passed. Existing environment-gated skips remain documented in that run.

The result receipt SHA-256 is
`3c40cb0af9b74f1a046ed685cba0e7f1b25fefcd98955a203b12412f2ced22b5`.
The log SHA-256 is
`c94e7a0f40c3e9b9d61566ae9d8ced7aa50c6690db371d0575a264cbd2a2a7be`.
The frozen worktree is `incus-final-verification-oct07`.

These results do not cover later preview production changes. At `6082a3deb`,
the integration differs from the baseline in 69 files. It is not a docs-only
or test-only equivalent revision.

## Implemented since the baseline

- Bounded HTTP and WebSocket guest relays use current host authorization,
  pinned Incus transport, exact workspace binding, and the registered port.
- Normal Compose previews require a current saved SP09 proof. An old
  eight-case Compose receipt cannot qualify the profile.
- A qualification run uses a temporary, exact fixture preview permit. The
  initiating admin ID is stored with the fixture and checked after restart.
  The additive nullable `owner_user_id` migration does not assign owners to
  historical rows.
- The qualification method exercises the registry, token handoff, HTTP,
  WebSocket, access denials, stop, revocation, and cleanup. A proof cannot
  pass if cleanup fails.
- Incus source 0.1.6 no longer advertises unimplemented provider endpoint
  RPC methods. Host preview support remains separately qualified.
- Clean bundle staging builds the authoritative extension contract before
  its consumers and checks the generated outputs.

Focused checks passed: 35 host authority/broker/transport tests; 13 startup
tests; 17 qualification API tests; 66 owner/migration/restart tests; and 17
Python bundle-stage tests. Independent witness/startup checks passed 37 tests.
Measured startup coverage is 173/173 lines. The host witness reaches 100%
line coverage across its focused test union. These are focused results, not
a substitute for final repository gates.

## Built consumer failure and verified repair

The frozen `f6a7faea5` production build passed. Its real-auth browser consumer
loaded the preview page over HTTP but received 403 for the WebSocket upgrade,
despite the expected cookie, Host, Origin, and subprotocol. The run failed.
Its log and browser trace are retained in the isolated
`incus-preview-browser-consumer-sol61-oct07` worktree.

Inspection found that `svelte-adapter-bun` 1.0.1 patches `get_hooks()` in the
generated server entry. The current SvelteKit build puts that function in a
separate chunk, so the generated handler does not receive the exported
WebSocket handler. A strict adapter compatibility repair now runs at the
adapter's build hook. It requires exactly one supported generated shape and
fails the build on missing, duplicate, or partial hooks. No authorization
check is relaxed. Four focused helper tests pass with 100% measured line and
function coverage, and the test is in both required test pools.

The repeated production Chromium consumer passed on clean revision
`79d8980b0de2a5944a1b112ce94126f5d50ded6c`: one test, exit 0, 3.7 minutes.
The built listener reports `with WebSocket`. The browser opens the preview,
receives HTTP 200, exchanges the `vite-hmr` challenge, and observes its socket
close on revocation. Subsequent HTTP returns 404 and a new socket is denied.
Wrong and malformed Host requests each return 404 without the guest proof.
The log is `.cache/incus-preview-browser-consumer/79d8980b0-browser.log` in
the isolated consumer worktree. Combined regression test type checking also
passes. The fixture uses a controlled in-memory backend; this result does
not establish real Incus transport qualification.
Independent receipt review passed. The log SHA-256 is
`e9c90e33299643935aabbe3a85bd4d65f79bf63cf51479c7bf1c4012d2743fdb`.
No passing-run trace or literal 101 log is claimed; the browser's received
WebSocket echo establishes that the upgrade succeeded.

## Remaining release gates

- [x] Complete the adapter repair and pass HTTP, WebSocket, revocation, and
      wrong-Host checks against a fresh production build.
- [ ] Freeze the final source and hand its exact SHA to the API verification
      team for separate final-source gates.
- [ ] Build and review the isolated release bundle with fresh manifest pins.
- [ ] Apply the guarded isolated-app update and preview-host configuration.
- [ ] Build, verify, review, and activate the exact Incus 0.1.6 release through
      v4. Plan its new release-bound connection once; review and apply its
      exact setup plan. Existing connection credentials are reusable only
      when the supported drain and identity checks pass.
- [ ] Obtain real Incus SP09 evidence, complete ten feature lifecycles, and
      verify cleanup, accounting, and bounded secret-leakage captures.
- [ ] Publish final evidence and remaining support limits in PR303.

Root retains sole live ownership. The live isolated app remains at
`2bde0375ef617fd0a529901b418c55c599bdfabb`, manifest
`ada643a7e46fc272d7d9edff34a5fe62fde8ff9eb5dbeb8cdff58db6d8974d04`.
The preview code has not been deployed. No new guest lifecycle or live
preview result is implied by the local checks above.
