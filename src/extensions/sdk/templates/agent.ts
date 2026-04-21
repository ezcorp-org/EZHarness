// ── Agent Extension Template ────────────────────────────────────

export function agentManifest(name: string, description: string): string {
  return `import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 2,
  name: "${name}",
  version: "0.1.0",
  description: "${description}",
  author: { name: "Your Name" },
  agent: {
    prompt: "You are ${name}. ${description}",
    category: "Other",
  },
  permissions: {},
});
`;
}

export function agentEntrypoint(_name: string, _description: string): string {
  // Agent extensions are prompt-based -- no entrypoint needed
  return "";
}

export function agentTest(name: string, _description: string): string {
  return `import { test, expect, describe } from "bun:test";

describe("${name}", () => {
  test.todo("agent prompt is well-formed");
  test.todo("agent responds to basic input");
});
`;
}

export function agentReadme(name: string, description: string): string {
  return `# ${name}

${description}

## Install

\`\`\`bash
ezcorp ext install ./${name}
\`\`\`

## Usage

This agent extension creates a new conversational persona. Once installed, you can start a conversation with this agent from the Pi interface.

## Test

\`\`\`bash
bun test
\`\`\`
`;
}
