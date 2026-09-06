# Mock-lane 500 classification

This is a source-and-receipt classification only. It does not identify the
individual request behind each opaque error, because `handleError` records an
empty serialized error object and no request URL.

## Result

The `hooks.server` 500 entries are a pre-existing `PI_SKIP_INIT` mock-preview
artifact. They are not attributable to the September 6 chat observability
batch-read change, and no fixture or production change follows from this
review.

The earlier mock CI receipt, from September 5 and before commit
`a6af35e9d286c24330fc56bb61f316e92a31b6dc`, contains **105** identical
`hooks.server` 500 entries while its mock lane passed **210** tests with **12**
Docker skips:

`/home/dev/work/EZCorp/extension-v4-independent-audit/docs/validation/extension-v4-independent/parent/hosted-ci.log.gz`

SHA-256: `5aed71c0a859bccf5f2b1f25439f8793eddd3c270efdb5a86ea2c30e8798dfc1`.

The current parent receipt contains **106** identical entries while passing
**210** tests with **13** Docker skips:

`/home/dev/work/EZCorp/extension-v4-independent-audit/.cache/terra-flow-validation/parent/mock-gate.log`

SHA-256: `e3011acee87150ec38e589d1bcad6bd5ce184f894e29f90b0284e16d36a673da`.

The one-entry count difference alone cannot identify a route. Both receipts
show the errors throughout unrelated mocked specifications, rather than at a
new extension lifecycle flow.

## Source basis

Commit `a6af35e9` changed the chat page from a per-key request to
`fetchSettings()` (`web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte`,
lines 111-118). The browser mock already fulfills `GET /api/settings` with the
configured settings object (`web/e2e/fixtures/api-mocks.ts`, lines 937-940),
so this request has a complete client-side fixture.

The mock preview deliberately starts with `PI_SKIP_INIT=1`
(`web/playwright.config.ts`, lines 83-85). In that mode the hook permits a
request through when the initial user-count database read cannot run
(`web/src/hooks.server.ts`, lines 649-659), while page-server loads and other
server work can still reach the absent database. The Playwright route fixture
only intercepts browser requests (`page.route("**/api/**", ...)` in
`web/e2e/fixtures/api-mocks.ts`, line 470); it cannot fulfill server-side
loads. This explains the class of preview-only opaque errors, but does not
claim an exact route for each entry.

The real-auth UI replay has empty browser console, page-error, lifecycle API,
and other API error arrays. No focused replay, trace, fixture edit, or
production edit is justified by these receipts.
