import { defineRuntimeManifest } from "@ezcorp/sdk/v4";

export default defineRuntimeManifest({
  schemaVersion: 4,
  name: "extension-author",
  version: "4.0.0",
  description: "Explains the move from extension authoring to host-managed workspaces and releases.",
  author: { name: "EZCorp" },
  entrypoint: "./extension.ts",
  permissions: {},
  tools: [{
    name: "migration_status",
    description: "Show the host tools that replace extension authoring.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }],
  smokeTest: { tool: "migration_status", input: {}, expect: { textIncludes: "EXTENSION_AUTHOR_MOVED_TO_HOST" } },
});
