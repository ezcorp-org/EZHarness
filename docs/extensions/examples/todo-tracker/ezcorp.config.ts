import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "todo-tracker",
  version: "1.0.0",
  description: "Scan project files for TODO, FIXME, and HACK comments",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "scan-todos",
      description: "Find TODO/FIXME/HACK comments in project source files",
      inputSchema: {
        type: "object",
        properties: {
          searchQuery: {
            type: "string",
            format: "search",
            description: "Filter TODOs by text content",
          },
          priority: {
            type: "string",
            format: "combo-box",
            description: "Filter by priority marker",
            "x-options": {
              options: ["all", "critical", "high", "medium", "low"],
              allowCustom: false,
            },
          },
          tags: {
            type: "array",
            items: { type: "string" },
            format: "tag-input",
            description: "Filter by tag",
            "x-options": {
              suggestions: ["bug", "feature", "refactor", "debt", "perf"],
              freeform: true,
            },
          },
          deadline: {
            type: "string",
            format: "date",
            description: "Only show TODOs with deadlines before this date",
          },
        },
      },
    },
  ],
  permissions: {
    filesystem: ["$CWD"],
    // Phase post-perm-cleanup: shell dropped — the post-migration
    // implementation walks via `fsList` and reads via `fsRead`. The
    // pre-migration `Bun.$` find shell-out is gone, so the manifest
    // no longer needs `shell` capability.
    shell: false,
  },
});
