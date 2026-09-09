import { defineRuntimeManifest as defineExtension } from "@ezcorp/sdk/v4";

export default defineExtension({
  schemaVersion: 4,
  name: "project-analyzer",
  version: "1.0.0",
  description: "Read and list project files with filesystem and shell access",
  author: {
    name: "EZCorp",
  },
  entrypoint: "./extension.ts",
  tools: [
    {
      name: "listFiles",
      description: "List files in the current working directory",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory relative to the project root" },
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
    filesystem: ["/project", "/data"],
    shell: false,
  },
  scripts: {
    postinstall: "./scripts/postinstall.ts",
  },
});
