# Getting Started

Build and publish your first EZCorp extension. This guide walks through two extensions -- a skill (prompt + files) and an MCP tool (callable function) -- then publishes to the marketplace.

## Prerequisites

- An EZCorp account on your team's hosted instance
- [Bun](https://bun.sh) installed locally
- The EZCorp CLI available as `ezcorp` (ships with the platform)

For self-hosting setup, see [Quick Start](../quick-start.md).

## Part 1: Build a Skill Extension

Skills inject knowledge and prompts into agent conversations. No code required -- just a manifest and reference files.

### Scaffold the project

```bash
ezcorp ext init my-writing-skill --type skill
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
  schemaVersion: 2,
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
- `schemaVersion` must be `2` (the number, not a string)
- `permissions` is always present, even if empty
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
  schemaVersion: 2,
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
ezcorp ext test
```

Tests run in a sandboxed environment with restricted filesystem and memory limits. Edit `index.test.ts` to add your own assertions:

```typescript
import { test, expect, describe } from "bun:test";
import manifest from "./ezcorp.config.ts";

describe("my-writing-skill", () => {
  test("manifest has required fields", () => {
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.skills.length).toBeGreaterThan(0);
  });

  test("skill references style guide", () => {
    expect(manifest.skills[0].files).toContain("style-guide.md");
  });
});
```

### Install locally

```bash
ezcorp ext install ./my-writing-skill
```

Verify it appears:

```bash
ezcorp ext list
```

The skill is now active. Start a conversation and the agent has access to your writing style rules.

## Part 2: Build an MCP Tool Extension

Tools are callable functions that agents invoke during conversations. They communicate over JSON-RPC 2.0 via stdio.

### Scaffold the project

```bash
ezcorp ext init my-first-tool --type tool
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

If your tool needs to write user-visible files (markdown notes, JSON state, logs), store them under:

```
<projectRoot>/.ezcorp/extension-data/<extension-name>/
```

`<projectRoot>` is the nearest ancestor containing a `.git/` directory. This convention keeps every extension's state under a single gitignored root, avoids filename collisions across extensions, and lets users reset all extension data by deleting one directory.

The runtime entry exports a helper that locates it for you:

```typescript
import { findProjectRoot, getExtensionDataDir } from "@ezcorp/sdk/runtime";

const dataDir = getExtensionDataDir("my-first-tool");
// Resolves to <projectRoot>/.ezcorp/extension-data/my-first-tool/
```

See [Data Storage Convention](data-storage.md) for the `postinstall.ts` scaffold pattern, read patterns for agents, and when to use this instead of the `ezcorp/storage` key-value API.

### Examine the manifest

```typescript
import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 2,
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
    },
  ],
  permissions: {},
});
```

Key differences from skills:
- `entrypoint` is required when `tools[]` is non-empty
- Each tool defines an `inputSchema` describing its parameters
- Tool names are short -- the platform namespaces them as `packageName.toolName`

### Examine the entrypoint

The generated `index.ts` is a JSON-RPC 2.0 server over stdio:

```typescript
#!/usr/bin/env bun
// my-first-tool - JSON-RPC 2.0 tool server over stdio

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = "";

async function main() {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const req: JsonRpcRequest = JSON.parse(line);
        const res = handleRequest(req);
        process.stdout.write(JSON.stringify(res) + "\n");
      } catch {
        // Ignore malformed lines
      }
    }
  }
}

function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
  if (req.method === "tools/call") {
    const toolName = (req.params?.name as string) ?? "";
    const args = (req.params?.arguments as Record<string, unknown>) ?? {};

    if (toolName === "my-first-tool-example") {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: `Received: ${args.input ?? ""}` }],
          isError: false,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Unknown tool: ${toolName}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `Unknown method: ${req.method}` },
  };
}

main();
```

**How the protocol works:**

1. The platform spawns your extension as a subprocess
2. It sends JSON-RPC requests as newline-delimited JSON on stdin
3. Your extension reads stdin, parses each line, and writes responses to stdout
4. The buffer + newline scanning pattern handles messages split across read chunks

> The `toolName` in `tools/call` is the short name from your manifest (e.g., `my-first-tool-example`), not the namespaced version the platform uses internally.

### Modify the tool

Replace the echo behavior with something useful -- a word counter:

```typescript
if (toolName === "my-first-tool-example") {
  const text = String(args.input ?? "");
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return {
    jsonrpc: "2.0",
    id: req.id,
    result: {
      content: [{ type: "text", text: `Word count: ${wordCount}` }],
      isError: false,
    },
  };
}
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
ezcorp ext test
```

### Start the dev server

```bash
ezcorp ext dev
```

The dev server:
- Registers your extension with the local EZCorp instance
- Watches for file changes and auto-reloads (100ms debounce)
- Cleans up the registration on Ctrl+C

Edit your code while the dev server runs -- changes take effect immediately.

### Install locally

```bash
ezcorp ext install ./my-first-tool
```

Verify:

```bash
ezcorp ext list
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
ezcorp ext publish --token <your-token>
```

Or save the token to `~/.ezcorp/config.json` and skip the flag:

```bash
ezcorp ext publish
```

The publish pipeline:

1. **Validates the manifest** -- checks all required fields, schema version, entrypoint exists
2. **Runs tests** -- your extension must pass `ezcorp ext test` before publishing
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
Check that `schemaVersion` is `2` (the number, not the string `"2"`). Verify all required fields are present: `name`, `version`, `description`, `author.name`.

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
