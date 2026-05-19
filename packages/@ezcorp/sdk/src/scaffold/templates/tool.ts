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
  // Deterministic acceptance gate. \`ezcorp ext verify\` (and the
  // extension-author install endpoint) spin this extension up in a
  // sandbox, call the tool below with \`input\`, and assert the result.
  // This is the machine-checked PASS contract — "done" means this
  // passes, NOT a self-judged "looks installed". Keep it in sync with
  // the example tool's behavior.
  smokeTest: {
    tool: "${name}-example",
    input: { input: "smoke" },
    expect: { isError: false, textIncludes: "Received: smoke" },
  },
  permissions: {},
});
`;
}

export function toolEntrypoint(name: string, _description: string): string {
  return `#!/usr/bin/env bun
// ${name} - JSON-RPC 2.0 tool server over stdio

import type { JsonRpcRequest, JsonRpcResponse } from "@ezcorp/sdk";

// IMPORT-SAFE: the stdin reader grab + the JSON-RPC loop run ONLY when
// this file is the process entrypoint (\`import.meta.main\`). When the
// module is merely imported — by \`ezcorp.config.ts\` for the
// \`handleRequest\` reference, by \`index.test.ts\`, or by the host's
// \`loadManifest\` / \`ezcorp ext verify\` — we must NOT lock stdin's
// reader (doing so throws "ReadableStream is locked" on the next
// import / subprocess spawn). The runtime still runs the loop because
// the host launches this file directly as the subprocess entrypoint.
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

// Only run the stdio server when launched as the entrypoint — NOT when
// imported for \`handleRequest\` (config / tests / host loadManifest).
if (import.meta.main) {
  main();
}
`;
}

export function toolTest(name: string, _description: string): string {
  return `import { test, expect, describe } from "bun:test";
import { handleRequest } from "./index";

describe("${name}", () => {
  test("handles tools/call for ${name}-example", () => {
    const res = handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "${name}-example", arguments: { input: "hello" } },
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
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
      params: { name: "does-not-exist", arguments: {} },
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
