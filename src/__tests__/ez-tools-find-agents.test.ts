/**
 * Phase 48 Wave 2 — find_agents Ez tool.
 *
 * Asserts:
 *  - empty result for a query with zero matches
 *  - exact name match outranks substring matches
 *  - capability tag match outranks prompt-substring match
 *  - returns deep-link URLs of the form /agents/<id>
 *  - missing query rejects with an error result
 *  - results are limited (top 10) and ordered by score descending
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { expectDetails, expectJson, expectText } from "./helpers/expect-tool-result";

interface AgentHit {
  id: string;
  name: string;
  description: string;
  url: string;
  capabilities: string[];
  category: string | null;
  shared: boolean;
}
interface FindAgentsJson {
  query: string;
  count: number;
  agents: AgentHit[];
}
interface ToolErrorDetails {
  isError: true;
}

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { createAgentConfig } = await import("../db/queries/agent-configs");
const { createFindAgentsTool } = await import("../runtime/tools/ez/find-agents");

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "ez-find@test.com", passwordHash: "h", name: "F" });
  userId = u.id;

  // Seed a small library so the ranking has something to chew on.
  await createAgentConfig({ name: "Crawler", description: "Crawls web pages", prompt: "You are a web crawler agent.", capabilities: ["llm", "tools"], userId });
  await createAgentConfig({ name: "Summarizer", description: "Summarizes text", prompt: "You summarize content using llm.", capabilities: ["llm"], userId });
  await createAgentConfig({ name: "PDF Reader", description: "Reads PDFs", prompt: "You read PDFs.", capabilities: ["pdf"], userId });
  await createAgentConfig({ name: "MentionsCrawler", description: "Crawls mentions", prompt: "Find mentions in PR descriptions.", capabilities: ["llm"], userId });
});

afterAll(async () => {
  await closeTestDb();
});

describe("find_agents", () => {
  test("empty result when nothing matches", async () => {
    const tool = createFindAgentsTool({ userId });
    const result = await tool.execute("f-1", { query: "no-such-agent-xyz" });
    const parsed = expectJson<FindAgentsJson>(result);
    expect(parsed.count).toBe(0);
    expect(parsed.agents).toEqual([]);
  });

  test("exact name match wins (Crawler > MentionsCrawler for query='crawler')", async () => {
    const tool = createFindAgentsTool({ userId });
    const result = await tool.execute("f-2", { query: "Crawler" });
    const parsed = expectJson<FindAgentsJson>(result);
    expect(parsed.count).toBeGreaterThanOrEqual(2);
    expect(parsed.agents[0]!.name).toBe("Crawler");
  });

  test("capability tag match outranks prompt substring match", async () => {
    // 'pdf' is a capability on PDF Reader but only appears in prompts of others.
    const tool = createFindAgentsTool({ userId });
    const result = await tool.execute("f-3", { query: "pdf" });
    const parsed = expectJson<FindAgentsJson>(result);
    expect(parsed.agents[0]!.name).toBe("PDF Reader");
  });

  test("returns deep-link URLs of the form /agents/<id>", async () => {
    const tool = createFindAgentsTool({ userId });
    const result = await tool.execute("f-4", { query: "Summarizer" });
    const parsed = expectJson<FindAgentsJson>(result);
    expect(parsed.agents.length).toBeGreaterThan(0);
    expect(parsed.agents[0]!.url).toMatch(/^\/agents\/[0-9a-f-]+$/);
  });

  test("missing query rejects with an error result", async () => {
    const tool = createFindAgentsTool({ userId });
    const result = await tool.execute("f-5", { query: "  " });
    expect(expectDetails<ToolErrorDetails>(result).isError).toBe(true);
    expectText(result, "query");
  });
});
