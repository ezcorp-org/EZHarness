// ── Tool Extension Template ─────────────────────────────────────

import { authorWorkflow } from "./author-workflow";

export function toolManifest(name: string, description: string): string {
  return `import { defineExtension } from "@ezcorp/sdk";
import { handleRequest } from "./index";

export default defineExtension({
  schemaVersion: 3,
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
      capabilities: {},
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
// ${name} - JSON-RPC tool server over stdio

import {
  createToolDispatcher,
  getChannel,
  toolResult,
  type ToolHandler,
} from "@ezcorp/sdk/runtime";

export const handleRequest: ToolHandler = (args) => {
  return toolResult(\`Received: \${args.input ?? ""}\`);
};

if (import.meta.main) {
  const channel = getChannel();
  createToolDispatcher({ "${name}-example": handleRequest });
  channel.start();
}
`;
}

export function toolTest(name: string, _description: string): string {
  return `import { test, expect, describe } from "bun:test";
import { handleRequest } from "./index";

describe("${name}", () => {
  test("handles the example input", () => {
    const result = handleRequest({ input: "hello" });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("Received: hello");
  });
});
`;
}

export function toolReadme(name: string, description: string): string {
  return `# ${name}

${description}

${authorWorkflow(true)}
`;
}
