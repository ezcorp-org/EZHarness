// ── Tool Extension Template ─────────────────────────────────────

export function toolManifest(name: string, description: string): string {
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
      name: "${name}-example",
      description: "Example tool for ${name}",
      inputSchema: {
        type: "object",
        properties: { input: { type: "string", description: "Input text" } },
      },
      handler: handleRequest,
    },
  ],
  permissions: {},
});
`;
}

export function toolEntrypoint(name: string, _description: string): string {
  return `#!/usr/bin/env bun
// ${name} - JSON-RPC 2.0 tool server over stdio

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

    if (toolName === "${name}-example") {
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

export function toolTest(name: string, _description: string): string {
  return `import { test, expect, describe } from "bun:test";

describe("${name}", () => {
  test.todo("handles tools/call for ${name}-example");
  test.todo("returns error for unknown tool");
  test.todo("returns error for unknown method");
});
`;
}

export function toolReadme(name: string, description: string): string {
  return `# ${name}

${description}

## Install

\`\`\`bash
ezcorp ext install ./${name}
\`\`\`

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
