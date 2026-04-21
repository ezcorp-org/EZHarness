import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "file-refactor",
  version: "1.0.0",
  description: "Preview file renames to match a naming convention",
  author: { name: "EzCorp" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "rename-files",
      description:
        "List files that don't match a naming convention and preview proposed renames (does NOT actually rename)",
      inputSchema: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            format: "file-path",
            description: "File or directory to analyze",
            "x-shared": "project.cwd",
          },
          convention: {
            type: "string",
            format: "combo-box",
            description: "Target naming convention",
            "x-options": {
              options: ["camelCase", "snake_case", "kebab-case", "PascalCase"],
              allowCustom: false,
            },
          },
          excludePatterns: {
            type: "array",
            format: "tag-input",
            description: "Glob patterns to skip (e.g. node_modules, .git)",
            "x-options": {
              suggestions: ["node_modules", ".git", "dist", "build", ".svelte-kit"],
              freeform: true,
            },
          },
        },
        required: ["sourcePath", "convention"],
      },
    },
  ],
  permissions: {
    filesystem: ["$CWD"],
    shell: false,
  },
});
