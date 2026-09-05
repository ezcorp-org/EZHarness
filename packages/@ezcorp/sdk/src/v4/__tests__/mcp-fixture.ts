import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }] }));
server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: "text", text: String(request.params.arguments?.text) }], structuredContent: { text: request.params.arguments?.text }, isError: false }));
await server.connect(new StdioServerTransport());
