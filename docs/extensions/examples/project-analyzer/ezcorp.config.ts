import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "project-analyzer",
  version: "1.0.0",
  description: "Read and list project files with filesystem and shell access",
  author: {
    name: "EZCorp",
  },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "listFiles",
      description: "List files in the current working directory",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern to filter files (default: *)",
          },
        },
      },
    },
    {
      name: "readFile",
      description: "Read the contents of a file within the project directory",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path relative to project root",
            "x-shared": "project.cwd",
          },
        },
        required: ["path"],
      },
    },
  ],
  permissions: {
    filesystem: ["$CWD"],
    shell: true,
  },
  scripts: {
    postinstall: "./scripts/postinstall.ts",
  },
});
