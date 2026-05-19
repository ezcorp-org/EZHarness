// ── Multi-component Extension Template ──────────────────────────

export function multiManifest(name: string, description: string): string {
  return `import { defineExtension } from "@ezcorp/sdk";
import { handleRequest } from "./index";

export default defineExtension({
  schemaVersion: 2,
  name: "${name}",
  version: "0.1.0",
  description: "${description}",
  author: { name: "Your Name" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "${name}-tool",
      description: "Tool component for ${name}",
      inputSchema: {
        type: "object",
        properties: { input: { type: "string", description: "Input text" } },
      },
      handler: handleRequest,
    },
  ],
  skills: [
    {
      name: "${name}-skill",
      description: "Skill component for ${name}",
      prompt: "You are a helpful assistant with access to ${name} tools. ${description}",
    },
  ],
  agent: {
    prompt: "You are ${name}. ${description} You have access to tools and skills to accomplish tasks.",
    category: "Other",
  },
  // Deterministic acceptance gate — see the tool template's note.
  // \`ezcorp ext verify\` / the author install endpoint round-trip this
  // tool in a sandbox. "done" == this passes.
  smokeTest: {
    tool: "${name}-tool",
    input: { input: "smoke" },
    expect: { isError: false, textIncludes: "Received: smoke" },
  },
  permissions: {},
});
`;
}

export function multiEntrypoint(name: string, _description: string): string {
  return `#!/usr/bin/env bun
// ${name} - JSON-RPC 2.0 multi-component server over stdio

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

// IMPORT-SAFE: see the tool template's note. The stdin reader grab +
// loop run ONLY when this file is the process entrypoint, so importing
// it for \`handleRequest\` (config / tests / host loadManifest /
// \`ezcorp ext verify\`) does not lock stdin's reader.
async function main() {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  const stdoutWriter = Bun.stdout.writer();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const req: JsonRpcRequest = JSON.parse(line);
        const res = handleRequest(req);
        stdoutWriter.write(JSON.stringify(res) + "\\n");
        await stdoutWriter.flush();
      } catch {
        // Ignore malformed lines
      }
    }
  }
}

export function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
  if (req.method === "tools/call") {
    const toolName = (req.params?.name as string) ?? "";
    const args = (req.params?.arguments as Record<string, unknown>) ?? {};

    if (toolName === "${name}-tool") {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [{ type: "text", text: \`Received: \${args.input ?? ""}\` }],
          isError: false,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: \`Unknown tool: \${toolName}\` },
    };
  }

  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: \`Unknown method: \${req.method}\` },
  };
}

// Only run the stdio server when launched as the entrypoint — NOT when
// imported for \`handleRequest\` (config / tests / host loadManifest).
if (import.meta.main) {
  main();
}
`;
}

export function multiTest(name: string, _description: string): string {
  return `import { test, expect, describe } from "bun:test";
import { handleRequest } from "./index";

describe("${name}", () => {
  test("handles tools/call for ${name}-tool", () => {
    const res = handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "${name}-tool", arguments: { input: "hello" } },
    });
    expect(res.error).toBeUndefined();
    const result = res.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("Received: hello");
  });

  test("returns error for unknown tool", () => {
    const res = handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32601);
  });

  test("returns error for unknown method", () => {
    const res = handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
    });
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBe(-32601);
  });
});
`;
}

export function multiReadme(name: string, description: string): string {
  return `# ${name}

${description}

## Install

\`\`\`bash
ezcorp ext install ./${name}
\`\`\`

## Components

- **Tool:** \`${name}-tool\` - Callable tool component
- **Skill:** \`${name}-skill\` - Knowledge and prompt context
- **Agent:** Conversational persona

## Development

\`\`\`bash
ezcorp ext dev
\`\`\`

## Test

\`\`\`bash
bun test
\`\`\`
`;
}
