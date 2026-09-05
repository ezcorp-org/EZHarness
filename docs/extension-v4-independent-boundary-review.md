# Extension v4 independent boundary review

Reviewed the merged source admission, approval, binary file, and host UI boundaries. This review excludes the native transport implementation written by the same reviewer. It is not a claim that the system has no defects.

## Confirmed finding and fix

The host page cache and concurrent-render map did not include the viewing user. The render request did include that user. A second user could therefore receive the first user's private page. The same defect affected concurrent requests.

The regression uses the production `renderExtensionPage` function and real `ExtensionPageCache`. Both sequential and concurrent cross-user cases failed before the fix. The original failure log is `/tmp/ez-independent-page-cache-red.log`.

Related review found that page pushes could seed a shared cache, panel state was broadcast to all users, and project page parameters exposed host paths and an unfiltered project list.

- [x] Cache and concurrent-render identity include principal, active release, generation, grants, role, project access, and the complete render scope.
- [x] Read current user, projection, release, and project membership before each cache lookup. Repeat the authority check before storing or returning a new render.
- [x] Do not share concurrent renders between users. Bound active renders to 128; retain the existing 64-variant cache bound.
- [x] Treat all page pushes as invalidation only. Never serve pushed private content as a global page.
- [x] Resolve panel identity from the live host token. Reject missing, expired, ownerless, or wrong-extension tokens. Do not include the token in panel state.
- [x] Filter panel SSE events to their exact host-issued principal, including replay. Missing identity fails closed.
- [x] Filter project lists by current membership and replace host paths with `/project` in extension parameters.
- [x] Set private, no-store HTTP response policy. The route does not return another user's conditional cached response.

## Other boundaries inspected

- Source import stages an immutable workspace and build only. It does not approve or activate a release. Local source requires an administrator. Descriptor-relative directory traversal rejects symlinks and hardlinks and enforces file, count, and byte limits. Source configuration is not evaluated on the host.
- Private GitHub import uses a host-resolved project credential and fixed GitHub API origin. The guarded transport pins approved DNS results, disables redirects for import requests, and checks authority before requests. Repository trees and blobs are bound to a frozen commit; symlink and submodule entries are rejected.
- Binary files use a strict canonical base64 envelope and decoded-byte limits. Code and control files must remain text. Safe path validation rejects parent traversal, reserved paths, and file/directory collisions. Runner staging preserves read-only and executable-file distinctions.
- Release approval requires a human administrator and exact release, policy, profile, ownership, scope, and generation evidence. Activation rechecks the binding and consumes approval atomically. Runtime reverse RPC compares the full host-issued invocation context and active release binding.

No additional exploit was reproduced in these inspected source, binary, approval, or reverse-RPC paths. This is a bounded code and test review, not external penetration testing.

## Evidence

- Native regression cohort: 38 tests, 233 assertions; separate HTTP/TCP grant checks and approved-release denial remain enforced.
- Host render, route, state, and SSE cohort: 243 tests passed before the final additional authority test. Dedicated production-authority render suite: 27 tests passed.
- New and adjacent browser-server unit suites: 34 tests passed. These cover sequential and concurrent user isolation, grant and release changes, revoked membership, authority changes during rendering, compound scope collisions, and the concurrent-render bound.
- Merged Bun and Vitest line evidence for `hub-render-pull.ts`: 250/250 measured lines covered. State mediator measured 108/108 before removal of redundant push-cache code. The final combined CI gate remains required.
- Full backend, web, backend-test, and web-E2E type checks passed. Scoped Biome check passed.

Additional service proof: `src/__tests__/hub-private-page-podman.test.ts` builds and type-checks the page fixture in real rootless Podman, executes it through `ReleaseProcess`, and serves the real page and SSE route handlers over HTTP. Two concurrent users receive separate page results and separate private panel streams. Cache hits preserve their identity, conditional requests do not return a shared 304, a generation change starts a fresh worker, and revocation returns 404 without another worker. The run passed 26 assertions in 8.7 seconds; log `/tmp/ez-private-page-rootless-http.log`.

The service test maps random fixture cookies to host principals. It tests the HTTP handlers, isolated runtime, and SSE pipeline, not production login hooks or a deployed browser session. Rerun the final combined application suite after integration.
