import { defineExtension } from "../../../../src/extensions/sdk/define";

// Minimal test extension for the Phase 2c event-subscription
// integration test. Declares a single tool that drains the
// extension's received-event buffer, and subscribes to `task:snapshot`
// via the new manifest permission. Not bundled — only loaded by
// src/__tests__/event-subscription.integration.test.ts.
export default defineExtension({
  schemaVersion: 2,
  name: "test-event-subscriber",
  version: "1.0.0",
  description: "Integration-test fixture — buffers task:snapshot events",
  author: { name: "EzCorp" },
  entrypoint: "./index.ts",
  persistent: false,
  tools: [
    {
      name: "drain_received",
      description: "Return the list of task:snapshot events this extension has seen",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  permissions: {
    eventSubscriptions: ["task:snapshot"],
  },
});
