import { defineExtension } from "../../../extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "test-tools",
  version: "1.0.0",
  description: "Mock extension for testing",
  author: { name: "Test" },
  entrypoint: "./entrypoint.ts",
  persistent: false,
  tools: [
    {
      name: "echo",
      description: "Echoes back the input text",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
  ],
  permissions: {},
});
