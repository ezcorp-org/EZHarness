import { createMcpExtension, serve } from "../index";

await serve(await createMcpExtension({ manifest: {
  schemaVersion: 4,
  name: "isolated-mcp",
  version: "1.0.0",
  description: "Rootless MCP isolation fixture",
  author: { name: "Tests" },
  permissions: {},
  kind: "mcp",
  mcpServers: [{ name: "fixture", transport: "stdio", command: process.execPath, args: ["/workspace/server.js"] }],
} }));
