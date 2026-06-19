// Fixture manifest for the Loop primitive real-subprocess integration
// test. Declares the triggers each `defineLoop` in `entrypoint.ts` wires
// (event subscriptions + a manual tool) plus the storage + spawnAgents
// grants the facade's run store + deferred dispatch need.

import { defineExtension } from "../../../extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "loop-fixture",
  version: "0.1.0",
  description: "Loop primitive integration-test fixture (defineLoop).",
  author: { name: "EZCorp" },
  entrypoint: "./entrypoint.ts",

  tools: [
    {
      name: "list_runs",
      description: "Read persisted loop run records for a loop id.",
      inputSchema: {
        type: "object",
        properties: { loopId: { type: "string" } },
      },
    },
    {
      name: "run_capture",
      description: "Manually fire the manualCapture loop.",
      inputSchema: {
        type: "object",
        properties: { tag: { type: "string" } },
      },
    },
  ],

  permissions: {
    spawnAgents: { maxPerHour: 30, maxConcurrent: 6 },
    eventSubscriptions: ["run:complete", "tool:complete", "task:assignment_update"],
    schedule: {
      crons: ["0 * * * *"],
      maxRunsPerDay: 24,
      purpose: "Fire the cronCapture loop hourly (integration-test fixture).",
    },
    storage: true,
  },

  resources: {
    memory: "128MB",
  },
});
