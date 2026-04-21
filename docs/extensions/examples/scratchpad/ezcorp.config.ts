import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "scratchpad",
  version: "1.0.0",
  description:
    "Ephemeral key-value store for sharing data between agents within a conversation",
  author: { name: "EzCorp" },
  entrypoint: "./index.ts",
  persistent: false,
  tools: [
    {
      name: "scratchpad_write",
      description:
        "Write a key-value pair to the ephemeral scratchpad for this conversation. Use this to share intermediate results between agents during orchestration. Values are scoped to the current conversation and auto-expire 24 hours after the last write.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "The key to store the value under" },
          value: { type: "string", description: "The value to store" },
        },
        required: ["key", "value"],
      },
    },
    {
      name: "scratchpad_read",
      description:
        "Read a value by key from the ephemeral scratchpad for this conversation. Use this to retrieve intermediate results shared by other agents during orchestration. Returns the stored value or a not-found message.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "The key to look up" },
        },
        required: ["key"],
      },
    },
  ],
  permissions: {
    storage: true,
  },
});
