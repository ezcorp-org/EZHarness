# Shared GitHub App without central credential handling

## Goal

One public GitHub App serves independent self-hosted EZCorp installations. Users connect from their own installation. The supported flows send our Cloudflare Worker no GitHub access tokens, refresh tokens, device codes, user codes, local session identities, repository content, or installation URLs. The Worker rejects requests with query strings or credential headers, does not read request bodies, and does not log or persist submitted data.

The user supplied public App ID `5049328`, Client ID `Iv23linp84AzzvCGxstF`, and Worker hostname `github-auth.ezcorp.org`. GitHub's public App API confirms those values, owner `ezcorp-org`, name `EZCorp Github Auth`, and slug `ezcorp-github-auth`.

## Design

- GitHub device authorization starts and is polled by the self-hosted backend, directly against GitHub. Its browser only receives the user-facing code and fixed GitHub verification link.
- Device attempts are durable, expire, and belong to one verified local user and session. The backend enforces GitHub's polling interval and slow-down responses even if callers poll concurrently. Cancellation, disconnect, reconnect, session revocation, and superseding attempts cannot install a stale token.
- Tokens remain encrypted in the installation database. Existing owner-only sandbox, immutable run snapshot, repository permission, generation, and PR publication checks remain in force.
- Refresh for device-issued credentials calls GitHub directly without a client secret. Existing OAuth-issued tokens must remain explicitly distinguishable; they must not silently be treated as device tokens.
- The Worker is a public information service only: a landing/setup page, public App metadata, and health. No authentication relay, token endpoint, webhook, arbitrary redirect, upstream proxy, or registration database.
- The Worker has no KV, D1, Durable Objects, R2, queues, analytics binding, cookies, or application request logging. Disable Workers Logs/tracing and Logpush in its configuration. This states what our application stores; Cloudflare's platform processing is a separate operator policy, not a claim that no provider can observe network traffic.
- Each installation is configured with the public App ID, slug, and client ID, plus its existing stable local instance ID. No shared secret or callback URL is required in device mode. The Worker publishes those same public values for setup; it is not in the token or PR request path.
- Ship the confirmed public shared-App identity as local defaults so end users do not register or configure their own App. Derive a stable local instance identity from the existing persistent encryption material when no legacy explicit identity is set. Preserve explicit legacy identities so their encrypted records remain readable.
- Leave GitHub App Callback and Setup URLs blank, OAuth-on-install disabled, and webhooks inactive. Only the Homepage URL may point to the public Worker. Local UI links must not leak their origin through Referer to that Worker.
- Device disconnect deletes local credentials and advances the local generation fence. It must not claim remote GitHub revocation through the old secret-required revoke endpoint. Guide users to GitHub's authorized-App settings when they want to revoke there.
- HTTPS remains required for exposed user sessions. Device flow removes the need for a GitHub-reachable callback, not the need to protect browser sessions.

## API contract

- `POST /api/github/device/start`: verified session only; returns `{ attemptId, userCode, verificationUri, expiresAt, intervalSeconds }` with no-store headers. Never returns `device_code`.
- `POST /api/github/device/poll`: verified same session and owner, body `{ attemptId }`; returns `{ status, nextPollAt? }`, where status is `pending`, `slow_down`, `connected`, `expired`, `denied`, or `cancelled`.
- `POST /api/github/device/cancel`: verified same session and owner, body `{ attemptId }`; returns `{ status: "cancelled" }`. A connected attempt cannot be cancelled; use Disconnect.
- Existing connection status and repository checks remain the source of account/access state after completion.
- Device mode is the shared-App default. Retain old OAuth only through explicit separate configuration if needed for compatibility; its credentials must never be required or sent by device mode.

## User flow

1. Select Connect GitHub in the installation's Settings.
2. See the short code and a button that opens `https://github.com/login/device`.
3. Enter the code on GitHub and approve the account shown there.
4. Return to the existing Settings tab; completion is detected without a redirect.
5. Install/enable the App for selected repositories through the existing repository access flow.

Show cancel, expiry, denied access, network failure, reconnect, and polling backoff states. Preserve return-to-review context locally. Explain that users should only enter a code they just requested in their own installation.

## Work and acceptance

- [x] Sol backend author: durable device flow, direct refresh, transport validation, migration, regression coverage.
- [ ] Sol web author: session-only routes, Settings device flow, account recovery, desktop/mobile evidence and tests.
- [x] Sol Worker author: stateless public service, configuration, generated types, local Worker proof, deployment instructions.
- [x] Coordinator: shared contract, route registry, coverage wiring, deployment/env docs, integration.
- [ ] Separate Sol review team: cross-user/session/install isolation, refresh/cancel races, no central credential handling, user flow, Worker data handling.
- [ ] Resolve all review findings; run complete local checks without weakening gates.
- [x] Live GitHub device-flow and refresh proof after the operator supplies the public App configuration. No substitute CLI token proof.
- [ ] Worker deployment after an exact Cloudflare target is available and authorized; local build and runtime proof do not imply a live deployment.

## Sources checked 2026-09-23

Live proof: the operator approved a code created by the real local broker. GitHub connected as `EZArchy`; repository access to `ezcorp-org/factory-platform-publication-tests` and direct refresh without a client secret passed. The local connection was then removed. The Worker was deployed as `ezcorp-github-app-directory-production`, version `8a390eba-9178-40cb-aea4-e248cc00474b`; public DNS/HTTPS verification remains separate from deployment success.

- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
- https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
