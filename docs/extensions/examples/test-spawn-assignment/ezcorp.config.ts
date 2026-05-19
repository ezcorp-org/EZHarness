import { defineExtension } from "../../../../src/extensions/sdk/define";

// Minimal test extension for the Phase 2d spawn-assignment integration
// test. Exposes two tools:
//   - `spawn_one` — wraps `spawnAssignment(...)` and returns the handle
//     as JSON, surfacing any JsonRpcError with its code + data.reason so
//     the test can assert on -32000 / -32001 / -32029 etc.
//   - `drain_updates` — returns (and clears) the buffer of
//     `task:assignment_update` payloads the extension has received via
//     `registerEventHandler` (Phase 2c round-trip proof).
//
// Not bundled — only loaded by
// src/__tests__/spawn-assignment.integration.test.ts.
export default defineExtension({
  schemaVersion: 2,
  name: "test-spawn-assignment",
  version: "1.0.0",
  description: "Integration-test fixture — exercises ezcorp/spawn-assignment",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: false,
  tools: [
    {
      name: "spawn_one",
      description: "Spawn a single sub-assignment via spawnAssignment().",
      inputSchema: {
        type: "object",
        properties: {
          agentConfigId: { type: "string" },
          agentName: { type: "string" },
          task: { type: "string" },
          title: { type: "string" },
        },
        required: ["task"],
      },
    },
    {
      name: "drain_updates",
      description: "Return the list of task:assignment_update events this extension has seen, then clear the buffer.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  permissions: {
    spawnAgents: { maxPerHour: 5, maxConcurrent: 2 },
    eventSubscriptions: ["task:assignment_update"],
  },
});
