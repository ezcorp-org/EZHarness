import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "code-review-delegator",
  version: "1.0.0",
  description: "Comprehensive code reviews by delegating to project-analyzer and code-quality",
  author: {
    name: "EZCorp",
  },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "reviewFile",
      description: "Produce a comprehensive code review by delegating to specialized analysis tools",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Path to the file to review",
          },
        },
        required: ["filePath"],
      },
    },
  ],
  agent: {
    prompt: "You are a code review assistant that produces comprehensive reviews by delegating to specialized analysis tools.",
    category: "Development",
  },
  permissions: {},
  dependencies: {
    "project-analyzer": {
      source: "github:ezcorp/project-analyzer",
      version: "^1.0.0",
    },
    "code-quality": {
      source: "github:ezcorp/code-quality",
      version: "^1.0.0",
    },
  },
});
