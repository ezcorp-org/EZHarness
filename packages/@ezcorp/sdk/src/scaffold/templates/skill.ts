// ── Skill Extension Template ────────────────────────────────────

import { authorWorkflow } from "./author-workflow";

export function skillManifest(name: string, description: string): string {
  return `import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 3,
  name: "${name}",
  version: "0.1.0",
  description: "${description}",
  author: { name: "Your Name" },
  skills: [
    {
      name: "${name}-example",
      description: "Example skill for ${name}",
      prompt: "You are a helpful assistant specialized in ${name}. ${description}",
    },
  ],
  permissions: {},
});
`;
}

export function skillEntrypoint(_name: string, _description: string): string {
  // Skills don't need an entrypoint -- they're prompt-based
  return "";
}

export function skillTest(name: string, _description: string): string {
  return `import { test, expect, describe } from "bun:test";
import manifest from "./ezcorp.config";

describe("${name}", () => {
  test("declares the example skill", () => {
    const skill = manifest.skills?.[0];
    expect(skill?.name).toBe("${name}-example");
    expect(skill?.prompt).toContain("${name}");
  });
});
`;
}

export function skillReadme(name: string, description: string): string {
  return `# ${name}

${description}

## Usage

This skill adds contextual knowledge to your conversations. Once installed, the agent will have access to the skill's prompt and associated files.

${authorWorkflow()}
`;
}
