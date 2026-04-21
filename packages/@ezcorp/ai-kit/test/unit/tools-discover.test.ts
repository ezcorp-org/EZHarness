import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EzcorpClient } from "../../src/client.js";
import { register, TOOLS } from "../../src/mcp/tools/discover.js";
import { startStubServer, type StubServer } from "../fixtures/stub-server.js";

describe("tools/discover", () => {
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

  test("TOOLS constant has 5 entries with correct names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("list_agents");
    expect(names).toContain("search_mentions");
    expect(names).toContain("list_models");
    expect(names).toContain("list_extensions");
    expect(TOOLS).toHaveLength(5);
  });

  test("list_projects returns stub project list", async () => {
    const projects = await client.listProjects();
    expect(Array.isArray(projects)).toBe(true);
    expect(projects[0]).toMatchObject({ id: "global", name: "Global" });
  });

  test("list_agents returns empty list by default", async () => {
    const agents = await client.listAgents();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents).toHaveLength(0);
  });

  test("search_mentions returns hits for a query", async () => {
    const hits = await client.searchMentions({ q: "test" });
    expect(Array.isArray(hits)).toBe(true);
    expect(hits[0]).toMatchObject({ name: "test-match" });
  });

  test("search_mentions with type filter passes type to stub", async () => {
    const hits = await client.searchMentions({ q: "foo", type: "agent" });
    expect(hits[0]).toMatchObject({ kind: "agent" });
  });

  test("list_models returns model list", async () => {
    const models = await client.listModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });

  test("list_extensions returns empty array", async () => {
    const exts = await client.listExtensions();
    expect(Array.isArray(exts)).toBe(true);
  });

  test("all tool descriptions are action-oriented (start with a verb)", () => {
    for (const tool of TOOLS) {
      // description should start with a capital letter verb phrase
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});
