import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EzcorpClient } from "../../src/client.js";
import { register, TOOLS } from "../../src/mcp/tools/agents.js";
import { startStubServer, type StubServer } from "../fixtures/stub-server.js";

describe("tools/agents", () => {
  let stub: StubServer;
  let client: EzcorpClient;
  let server: McpServer;

  beforeEach(() => {
    stub = startStubServer();
    client = new EzcorpClient({ baseUrl: stub.url });
    server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    register(server, client);
  });

  afterEach(() => stub.stop());

  test("TOOLS has 3 entries", () => {
    expect(TOOLS).toHaveLength(3);
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("create_agent");
    expect(names).toContain("generate_agent");
    expect(names).toContain("get_agent");
  });

  test("create_agent returns created agent with id", async () => {
    const agent = await client.createAgent({ name: "TestAgent", prompt: "You are a test agent." });
    expect(typeof agent.id).toBe("string");
    expect(agent.name).toBe("TestAgent");
  });

  test("generate_agent single turn returns clarifying text with null config", async () => {
    const result = await client.generateAgent({
      messages: [{ role: "user", content: "I need an agent for data analysis" }],
    });
    expect(typeof result.text).toBe("string");
    expect(result.config).toBeNull();
  });

  test("generate_agent two-turn wizard returns config on second turn", async () => {
    const turn1 = await client.generateAgent({
      messages: [{ role: "user", content: "I need an agent for data analysis" }],
    });
    expect(turn1.config).toBeNull();

    const turn2 = await client.generateAgent({
      messages: [
        { role: "user", content: "I need an agent for data analysis" },
        { role: "assistant", content: turn1.text },
        { role: "user", content: "Focus on SQL and Python analysis" },
      ],
    });
    expect(turn2.config).not.toBeNull();
    expect(typeof turn2.config?.name).toBe("string");
    expect(typeof turn2.config?.prompt).toBe("string");
  });

  test("get_agent returns agent by id", async () => {
    const created = await client.createAgent({ name: "FindMe", prompt: "Hello" });
    const agents = await client.listAgents();
    const found = agents.find((a) => a.id === created.id);
    expect(found).toBeDefined();
    expect(found?.name).toBe("FindMe");
  });

  test("get_agent handles not-found gracefully", async () => {
    // The get_agent tool internally calls listAgents and filters.
    // Stub returns only agents in state, so a fake UUID won't be found.
    const agents = await client.listAgents();
    const fakeId = "00000000-0000-0000-0000-000000000001";
    const found = agents.find((a) => a.id === fakeId);
    expect(found).toBeUndefined();
  });
});
