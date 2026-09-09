# Extension API reference

## Host control

The harness and HTTP client share the five control tools declared in [extension-control.ts](../../src/extensions/extension-control.ts). Read their current schemas instead of duplicating parameter lists.

| Tool | Purpose |
|---|---|
| `extensions_describe` | Current SDK template, supported features, and release rules. |
| `extensions_workspace` | Create, list, read, edit, fork, or resolve dependencies. |
| `extensions_build` | Submit the exact revision for isolated verification. |
| `extensions_inspect` | Read durable operation, workspace, release, and approval state. |
| `extensions_release` | Request approval, activate, roll back, disable, or uninstall. Never approve. |

For HTTP, send an authenticated `POST /api/extensions/control` with `{ "tool": "extensions_describe", "input": {} }`. API keys need the `extensions` scope and the caller's applicable ownership and role. The host derives actor and installation scope; a request cannot supply its own authority.

Edits require `expectedRevision`. Builds require an idempotency key. Activation uses the exact approval and expected active release. On a conflict, inspect current state before retrying. Reuse a key only for an identical operation.

Human approval uses the release review page and its session-only approval endpoint. An API key with an administrator role is not a human session. `requestApproval` and HTTP acceptance are not activation success.

See [Authoring](AUTHORING.md) for the ordered workflow and [the harness client package](../../packages/@ezcorp/harness-client/README.md) for remote use.

## SDK entrypoints

Use `@ezcorp/sdk/v4` for `defineExtension`, `serve`, `validateManifest`, and the invocation context. The SDK owns framing, cancellation, dispatch, and schema validation. Do not add a stdin reader or write protocol frames to stdout.

`defineRuntimeManifest` and `createRuntimeExtension` retain the SDK tool, event, page, and other contribution registration helpers. Use them inside the worker entrypoint, not in host configuration. Registration must finish before serving and must not perform host effects.

`@ezcorp/sdk/scaffold` exports the shared source scaffold. Use it instead of maintaining a separate template in the harness. See [the SDK guide](../../packages/@ezcorp/sdk/src/v4/README.md) for exact interfaces.

## Host calls

Handlers use `ctx.call(method, input)` or supported `@ezcorp/sdk/runtime` helpers during an active invocation. The host validates release, worker, principal, scope, deadline, and grants. Saving a context and using it after completion fails.

The runtime helpers work in both `defineExtension` and `createRuntimeExtension` handlers. They share the active invocation channel; do not start another channel or stdin reader.

Important retained surfaces include:

- `ezcorp/storage`: scoped host storage and bounded batches.
- `ezcorp/fs.*`: virtual filesystem operations; use `/project` and `/data`.
- Host-mediated network requests and opaque credential injection.
- Page, panel, task, loop, and custom-event helpers.
- Host-owned message, attachment, workflow, and child-agent operations under their respective permissions.

The wire schema and broker, not extension-supplied identity fields, define the allowed operation. A tool result does not bypass page validation, output limits, or capability checks.

## Actions and events

### Reverse RPC: ezcorp/append-message

The scoped host message writer saves the message, cards, attachment links, and durable message event in one transaction. Queue rejection rolls back those changes. Use the SDK helper; the host resolves the conversation and author from invocation authority.

### Reverse RPC: ezcorp/finalize-tool-call

The host finalizes the matching tool-call record under the current invocation. A caller cannot finalize another user's tool call by supplying an identifier. See [message toolbar](message-toolbar.md) for custom actions.

Custom HTTP actions require a bounded `Idempotency-Key`. The same principal, scope, key, and payload identify a retry. Changing payload or scope under that key conflicts.

Conversation custom actions acknowledge durable admission. Hub actions wait for the isolated handler outcome. Neither response grants human approval. Failed or uncertain worker effects must not be reported as successful execution.

Durable domain events are queued in the source transaction. Live progress and content-free invalidations remain transient. Each recipient needs its sealed and current scoped subscription grant. Full-payload permission does not remove byte limits.

## Storage API

`Storage` from `@ezcorp/sdk/runtime` supports `get`, `set`, `delete`, `list`, and `batch`. Construct it with the desired scope: `new Storage("user")`. Scope is `user`, `conversation`, or `global`; the host supplies its identifier. Per-user private state belongs in user scope. Settings are not credential storage.

Writes and batches enforce quotas transactionally. A batch does not make a preceding separate read atomic. See [Storage](data-storage.md) for concurrency and filesystem rules.

`withLock(key, action)` and `createMutex(key)` coordinate separate workers through host-held ownership. Use explicit stable keys. Inspect quarantine with `extensions_inspect` and `locks: true`; only a human administrator can use `extensions_release` with `action: "recoverLock"`. See [Runtime locks](../extension-runtime-locks.md).

## CLI

Invoke `bun src/cli.ts ext ...` from the repository root; there is no installed binary.

| Command | Current behavior |
|---|---|
| `init <name>` | Write the shared default v4 scaffold; `--type tool\|skill\|agent\|multi` selects a typed SDK template. |
| `test [dir]`, `verify [dir]`, `dev [dir]` | Isolated build and verification; no hot reload or activation. |
| `install <source>` | Stage supported source for build and human review. |
| `update <name>` | Fork the active immutable source into a workspace. |
| `list`, `info <name>` | Inspect installation metadata. |
| `remove <name>` | Uninstall while retaining history and data. |
| `publish` | Build and publish a sealed marketplace version with a publisher token. |

Installation and update need an active administrator selected by `EZCORP_USER_ID`. CLI commands cannot approve a release, and `install --yes` is rejected. Publisher credentials do not grant runtime installation approval. See [Getting started](getting-started.md).

## Per-extension settings API

Declare the settings schema as manifest data. The host validates and resolves values for the active user. The UI provides save and reset; tools read the resolved settings from their invocation context. Use defaults for absent values. See [Settings](settings.md).

See [Manifest reference](manifest-schema.md) for declarations and capability limits.

## Browser client

See [Browser extensions](browser.md) for the sealed build config, private SDK client, trusted preview, and camera consent.

`/api/tool-invoke` makes one invocation attempt. A tool error, lost response, or cancellation can follow a completed effect. The endpoint does not retry it. Check the outcome before issuing another call.
