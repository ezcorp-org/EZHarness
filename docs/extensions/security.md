# Extension security

## Boundary

Treat all extension source, build steps, dependencies, assets, and runtime output as untrusted. The host accepts bounded data. It never imports extension configuration or runs extension postinstall code.

Build, test, discovery, and execution use the authenticated rootless Podman runner. Source, dependency closure, and artifacts are immutable and digest-bound. The runner applies resource, process, filesystem, and network restrictions. Missing controls fail closed; there is no automatic host-process fallback.

The separately configured `trusted-local` adapter is an explicit exception, not recovery from a runner failure. It requires approval for the exact build or execution digest, an expiry, an audit record and acknowledgement of omitted controls. It runs under a dedicated non-root account and must never be described as isolated. The historical [trusted fallback decision](../extension-system-v4-plan.md#trusted-fallback) does not authorize automatic fallback in the normal host lifecycle.

Host wiring for that adapter (`src/extensions/runner-mode.ts`, fail-closed): `EZCORP_EXTENSION_RUNNER=trusted-local` together with `EZCORP_EXTENSIONS_UNSANDBOXED_ACK=I-understand-extensions-run-with-the-apps-full-powers` — exactly that sentence — selects it; either alone, an unknown value, or an isolated-runner socket setting alongside it refuses boot. The runner then executes as the app's own non-root uid (the production image's uid 1000) with `setpriv --no-new-privs` and all capabilities dropped, and nothing else. A human acknowledges each phase: the Build action needs `acknowledgeUnsandboxed: true` (recorded for the exact source digest, because building runs the extension's tests, and extended for fifteen minutes to the artifact it produces so candidate verification — which starts a worker — can run under the same acknowledgement) and "Approve exact release" needs the same (recorded for the exact artifact digest, long-lived). Each record is a row in `extension_trusted_local_approvals`, keyed per installation and expiring after 180 days; it is what `approvalFor()` reads, and revoke, disable and uninstall delete it. Releases built this way carry `runnerProfile` `trusted-local-v4` and an image digest prefixed `localhost/trusted-local@`, so switching a host between modes stales every existing approval. The host logs at error level on every boot in this mode, `/api/health?detail=true` reports `extensions.runner`, and every authenticated page shows a standing banner. Rationale: [decision record](../decisions/2026-09-12-extension-runner-install-burden.md).

A fresh runtime worker receives one host-owned invocation context. It cannot choose another principal, release, project, or conversation. Host calls must match that context and the current approved installation. Cancellation, expiry, disable, and revocation prevent further authorized calls.

Rootless containers share the host kernel. They are not a defense against a compromised host administrator or every kernel defect. Keep the host and runner patched; do not expose the runner socket or token to extensions.

## Approval

Only an authenticated human administrator can approve the exact tested release. Agent/API-key and CLI requests cannot provide this approval. The review binds the release, requested grants, runner profile, policy, owner, and scope. Activation checks the binding again.

Changing source, dependencies, tests, permissions, or scope requires another build and review. First-party source is not exempt. `manifest.lock.json` records host-approved first-party source identity; it does not enable an installation or grant permissions.

Project access is host-resolved and checked again before effects. A project path in a payload is not authority. Project writes and pull-request operations must satisfy their additional proposal and revision checks.

## Service workflows

Release approval and job consent are separate human decisions. A service job needs a live service account and human consent bound to the exact sealed release, workflow closure, project and limits. The host records this binding; an extension or API key cannot supply it. A changed release requires new consent, even if the workflow body is unchanged.

A service run uses the service account ID as its principal and keeps the human `userId` null. It must not borrow the consenting person's identity or invent a user conversation. The host checks the persisted running workflow, release binding, delegation, account and project authority again before effects. Revocation, cancellation and run cleanup end further authority; they do not undo effects already admitted.

Service code agents receive explicit input only, not ambient account settings, project variables, host working directories or provider credentials. Direct host `ctx.file`, `ctx.shell` and `ctx.llm` adapters are denied. Use approved extension tools through `ctx.tools`, with the service's own capability limits. Nested agents retain these restrictions.

Not every broker is service-enabled. Missing service support must fail closed, not substitute a human principal or use a raw host provider. Verify each required broker with a real service invocation before deployment. A passing pure-tool identity test does not prove storage, filesystem, network or credential access. See [service authoring](AUTHORING.md#service-workflows).

## Network and credentials

HTTP requests use the host broker, bounded bodies, approved destinations, and pinned DNS resolution. Private addresses require their separate explicit policy. Redirects cannot escape the granted destination rules.

Normal HTTP credentials are opaque handles. The host resolves them for the approved request; workers do not receive secret bytes. Never place secrets or handles in logs, source, settings, or returned output.

Native stdio MCP can use the controlled loopback proxy when the exact release has the required grants. `network` covers HTTP policy; `networkTcp` permits opaque TCP to exact endpoints and is a broader capability. Native code remains responsible for TLS certificate verification. No unrestricted direct-network fallback exists.

`secretRead` is a separate, explicit grant for supported native credential providers. Native code can read those bytes and could return them or send them to an approved network destination. Human review must acknowledge this risk. Prefer opaque HTTP credentials. Build and catalog discovery remain offline and credential-free. See [the native transport contract](../extension-native-proxy-plan.md).

## Private output

Served extension HTML and SVG have an opaque browser origin through both iframe and response CSP sandboxing. Inline scripts remain possible; application DOM, cookies, origin storage, direct network calls, and session APIs do not. Direct-open documents retain the response sandbox. Only the current extension's data URLs are accepted as preview targets. Do not restore `allow-same-origin` or add a generic authenticated fetch bridge to support a feature.

Page cache and concurrent-render identity include the principal, live release authority, and full scope. Authority is checked before cache use and after rendering. HTTP page responses are private and not stored by shared caches. Page pushes invalidate caches; they do not supply a global private page.

Panel identity comes from the host invocation token. SSE sends panel content only to that principal. Project metadata is filtered for current access, and worker parameters use virtual paths rather than host paths.

## Durability and limits

Durable source events must commit with their source state. Accepted actions use owner-scoped receipts so equal retries do not repeat delivery and changed requests conflict. Host UI notification follows commit. Live progress and content-free invalidations are not durable business records.

Each subscriber receives only its approved event representation. Default terminal events omit large logs and result output; the source record remains intact. Full-payload approval does not remove payload limits. Queue or representation overflow fails the source transaction instead of silently dropping an event.

Receipts have bounded capacity and retention. External effects whose outcome cannot be established remain `outcome_unknown`; do not automatically repeat them. These controls do not claim exactly-once external effects or full resumption of an interrupted model turn.

## Required proof

Test malformed source, path escapes, denied capabilities, cross-user access, revoked grants, cancellation, restart, and failed publication using the production runner and broker. Keep builder feature tests separate from host-owned security checks. A mocked transport or passing compilation does not establish isolation.
