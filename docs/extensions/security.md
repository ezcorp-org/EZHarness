# Extension security

## Boundary

Treat all extension source, build steps, dependencies, assets, and runtime output as untrusted. The host accepts bounded data. It never imports extension configuration or runs extension postinstall code.

Build, test, discovery, and execution use the authenticated rootless Podman runner. Source, dependency closure, and artifacts are immutable and digest-bound. The runner applies resource, process, filesystem, and network restrictions. Missing controls fail closed; there is no automatic host-process fallback.

A fresh runtime worker receives one host-owned invocation context. It cannot choose another principal, release, project, or conversation. Host calls must match that context and the current approved installation. Cancellation, expiry, disable, and revocation prevent further authorized calls.

Rootless containers share the host kernel. They are not a defense against a compromised host administrator or every kernel defect. Keep the host and runner patched; do not expose the runner socket or token to extensions.

## Approval

Only an authenticated human administrator can approve the exact tested release. Agent/API-key and CLI requests cannot provide this approval. The review binds the release, requested grants, runner profile, policy, owner, and scope. Activation checks the binding again.

Changing source, dependencies, tests, permissions, or scope requires another build and review. First-party source is not exempt. `manifest.lock.json` records host-approved first-party source identity; it does not enable an installation or grant permissions.

Project access is host-resolved and checked again before effects. A project path in a payload is not authority. Project writes and pull-request operations must satisfy their additional proposal and revision checks.

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
