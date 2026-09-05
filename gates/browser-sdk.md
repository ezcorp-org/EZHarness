# Browser SDK gates

- [x] Expose one pure browser entrypoint; no Node imports, stdin, AJV or dynamic code generation.
- [x] Bind one private MessageChannel to the host-injected nonce and exact parent origin.
- [x] Bound and validate JSON requests, responses, pending calls and deadlines.
- [x] Send exact-call cancellation; close all calls and ports on page hide.
- [x] Keep camera subscription data bounded; no camera or session credentials in the frame.
- [x] Test real MessagePorts, wrong nonce, malformed response, capacity, timeout and cancellation.
- [x] Verify a browser-target bundle and SDK declarations.
- [x] Scanner consumes this client; real host and browser E2E pass together in `/tmp/ez-extension-v4-real-final10.log` (nine tests). The private browser cancellation test also proves durable cancellation prevents a later isolated-worker storage effect; see protected-browser-validation.md.

Cancellation stops pending work where possible. It cannot undo committed effects.
