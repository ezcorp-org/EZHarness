# Native MCP network boundary

## Contract

- Keep the existing rootless profile and `--network=none` unchanged.
- Start a trusted SDK loopback proxy only for an active invocation. The SDK is supplied by the runner, not copied from extension source. Discovery and build receive no proxy or capability context.
- HTTP proxy requests use the existing invocation-bound HTTP broker. Remove hop-by-hop headers; reject upgrades, credentials in URLs, unsupported methods and oversized messages. Existing host DNS, redirect, origin, credential-handle and response limits remain authoritative.
- CONNECT uses a separate `networkTcp` list of exact `host:port` destinations. An HTTP `network` grant never permits a tunnel. Approval must show that tunnel traffic is opaque and is not HTTP-inspected.
- Tunnel methods are `ezcorp/network.tunnel.open`, `.write`, `.read`, and `.close`. Open returns a random opaque handle. Each later method checks the same active host call token, extension and declared/live grant. Reads and writes use canonical base64 chunks, ordered sequence numbers and bounded buffers.
- The host resolves and validates every address before opening one pinned connection. Private destinations require a separately configured exact IP-and-port allowlist as well as the release grant. There is no arbitrary host network namespace, SOCKS proxy, UDP, listener or shell interface.
- A tunnel has a maximum lifetime, byte budget and concurrency budget. Revocation, cancellation, EOF, protocol error and worker exit close it. Pending reads periodically recheck live authority. Writes never retry after an uncertain socket effect.
- CONNECT relays TLS unchanged. It cannot inject credentials inside TLS. No TLS interception, host CA installation or ambient secret inheritance is introduced.
- Raw provider access requires a separate exact `secretRead` grant and `ezcorp/credentials.read`. Supported names are `OPENAI_API_KEY`, `OPENAI_ACCESS_TOKEN`, and `GITHUB_TOKEN`. Only an active administrator may extract these values; normal users can still use approved opaque handles. GitHub also requires an owned conversation and current project access. Grant approval cannot override these principal checks. The generic secrets-store scope/path API is never exposed.
- The SDK obtains raw values only during an active invocation and passes them to that invocation's native child environment. Discovery and build remain offline and credential-free. Approval must warn that native code can read these bytes and send them over an approved network destination or return them in tool output. Prefer opaque HTTP credentials when possible. This is an explicit, narrow exception to the default rule against raw reverse-RPC credentials, not a claim that native code cannot disclose an explicitly granted secret.
- Proxy environment values override child-supplied proxy settings. The loopback listener is bound to the active worker only and is closed before the invocation ends.

## Implementation gates

- [x] Add shared exact TCP destination validation, permission projection and approval text. Test HTTP/TCP separation and malformed destinations.
- [x] Add bounded host tunnel broker and dispatch entries. Test DNS pinning, private addresses, wrong token/extension, live grant revocation, read/write sequences, quotas and cleanup.
- [x] Add trusted SDK loopback HTTP/CONNECT relay. Test request parsing, hop headers, bounded bodies, connection handling, no-startup access and cancellation.
- [x] Enable network stdio staging only through these declared grants. Keep runtime package installation and plaintext secret rejection.
- [x] Run a real rootless MCP fixture against a controlled HTTP/TLS service through the broker. Prove raw direct connections remain blocked, revoke an active tunnel, and reject another invocation's handle.
- [x] Run focused suites, type checks, measured coverage and the existing real offline MCP test. No skipped isolation checks or weakened gates.

## Required evidence

Record exact test commands and logs. The real test must use the production relay and host authorization path, not return fabricated network success. Controlled host services are test fixtures; no external provider credentials are required. Only mark this feature complete after every gate passes.

## Support and limits

- Native clients must honor the supplied HTTP proxy environment or explicitly use that proxy. Direct sockets remain blocked by the container network namespace. SOCKS, UDP, host listeners, and transparent traffic interception are not supplied.
- HTTP proxy traffic keeps host HTTP policy, pinned DNS, redirect checks, and opaque credential injection. CONNECT permits an opaque TCP stream to one approved endpoint; it is not an HTTP-origin restriction inside that stream. A destination that forwards traffic can itself forward it elsewhere. Approval must account for that endpoint's behavior.
- HTTPS command URLs request exact CONNECT endpoints. Extra dynamic destinations or `secretRead` providers must be declared in the editable source manifest, built, and approved as a new exact release.
- Catalog discovery must work without network access or credentials. A server that requires a live provider call or secret merely to start or list tools is not supported by this offline build profile. No fake catalog or secret is substituted.
- A TLS client remains responsible for verifying its destination certificate. The relay does not terminate TLS. The controlled integration fixture verifies its locally generated certificate against an exact public test CA included in its sealed source; certificate verification is not disabled.
- Revocation closes active streams, but cannot undo bytes already received by a remote endpoint. Writes with an uncertain outcome are never retried automatically.

## Verification record

- `bun test packages/@ezcorp/extension-runner/tests/native-network.integration.test.ts`: actual rootless build, typecheck, discovery and native MCP execution; HTTP, TCP, verified TLS, TLS hostname rejection, direct-network denial, revoked grant, raw credential digest and principal-resolver denial. 1 test, 41 assertions; `/tmp/ez-native-verified-tls.log`.
- `bun test src/extensions/__tests__/network-tunnel-broker.test.ts`: 9 tests, 1,660 assertions, including actual 32 MiB duplex budget exhaustion and a five-second stalled-policy deadline; `/tmp/ez-tunnel-limits.log`.
- `EZCORP_RUN_PODMAN_TESTS=1 bun test ./packages/@ezcorp/sdk/src/v4/mcp.test.ts`: 7 tests, 32 assertions, including the existing actual networkless MCP executable; `/tmp/ez-native-mcp-sdk.log`.
- Final focused contract, host broker, SDK HTTP/MCP and staging suites: 41 tests, 1,934 assertions with real Podman enabled; `/tmp/ez-native-final-coverage.log`. Measured new source line coverage: TCP codec 19/19, loopback proxy 123/123, tunnel broker 144/144; credential broker 81/81, SDK context 24/24 and SDK MCP 69/69. Related permission, grant, MCP capability and policy-cache regression suites: 147 tests, 300 assertions; `/tmp/ez-native-regression.log`.
- Human approval warning and credential-principal resolver suites: 20 passing tests; `/tmp/ez-native-ui.log`. Ordinary active users can use opaque provider credentials but cannot extract them; inactive administrators and unrelated GitHub project scopes are denied.
- Shared schema regeneration check passed. Both trusted package builds and `bun x tsc --noEmit -p tsconfig.typecheck.json` passed. The unscoped repository tsconfig is not the root typecheck gate and includes unresolved Svelte-generated test imports; it was not reported as passing.
- After merging the binary-source changes, full `bun run typecheck` passed: backend, SvelteKit, backend tests and web end-to-end tests; `/tmp/ez-native-full-typecheck.log`. The HTTP authorization helper accepts only its required header shape, avoiding incompatible Bun/Node request identity types.

Use pinned Bun 1.3.14 with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` for these checks. The real runner test is not skipped when Podman is absent: it fails its rootless isolation probe.
