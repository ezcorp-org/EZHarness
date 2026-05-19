import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "code-quality",
  version: "1.0.0",
  description: "Static quality analysis for source files — complexity, naming, and style checks",
  author: {
    name: "EZCorp",
  },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "analyzeFile",
      description: "Analyze a source file for quality issues (complexity, naming, style)",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Path to the file to analyze",
            "x-shared": "project.cwd",
          },
        },
        required: ["filePath"],
      },
    },
    {
      name: "analyzeDirectory",
      description: "Analyze all source files in a directory and return an aggregate quality report",
      inputSchema: {
        type: "object",
        properties: {
          dirPath: {
            type: "string",
            description: "Path to the directory to analyze",
            "x-shared": "project.cwd",
          },
          extensions: {
            type: "string",
            description: "Comma-separated file extensions to include (default: ts,js,tsx,jsx)",
          },
        },
        required: ["dirPath"],
      },
    },
  ],
  scripts: {
    preuninstall: "./scripts/preuninstall.ts",
  },
  dependencies: {
    "project-analyzer": {
      source: "github:ezcorp/project-analyzer",
      version: "^1.0.0",
    },
  },
  permissions: {},
});
