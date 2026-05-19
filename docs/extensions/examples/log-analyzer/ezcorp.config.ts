import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "log-analyzer",
  version: "1.0.0",
  description: "Search and filter log files by query, level, and date",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "search-logs",
      description: "Search a log file with filters for text, level, and date",
      inputSchema: {
        type: "object",
        properties: {
          logFile: {
            type: "string",
            format: "file-path",
            description: "Log file to search",
            "x-shared": "project.cwd",
            "x-options": { extensions: [".log", ".txt"] },
          },
          query: {
            type: "string",
            format: "search",
            description: "Text or pattern to search for",
          },
          level: {
            type: "string",
            format: "combo-box",
            description: "Filter by log level",
            "x-options": {
              options: ["all", "error", "warn", "info", "debug"],
              allowCustom: false,
            },
          },
          since: {
            type: "string",
            format: "date",
            description: "Only show entries after this date",
          },
        },
        required: ["logFile"],
      },
    },
  ],
  permissions: {
    filesystem: ["$CWD"],
    shell: false,
  },
});
