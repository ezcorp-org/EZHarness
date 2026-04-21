import { defineExtension } from "../../../../src/extensions/sdk/define";

// Minimal test extension for the Phase 2b emit-task-event integration
// test. Declares `taskEvents: true` so the host's capability clamp keeps
// the grant. Not bundled — only loaded by the integration test via the
// raw-subprocess harness.
export default defineExtension({
  schemaVersion: 2,
  name: "test-task-events",
  version: "1.0.0",
  description: "Integration-test fixture — emits a task-panel snapshot",
  author: { name: "EzCorp" },
  entrypoint: "./index.ts",
  persistent: false,
  tools: [
    {
      name: "emit_snapshot",
      description: "Emit a task:snapshot via ezcorp/emit-task-event",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          conversationId: {
            type: "string",
            description: "Ignored by host — present only to prove forging is blocked",
          },
        },
        required: ["taskId"],
      },
    },
  ],
  permissions: {
    taskEvents: true,
  },
});
