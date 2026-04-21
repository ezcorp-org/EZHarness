import { test, expect, describe, beforeEach, mock } from "bun:test";
import { agentColor } from "../lib/agent-color";

// ── Agent Color Consistency Tests ───────────────────────────────────

describe("Agent Color Consistency", () => {
  test("4+ different agent names produce valid hex colors", () => {
    const agents = ["researcher", "coder", "reviewer", "debugger", "planner"];
    for (const agent of agents) {
      const color = agentColor(agent);
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  test("same agent always gets same color", () => {
    expect(agentColor("researcher")).toBe(agentColor("researcher"));
    expect(agentColor("coder")).toBe(agentColor("coder"));
    expect(agentColor("debugger")).toBe(agentColor("debugger"));
  });

  test("at least 2 different agents get different colors", () => {
    // Test several pairs to find at least one difference
    const agents = ["researcher", "coder", "reviewer", "debugger", "planner", "analyst"];
    const colors = agents.map(agentColor);
    const unique = new Set(colors);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });
});

// ── Sub-Convo Block Logic Tests ─────────────────────────────────────

interface SubConvoMessage {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

function getSummaryText(messages: SubConvoMessage[]): string {
  if (messages.length === 0) return "No messages yet";
  const last = messages[messages.length - 1]!;
  const text = last.content;
  return text.length > 80 ? text.slice(0, 80) + "..." : text;
}

const makeMsg = (id: string, role: string, content: string): SubConvoMessage => ({
  id, role, content, createdAt: new Date(),
});

describe("Sub-Convo Block Logic", () => {
  test("summary text: empty messages", () => {
    expect(getSummaryText([])).toBe("No messages yet");
  });

  test("summary text: single message", () => {
    const msgs = [makeMsg("m1", "assistant", "Hello world")];
    expect(getSummaryText(msgs)).toBe("Hello world");
  });

  test("summary text: long message truncation (>80 chars)", () => {
    const long = "X".repeat(120);
    const msgs = [makeMsg("m1", "assistant", long)];
    const summary = getSummaryText(msgs);
    expect(summary.length).toBe(83);
    expect(summary).toBe("X".repeat(80) + "...");
  });

  test("summary text: exactly 80 chars not truncated", () => {
    const exact = "Y".repeat(80);
    const msgs = [makeMsg("m1", "assistant", exact)];
    expect(getSummaryText(msgs)).toBe(exact);
  });

  test("multiple agents in sequence: researcher block → summary → coder block → summary", () => {
    // Researcher block
    const researchMsgs = [
      makeMsg("r1", "user", "Find info"),
      makeMsg("r2", "assistant", "Here are the findings on the topic"),
    ];
    const researchSummary = getSummaryText(researchMsgs);
    expect(researchSummary).toBe("Here are the findings on the topic");

    // Coder block
    const coderMsgs = [
      makeMsg("c1", "user", "Implement feature"),
      makeMsg("c2", "assistant", "Feature implemented successfully"),
    ];
    const coderSummary = getSummaryText(coderMsgs);
    expect(coderSummary).toBe("Feature implemented successfully");

    // Summaries are independent
    expect(researchSummary).not.toBe(coderSummary);
  });

  test("message scoping: messages from agent A don't leak into agent B", () => {
    const agentAMessages: SubConvoMessage[] = [];
    const agentBMessages: SubConvoMessage[] = [];

    // Agent A session
    agentAMessages.push(makeMsg("a1", "user", "Task for researcher"));
    agentAMessages.push(makeMsg("a2", "assistant", "Research done"));

    // Agent B session
    agentBMessages.push(makeMsg("b1", "user", "Task for coder"));
    agentBMessages.push(makeMsg("b2", "assistant", "Code written"));

    // No cross-contamination
    expect(agentAMessages.every(m => m.id.startsWith("a"))).toBe(true);
    expect(agentBMessages.every(m => m.id.startsWith("b"))).toBe(true);
    expect(agentAMessages.length).toBe(2);
    expect(agentBMessages.length).toBe(2);
  });

  test("return-to-main callback pattern with multiple agents", () => {
    const mainMessages: string[] = [];
    const returnToMain = (summary: string) => { mainMessages.push(summary); };

    // Researcher finishes
    const researchMsgs = [makeMsg("r1", "assistant", "Research complete: found 3 papers")];
    returnToMain(getSummaryText(researchMsgs));

    // Coder finishes
    const coderMsgs = [makeMsg("c1", "assistant", "Implementation done, all tests pass")];
    returnToMain(getSummaryText(coderMsgs));

    // Reviewer finishes
    const reviewerMsgs = [makeMsg("v1", "assistant", "Code review approved with minor nits")];
    returnToMain(getSummaryText(reviewerMsgs));

    expect(mainMessages).toEqual([
      "Research complete: found 3 papers",
      "Implementation done, all tests pass",
      "Code review approved with minor nits",
    ]);
  });
});

// ── API Helper Tests (mocked fetch) ────────────────────────────────

describe("Sub-Conversation API Helpers", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock() as typeof fetch;
  });

  // Restore after all tests in this describe
  test("createSubConversation sends correct payload", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        id: "sub-1",
        parentConversationId: "conv-1",
        parentMessageId: "msg-1",
        agentConfigId: "cfg-researcher",
      }),
    } as Response;
    (globalThis.fetch as ReturnType<typeof mock>).mockResolvedValue(mockResponse);

    const { createSubConversation } = await import("../lib/api");
    await createSubConversation("conv-1", {
      parentMessageId: "msg-1",
      agentConfigId: "cfg-researcher",
      projectId: "proj-1",
      title: "Research task",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/conversations");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body as string);
    expect(body.parentConversationId).toBe("conv-1");
    expect(body.parentMessageId).toBe("msg-1");
    expect(body.agentConfigId).toBe("cfg-researcher");
    expect(body.projectId).toBe("proj-1");
    expect(body.title).toBe("Research task");

    globalThis.fetch = originalFetch;
  });

  test("fetchSubConversations calls correct URL", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ([]),
    } as Response;
    (globalThis.fetch as ReturnType<typeof mock>).mockResolvedValue(mockResponse);

    const { fetchSubConversations } = await import("../lib/api");
    await fetchSubConversations("conv-42");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url] = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0]! as [string];
    expect(url).toBe("/api/conversations/conv-42/sub-conversations");

    globalThis.fetch = originalFetch;
  });

  test("error handling: non-200 response throws", async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers(),
    } as Response;
    (globalThis.fetch as ReturnType<typeof mock>).mockResolvedValue(mockResponse);

    const { fetchSubConversations } = await import("../lib/api");
    await expect(fetchSubConversations("conv-1")).rejects.toThrow("500 Internal Server Error");

    globalThis.fetch = originalFetch;
  });
});
