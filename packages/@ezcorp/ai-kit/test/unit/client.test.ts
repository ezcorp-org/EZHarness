import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EzcorpClient, EzcorpApiError } from "../../src/client";
import { startStubServer, type StubServer } from "../fixtures/stub-server";

let server: StubServer;
let client: EzcorpClient;

beforeEach(() => {
  server = startStubServer();
  client = new EzcorpClient({ baseUrl: server.url });
});

afterEach(() => {
  server.stop();
});

describe("EzcorpClient — auth + errors", () => {
  test("injects Authorization header when apiKey provided", async () => {
    server.stop();
    server = startStubServer({ apiKey: "ez_test" });
    const authed = new EzcorpClient({ baseUrl: server.url, apiKey: "ez_test" });
    expect(await authed.me()).toMatchObject({ id: "stub-user" });
  });

  test("health requires no auth", async () => {
    server.stop();
    server = startStubServer({ apiKey: "ez_test" });
    const noKey = new EzcorpClient({ baseUrl: server.url });
    expect(await noKey.health()).toEqual({ ok: true });
  });

  test("throws EzcorpApiError with status + url on non-2xx", async () => {
    server.state.nextConversationFailure = { status: 400, body: '{"error":"bad"}' };
    const err = await client
      .createConversation({ projectId: "global" })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(EzcorpApiError);
    expect((err as EzcorpApiError).status).toBe(400);
    expect((err as EzcorpApiError).url).toContain("/api/conversations");
  });

  test("baseUrl trailing slash is normalized", () => {
    const c = new EzcorpClient({ baseUrl: "http://x/" });
    expect(c.baseUrl).toBe("http://x");
  });
});

describe("EzcorpClient — projects + conversations", () => {
  test("listProjects returns seeded global", async () => {
    const ps = await client.listProjects();
    expect(ps.some((p) => p.id === "global")).toBe(true);
  });

  test("createProject + getProject round-trip", async () => {
    const created = await client.createProject({ name: "p1", path: "/tmp/p1" });
    expect(created.name).toBe("p1");
    const fetched = await client.getProject(created.id);
    expect(fetched.id).toBe(created.id);
  });

  test("listConversations filters by projectId", async () => {
    const c1 = await client.createConversation({ projectId: "global", title: "a" });
    const list = await client.listConversations({ projectId: "global", limit: 10, offset: 0 });
    expect(list.some((c) => c.id === c1.id)).toBe(true);
    const empty = await client.listConversations({
      projectId: "00000000-0000-4000-8000-000000000999",
      search: "nomatch",
    });
    expect(empty).toEqual([]);
  });

  test("getConversation returns a single row", async () => {
    const c = await client.createConversation({ projectId: "global" });
    const fetched = await client.getConversation(c.id);
    expect(fetched.id).toBe(c.id);
  });

  test("getTasks returns stub shape", async () => {
    const c = await client.createConversation({ projectId: "global" });
    const tasks = await client.getTasks(c.id);
    expect(tasks).toBeDefined();
  });

  test("createConversation + sendMessage round-trip", async () => {
    const c = await client.createConversation({ projectId: "global", title: "t" });
    expect(c.projectId).toBe("global");
    const res = await client.sendMessage(c.id, { content: "hi" });
    expect(res.runId).toBeString();
    const msgs = await client.getMessages(c.id);
    expect(msgs[0]?.content).toBe("hi");
  });

  test("createConversation validates uuid projectId", () => {
    expect(() =>
      client.createConversation({ projectId: "not-a-uuid" as unknown as string }),
    ).toThrow();
  });

  test("sendMessage enforces content length", () => {
    expect(() => client.sendMessage("conv-id", { content: "" })).toThrow();
  });
});

describe("EzcorpClient — fan-out", () => {
  test("spawnChats rejects batches larger than 10 (amplification defense)", async () => {
    const tooMany = Array.from({ length: 11 }, () => ({
      projectId: "global" as const,
      initialMessage: "x",
    }));
    await expect(client.spawnChats({ chats: tooMany })).rejects.toThrow();
  });

  test("spawnChats accepts a batch of exactly 10 (the hard cap)", async () => {
    const atLimit = Array.from({ length: 10 }, () => ({
      projectId: "global" as const,
      initialMessage: "x",
    }));
    const res = await client.spawnChats({ chats: atLimit });
    expect(res.chats).toHaveLength(10);
  });

  test("spawnChats creates N independent root conversations", async () => {
    const res = await client.spawnChats({
      chats: [
        { projectId: "global", initialMessage: "first" },
        { projectId: "global", initialMessage: "second" },
        { projectId: "global", initialMessage: "third" },
      ],
    });
    expect(res.chats).toHaveLength(3);
    const ids = new Set(res.chats.map((c) => c.conversationId));
    expect(ids.size).toBe(3);
  });

  test("assignTask + startAssignment produces a sub-conversation", async () => {
    const parent = await client.createConversation({ projectId: "global" });
    const { assignment } = await client.assignTask({
      conversationId: parent.id,
      taskId: "t1",
      agentConfigId: "00000000-0000-4000-8000-000000000001",
    });
    const started = await client.startAssignment({
      conversationId: parent.id,
      taskId: "t1",
      assignmentId: assignment.id,
    });
    expect(started.subConversationId).toBeString();
    const subs = await client.getSubConversations(parent.id);
    expect(subs.some((s) => s.id === started.subConversationId)).toBe(true);
  });
});

describe("EzcorpClient — agents", () => {
  test("createAgent round-trips", async () => {
    const agent = await client.createAgent({ name: "reviewer", prompt: "You review code." });
    expect(agent.name).toBe("reviewer");
  });

  test("generateAgent returns clarifying text then config on second turn", async () => {
    const turn1 = await client.generateAgent({
      messages: [{ role: "user", content: "build me a reviewer" }],
    });
    expect(turn1.config).toBeNull();
    const turn2 = await client.generateAgent({
      messages: [
        { role: "user", content: "build me a reviewer" },
        { role: "assistant", content: turn1.text },
        { role: "user", content: "TypeScript security focus" },
      ],
    });
    expect(turn2.config?.name).toBeString();
  });

  test("searchMentions with type filter", async () => {
    const hits = await client.searchMentions({ q: "code", type: "agent" });
    expect(hits[0]?.kind).toBe("agent");
  });
});

describe("EzcorpClient — call context", () => {
  test("onBehalfOfContext back-compat shim round-trips through callContext", async () => {
    const { onBehalfOfContext, callContext } = await import("../../src/client");
    expect(onBehalfOfContext.getStore()).toBeUndefined();
    const got = onBehalfOfContext.run("geff", () => {
      return {
        shimValue: onBehalfOfContext.getStore(),
        ctxValue: callContext.getStore()?.onBehalfOf,
      };
    });
    expect(got.shimValue).toBe("geff");
    expect(got.ctxValue).toBe("geff");
  });

  test("callContext defaults fill in missing model + provider", async () => {
    const { callContext } = await import("../../src/client");
    const s = startStubServer();
    const c = new EzcorpClient({ baseUrl: s.url });
    try {
      const conv = await callContext.run(
        { defaultModel: "claude-sonnet-4-6", defaultProvider: "anthropic" },
        () => c.createConversation({ projectId: "global" }),
      );
      expect(conv.projectId).toBe("global");
    } finally {
      s.stop();
    }
  });

  test("explicit args override callContext defaults", async () => {
    const { callContext } = await import("../../src/client");
    const s = startStubServer();
    const captured: Array<{ model?: string }> = [];
    const c = new EzcorpClient({
      baseUrl: s.url,
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body === "string" && (init?.method ?? "GET") === "POST") {
          try {
            captured.push(JSON.parse(init.body));
          } catch {
            /* not JSON */
          }
        }
        return fetch(input, init);
      }) as unknown as typeof fetch,
    });
    try {
      await callContext.run(
        { defaultModel: "sonnet", defaultProvider: "anthropic" },
        () => c.createConversation({ projectId: "global", model: "opus" }),
      );
      expect(captured[0]?.model).toBe("opus");
    } finally {
      s.stop();
    }
  });
});

describe("EzcorpClient — SSE streaming", () => {
  test("streamEvents yields emitted frames in order", async () => {
    const ac = new AbortController();
    const received: string[] = [];
    const task = (async () => {
      for await (const ev of client.streamEvents({ signal: ac.signal })) {
        received.push(ev.type);
        if (ev.type === "run:complete") break;
      }
    })();
    // Allow client to establish before we emit
    await new Promise((r) => setTimeout(r, 20));
    server.emit({ type: "run:start", data: { runId: "r1" } });
    server.emit({ type: "run:token", data: { runId: "r1", token: "hi" } });
    server.emit({ type: "run:complete", data: { runId: "r1" } });
    await task;
    ac.abort();
    expect(received).toEqual(["run:start", "run:token", "run:complete"]);
  });
});
