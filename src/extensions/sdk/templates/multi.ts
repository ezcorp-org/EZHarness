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
  permissions: {},
});
`;
}

export function multiEntrypoint(name: string, _description: string): string {
  return `#!/usr/bin/env bun
// ${name} - JSON-RPC 2.0 multi-component server over stdio

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
    while ((newlineIdx = buffer.indexOf("\\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const req: JsonRpcRequest = JSON.parse(line);
        const res = handleRequest(req);
        process.stdout.write(JSON.stringify(res) + "\\n");
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

main();
`;
}

export function multiTest(name: string, _description: string): string {
  return `import { test, expect, describe } from "bun:test";

describe("${name}", () => {
  test.todo("handles tools/call for ${name}-tool");
  test.todo("returns error for unknown tool");
  test.todo("agent prompt is well-formed");
  test.todo("skill prompt is well-formed");
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
