# Extension API Reference

Quick-reference for CLI commands, SDK types, and the JSON-RPC protocol.

For manifest field details, see [Manifest Schema Reference](manifest-schema.md).

---

## CLI Commands

All extension commands live under `ezcorp ext`.

### `ezcorp ext init`

Scaffold a new extension project.

```
ezcorp ext init <name> [--type tool|skill|agent|multi]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--type` | `tool` | Extension type to scaffold |

Creates a directory with:
- `ezcorp.config.ts` -- pre-filled manifest
- `index.ts` -- entrypoint (tool and multi types only; skill and agent skip this)
- `index.test.ts` -- starter test file
- `README.md` -- project readme
- `package.json` -- declares `@ezcorp/sdk` as a registry dependency
- `tsconfig.json` -- standalone TypeScript config (Bun-compatible defaults)
- `.gitignore` -- standard ignores

After scaffolding, run `bun install` inside the new directory to pull `@ezcorp/sdk` from the registry.

If `--type` is omitted and stdin is a TTY, an interactive wizard prompts for description and type selection.

```bash
# Scaffold a tool extension
ezcorp ext init my-tool --type tool

# Interactive mode (no --type flag)
ezcorp ext init my-extension
```

---

### `ezcorp ext install`

Install an extension from a git source.

```
ezcorp ext install <source> [--yes]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--yes` | `false` | Auto-accept all permission prompts |

Supported source formats:

| Format | Example |
|--------|---------|
| GitHub | `github:user/repo` |
| GitLab | `gitlab:org/project` |
| HTTPS | `https://github.com/user/repo.git` |
| SSH | `git@github.com:user/repo.git` |

All formats support an optional `@ref` suffix for a specific branch or tag (e.g., `github:user/repo@v1.0`).

Dependencies declared in the manifest are auto-installed.

```bash
ezcorp ext install github:acme/weather-tool
ezcorp ext install github:acme/weather-tool@v2.0 --yes
```

---

### `ezcorp ext update`

Update one or all installed extensions to the latest version from their git source.

```
ezcorp ext update [name]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | No | Extension to update. Omit to update all. |

```bash
# Update a single extension
ezcorp ext update weather-tool

# Update all extensions
ezcorp ext update
```

---

### `ezcorp ext list`

List all installed extensions.

```
ezcorp ext list
```

Displays each extension's name, version, and inferred type.

```bash
ezcorp ext list
# weather-tool  1.2.0  extension
# writing-help  1.0.0  agent
```

---

### `ezcorp ext remove`

Remove an installed extension and its files.

```
ezcorp ext remove <name>
```

```bash
ezcorp ext remove weather-tool
```

If other installed extensions declare `name` as a dependency, removal will warn about dependents.

---

### `ezcorp ext info`

Show detailed information about an installed extension.

```
ezcorp ext info <name>
```

Displays manifest contents, install path, enabled status, and granted permissions.

```bash
ezcorp ext info weather-tool
```

---

### `ezcorp ext dev`

Start a development server with hot reload.

```
ezcorp ext dev [dir]
```

| Argument | Default | Description |
|----------|---------|-------------|
| `dir` | Current directory | Extension project directory |

Behavior:
1. Reads and validates `ezcorp.config.ts` in the target directory
2. Registers the extension with the local platform (dev mode auto-approves all permissions)
3. Watches for file changes with 100ms debounce
4. Hot-reloads the extension process on change (kills existing process, reloads registry)
5. Cleans up on `Ctrl+C` -- removes dev DB entry and kills extension processes

```bash
# Dev server in current directory
ezcorp ext dev

# Dev server in a specific directory
ezcorp ext dev ./my-extension
```

---

### `ezcorp ext test`

Run extension tests in a sandboxed environment.

```
ezcorp ext test [dir] [--filter <name>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--filter` | none | Run only tests matching this name |

Sandbox constraints:
- Memory limited via `prlimit --rss=` (uses manifest `resources.memory` or 512MB default)
- Clean environment: only `PATH`, `HOME`, `TMPDIR`, `NODE_ENV=test`, `BUN_ENV=test`
- Isolated temp directory at `/tmp/ezcorp-ext-test/<name>/`
- Uses `bun test` under the hood

```bash
# Run all tests
ezcorp ext test

# Run filtered tests in a specific directory
ezcorp ext test ./my-extension --filter "should parse"
```

---

### `ezcorp ext publish`

Publish an extension to the marketplace.

```
ezcorp ext publish [--token <token>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--token` | Config file value | Publish token (generate at Settings > Developer) |

Token resolution order:
1. `--token` flag
2. `publishToken` in `~/.ezcorp/config.json`

Validation pipeline (fails fast):
1. Resolve and verify publish token
2. Read and validate manifest
3. Check entrypoint file exists (if declared)
4. Run tests (must pass)
5. Check version not already published
6. Compute package checksums
7. Create or update marketplace listing

```bash
# Publish with inline token
ezcorp ext publish --token pt_abc123

# Publish using saved token
ezcorp ext publish
```

---

## HTTP API

The web app exposes the same install flow over `POST /api/extensions`. This is what the admin UI and any programmatic caller use. The endpoint requires an admin-role session; caller-supplied `permissions` are ignored — install is always `enabled=false` with empty grants, and the admin explicitly activates via `POST /api/extensions/:id/activate`.

### Install request body

| `source` | Additional fields | Meaning |
|----------|-------------------|---------|
| `"local"` | `path` (string) | Install from a server-local directory. |
| `"github"` | `repo` (string, e.g. `"user/repo"` or `"user/repo@v1.0"`) | Install from a GitHub release tarball. |
| `"git"` | `url` (http(s) or `git@host:owner/repo.git`), `ref` (optional branch/tag/sha) | Clone any branch/tag — no GitHub release required. `file://` URLs and URLs starting with `-` are rejected. |

### Example: install from git

```bash
curl -X POST https://your-host/api/extensions \
  -H "Content-Type: application/json" \
  --cookie "$COOKIE_JAR" \
  -d '{
    "source": "git",
    "url": "https://github.com/acme/weather-tool.git",
    "ref": "main"
  }'
```

Returns `201` with the installed extension record (`enabled: false`, empty `grantedPermissions`). Activate it with:

```bash
curl -X POST https://your-host/api/extensions/<id>/activate \
  -H "Content-Type: application/json" \
  --cookie "$COOKIE_JAR" \
  -d '{
    "grantedPermissions": {
      "network": ["api.weatherapi.com"],
      "grantedAt": { "install": 1712345678901 }
    }
  }'
```

Submitted permissions are clamped to the manifest — any domain/path/flag the manifest does not declare is silently dropped.

---

## SDK Types

Extension authors import types from `@ezcorp/sdk`, installed via `bun add @ezcorp/sdk`:

```typescript
import type { ToolDefinition, JsonRpcRequest } from "@ezcorp/sdk";
```

Runtime helpers ship under the `/runtime` entry point — see [Runtime Helpers](#runtime-helpers) below.

### `defineExtension`

Identity function that provides type inference for `ezcorp.config.ts` files. Follows ecosystem convention (Vite `defineConfig`, Drizzle `defineConfig`).

```typescript
import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 2,
  name: "my-extension",
  version: "1.0.0",
  description: "My extension",
  author: { name: "Your Name" },
  permissions: {},
});
```

At runtime, `defineExtension` returns the config object unchanged. At dev time, it enables full autocomplete and type checking for all manifest fields.

---

### `ExtensionManifestV2`

The root manifest type. See [Manifest Schema Reference](manifest-schema.md) for full field documentation.

```typescript
import type { ExtensionManifestV2 } from "@ezcorp/sdk";
```

---

### `ToolDefinition`

Defines a callable tool exposed over JSON-RPC.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Tool name (registered as `packageName.toolName` in platform) |
| `description` | `string` | Yes | Human-readable description |
| `inputSchema` | `Record<string, unknown>` | Yes | JSON Schema object defining accepted parameters |

```typescript
const tool: ToolDefinition = {
  name: "get-weather",
  description: "Get current weather for a city",
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name" }
    },
    required: ["city"]
  }
};
```

---

### `SkillDefinition`

Defines a prompt-based skill (no subprocess needed).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Skill name |
| `description` | `string` | Yes | Human-readable description |
| `prompt` | `string` | No | Inline prompt text |
| `files` | `string[]` | No | Paths relative to package root (knowledge files) |

```typescript
const skill: SkillDefinition = {
  name: "technical-writing",
  description: "Technical writing guidelines",
  prompt: "Follow these writing rules...",
  files: ["style-guide.md", "examples/good.md"]
};
```

---

### `AgentComponentDefinition`

Defines a conversational agent persona.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | `string` | Yes | System prompt defining agent behavior |
| `category` | `string` | No | Agent category label |
| `capabilities` | `string[]` | No | List of capability descriptions |
| `modelRequirements` | `{ tier: "fast" \| "balanced" \| "powerful" \| "reasoning"; contextWindow?: number }` | No | Model tier preference and optional minimum context window |
| `temperature` | `number` | No | Sampling temperature |
| `maxTokens` | `number` | No | Maximum response tokens |
| `outputFormat` | `"text" \| "json"` | No | Expected output format |
| `inputSchema` | `Record<string, unknown>` | No | JSON Schema for structured input |
| `exampleConversations` | `Array<{ title, messages }>` | No | Example conversations for context |

```typescript
const agent: AgentComponentDefinition = {
  prompt: "You are a code review assistant...",
  category: "Development",
  modelRequirements: { tier: "powerful" },
  temperature: 0.3,
  maxTokens: 4096,
  outputFormat: "text"
};
```

---

### `McpServerDefinition`

Defines an MCP server endpoint bundled with the extension.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Server name |
| `description` | `string` | Yes | Human-readable description |
| `entrypoint` | `string` | Yes | Script path (separate from package-level entrypoint) |
| `transport` | `"stdio" \| "sse"` | No | Transport protocol (default: `"stdio"`) |

```typescript
const mcp: McpServerDefinition = {
  name: "db-server",
  description: "Database query MCP server",
  entrypoint: "mcp-server.ts",
  transport: "stdio"
};
```

---

### `ScriptDefinition`

Defines lifecycle hooks and named commands.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `postinstall` | `string` | No | Script path run after install |
| `preuninstall` | `string` | No | Script path run before removal |
| `commands` | `Record<string, { entrypoint: string; description?: string }>` | No | Named user-invokable commands |

```typescript
const scripts: ScriptDefinition = {
  postinstall: "scripts/setup.ts",
  preuninstall: "scripts/cleanup.ts",
  commands: {
    migrate: {
      entrypoint: "scripts/migrate.ts",
      description: "Run database migrations"
    }
  }
};
```

---

### `DependencySpec`

Declares a dependency on another extension.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | `string` | Yes | Git source (e.g., `"github:user/repo"`) |
| `version` | `string` | Yes | Version range: exact `"1.0.0"` or caret `"^1.0.0"` only |

Tilde (`~`), wildcard (`*`), and range (`>=`) specifiers are not supported.

```typescript
const dep: DependencySpec = {
  source: "github:acme/utils",
  version: "^1.0.0"
};
```

---

### `JsonRpcRequest`

A JSON-RPC 2.0 request sent over stdio.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `jsonrpc` | `"2.0"` | Yes | Protocol version (always `"2.0"`) |
| `id` | `number \| string` | Yes | Request identifier |
| `method` | `string` | Yes | Method name (e.g., `"tools/call"`) |
| `params` | `Record<string, unknown>` | No | Method parameters |

```typescript
const request: JsonRpcRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "get-weather", arguments: { city: "Tokyo" } }
};
```

---

### `JsonRpcResponse`

A JSON-RPC 2.0 response.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `jsonrpc` | `"2.0"` | Yes | Protocol version (always `"2.0"`) |
| `id` | `number \| string \| null` | Yes | Matching request identifier |
| `result` | `unknown` | No | Success payload (mutually exclusive with `error`) |
| `error` | `{ code: number; message: string; data?: unknown }` | No | Error payload (mutually exclusive with `result`) |

---

### `ToolCallResult`

The result shape returned by tool implementations.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | `Array<{ type: "text"; text: string }>` | Yes | Content blocks (text only) |
| `isError` | `boolean` | Yes | Whether this result represents an error |

```typescript
const result: ToolCallResult = {
  content: [{ type: "text", text: "Weather in Tokyo: 22C, sunny" }],
  isError: false
};
```

---

## JSON-RPC Protocol

Extensions communicate with the platform over **newline-delimited JSON** on stdio (stdin/stdout).

### Message flow

```
Platform                          Extension (subprocess)
   |                                    |
   |  -- JsonRpcRequest (tools/call) -> |
   |                                    |  (process request)
   |  <- JsonRpcResponse -------------- |
   |                                    |
```

Each message is a single JSON object followed by `\n`. The transport handles buffer fragmentation automatically.

### Platform-to-extension methods

| Method | Description |
|--------|-------------|
| `tools/call` | Invoke a tool. `params` contains `name` (short tool name) and `arguments`. |

### Extension-to-platform methods (Reverse RPC)

Extensions can call back into the platform by sending a `JsonRpcRequest` on stdout. The platform detects reverse RPC by checking for a `method` field on the message (responses only have `id` + `result`/`error`).

| Method | Description |
|--------|-------------|
| `ezcorp/invoke` | Call a tool in another extension. Cross-extension call depth limited to 10. |
| `ezcorp/fs` | Request filesystem access (mediated by permission checks). Files the user might open, edit, or grep should live under the convention path `<projectRoot>/.ezcorp/extension-data/<name>/` -- see [Data Storage Convention](data-storage.md). |
| `ezcorp/storage` | Persistent key-value storage (requires `permissions.storage: true`). See [Storage API](#storage-api). |
| `ezcorp/append-message` | Author a new turn in the caller's conversation (requires `permissions.appendMessages`). See [Reverse RPC: `ezcorp/append-message`](#reverse-rpc-ezcorpappend-message). |
| `ezcorp/finalize-tool-call` | Mark an existing tool call complete and persist its `output` (used by `messageToolbar` cards to swap a transient blob URL for a stable attachment id once upload finishes). |

### Distinguishing requests from responses

The transport uses a simple rule:
- **Has `method` + `id`** -- incoming request (reverse RPC)
- **Has `id` only** (no `method`) -- response to a previous request

### Example: minimal tool server

```typescript
// Read stdin line by line, respond to tools/call
const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);

    if (req.method === "tools/call") {
      const result = { content: [{ type: "text", text: "Hello!" }], isError: false };
      const response = { jsonrpc: "2.0", id: req.id, result };
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  }
}
```

For working extension examples, see the [examples directory](examples/).

---

## Runtime Helpers

The `@ezcorp/sdk/runtime` entry point ships pre-built helpers that wrap the JSON-RPC protocol above. Prefer these over hand-rolled stdin/stdout parsing.

```typescript
import {
  // Channel + dispatcher
  getChannel,
  createToolDispatcher,
  toolResult,
  toolError,
  JsonRpcError,
  // Filesystem helpers
  findProjectRoot,
  getExtensionDataDir,
  atomicRead,
  atomicWrite,
  loadJSON,
  saveJSON,
  // Concurrency
  withLock,
  createMutex,
  // Phase 2 wrappers
  fetchPermitted,
  invoke,
  PanelBuilder,
  registerLifecycleHook,
  Storage,
} from "@ezcorp/sdk/runtime";
```

| Export | Purpose |
|---|---|
| `getChannel()` | Returns the singleton `HostChannel` reading `process.stdin` and writing `process.stdout`. |
| `createToolDispatcher(handlers)` | Builds a request handler from a `{ [toolName]: ToolHandler }` map. Pair with `channel.onRequest(dispatcher)`. |
| `toolResult(text) / toolError(message)` | Shape a `ToolCallResult` without boilerplate. |
| `findProjectRoot(from?)` | Walk up to the nearest `.git/` ancestor. Throws when none found. |
| `getExtensionDataDir(name)` | Resolves `<projectRoot>/.ezcorp/extension-data/<name>/`. |
| `atomicRead / atomicWrite / loadJSON / saveJSON` | Crash-safe file IO via temp-file + rename. |
| `withLock(path, fn) / createMutex(path)` | Cross-process file locks. |
| `fetchPermitted(url, init?)` | `fetch` that honours the extension's declared `permissions.network` allowlist. |
| `invoke(extension, tool, args)` | Cross-extension tool call via `ezcorp/invoke` reverse-RPC. |
| `PanelBuilder` | Fluent builder for UI panel payloads. |
| `registerLifecycleHook(event, handler)` | Subscribe to `install`, `enable`, `disable`, `uninstall` events. |
| `Storage` | Class wrapper over the `ezcorp/storage` reverse-RPC API (see [Storage API](#storage-api)). |

See the [`getChannel` + `createToolDispatcher` quick-start](../../packages/@ezcorp/sdk/README.md) for a minimal working tool server.

---

## Runtime Limits

| Limit | Value | Description |
|-------|-------|-------------|
| Tool calls per turn | 10 | Maximum number of extension tool calls the platform will make in a single agent turn |
| Cross-extension call depth | 10 | Maximum nesting depth for `ezcorp/invoke` chains (A calls B calls C...) |
| Idle timeout | 5 minutes | Non-persistent subprocesses are killed after 5 minutes of inactivity |
| Call timeout | 30 seconds | Maximum time for a single `tools/call` request to complete |
| Auto-disable threshold | 3 | Extension is disabled after 3 consecutive subprocess crashes |
| Memory floor | 512 MB | Minimum memory limit (values below this are clamped to 512 MB) |

Filesystem violations (accessing paths outside granted permissions) disable the extension immediately — no 3-strike rule.

---

## Storage API

> **Choosing a storage mechanism.** Use `ezcorp/storage` (below) for opaque, server-authoritative key-value state -- caches, settings, quota-managed records that only the extension itself reads. Use the filesystem convention `<projectRoot>/.ezcorp/extension-data/<name>/` for user-visible files the user (or an agent helping the user) might open in an editor -- markdown vaults, JSON task stores, generated logs. See [Data Storage Convention](data-storage.md) for the full convention.

The `ezcorp/storage` reverse RPC channel provides persistent, isolated key-value storage for extensions. Data is stored in a PostgreSQL database and survives server restarts.

**Requirement:** The extension manifest must declare `permissions.storage: true` and the user must grant it at install time.

### Security Model

- **Fully isolated** — each extension has its own namespace. Extension A cannot read or write Extension B's data, ever.
- **Server-authoritative identity** — the extension ID is assigned by the server from the registry, not from the request payload. Extensions cannot impersonate each other.
- **Scoped access** — conversation-scoped storage requires the extension to be wired to that conversation.
- **Encrypted at rest** — values can be stored with AES-256-GCM encryption (the extension sends plaintext; the server encrypts before writing to the database).
- **Quota-enforced** — default 5MB per extension (configurable via `resources.storage`, max 100MB).
- **Rate-limited** — 50 operations per second per extension.

### Scopes

| Scope | `scopeId` | Use case |
|-------|-----------|----------|
| `global` | (none) | Extension-wide settings, caches |
| `conversation` | Current conversation ID | Per-conversation state, task data |
| `user` | Current user ID | Per-user preferences |

### Request Format

Send a `JsonRpcRequest` on stdout with `method: "ezcorp/storage"`:

```typescript
{
  jsonrpc: "2.0",
  id: 1,
  method: "ezcorp/storage",
  params: {
    action: "get" | "set" | "delete" | "list" | "batch",
    scope: "global" | "conversation" | "user",  // default: "global"
    // ... action-specific fields below
  }
}
```

### Actions

#### `get` — Read a value

```typescript
// Request
{ action: "get", scope: "global", key: "settings" }

// Response
{ value: { theme: "dark", lang: "en" }, exists: true }
// or
{ value: null, exists: false }
```

#### `set` — Write a value (upsert)

```typescript
// Request
{
  action: "set",
  scope: "conversation",
  key: "analysis-cache",
  value: { results: [...] },
  encrypted: false,        // optional, default false
  ttlSeconds: 3600         // optional, auto-expires after 1 hour (max: 31536000 / 1 year)
}

// Response
{ ok: true, sizeBytes: 1234 }
```

#### `delete` — Remove a key

```typescript
// Request
{ action: "delete", scope: "global", key: "old-cache" }

// Response
{ deleted: true }
// or
{ deleted: false }  // key didn't exist
```

#### `list` — List keys (with optional prefix filter)

```typescript
// Request
{ action: "list", scope: "global", prefix: "cache/", limit: 50 }

// Response
{
  keys: [
    { key: "cache/v1", sizeBytes: 512, encrypted: false, expiresAt: null },
    { key: "cache/v2", sizeBytes: 1024, encrypted: false, expiresAt: "2026-04-07T00:00:00Z" },
  ]
}
```

`limit` defaults to 100, max 1000.

#### `batch` — Multiple operations in one call

```typescript
// Request
{
  action: "batch",
  scope: "conversation",
  operations: [
    { action: "set", key: "step-1", value: "done" },
    { action: "set", key: "step-2", value: "done" },
    { action: "get", key: "total-count" },
  ]
}

// Response
{ results: [{ ok: true, sizeBytes: 6 }, { ok: true, sizeBytes: 6 }, { value: 42, exists: true }] }
```

Max 100 operations per batch.

### Key Rules

- Length: 1–256 characters
- Allowed characters: `a-z A-Z 0-9 _ . - / :`
- Cannot start or end with `.` or `/`
- Prefixes `__` and `ezcorp/` are reserved (used internally)

### Limits

| Limit | Value |
|-------|-------|
| Storage quota per extension | 5MB default, configurable up to 100MB via `resources.storage` |
| Max value size per key | 1MB |
| Max key length | 256 characters |
| Rate limit | 50 operations/second per extension |
| Max batch size | 100 operations |
| Max TTL | 31,536,000 seconds (1 year) |

### Error Codes

| Code | Meaning |
|------|---------|
| `-32001` | Permission denied (storage not granted, or not wired to conversation) |
| `-32002` | Storage quota exceeded |
| `-32004` | Rate limited |
| `-32602` | Invalid parameters (bad key, missing fields, invalid TTL) |
| `-32603` | Internal error (decryption failure, extension not found) |

### Example: Settings Extension

A complete example showing how an extension stores and retrieves user preferences:

```typescript
// index.ts — tool server with persistent settings
const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let buffer = "";
let rpcId = 1;

// Helper: send a reverse RPC request and wait for response
function sendRpc(method: string, params: Record<string, unknown>): void {
  const msg = { jsonrpc: "2.0", id: rpcId++, method, params };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// Helper: store a setting
function saveSetting(key: string, value: unknown): void {
  sendRpc("ezcorp/storage", {
    action: "set",
    scope: "user",
    key: `settings/${key}`,
    value,
  });
}

// Helper: read a setting
function loadSetting(key: string): void {
  sendRpc("ezcorp/storage", {
    action: "get",
    scope: "user",
    key: `settings/${key}`,
  });
}
```

### What Extensions CANNOT Do

| Action | Why it's blocked |
|--------|-----------------|
| Read another extension's data | Every query is scoped by `extensionId` (server-assigned, not self-reported) |
| Spoof their identity | Extension ID comes from the server registry, not from the request payload |
| Exceed storage quota | Checked before every write; rejects with error `-32002` |
| Flood the database | Rate-limited to 50 ops/sec; batch limited to 100 ops |
| Write to reserved keys (`__tasks`, `ezcorp/*`) | Key prefix validation rejects reserved prefixes for non-builtin extensions |
| Access conversations they're not wired to | Conversation scope validates via the `conversation_extensions` junction table |
| Access the database directly | Extensions run as isolated subprocesses with no database connection string |
| Store unlimited data | Per-key limit of 1MB, per-extension quota of 5–100MB |
| Use expired data to inflate quota | Expired keys are excluded from quota calculations |

---

## Reverse RPC: `ezcorp/append-message`

Author a new turn directly in the caller's conversation. Pairs with the `messageToolbar` manifest field — a toolbar click delivers an event to the subprocess, the subprocess calls this RPC to insert a follow-up turn. See **[Message Toolbar](message-toolbar.md)** for the end-to-end pattern.

**Requirement:** the manifest must declare `permissions.appendMessages` and the user must grant it at install time. Without the grant the RPC returns `-32001 Permission denied`.

### Request

```typescript
{
  jsonrpc: "2.0",
  id: 1,
  method: "ezcorp/append-message",
  params: {
    conversationId: string,         // forced by the host to the caller's wired conversation
    parentMessageId: string,        // the row this turn is a follow-up to
    role: "extension",              // only role accepted today; enum may widen later
    content: string,                // 1-100_000 characters (matches the messages POST cap)
    excluded?: boolean,             // ignored — host always forces `true`
    toolCalls?: Array<{
      name: string,
      input: Record<string, unknown>,
      cardType?: string,
      cardLayout?: "inline" | "dock",
      status: "running" | "complete",
      output?: unknown,
    }>,
    attachmentIds?: string[],       // pre-uploaded ids (re-keyed to the new message id)
  }
}
```

### Response

```typescript
{
  jsonrpc: "2.0",
  id: 1,
  result: {
    messageId: string,              // id of the newly inserted message row
    toolCallIds?: string[],         // parallel to params.toolCalls if any
  }
}
```

### Forced behaviour

| Field | Force | Why |
|-------|-------|-----|
| `conversationId` | substituted with the caller's wired conversation | Mirrors `ezcorp/emit-task-event`: extensions cannot target other conversations even by guessing UUIDs |
| `role` | coerced to `"extension"` | A future enum widening is the only path to other roles |
| `excluded` | forced to `true` | Today every appended turn is excluded from chat context. The `excludedDefault` permission field is reserved for a future opt-in tier |

### Attachment re-attribution

If `attachmentIds` is non-empty, every id is re-keyed to the new message row by updating `message_attachments.messageId`. The host rejects the call (and rolls back the insert) if any attachment doesn't belong to the caller's user/conversation — this prevents an extension from grafting another user's file onto its own turn.

### Error codes

| Code | Meaning |
|------|---------|
| `-32001` | `appendMessages` permission not granted |
| `-32602` | Invalid params (missing parentMessageId, content too long, bad attachment id, unknown role) |
| `-32603` | Internal error (DB write failed) |

---

## Per-extension Settings API

Three HTTP routes manage the user-facing configuration declared via [`manifest.settings`](manifest-schema.md#settings----recordstring-settingsfield). See [Settings](settings.md) for the full provider guide.

All routes require an authenticated session. Settings are per-user only.

### `GET /api/extensions/[id]/settings`

Returns the schema and the user's resolution chain.

```typescript
// Response (200)
{
  schema: SettingsSchema | null,             // null when manifest has no settings block
  declaredDefaults: Record<string, unknown>, // empty when schema is null
  userValues:       Record<string, unknown>, // calling user's overrides
  resolved:         Record<string, unknown>, // declared < user, clamped to schema
}
```

| Status | Meaning |
|--------|---------|
| `200` | Success — `schema: null` when the extension declares no settings (the value blobs are all `{}`). |
| `404` | Extension not found. |

### `PUT /api/extensions/[id]/settings/user`

Replaces the calling user's override blob. No audit (per-user preferences are not security-relevant).

```typescript
// Body
{ values: Record<string, unknown> }

// Response (200)
{ ok: true, userValues: Record<string, unknown> }
```

| Status | Meaning |
|--------|---------|
| `200` | Saved. |
| `400` | Body lacks `values` or `values` is not an object. |
| `404` | Extension not found. |
| `409` | Extension's manifest declares no settings block. |

### `DELETE /api/extensions/[id]/settings/user`

Clears the calling user's overrides. The next `resolved` blob falls back to declared defaults.

```typescript
// Response (200)
{ ok: true }
```

### Runtime injection — `_meta.invocationMetadata.settings`

The tool executor calls `resolveExtensionSettings(extensionId, userId)` before building the JSON-RPC envelope and merges the result under `_meta.invocationMetadata.settings`. Caller-supplied `invocationMetadata.settings` (e.g. from cross-extension `ezcorp/invoke` calls) takes precedence. The subprocess reads via the SDK helpers below.

### SDK helpers — `getSetting<T>(ctx, key)` / `getAllSettings(ctx)`

Exported from [`@ezcorp/sdk/runtime`](../../packages/@ezcorp/sdk/src/runtime/settings.ts):

```typescript
import { createToolDispatcher, getChannel, getSetting, getAllSettings, toolResult } from "@ezcorp/sdk/runtime";

createToolDispatcher({
  synthesize: async (ctx, args) => {
    const voice = getSetting<string>(ctx, "voice") ?? "af_bella";
    const speed = getSetting<number>(ctx, "speed") ?? 1.0;
    // … call into kokoro-js with { voice, speed } …
    return toolResult(JSON.stringify({ ok: true }));
  },
});

getChannel().start();
```

`getSetting<T>(ctx, key)` returns the resolved value (or `undefined` if missing); `getAllSettings(ctx)` returns the full resolved blob. Both read from `ctx._meta.invocationMetadata.settings`.

---

## Reverse RPC: `ezcorp/finalize-tool-call`

Mark an in-flight tool call complete and persist its `output`. Used by `messageToolbar` cards that perform asynchronous browser-side work (e.g. uploading a generated artifact) — the card POSTs the result to the extension's event route, the subprocess then finalizes the tool call so the next render shows the completed state.

### Request

```typescript
{
  jsonrpc: "2.0",
  id: 1,
  method: "ezcorp/finalize-tool-call",
  params: {
    toolCallId: string,
    output: unknown,
    status: "complete" | "error",
  }
}
```

### Response

```typescript
{
  jsonrpc: "2.0",
  id: 1,
  result: { ok: true }
}
```

### Scope

The host validates that `toolCallId` belongs to a message in the caller's wired conversation; mismatches return `-32001`. No new permission is needed beyond whatever permission inserted the tool call in the first place (typically `appendMessages` for `messageToolbar` flows).
