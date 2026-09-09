# Protected browser validation

- [x] Reproduce a real child document reading the parent and session before containment.
- [x] Deny parent DOM, cookies, direct API access, and navigation authority after containment.
- [x] Build the real scanner source and browser assets in the rootless runner.
- [x] Prove a private transferred message port and explicit host camera consent.
- [x] Reproduce HTTP disconnect failing to stop an isolated worker's later storage write.
- [x] Replace disconnect-only cancellation with an exact, durable, host-issued request ticket.
- [x] Prove cancellation through the real browser, HTTP service, database, and isolated worker.
- [x] Independently verify native MCP isolation and PostgreSQL two-client cancellation fences.
- [x] Prove desktop click and mobile tap, including continuous camera start and stop.
- [x] Pass all nine real extension browser specifications together.
- [x] Rebuild and verify the production application image against the real runner.

## Input test contract

The desktop test uses full Chromium. The mobile test starts its own short-lived
Chromium headless-shell process with the Pixel 5 device profile. Both use normal
Playwright pointer methods after genuine wheel or touch scrolling. Mobile waits
for the actual outer scroll container's `scrollend` event before its first tap.
Neither uses forced clicks, script clicks, coordinate
offset correction, relaxed iframe flags, or a conditional fallback.

A separate minimal opaque-iframe probe reproduced incorrect synthetic touch
coordinates in full Chromium headless versions 147 and 151. The same probe with
headless-shell delivers the correct trusted click and camera request. This is a
test-driver observation, not proof of a defect on a physical mobile device. The
mobile process is not reused with the main suite: that suite already records a
headless-shell crash after teardown of a live event stream.

The mobile launch explicitly selects `chromium-headless-shell`: Playwright's test
runner otherwise inherits the full-Chromium project channel even for a manually
launched browser. The passing run records both executable paths. Independent
mobile probes fail six of six taps during kinetic scrolling and pass six of six
after the real `scrollend` event. Desktop uses a real wheel before clicking; its
automatic locator scroll did not reliably route input into the opaque child.
No production input behavior or isolation policy was changed for these probes.

## Evidence

- `/tmp/ez-protected-browser-real8.log`: actual durable browser cancellation passes.
- `/tmp/ez-native-final-independent.log`: real rootless native MCP passes 42 assertions.
- `/tmp/ez-postgres-final-independent.log`: fresh PostgreSQL 16, two independent connections; lifecycle, receipts, delivery fencing, cancellation, and SQL effect ordering pass.
- `/tmp/ez-protected-browser-pointer20.log`: real scanner build, approved tools, full-Chromium desktop click, headless-shell mobile tap, explicit host camera start/stop, JPEG frames, session isolation, revocation, and 24px mobile gutters pass.
- `/tmp/ez-runner-final-independent.log`: 36 runner tests and 266 assertions pass, including real rootless isolation.
- `/tmp/ez-runner-path-probe-final.log`: the real malicious host-path probe passes without swallowing unexpected errors.
- `/tmp/ez-container-final-verify3.log`: production image `815764c0a0adc87d7206f1fe8cf0ae2ac7a85791700488d1e2fd88f5b7cd271b` passes boot, file credential, isolated build, human approval, activation, tool invocation, disable denial, and retained history checks after the Hub authorization and mobile gutter fixes.
- `/tmp/ez-extension-v4-real-final10.log`: all nine real browser specifications pass together in 2.5 minutes on the final product source and cleaned input test. This includes authoring, binary assets, durable browser cancellation, chat self-build, failed-update retention, project authority, release gates, marketplace source import, and the protected scanner. Cancellation waits for the durable response before a separate worker releases the test's storage latch.
- `/tmp/ez-scanner-pointer20-blob.zip` and `/tmp/ez-scanner-pointer20-mobile.zip`: passing desktop/mobile screenshots and the mobile input trace. Desktop and mobile PNGs are also saved as `/tmp/extension-scanner-trusted-camera.png` and `/tmp/extension-scanner-protected-mobile.png`.

Earlier production verification runs also passed. Image `4708304a51cc` preceded
the Hub action authorization fix; image
`ba4cb8b0db435a9f8fbbf5dae73969ebd7aba1eb29925d716439424ab3bf76d1`
included that fix but preceded the mobile gutter adjustment. Only the final
`815764c0a0ad` image represents both final product changes. Their build/verification
logs are `/tmp/ez-container-final-{build,verify}.log`,
`/tmp/ez-container-final-{build,verify}2.log`, and
`/tmp/ez-container-final-{build,verify}3.log` respectively.

Cancellation prevents later effects after the durable guard observes the request.
It does not undo earlier admitted effects. An uncertain outcome must not be replayed.
