# Gate: Wave 3 preview and attachment routing

Date: 2026-09-22
Scope: fail-closed routing for workspace attachments and previews. This gate
does not qualify a live sandbox attachment store or preview relay.

## Result

PASS for the routing and denial slice. `WorkspaceTarget` carries narrow
attachment and preview capabilities. Each sandbox request carries the full
host-selected binding, including connection, release and settings digests,
and generation. The persisted preview row contains only the target reference.
A forged or expired sandbox row cannot select a local file or loopback port.
The provider receives a new request with preview cookies, Authorization,
proxy credentials, internal headers, and forwarded identity headers removed;
the request method and body remain available.

Production web routes have no resolver that turns a durable sandbox binding
into a live attachment or preview backend. They deny sandbox attachment
downloads, message sends, and conversation deletion before AMD file access
or database mutation. HTTP preview dispatch returns an unavailable response
for sandbox rows; WebSocket upgrade is denied. A local preview also stops
serving if its project receives a sandbox binding after preview creation.
Local attachment and preview behavior remains covered by existing tests.

## Evidence

- Pinned runtime: Bun 1.3.14, `/nix/store/7hqaibb70a221fg6gk01qm8w662lci8k-bun-1.3.14/bin/bun`.
- Focused suite: 177 passed, 0 failed, 1027 assertions across 11 files. It
  includes AMD attachment and preview canaries, forged generation, expiry,
  owner checks, local compatibility, production route denial, header and POST
  body handling, and the local-preview-to-sandbox transition.
- Independent reproduction on pinned Bun 1.3.14: a request with only Cookie,
  Authorization, and `x-ezcorp-*` headers reaches the provider with `{}`
  headers. This catches Bun retaining original headers when a replacement
  empty `Headers` object is passed to `new Request(original, ...)`.
- Preview dispatch Vitest suite: 22 passed in one file, run from `web/` with
  `bun x vitest run src/__tests__/preview-dispatch.server.test.ts`.
- Follow-up combined-lane regressions: the live session-history parity file
  passes 14 tests and 33 assertions, including a real image rehydration and
  sandbox-binding denial canary with both an omitted target and a stale local
  target. The extension-upload route file passes 22
  tests and 49 assertions, including a bound-project denial before bytes or
  an attachment row are written. The affected routing and image suite passes
  201 tests and 1075 assertions across 12 files; the project-target integration
  file passes 2 more tests.
- `bun run typecheck`: backend, web, backend tests, and web E2E typechecks pass.
- `bun run lint`: exit 0, with eight informational findings outside this
  slice.
- `git diff --check`: exit 0.

Direct history callers that omit a target now resolve the project from the
persisted conversation and use the durable binding guard. An explicit local
target also passes that guard before attachment bytes are read. This restores
local image rehydration and denies a sandbox project before AMD access.
The extension-upload route uses the same selector and returns 503 on denial.

## Live work still required

- Implement and qualify a provider attachment store and wire a controller
  resolver into production request handling. Define durable attachment
  placement and cleanup before enabling sandbox uploads.
- Implement an authenticated provider HTTP and WebSocket preview relay, and
  inject its resolver into web dispatch. Qualify reconnect, expiry, revocation,
  quota enforcement and recovery across restart.
- Rehydrate the full target reference from durable controller state and
  validate project, connection, release, preset and generation before a live
  backend handle is used.
