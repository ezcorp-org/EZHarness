# Extension browser boundary

## Evidence and gates

- [x] Reproduce with Chromium and the real data route: a framed extension reads parent DOM and calls session APIs.
- [x] Apply response CSP sandbox to direct HTML and SVG, not only embedded frames.
- [x] Remove same-origin authority from the frame and shared SDK constant.
- [x] Reject arbitrary app URLs, foreign extension paths, encoded separators, and user-info URLs.
- [x] Block direct network and device access from untrusted documents.
- [x] Verify HTML/SVG cookie, storage, and API denial; verify an inline canvas button still works.
- [ ] Verify trusted sidebar controls and any new message bridge in the real app.
- [ ] Restore scanner camera and tool access through an explicit host-owned interface, not app cookies.
- [ ] Run all affected tests, full typecheck, coverage, and lint.

## Boundaries

Extension data documents have an opaque origin. They can run inline scripts and render embedded assets. They cannot read the parent, browser storage, cookies, app APIs, or arbitrary network resources. The response policy also applies when a user opens an HTML or SVG URL directly.

The trusted preview owns the conversation and tool-call IDs. Payload fields cannot replace these IDs. Its private message port binds the actual frame window and opaque origin, checks live extension authority, and exposes only the sealed tool list and explicit camera operations. It exposes no general fetch, arbitrary tool execution, or host DOM access.

The scanner now uses the shared browser SDK, bundled local code, tool-backed storage, and the host camera interface. The host obtains explicit camera consent and provides bounded frames. The generic development preview proxy is not an extension authorization service. Final protected desktop and mobile validation remains a separate gate.

## Current proof

`web/src/__tests__/extension-browser-isolation.test.ts` serves the actual route over HTTP with a private test session cookie. It launches Chromium, reproduces the old parent/session escape, verifies the corrected denial, and clicks an inline canvas control. It tests direct HTML and SVG navigation as well. The fixture does not claim production login or full scanner parity.
