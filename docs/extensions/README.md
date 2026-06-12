# Extension Development

Extensions add capabilities to EZCorp -- tools that agents can call, skills that inject knowledge, and agent personas with specialized behavior. Build single-purpose tools or multi-component packages combining all three.

Extensions run in isolated subprocesses with strict security boundaries. They communicate with the platform over JSON-RPC and can only access resources explicitly granted by the user at install time.

## Documentation

- **[Getting Started](getting-started.md)** -- Build and publish your first extension step-by-step
- **[Authoring Guide (LLM-friendly)](AUTHORING.md)** -- One-stop reference for any LLM (or human) producing an extension from a user request
- **[API Reference](api-reference.md)** -- CLI commands, SDK types, JSON-RPC protocol, and Storage API
- **[Manifest Schema](manifest-schema.md)** -- Complete manifest field reference with permissions
- **[Data Storage Convention](data-storage.md)** -- Where extensions write persistent user-visible files
- **[Canvas Cards](canvas-cards.md)** -- Interactive cards with iframe previews + bidirectional events (`createCanvas`, `ExtensionIframeCard`)
- **[Message Toolbar](message-toolbar.md)** -- Contribute icons to every turn's action toolbar + author excluded turns via `ezcorp/append-message`
- **[Hub Pages](pages.md)** -- Contribute a top-level Hub tab rendered from a declarative component tree (`definePage`, `PageBuilder`, `pushPage`)
- **[Examples](examples/)** -- Working example extensions for common patterns

## Quick Links

The extension developer loop in three commands:

```bash
# Scaffold a new extension
ezcorp ext init my-extension --type tool

# Develop with hot reload
ezcorp ext dev

# Publish to the marketplace
ezcorp ext publish
```

> **Note:** there is no installed `ezcorp` binary — the CLI is `src/cli.ts`, invoked from the repo root as `bun src/cli.ts ext …` (or `bun index.ts ext …`). `ezcorp ext …` in these docs is shorthand for that invocation.

See the [Getting Started guide](getting-started.md) for the full walkthrough.

## Extension Capabilities

| Capability | How it works | Permission needed |
|-----------|-------------|-------------------|
| **Tools** | Callable functions over JSON-RPC | None (tools are always available) |
| **Skills** | Prompt/knowledge injection | None (no subprocess) |
| **Agents** | Conversational personas | None (configuration-based) |
| **Network** | HTTP/HTTPS requests | `permissions.network: ["domain.com"]` |
| **Filesystem** | Read/write files | `permissions.filesystem: ["./path"]` |
| **Shell** | Execute commands | `permissions.shell: true` |
| **Env Vars** | Read host environment | `permissions.env: ["VAR_NAME"]` |
| **Storage** | Persistent key-value DB | `permissions.storage: true` |
| **Lifecycle hooks** | Subscribe to platform events | Top-level `lifecycleHooks: string[]` manifest field (the `permissions.lifecycleHooks` boolean is informational only) |
| **Canvas cards** | Interactive UI cards with bidirectional events ([guide](canvas-cards.md)) | `tools[].cardType` + `permissions.eventSubscriptions` |
| **Message toolbar** | Per-turn action icons that route a click to your subprocess ([guide](message-toolbar.md)) | `messageToolbar[]` + `permissions.eventSubscriptions` |
| **Hub pages** | Top-level Hub tab rendered from a declarative, server-validated component tree ([guide](pages.md)) | `pages[]` (+ `permissions.eventSubscriptions` for actions) |
| **Author turns** | Insert excluded turns via `ezcorp/append-message` (pairs with `messageToolbar`) | `permissions.appendMessages` |
| **Cross-extension calls** | Invoke other extensions' tools | `dependencies` declared in manifest |

## Security Model

Extensions are sandboxed with multiple layers of isolation:

- **Process isolation** — each extension runs as a separate subprocess with `prlimit` memory limits
- **Environment isolation** — only 4 env vars passed (`PATH`, `HOME`, `NODE_ENV`, `TMPDIR`); others require explicit grants
- **Filesystem isolation** — `realpath`-resolved permission checks prevent traversal attacks; violations auto-disable the extension
- **Storage isolation** — each extension gets its own DB namespace; extension A cannot read extension B's data
- **Rate limiting** — several RPC channels are rate-limited (storage, append-message, task events, spawn-assignment, agent-configs, event delivery — 50 ops/s per extension); the `ezcorp/fs.*` and `ezcorp/invoke` channels have no per-second limiter and are bounded by other limits (per-turn tool-call cap, call depth, timeouts)
- **Auto-disable** — 3 consecutive crashes disables the extension; filesystem violations disable immediately
- **Checksum verification** — package integrity verified on first load per session

## Data Storage Convention

See [data-storage.md](data-storage.md) for the full implementation guide (the `EZCORP_PROJECT_ROOT` + host-mediated `fsRead`/`fsWrite` pattern for sandboxed tool code), the `postinstall.ts` pattern, and agent read patterns.

Every extension that writes persistent data to the host filesystem MUST put it under:

```
<projectRoot>/.ezcorp/extension-data/<extension-name>/
```

where `<projectRoot>` is the nearest ancestor directory containing a `.git/` folder (inside a sandboxed subprocess, read the host-injected `EZCORP_PROJECT_ROOT` env var; host-side scripts may walk for `.git/` themselves), and `<extension-name>` matches the extension's manifest `name` field.

**Why**:
- One `.gitignore` rule (`.ezcorp/`) covers every extension's state — users never accidentally commit a vault file or task store.
- Zero collisions between extensions: two extensions can both pick `config.json` as a filename without clobbering each other.
- Trivial cleanup — deleting the `.ezcorp/` directory resets every extension at once.
- Matches the platform's own `.ezcorp/` footprint, so users only see one hidden directory.

**Examples**:
- `task-stack` → `.ezcorp/extension-data/task-stack/task-stack.json`
- `auto-note` → `.ezcorp/extension-data/auto-note/vault/`, `.ezcorp/extension-data/auto-note/config.json`

A `postinstall.ts` script is the conventional place to scaffold the directory (see `docs/extensions/examples/auto-note/scripts/postinstall.ts`). The repo's top-level `.gitignore` already ignores `.ezcorp/`, so extension data is excluded from version control by default.
