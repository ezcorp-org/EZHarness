# Manifest Schema Reference

Every extension has a `ezcorp.config.ts` at its root. This file declares what the extension contains, what permissions it needs, and metadata for the marketplace.

For CLI commands and SDK types, see [API Reference](api-reference.md).

---

## Minimal Example

A tool extension with one tool and network access:

```typescript
import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 2,
  name: "weather-tool",
  version: "1.0.0",
  description: "Get current weather for any city",
  author: { name: "Jane Developer" },
  entrypoint: "index.ts",
  tools: [
    {
      name: "get-weather",
      description: "Fetch weather by city name",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string" },
        },
        required: ["city"],
      },
    },
  ],
  permissions: {
    network: ["api.weatherapi.com"],
  },
});
```

> `schemaVersion` must be the literal number `2`, not the string `"2"`.

---

## Required Fields

Every manifest must include these fields. Validation rejects the manifest if any are missing.

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `2` (literal number) | Must be exactly `2` |
| `name` | `string` | Package name. Also serves as the tool namespace prefix (tools register as `name.toolName`). |
| `version` | `string` | Semver format `X.Y.Z`. Validated against `^\d+\.\d+\.\d+$`. |
| `description` | `string` | Human-readable description. |
| `author.name` | `string` | Author display name. |
| `author.id` | `string` | Optional. Author identifier. |
| `permissions` | `object` | Permission declarations. Can be empty `{}` if no special access needed. |

---

## Component Fields

An extension can contain any combination of components. An empty manifest (no components) is valid.

### `tools[]` -- `ToolDefinition[]`

Callable functions exposed over JSON-RPC.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Tool name. Sent as-is to the subprocess via `tools/call`. |
| `description` | `string` | Yes | Human-readable description. |
| `inputSchema` | `object` | Yes | JSON Schema defining accepted parameters. |

When `tools[]` is non-empty, `entrypoint` is **required** at the manifest level. The platform spawns a subprocess at the entrypoint and communicates via JSON-RPC over stdio.

Tool names are registered in the platform as `packageName.toolName`. The subprocess receives the original short name in `tools/call` requests.

```typescript
tools: [
  {
    name: "translate",
    description: "Translate text between languages",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        to: { type: "string" },
      },
      required: ["text", "to"],
    },
  },
]
```

---

### `skills[]` -- `SkillDefinition[]`

Prompt-based knowledge units. No subprocess or entrypoint needed.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Skill name. |
| `description` | `string` | Yes | Human-readable description. |
| `prompt` | `string` | No | Inline prompt text injected into context. |
| `files` | `string[]` | No | Paths relative to package root. Knowledge files loaded into context. |

```typescript
skills: [
  {
    name: "style-guide",
    description: "Technical writing style guidelines",
    prompt: "Follow AP style with Oxford commas.",
    files: ["rules.md", "examples/good.md"],
  },
]
```

---

### `agent` -- `AgentComponentDefinition`

A conversational agent persona. Configuration-based -- no entrypoint needed.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | `string` | Yes | System prompt defining agent behavior. |
| `category` | `string` | No | Agent category label. |
| `capabilities` | `string[]` | No | List of capability descriptions. |
| `modelRequirements.tier` | `"fast" \| "balanced" \| "powerful" \| "reasoning"` | No | Preferred model tier. |
| `modelRequirements.contextWindow` | `number` | No | Minimum context window size in tokens. |
| `temperature` | `number` | No | Sampling temperature. |
| `maxTokens` | `number` | No | Maximum response tokens. |
| `outputFormat` | `"text" \| "json"` | No | Expected output format. |
| `inputSchema` | `object` | No | JSON Schema for structured input. |
| `exampleConversations` | `array` | No | Array of `{ title, messages: [{ role, content }] }` examples. |

```typescript
agent: {
  prompt: "You are a senior code reviewer. Focus on correctness, readability, and performance.",
  category: "Development",
  modelRequirements: { tier: "powerful" },
  temperature: 0.2,
  maxTokens: 4096,
}
```

---

### `mcpServers[]` -- `McpServerDefinition[]`

MCP server endpoints bundled with the extension. Each has its own entrypoint (separate from the package-level `entrypoint`).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Server name. |
| `description` | `string` | Yes | Human-readable description. |
| `entrypoint` | `string` | Yes | Script path for this server. |
| `transport` | `"stdio" \| "http" \| "sse"` | No | Transport protocol. Default: `"stdio"`. |

Pick transport by how the server runs:
- **`stdio`** — bundled with the extension; the platform spawns it as a subprocess. Default and safest.
- **`http`** — connects to a remote server over Streamable HTTP (the current MCP network transport). Use for hosted servers.
- **`sse`** — legacy Server-Sent Events transport. Only use it when the remote server has not migrated to Streamable HTTP.

```typescript
mcpServers: [
  {
    name: "db-query",
    description: "Execute read-only database queries",
    entrypoint: "servers/db.ts",
    transport: "stdio",
  },
]
```

---

### `scripts` -- `ScriptDefinition`

Lifecycle hooks and named commands.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `postinstall` | `string` | No | Script path run after install (relative to package root). |
| `preuninstall` | `string` | No | Script path run before removal (relative to package root). |
| `commands` | `Record<string, { entrypoint, description? }>` | No | Named commands invokable by the user. |

```typescript
scripts: {
  postinstall: "scripts/setup.ts",
  preuninstall: "scripts/cleanup.ts",
  commands: {
    migrate: {
      entrypoint: "scripts/migrate.ts",
      description: "Run database migrations",
    },
  },
}
```

---

### `dependencies` -- `Record<string, DependencySpec>`

Declare dependencies on other extensions. Dependencies are auto-installed when the extension is installed.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | `string` | Yes | Git source (e.g., `"github:user/repo"`). |
| `version` | `string` | Yes | Exact `"1.0.0"` or caret `"^1.0.0"`. |

Only exact and caret version ranges are supported. Tilde (`~`), wildcard (`*`), and range (`>=`) specifiers are rejected during validation.

Multi-version dependencies use `name@version` as the install directory name.

```typescript
dependencies: {
  "shared-utils": {
    source: "github:acme/shared-utils",
    version: "^1.0.0",
  },
}
```

---

### `panel` -- Panel Configuration

Extensions can render a UI panel in the web interface. The panel displays structured status information using a vocabulary of typed components.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `position` | `"bottom"` | Yes | Panel position. Currently only `"bottom"` is supported. |
| `stateSchema` | `object` | No | JSON Schema defining the panel state shape. |
| `defaultCollapsed` | `boolean` | No | Whether the panel starts collapsed. Default: `false`. |

```typescript
panel: {
  position: "bottom",
  defaultCollapsed: true,
  stateSchema: {
    type: "object",
    properties: {
      status: { type: "string" },
      progress: { type: "number" },
    },
  },
}
```

**Panel components:** Extensions send panel state updates containing an array of typed components. The platform renders them in order.

| Component | Fields | Description |
|-----------|--------|-------------|
| `header` | `title`, `subtitle?` | Section header |
| `text` | `content`, `variant?` (`"muted"` \| `"default"` \| `"emphasis"`) | Text block |
| `badge` | `label`, `color?` (`"blue"` \| `"green"` \| `"red"` \| `"yellow"` \| `"purple"` \| `"gray"`) | Colored badge |
| `progress` | `value` (0-1), `label?` | Progress bar |
| `status` | `label`, `state` (`"idle"` \| `"running"` \| `"success"` \| `"error"` \| `"warning"`) | Status indicator |
| `list` | `items[]` (`label`, `status?`, `detail?`, `badge?`, `badgeColor?`) | List of items with optional status |
| `kv` | `pairs[]` (`key`, `value`) | Key-value display |
| `counter` | `label`, `value`, `total?` | Numeric counter |
| `divider` | (none) | Visual separator |

---

## Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `entrypoint` | `string` | none | Path to main JSON-RPC server script. **Required** when `tools[]` is non-empty. |
| `persistent` | `boolean` | `false` | Keep subprocess alive between calls (no idle timeout). |
| `resources.memory` | `string` | `"512MB"` | Memory limit for subprocess (e.g., `"512MB"`, `"1GB"`). Floor: 512MB. Applied via `prlimit --rss=`. |
| `resources.storage` | `string` | `"5MB"` | Storage quota for `ezcorp/storage` key-value data (e.g., `"5MB"`, `"50MB"`). Max: 100MB. |
| `tags` | `string[]` | `[]` | Marketplace categorization tags. |
| `changelog` | `string` | none | Markdown string describing version history. |
| `category` | `string` | `"Other"` | Marketplace category. |

---

## Permissions

Permissions control what system resources the extension subprocess can access. Declared in `ezcorp.config.ts` and granted at install time.

An empty `permissions: {}` means the extension requests no special access.

### `network` -- `string[]`

Controls outbound HTTP/HTTPS requests from the extension subprocess.

| Detail | |
|--------|---|
| **Type** | Array of allowed domain strings |
| **What it controls** | Which hosts the extension can make network requests to |
| **Default** | No network access |

**Safe example:** Only allow calls to a specific API.

```typescript
permissions: {
  network: ["api.openai.com"],
}
```

**Broad example:** Multiple APIs.

```typescript
permissions: {
  network: ["api.openai.com", "api.anthropic.com", "hooks.slack.com"],
}
```

List every domain the extension needs. There is no wildcard `"*"` -- each domain must be explicit.

---

### `filesystem` -- `string[]`

Controls file read/write access outside the extension's own directory.

| Detail | |
|--------|---|
| **Type** | Array of allowed path prefixes |
| **What it controls** | Which directories/files outside the install directory the extension can access |
| **Default** | Own install directory only |
| **Resolution** | Paths resolved via `realpath` to prevent `../` traversal and symlink escapes |

Extensions always have implicit read/write access to their own install directory.

**Safe example:** Relative path scoped to a data subdirectory.

```typescript
permissions: {
  filesystem: ["./data"],
}
```

Relative paths resolve against the extension's install directory.

> **Convention:** extensions that declare `filesystem: ["$CWD"]` or a project-relative path (anything that resolves under the user's project root) should write their persistent user-visible files under `<projectRoot>/.ezcorp/extension-data/<name>/`. The `.ezcorp/` directory is already gitignored at the project root. See [Data Storage Convention](data-storage.md).

**Broad example:** Full home directory access.

```typescript
permissions: {
  filesystem: ["/home/user"],
}
```

> Requesting broad paths like `/` grants full filesystem access. Users will see the full path list during install and must approve.

Non-existent paths are denied by default (if `realpath` fails, access is rejected).

---

### `shell` -- `boolean`

Controls ability to execute shell commands via subprocess.

| Detail | |
|--------|---|
| **Type** | Boolean |
| **What it controls** | Whether the extension can spawn shell processes |
| **Default** | `false` |

Shell access is always considered a sensitive operation. Users must confirm during installation.

```typescript
permissions: {
  shell: true,
}
```

Use case: extensions that run external tools (linters, compilers, git commands).

---

### `env` -- `string[]`

Controls which environment variables the extension can read.

| Detail | |
|--------|---|
| **Type** | Array of allowed environment variable names |
| **What it controls** | Which host environment variables are passed to the extension subprocess |
| **Default** | Clean environment (no host vars) |

Extension subprocesses get a minimal environment by default (`PATH`, `HOME`, `NODE_ENV`, `TMPDIR`). Only variables listed in `env` are added from the host.

```typescript
permissions: {
  env: ["OPENAI_API_KEY", "DATABASE_URL"],
}
```

Extensions cannot read variables not in their declared list.

---

### `lifecycleHooks` -- `boolean`

Controls whether the extension can subscribe to platform lifecycle events.

| Detail | |
|--------|---|
| **Type** | Boolean |
| **What it controls** | Whether the extension receives lifecycle event notifications |
| **Default** | `false` |

When granted, the extension can declare which hooks to subscribe to in its manifest `permissions.lifecycleHooks` array. Notifications are fire-and-forget — they are sent to the extension's subprocess as JSON-RPC notifications (no response expected), and only if the process is already running.

```typescript
permissions: {
  lifecycleHooks: true,
}
```

See [Lifecycle Hooks](#lifecycle-hooks) below for available hook names and payload shapes.

---

### `storage` -- `boolean`

Controls access to the isolated persistent key-value storage API (`ezcorp/storage`).

| Detail | |
|--------|---|
| **Type** | Boolean |
| **What it controls** | Whether the extension can read/write persistent data via the `ezcorp/storage` RPC channel |
| **Default** | `false` (no storage access) |

When granted, the extension gets its own isolated namespace in the database. Each extension can only access its own data — there is no way to read or write another extension's storage.

```typescript
permissions: {
  storage: true,
},
resources: {
  storage: "10MB",  // optional quota override (default: 5MB, max: 100MB)
}
```

Storage is scoped at three levels:
- **`global`** — extension-wide, shared across all conversations and users
- **`conversation`** — isolated per conversation (requires extension to be wired to the conversation)
- **`user`** — isolated per user

See [Storage API](api-reference.md#storage-api) in the API Reference for the full `ezcorp/storage` protocol.

---

## Lifecycle Hooks

Extensions with `permissions.lifecycleHooks: true` can subscribe to platform events. Subscriptions are declared in the manifest `permissions.lifecycleHooks` field. Notifications are delivered as JSON-RPC notifications via `lifecycle/<hookName>` on stdin.

Only these hook names are accepted — unknown names are silently ignored:

| Hook | Delivered when | Payload fields |
|------|---------------|----------------|
| `agent:spawn` | An agent starts executing | `agentName`, `agentConfigId`, `runId`, `timestamp` |
| `agent:complete` | An agent finishes executing | `agentName`, `agentConfigId`, `runId`, `success` (boolean), `timestamp` |
| `run:start` | A run begins | `runId`, `agentName`, `timestamp` |
| `run:complete` | A run finishes | `runId`, `agentName`, `status`, `timestamp` |

**Security:** All payloads are sanitized via an allowlist. Only the fields listed above are included — raw event data is never forwarded to extensions.

**Delivery:** Notifications are fire-and-forget. They are only sent to extensions whose subprocess is already running (a sleeping extension is never started just to receive a notification). No response is expected or read.

### Example notification (received on stdin)

```json
{"jsonrpc":"2.0","method":"lifecycle/agent:complete","params":{"agentName":"summarizer","agentConfigId":"abc-123","runId":"run-456","success":true,"timestamp":1712345678901}}
```

---

## Complete Example

A manifest using all fields:

```typescript
import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 2,
  name: "full-example",
  version: "1.2.0",
  description: "Example extension demonstrating all manifest fields",
  author: {
    name: "Jane Developer",
    id: "jane-dev-123",
  },
  entrypoint: "index.ts",
  persistent: true,
  tools: [
    {
      name: "analyze",
      description: "Analyze text content",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          mode: { type: "string", enum: ["summary", "sentiment", "keywords"] },
        },
        required: ["text"],
      },
    },
  ],
  skills: [
    {
      name: "analysis-guide",
      description: "Text analysis best practices",
      files: ["guides/analysis.md"],
    },
  ],
  agent: {
    prompt: "You are a text analysis assistant. Use the analyze tool when asked about text.",
    category: "Data & Analysis",
    capabilities: ["text analysis", "summarization"],
    modelRequirements: { tier: "balanced" },
    temperature: 0.3,
    maxTokens: 2048,
    outputFormat: "text",
  },
  mcpServers: [
    {
      name: "analysis-server",
      description: "Standalone analysis MCP server",
      entrypoint: "servers/analysis.ts",
    },
  ],
  scripts: {
    postinstall: "scripts/download-models.ts",
    commands: {
      benchmark: {
        entrypoint: "scripts/benchmark.ts",
        description: "Run analysis benchmarks",
      },
    },
  },
  dependencies: {
    "shared-utils": {
      source: "github:acme/shared-utils",
      version: "^2.0.0",
    },
  },
  permissions: {
    network: ["api.openai.com"],
    filesystem: ["./data", "./cache"],
    shell: false,
    env: ["OPENAI_API_KEY"],
    storage: true,
  },
  resources: {
    memory: "1GB",
    storage: "10MB",
  },
  tags: ["analysis", "nlp", "text"],
  category: "Data & Analysis",
  changelog: "## 1.2.0\n- Added sentiment analysis mode\n\n## 1.1.0\n- Added keyword extraction\n\n## 1.0.0\n- Initial release",
});
```
