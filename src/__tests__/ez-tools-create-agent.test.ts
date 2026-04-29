/**
 * Phase 48 Wave 2 — propose_create_agent Ez tool.
 *
 * Mirror of ez-tools-create-project. Asserts:
 *  - persists ez_drafts row with kind='agent'
 *  - returns { draftId, openUrl='/agents/new?prefill=<id>' }
 *  - inputSchema and capabilities round-trip into the payload
 *  - missing name or prompt → error result
 *  - draft ownership is scoped to userId
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { expectDetails, expectJson, expectText } from "./helpers/expect-tool-result";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { createProposeCreateAgentTool } = await import("../runtime/tools/ez/propose-create-agent");
const { getDraft } = await import("../db/queries/ez-drafts");

interface AgentDraftDetails {
  draftId: string;
  openUrl: string;
  kind: "agent";
}
interface ToolErrorDetails {
  isError: true;
}

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "ez-create-agent@test.com", passwordHash: "h", name: "EZA" });
  userId = u.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("propose_create_agent", () => {
  test("happy path: minimal name+prompt persists a draft", async () => {
    const tool = createProposeCreateAgentTool({ userId });
    const result = await tool.execute("a-1", { name: "Summarizer", prompt: "Summarize PR comments." });

    const { draftId, openUrl } = expectJson<{ draftId: string; openUrl: string }>(result);
    expect(draftId).toBeDefined();
    expect(openUrl).toBe(`/agents/new?prefill=${draftId}`);
    expect(expectDetails<AgentDraftDetails>(result).kind).toBe("agent");

    const row = await getDraft(draftId, userId);
    expect(row!.kind).toBe("agent");
    expect(row!.payload).toEqual({ name: "Summarizer", prompt: "Summarize PR comments." });
  });

  test("inputSchema and capabilities round-trip into the payload", async () => {
    const tool = createProposeCreateAgentTool({ userId });
    const inputSchema = { type: "object", properties: { url: { type: "string" } }, required: ["url"] };
    const capabilities = ["llm", "tools"];
    const result = await tool.execute("a-2", { name: "Crawler", prompt: "Crawl a URL.", inputSchema, capabilities });

    const { draftId } = expectJson<{ draftId: string }>(result);
    const row = await getDraft(draftId, userId);
    expect(row!.payload).toEqual({
      name: "Crawler",
      prompt: "Crawl a URL.",
      inputSchema,
      capabilities,
    });
  });

  test("rejects when name is missing", async () => {
    const tool = createProposeCreateAgentTool({ userId });
    const result = await tool.execute("a-3", { prompt: "Has no name." });
    expect(expectDetails<ToolErrorDetails>(result).isError).toBe(true);
    expectText(result, "name");
  });

  test("rejects when prompt is missing", async () => {
    const tool = createProposeCreateAgentTool({ userId });
    const result = await tool.execute("a-4", { name: "Nope" });
    expect(expectDetails<ToolErrorDetails>(result).isError).toBe(true);
    expectText(result, "prompt");
  });

  test("non-string capabilities entries are filtered out", async () => {
    const tool = createProposeCreateAgentTool({ userId });
    const result = await tool.execute("a-5", {
      name: "Mixed",
      prompt: "Mixed caps test.",
      capabilities: ["llm", 42, null, "tools"] as any,
    });
    const { draftId } = expectJson<{ draftId: string }>(result);
    const row = await getDraft(draftId, userId);
    expect((row!.payload as { capabilities: string[] }).capabilities).toEqual(["llm", "tools"]);
  });

  test("openUrl matches /agents/new?prefill=<draftId>", async () => {
    const tool = createProposeCreateAgentTool({ userId });
    const result = await tool.execute("a-6", { name: "UrlShape", prompt: "x" });
    const { draftId, openUrl } = expectJson<{ draftId: string; openUrl: string }>(result);
    expect(openUrl).toMatch(/^\/agents\/new\?prefill=[a-f0-9-]+$/);
    expect(openUrl).toBe(`/agents/new?prefill=${draftId}`);
  });
});
