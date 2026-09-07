# Getting Started

Build and publish your first EZCorp extension. This guide walks through two extensions -- a skill (prompt + files) and an MCP tool (callable function) -- then publishes to the marketplace.

## Prerequisites

- An EZCorp account on your team's hosted instance
- [Bun](https://bun.sh) installed locally
- A checkout of the EZCorp repo. There is no installed `ezcorp` binary. Set `EZCORP_HOST` to that checkout and invoke its CLI as `bun "$EZCORP_HOST/src/cli.ts" ext …`.

For self-hosting setup, see [Quick Start](../quick-start.md).

## Part 1: Build a Skill Extension

Skills inject knowledge and prompts into agent conversations. No code required -- just a manifest and reference files.

### Scaffold the project

```bash
export EZCORP_HOST=/absolute/path/to/EZHarness
cd "$EZCORP_HOST"
bun src/cli.ts ext init my-writing-skill --type skill
```

This creates:

```
my-writing-skill/
  ezcorp.config.ts
  index.test.ts
  README.md
  package.json
  tsconfig.json
  .gitignore
```

No `index.ts` -- skills are prompt-based, not code-based.

### Install the SDK

The scaffold's `package.json` declares `@ezcorp/sdk` as a dependency. Install it before running tests or the dev server:

```bash
cd my-writing-skill
bun install
```

### Examine the manifest

```typescript
import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 3,
  name: "my-writing-skill",
  version: "0.1.0",
  description: "An ezcorp extension",
  author: { name: "Your Name" },
  skills: [
    {
      name: "my-writing-skill-example",
      description: "Example skill for my-writing-skill",
      prompt: "You are a helpful assistant specialized in my-writing-skill. An ezcorp extension",
    },
  ],
  permissions: {},
});
```

Key points:
- `schemaVersion` must be `2` or `3` (the number, not a string)
- `permissions` is optional -- the scaffold includes an empty block for clarity
- No `entrypoint` field -- skills don't need one

### Add a reference file

Create `style-guide.md` in the project directory:

```markdown
# Writing Style Guide

- Use active voice
- Keep sentences under 20 words
- Avoid jargon -- prefer plain language
- Use headings to break up long sections
```

### Update the manifest

Add the `files` array to your skill and update the prompt:

```typescript
import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 3,
  name: "my-writing-skill",
  version: "0.1.0",
  description: "Provides writing style guidance and tone consistency",
  author: { name: "Your Name" },
  skills: [
    {
      name: "my-writing-skill-example",
      description: "Apply consistent writing style rules",
      prompt: "Follow the writing guidelines in the attached style guide. Use active voice, keep sentences concise, and avoid jargon.",
      files: ["style-guide.md"],
    },
  ],
  permissions: {},
});
```

The `files` array makes `style-guide.md` available to the agent when this skill is active.

### Test the extension

```bash
cd my-writing-skill
bun test
bun "$EZCORP_HOST/src/cli.ts" ext verify "$PWD"
```

Tests run in a sandboxed environment with restricted filesystem and memory limits. Edit `index.test.ts` to add your own assertions:

```typescript
import { test, expect, describe } from "bun:test";
import manifest from "./ezcorp.config.ts";

describe("my-writing-skill", () => {
  test("manifest has required fields", () => {
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.skills.length).toBeGreaterThan(0);
  });

  test("skill references style guide", () => {
    expect(manifest.skills[0].files).toContain("style-guide.md");
  });
});
```

### Install locally

```bash
bun "$EZCORP_HOST/src/cli.ts" ext install "$PWD"
```

Verify it appears:

```bash
bun "$EZCORP_HOST/src/cli.ts" ext list
```

The skill is now active. Start a conversation and the agent has access to your writing style rules.

## Part 2: Build an MCP Tool Extension

Tools are callable functions that agents invoke during conversations. They communicate over JSON-RPC 2.0 via stdio.

### Scaffold the project

```bash
cd "$EZCORP_HOST"
bun src/cli.ts ext init my-first-tool --type tool
```

This creates:

```
my-first-tool/
  ezcorp.config.ts
  index.ts          <-- tool entrypoint
  index.test.ts
  README.md
  package.json
  tsconfig.json
  .gitignore
```

Run `bun install` inside the new directory so `@ezcorp/sdk` resolves against the registry before you edit or test:

```bash
cd my-first-tool
bun install
```

### Where to put persistent data

For private extension state, use the host-mediated `Storage` API. It works in
the sandbox and does not need filesystem access:

```typescript
import { Storage } from "@ezcorp/sdk/runtime";

const storage = new Storage("global");
await storage.set("state", { updatedAt: new Date().toISOString() });
```

The manifest must grant storage both to the extension and to the tool:

```typescript
tools: [{
  // ... name, description, inputSchema, and handler
  capabilities: { storage: true },
}],
permissions: { storage: true },
```

For user-visible files, use `<projectRoot>/.ezcorp/extension-data/<extension-name>/`
through the host-mediated filesystem API and declare matching filesystem paths
and `read`/`write` tool capabilities. Do not call `findProjectRoot()` or
`getExtensionDataDir()` from tool runtime code. See [Data Storage
Convention](data-storage.md) for the complete filesystem pattern.

### Examine the manifest

```typescript
import { defineExtension } from "@ezcorp/sdk";
import { handleRequest } from "./index";

export default defineExtension({
  schemaVersion: 3,
  name: "my-first-tool",
  version: "0.1.0",
  description: "An ezcorp extension",
  author: { name: "Your Name" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "my-first-tool-example",
      description: "Example tool for my-first-tool",
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "Input text" },
        },
      },
      capabilities: {},
      handler: handleRequest,
    },
  ],
  // Deterministic acceptance gate. `ezcorp ext verify` (and the
  // extension-author install endpoint) spin this extension up in a
  // sandbox, call the tool below with `input`, and assert the result.
  // This is the machine-checked PASS contract — "done" means this
  // passes, NOT a self-judged "looks installed". Keep it in sync with
  // the example tool's behavior.
  smokeTest: {
    tool: "my-first-tool-example",
    input: { input: "smoke" },
    expect: { isError: false, textIncludes: "Received: smoke" },
  },
  permissions: {},
});
```

Key differences from skills:
- `entrypoint` is required when `tools[]` is non-empty
- Each tool defines an `inputSchema` describing its parameters
- Tool names are short -- the platform namespaces them as `packageName__toolName` (double underscore)

### Examine the entrypoint

The generated `index.ts` uses the SDK dispatcher. It keeps the host channel open for reverse RPC calls such as `Storage`:

```typescript
#!/usr/bin/env bun

import {
  createToolDispatcher,
  getChannel,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

export const handleRequest: ToolHandler = (args) => {
  return toolResult(`Received: ${args.input ?? ""}`);
};

if (import.meta.main) {
  const channel = getChannel();
  createToolDispatcher({ "my-first-tool-example": handleRequest });
  channel.start();
}
```

The dispatcher receives `tools/call` requests and writes JSON-RPC responses. Use it instead of reading stdin yourself when the tool uses any host-mediated SDK helper.

### Modify the tool

Replace the echo behavior with something useful -- a word counter:

```typescript
export const handleRequest: ToolHandler = (args) => {
  const text = String(args.input ?? "");
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return toolResult(`Word count: ${wordCount}`);
};
```

Update the manifest description to match:

```typescript
{
  name: "my-first-tool-example",
  description: "Count words in the provided text",
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Text to count words in" },
    },
  },
}
```

### Test the tool

```bash
cd my-first-tool
bun test
bun "$EZCORP_HOST/src/cli.ts" ext verify "$PWD"
```

### Start the dev server

```bash
bun "$EZCORP_HOST/src/cli.ts" ext dev "$PWD"
```

The dev server:
- Registers your extension with the local EZCorp instance
- Watches for file changes and auto-reloads (100ms debounce)
- Cleans up the registration on Ctrl+C

Edit your code while the dev server runs -- changes take effect immediately.

### Install locally

```bash
bun "$EZCORP_HOST/src/cli.ts" ext install "$PWD"
```

Verify:

```bash
bun "$EZCORP_HOST/src/cli.ts" ext list
```

The tool is now available to agents. Ask a question that triggers word counting and the agent will call your tool.

## Publish to Marketplace

Both extensions are ready. Let's publish the tool.

### Get a publish token

1. Go to **Settings > Developer** in the EZCorp web UI
2. Generate a publish token
3. Save it (you'll use it once -- after that it's stored in your config)

### Publish

```bash
cd my-first-tool
bun "$EZCORP_HOST/src/cli.ts" ext publish --token <your-token>
```

Or save the token to `~/.ezcorp/config.json` and skip the flag:

```bash
bun "$EZCORP_HOST/src/cli.ts" ext publish
```

The publish pipeline:

1. **Validates the manifest** -- checks all required fields, schema version, entrypoint exists
2. **Runs tests** -- your extension must pass `bun test` and `ext verify` before publishing
3. **Computes checksums** -- integrity verification for all package files
4. **Checks version** -- rejects if this version is already published (bump `version` in ezcorp.config.ts)
5. **Creates the listing** -- your extension is live in the marketplace

```
Published my-first-tool v0.1.0
```

Your extension is now available in the marketplace. Other users can install it with:

```bash
ezcorp ext install github:your-username/my-first-tool
```

## Troubleshooting

**"Manifest validation failed"**
Check that `schemaVersion` is `2` or `3` (the number, not a string). Verify all required fields are present: `name`, `version`, `description`, `author.name`.

**"Missing entrypoint"**
The `entrypoint` field is only required when your manifest declares `tools[]`. Skills and agents don't need one -- remove it from skill/agent manifests.

**"Permission denied"**
Add the required permissions to your manifest `permissions` field. For example, to make network requests:

```typescript
permissions: {
  network: ["api.example.com"],
}
```

**"Publish failed"**
Verify your token is valid (regenerate at Settings > Developer if needed). Ensure tests pass with `ezcorp ext test`. Check that the version in `ezcorp.config.ts` hasn't already been published -- bump the version number.

## Installing from a git repo without a release

If your extension lives in a git repo that does not publish GitHub releases, install it from the clone URL directly — no tag or tarball needed.

**Web UI:** open **Extensions**, click the **Git URL** tab, paste the clone URL, and (optionally) a branch/tag/sha.

**HTTP API:**

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

Accepts http(s) or ssh (`git@host:user/repo.git`) URLs. After install the extension is disabled with no permissions granted — activate it from the UI or via `POST /api/extensions/:id/activate`. See the [HTTP API section in the API Reference](api-reference.md#http-api) for the full contract.

## Next Steps

- **[API Reference](api-reference.md)** -- Full CLI command reference and SDK type documentation
- **[Manifest Schema](manifest-schema.md)** -- Every manifest field explained with permissions deep-dive
- **[Examples](examples/)** -- 7 working extensions from simple tools to multi-agent orchestration
