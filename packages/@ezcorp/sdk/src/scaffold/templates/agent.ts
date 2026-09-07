// ── Agent Extension Template ────────────────────────────────────

import { authorWorkflow } from "./author-workflow";

export function agentManifest(name: string, description: string): string {
  return `import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 3,
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
import manifest from "./ezcorp.config";

describe("${name}", () => {
  test("declares the example agent", () => {
    expect(manifest.agent?.prompt).toContain("${name}");
    expect(manifest.agent?.category).toBe("Other");
  });
});
`;
}

export function agentReadme(name: string, description: string): string {
  return `# ${name}

${description}

## Usage

This agent extension creates a new conversational persona. Once installed, you can start a conversation with this agent from the Pi interface.

${authorWorkflow()}
`;
}
