# AI-kit E2E tests

These tests exercise the public client against a running EZHarness server and a real database. Use a disposable test instance: some cases create conversations and assignments.

## Standard CI

The real-auth browser lane runs `web/e2e/real-auth/ai-kit-public-api.spec.ts`. It creates a local user API key and reuses the package's doctor, internal-auth, and user-key OBO suites. A second case runs the real stdio MCP subprocess suite with its own database. Both cases reject skipped tests and check Bun against the repository pin. The key and temporary data are removed after the tests.

From the repository root:

```sh
bun scripts/run-real-e2e.ts real-auth e2e/real-auth/ai-kit-public-api.spec.ts
```

This uses the normal real-auth build, server, and database fixtures. The package coverage leg can still report opt-in skips; the public authentication and subprocess contracts above run in the separate real-auth job.

## Optional deployed-service checks

Start a test server, complete initial setup, and create a test API key through Settings → Developer. Grant the scopes required by the selected cases. Then run from the repository root:

```sh
export EZCORP_E2E_BASE_URL=http://localhost:5173
export EZCORP_E2E_API_KEY=ezk_...
bun test ./packages/@ezcorp/ai-kit/test/e2e
```

| File | Contract and additional setup |
| --- | --- |
| `doctor.test.ts` | Server health and client configuration. |
| `internal-auth.test.ts` | Forged internal tokens fail over HTTP; a valid user key authenticates. |
| `on-behalf-of.test.ts` | A user key cannot change persisted ownership through an OBO header. |
| `real-subprocess-obo.test.ts` | Real stdio MCP delegation and database ownership; requires `EZCORP_E2E_SUBPROCESS=1`. |
| `bundled.test.ts` | The AI-kit extension is installed and exposes its tools; prepare a verified release and approve its activation first. |
| `fanout.test.ts` | Agent mentions, team fan-out, and assignments; prepare the agent and team data described in the tests. |
| `quickstart.test.ts` | Create a conversation, send a message, and receive a completed run; requires a configured model/provider. |

Bundled source staging does not approve or activate a release. A pending installation does not satisfy the bundled test's prerequisites. The optional deployed-service cases are separate from the standard CI contracts above.

## Guards

Without the opt-in URL or required key, the corresponding package suites skip. When a URL is supplied, an unhealthy or unavailable server fails the suite. The subprocess suite has its own explicit opt-in and does not require an external model or a deployed server.
