import { defineExtension } from "../../../../src/extensions/sdk/define";

// Minimal test extension for the Phase 2b agent-configs integration
// test. Declares `agentConfig: "read"`; not bundled.
export default defineExtension({
  schemaVersion: 2,
  name: "test-agent-configs",
  version: "1.0.0",
  description: "Integration-test fixture — reads the caller's agent configs",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: false,
  tools: [
    {
      name: "list_configs",
      description: "Call AgentConfigs.list()",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "resolve_config",
      description: "Call AgentConfigs.resolve(idOrName)",
      inputSchema: {
        type: "object",
        properties: { idOrName: { type: "string" } },
        required: ["idOrName"],
      },
    },
  ],
  permissions: {
    agentConfig: "read",
  },
});
