# EZCorp Extension Authoring Guide

> **Audience:** any LLM (Claude Code, ChatGPT, the in-app `extension-author`
> bundled extension, or a human author) producing an EZCorp extension
> from a user request.
>
> **Goal:** produce an extension package that installs cleanly via the
> `installFromLocal` pipeline — passing `validateManifestV2`, the
> env-key-leak install gate, and (for `tool`/`multi`) the smoke-spawn
> sanity check.

This guide is **canonical**. It supersedes per-template comments. When the
host runtime and this document disagree, file an issue — this document
loses.

---

## 1. What is an extension?

An EZCorp extension is a self-contained package (one directory) declaring
zero or more of:

| Component  | What it is                                         | Manifest field    |
| ---------- | -------------------------------------------------- | ----------------- |
| **tool**   | LLM-callable function (JSON-RPC over stdio)        | `tools[]`         |
| **skill**  | Prompt + supporting files added to context         | `skills[]`        |
| **agent**  | A conversational persona (system prompt + config)  | `agent`           |
| **multi**  | Any combination of the above three                 | mix and match     |

An extension's **type** is a scaffolding label; a real extension can
ship anything. The four templates below are starting points.

---

## 2. The four template types

Every template scaffolds the same "outer" files (`ezcorp.config.ts`,
`README.md`, `package.json`, `tsconfig.json`, `.gitignore`,
`index.test.ts`) plus an `index.ts` for `tool`/`multi` only.

### tool — JSON-RPC tool server

Minimal manifest:

```ts
import { defineExtension } from "@ezcorp/sdk";
import { handleRequest } from "./index";

export default defineExtension({
  schemaVersion: 2,
  name: "weather",
  version: "0.1.0",
  description: "Returns current weather for a location",
  author: { name: "Your Name" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "weather-now",
      description: "Get the current temperature in a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      handler: handleRequest,
    },
  ],
  permissions: {},
});
```

The `index.ts` reads JSON-RPC requests on stdin and writes responses on
stdout, one JSON object per line. See `docs/extensions/examples/scratchpad/index.ts`
for the canonical reference.

### skill — prompt + knowledge

Skills have NO `entrypoint` and NO `index.ts` — they're prompt-based.

```ts
import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 2,
  name: "markdown-style",
  version: "0.1.0",
  description: "Markdown writing style guidelines",
  author: { name: "Your Name" },
  skills: [
    {
      name: "markdown-style",
      description: "Guidelines for clean markdown",
      prompt: "When asked to write markdown, follow these rules: ...",
    },
  ],
  permissions: {},
});
```

### agent — conversational persona

Like `skill`, agents have no entrypoint — they're persona-only.

```ts
import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 2,
  name: "rubber-duck",
  version: "0.1.0",
  description: "A debugging companion",
  author: { name: "Your Name" },
  agent: {
    prompt: "You are a rubber duck. Listen patiently. Ask only clarifying questions.",
    category: "Other",
  },
  permissions: {},
});
```

### multi — combined

`tools[]` + `skills[]` + `agent` in one manifest. Has an entrypoint
(because of the tools).

---

## 3. Capability model

Every runtime side-effect (filesystem write, network request, LLM call,
etc.) is gated by a permission declaration in the manifest. Permissions
are **declared in the manifest, granted by the user at install time, and
intersected at every call**.

Common permissions:

| Permission                 | What it allows                               |
| -------------------------- | -------------------------------------------- |
| `permissions: {}`          | Nothing — pure compute only                  |
| `filesystem: ["$CWD"]`     | Read/write under project root                |
| `filesystem: ["$CWD/.ezcorp/extension-data/<name>"]` | Read/write under extension data dir |
| `shell: true`              | Run shell commands                            |
| `network: ["host.example"]` | Outbound HTTP to the listed hosts            |
| `env: ["MY_VAR"]`          | Read the named env vars                       |
| `storage: true`            | Use `ctx.storage` reverse-RPC for KV         |
| `eventSubscriptions: ["x:y"]` | Receive bus events of named types         |
| `appendMessages: { excludedDefault: true }` | Insert excluded message rows |

Full list: `src/extensions/types.ts` → `ExtensionManifestV2["permissions"]`.

### Capability minimization

**Declare the narrowest possible scope.**
- Need to read one config file? `filesystem: ["$CWD/.ezcorp/extension-data/myext"]` — not `["$CWD"]`.
- Calling one HTTP API? `network: ["api.example.com"]` — not `["*"]`.
- Need an env var? Pick a non-credential-shaped name (see §4).

The user reviews these declarations at install time. The runtime
re-intersects them on every call.

---

## 4. The env-key-leak install gate (HARD)

**This is a hard install-time gate. It cannot be bypassed for user-installed extensions.**

The host refuses to install any extension whose `permissions.env`
contains a name matching `/(_API_KEY|TOKEN|SECRET)$/i` (case-insensitive).

Source: `src/extensions/clamp-permissions.ts:checkEnvKeyLeakInstallGate`.

### Examples

| Env name              | Verdict   | Why                                |
| --------------------- | --------- | ---------------------------------- |
| `WEATHER_DEBUG`       | OK        | No credential-shaped suffix        |
| `MY_PUBLIC_BASE_URL`  | OK        | Not a credential                   |
| `OPENAI_API_KEY`      | **REFUSED** | Ends in `_API_KEY`               |
| `GITHUB_TOKEN`        | **REFUSED** | Ends in `TOKEN`                  |
| `MY_SECRET`           | **REFUSED** | Ends in `SECRET`                 |
| `secret_value`        | OK        | Anchor is end-of-string + uppercase form |

### What to do instead

You're authoring an extension that needs an API key. **Don't pass the
key through `permissions.env`.** Two paths:

1. **Ask the user for the key in the tool input schema.** The user pastes
   it per-call (they can save it via a prompt-template).
2. **Wait for the v1.5+ `ctx.secrets` host-brokered cred surface** —
   the extension never sees the raw key; the host injects it on
   outbound HTTP calls. (Not yet released; track via the v1.4 release
   notes.)

If you're producing an extension that legitimately needs a host-issued
secret today, document the limitation in the README and have the user
review the tradeoff.

---

## 5. Manifest validation rules (will be checked at install)

`validateManifestV2` runs at install time. The extension is rejected if
any of these fail:

- `schemaVersion` MUST be `2` or `3`.
- `name` MUST match `/^[a-z0-9][a-z0-9-_.]{0,63}$/` and not contain `..`.
- `version` MUST be valid semver (e.g. `1.0.0`).
- `description` MUST be non-empty.
- `author.name` MUST be non-empty.
- `entrypoint` is REQUIRED when `tools[]` is non-empty (and not
  `kind: "mcp"`); MUST be a relative path with no `..` segments.
- Each tool's `inputSchema` MUST be a JSON Schema object.
- Permissions MUST validate per `validatePermissionsBlock`.
- `preprocessors[]`, when declared, MUST pass
  `validatePreprocessorsArray`: each entry's `tool` MUST name a tool
  declared in this manifest's `tools[]`, and `accepts` MUST be a
  non-empty array of exact MIMEs (`"image/png"`) or type globs
  (`"image/*"`).

Run `validate_extension({ draftId })` from the `extension-author`
bundled extension to check before install.

### Deterministic attachment preprocessors (`preprocessors[]`)

Declare a top-level `preprocessors` array when one of your tools should
run **automatically** on matching user attachments — deterministically,
before the assistant turn, with no LLM tool-choice involved:

```ts
preprocessors: [
  {
    tool: "identify_slab",                 // must exist in tools[]
    accepts: ["image/png", "image/jpeg"],  // exact MIMEs or "type/*" globs
    description: "Identify a graded-card slab photo.", // optional
  },
],
```

Contract highlights (full spec:
[docs/features/extensions/deterministic-preprocess.md](../features/extensions/deterministic-preprocess.md);
field reference: [manifest-schema.md](manifest-schema.md#preprocessors----preprocessordecl)):

- **Input shape** — your tool is called with
  `{ attachment: "ez-attachment://<id>", filename, mimeType }`; the
  host substitutes the handle for a `data:<mime>;base64,...` URI
  before your subprocess sees it. Same permission gating and
  `resources.callTimeoutMs` as an LLM-initiated call.
- **Caps** — max 4 invocations per turn (extras dropped; the model is
  told via a trailing `[preprocess: N additional attachment(s)
  skipped — per-turn cap]` note); attachments over 8 MB are skipped.
- **Result card** — each run persists a `preprocess-result` row the
  transcript renders as a tool card. Give the referenced tool a
  `cardType` to route a specialized card; failures always render the
  default error card.
- **Grounding note** — a successful result grounds the model's reply
  via a one-turn system note; the tool output is wrapped in explicit
  untrusted-data delimiters, and failures produce no note. Keep the
  output compact (notes truncate at 4 KB) and machine-readable (JSON
  works well — the note and the card both carry it verbatim).

---

## 6. Data storage convention

**Every extension stores user-visible state under
`<projectRoot>/.ezcorp/extension-data/<extension-name>/`.**

This directory is gitignored and persistent across restarts. To use it,
declare the matching filesystem permission:

```ts
permissions: {
  filesystem: ["$CWD/.ezcorp/extension-data/<name>"],
}
```

The `$CWD` token is substituted to the project root at runtime.

Full convention: `docs/extensions/data-storage.md`.

---

## 7. JSON-RPC over stdio (tool/multi only)

Tool servers read newline-delimited JSON-RPC 2.0 requests on stdin and
write responses on stdout. **One JSON object per line, no pretty-printing.**

```
Host →   {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{}}}
Server ← {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}],"isError":false}}
```

Returning errors:

```
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Missing argument"}}
```

Standard error codes: `-32700` parse, `-32600` invalid request,
`-32601` method not found, `-32602` invalid params, `-32603` internal,
`-32001` permission denied (host-defined).

The host's tool-call timeout defaults to 30s. Override per-extension
via `resources.callTimeoutMs`.

---

## 8. Reverse-RPC: calling host services from a tool

Tool subprocesses can call back into the host using **reverse-RPC**
methods on the same stdio channel. The host inspects `req.method` and
routes to the matching handler (`src/extensions/tool-executor.ts:2066+`).

| Method                    | What it does                              | Required permission                |
| ------------------------- | ----------------------------------------- | ---------------------------------- |
| `ezcorp/storage`          | KV store (get/set/delete/list/batch)      | `storage: true`                    |
| `ezcorp/memory`           | Read/write user memories                  | `memory: { access: "..." }`        |
| `ezcorp/lessons`          | Read/write the lessons corpus             | `lessons: { access: "..." }`       |
| `ezcorp/append-message`   | Insert a turn into the conversation       | `appendMessages: { excludedDefault: true }` |
| `ezcorp/spawn-assignment` | Run a sub-agent                           | `spawnAgents: { maxPerHour }`      |
| `ezcorp/llm-complete`     | Call an LLM through the host              | `llm: { providers, ... }`          |
| `ezcorp/drafts`           | Create an Ez proposal-card draft (bundled-only) | `custom: { drafts: { kinds } }` |

Full list: `src/extensions/tool-executor.ts` (search for
`req.method === "ezcorp/`).

---

## 9. Pitfalls + gotchas

- **`schemaVersion: 2` is the current public minimum.** v3 adds per-tool
  capabilities; the host auto-migrates v2 manifests.
- **Don't use `npm`/`yarn`/`pnpm`/`npx`/`node` in tooling scripts.** Bun
  only — see project CLAUDE.md.
- **Never declare an env var matching `/(_API_KEY|TOKEN|SECRET)$/i`**
  for a user-installed extension. Install will be refused.
- **Path-traversal in tool inputs:** never blindly pass user-supplied
  paths to fs APIs. Validate against an allowlist or reject `..`.
- **JSON-RPC `id` field:** echo the request's `id` exactly. The host
  matches responses to requests by id.
- **Empty `permissions: {}` is valid** — pure-compute extensions need
  no permissions.
- **Don't put credentials in the manifest.** No literal API keys, no
  secrets in default values.
- **Prefer JSON Schema for tool inputs.** The LLM sees this verbatim
  and uses it to construct calls.

---

## 10. End-to-end checklist

**"Done" is not a judgement call.** For a `tool` / `multi` extension,
"done" means exactly one machine-checked thing:

> `ezcorp ext verify ./<extension-dir>` exits 0 (`pass: true`).

`ezcorp ext verify` is a deterministic, zero-LLM pipeline:
`loadManifest` → `validateManifestV2` → (for tool/multi) **require a
`smokeTest` block** → spin the extension up in a sandbox → call
`smokeTest.tool` with `smokeTest.input` → assert the result against
`smokeTest.expect`. There is no "looks installed" — either the round
trip passes or it does not.

### The `smokeTest` contract (REQUIRED for tool / multi)

Every `tool` / `multi` extension MUST declare a `smokeTest` in
`ezcorp.config.ts` beside `resources`:

```ts
smokeTest: {
  tool: "my-tool",                       // MUST be a declared tool name
  input: { ... },                         // args passed to the tool
  expect: { isError?: boolean; textIncludes?: string },
},
```

The scaffolder (`ezcorp ext init --type tool|multi`) emits a valid
`smokeTest` wired to the example tool out of the box — keep it in sync
as you change tool behavior. The extension-author flow's
`validate_extension` returns the host's structured `VerifyResult`
(machine verdict, not self-judged), and the author install endpoint
**hard-fails (4xx)** any `tool` / `multi` install whose `smokeTest` is
missing or fails. `skill` / `agent` extensions have no subprocess to
round-trip and are unaffected — their manifest validation is the gate.

`smokeTest` stays OPTIONAL in `validateManifestV2` itself (the bundled
corpus predates it); it is REQUIRED only via the author path.

### Checklist

- [ ] `ezcorp ext verify ./<dir>` returns PASS (the authoritative gate).
- [ ] `tool` / `multi`: a `smokeTest` is declared, its `tool` is a
      declared tool name, and the round trip passes.
- [ ] `ezcorp.config.ts` parses through `validateManifestV2` with no errors.
- [ ] `permissions.env` contains no `_API_KEY|TOKEN|SECRET`-shaped name
      (unless the extension is bundled and on the audited
      `envEscapeHatch` list — not relevant for user-authored extensions).
- [ ] Filesystem scope is the narrowest possible.
- [ ] Network scope is the narrowest possible.
- [ ] Tool descriptions are concrete enough for the LLM to choose
      correctly between similar tools.
- [ ] `index.test.ts` has at least one real (non-`test.todo`) test for
      the happy path of each tool.
- [ ] README explains what the extension does in 1-2 paragraphs.

---

## 11. References

- Manifest schema:    `docs/extensions/manifest-schema.md`
- Getting started:    `docs/extensions/getting-started.md`
- Security model:     `docs/extensions/security.md`
- Settings schema:    `docs/extensions/settings.md`
- Data storage:       `docs/extensions/data-storage.md`
- Examples:           `docs/extensions/examples/`
- API reference:      `docs/extensions/api-reference.md`
- The pure scaffolder: `import { scaffoldExtension } from "@ezcorp/sdk"`
