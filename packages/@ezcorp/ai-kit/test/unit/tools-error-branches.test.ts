/**
 * Error / fallback branch coverage for the MCP tool handlers.
 *
 * The stub-server integration sweep (test/integration/tool-handlers.test.ts)
 * drives the happy paths; these drive the defensive arms that a live server
 * never trips: the `conversationUrlFor` link fallback when `getConversation`
 * fails, the stream_run non-abort rethrow, the generate_agent persisted-config
 * link, and the extension_search handler. Each tool is registered against a
 * tailored mock client and invoked through the real MCP transport.
 */

import { test, expect, describe } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { EzcorpClient } from "../../src/client.js";
import { register as registerChat } from "../../src/mcp/tools/chat.js";
import { register as registerAgents } from "../../src/mcp/tools/agents.js";
import { register as registerDiscover } from "../../src/mcp/tools/discover.js";
import { register as registerOrchestrate } from "../../src/mcp/tools/orchestrate.js";

type ToolText = { content: Array<{ type: string; text: string }>; isError?: boolean };
const read = (r: unknown): Record<string, unknown> => JSON.parse((r as ToolText).content[0]!.text);
const entityUrl = (a: { kind: string; id?: string; name?: string; projectId?: string }): string =>
  `https://ez/${a.kind}/${a.id ?? a.name}?project=${a.projectId ?? ""}`;

async function connectWith(
  registerFn: (s: McpServer, c: EzcorpClient) => void,
  client: EzcorpClient,
): Promise<Client> {
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
  registerFn(server, client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await mcp.connect(b);
  return mcp;
}

const UUID = "00000000-0000-4000-8000-000000000001";
const CONV_UUID = "00000000-0000-4000-8000-000000000002";

describe("MCP tool handler error / fallback branches", () => {
  test("cancel_run falls back to a project/unknown link when getConversation fails", async () => {
    const client = {
      cancelRun: async () => ({ ok: true }),
      getConversation: async () => {
        throw new Error("404 not found");
      },
      entityUrl,
    } as unknown as EzcorpClient;
    const mcp = await connectWith(registerChat, client);
    try {
      const res = read(await mcp.callTool({ name: "cancel_run", arguments: { conversationId: "c-x", force: true } }));
      expect(String(res.url)).toContain("project=unknown");
    } finally {
      await mcp.close();
    }
  });

  test("stream_run rethrows a non-abort stream error (returns an error result)", async () => {
    const client = {
      // An async iterable whose iterator rejects on first pull — the for-await
      // in stream_run then throws a non-abort error, driving the rethrow arm.
      streamEvents: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error("stream blew up")),
        }),
      }),
    } as unknown as EzcorpClient;
    const mcp = await connectWith(registerChat, client);
    try {
      const res = (await mcp.callTool({
        name: "stream_run",
        arguments: { runId: "r1", timeoutSeconds: 5 },
      })) as ToolText;
      expect(res.isError).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  test("assign_task falls back to a project/unknown link when getConversation fails", async () => {
    const client = {
      assignTask: async () => ({ assignment: { id: "as1" } }),
      getConversation: async () => {
        throw new Error("404 not found");
      },
      entityUrl,
    } as unknown as EzcorpClient;
    const mcp = await connectWith(registerOrchestrate, client);
    try {
      const res = read(
        await mcp.callTool({
          name: "assign_task",
          arguments: { conversationId: CONV_UUID, taskId: "t1", agentConfigId: UUID },
        }),
      );
      expect(String(res.url)).toContain("project=unknown");
    } finally {
      await mcp.close();
    }
  });

  test("generate_agent links to the agent once a persisted config (id + name) is returned", async () => {
    const client = {
      generateAgent: async () => ({ config: { id: "a1", name: "Reviewer" }, text: "" }),
      entityUrl,
    } as unknown as EzcorpClient;
    const mcp = await connectWith(registerAgents, client);
    try {
      const res = read(
        await mcp.callTool({
          name: "generate_agent",
          arguments: { messages: [{ role: "user", content: "build me one" }] },
        }),
      );
      expect(String(res.url)).toContain("agent/Reviewer");
    } finally {
      await mcp.close();
    }
  });

  test("extension_search returns the client's hits verbatim", async () => {
    const hits = [{ name: "ext1", description: "d", tools: [] }];
    const client = {
      searchExtensions: async () => hits,
    } as unknown as EzcorpClient;
    const mcp = await connectWith(registerDiscover, client);
    try {
      const res = (await mcp.callTool({ name: "extension_search", arguments: { query: "ext" } })) as ToolText;
      expect(JSON.parse(res.content[0]!.text)).toEqual(hits);
    } finally {
      await mcp.close();
    }
  });
});
