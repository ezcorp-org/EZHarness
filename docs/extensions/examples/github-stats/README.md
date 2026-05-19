# github-stats Extension

A tool extension that fetches GitHub repository and user statistics via the GitHub API. This example demonstrates **network permissions**, **environment variables**, and **resource limits**.

## Install

```bash
ezcorp ext install ./docs/extensions/examples/github-stats
```

## Manifest Walkthrough

### `schemaVersion: 2`

All extensions use schema version 2, the current manifest format.

### `tools` (3 tools)

- **repo-stats** - Fetches repository metadata (stars, forks, issues, language)
- **user-profile** - Fetches a GitHub user's public profile
- **repo-languages** - Fetches the language breakdown for a repository

Each tool declares an `inputSchema` so the platform knows what arguments to pass.

### `permissions.network`

```json
"network": ["api.github.com"]
```

This extension makes outbound HTTP requests to `api.github.com`. The platform enforces that only this domain is reachable -- any other network calls are blocked.

### `permissions.env`

```json
"env": ["GITHUB_TOKEN"]
```

The extension can read the `GITHUB_TOKEN` environment variable for authenticated API requests. Without it, the extension still works but is subject to lower rate limits.

### `resources.memory`

```json
"resources": { "memory": "256MB" }
```

The subprocess is capped at 256MB of memory. This prevents runaway allocations from affecting the host system.

## Entrypoint

`index.ts` implements a JSON-RPC 2.0 server over stdio. It reads newline-delimited JSON from stdin and writes responses to stdout. Each `tools/call` request is dispatched to the appropriate handler.

## Testing

```bash
bun test docs/extensions/examples/github-stats/index.test.ts
```

Tests mock `globalThis.fetch` to avoid real API calls and verify each tool returns the expected response shape, plus error handling for 404 and 403 responses.
