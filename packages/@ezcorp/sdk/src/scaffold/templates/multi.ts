// ── Multi-component Extension Template ──────────────────────────

import { authorWorkflow } from "./author-workflow";

export function multiManifest(name: string, description: string): string {
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
      name: "${name}-tool",
      description: "Tool component for ${name}",
      inputSchema: {
        type: "object",
        properties: { input: { type: "string", description: "Input text" } },
      },
      capabilities: {},
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
  createToolDispatcher({ "${name}-tool": handleRequest });
  channel.start();
}
`;
}

export function multiTest(name: string, _description: string): string {
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

export function multiReadme(name: string, description: string): string {
  return `# ${name}

${description}

## Components

- **Tool:** \`${name}-tool\` - Callable tool component
- **Skill:** \`${name}-skill\` - Knowledge and prompt context
- **Agent:** Conversational persona

${authorWorkflow(true)}
`;
}
