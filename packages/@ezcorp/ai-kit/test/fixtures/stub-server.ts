
/** In-memory stub of the EZCorp HTTP surface, hosted on a random port via
 *  `Bun.serve`. Mirrors request/response shapes of the real endpoints so unit
 *  + integration tests can run without the SvelteKit dev server.
 *
 *  Not a full fake — it covers only what the ai-kit tools call. If a test
 *  needs an endpoint we don't have, extend this. Drift from the real API is
 *  caught by the e2e suite (which runs against the real server). */

interface State {
  projects: Array<{ id: string; name: string; path: string }>;
  conversations: Map<
    string,
    {
      id: string;
      projectId: string;
      title?: string;
      parentConversationId?: string | null;
      parentMessageId?: string | null;
      agentConfigId?: string | null;
    }
  >;
  messages: Map<string, Array<{ id: string; role: string; content: string }>>;
  agents: Map<
    string,
    { id: string; name: string; prompt: string; category?: string; references?: unknown }
  >;
  /** Seedable list returned by `/api/extensions`. Tests can push entries
   *  before invoking client methods; defaults to empty so existing tests
   *  that expect `[]` keep passing. */
  extensions: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    enabled: boolean;
    manifest: { tools?: Array<{ name: string; description: string; inputSchema?: unknown }> };
  }>;
  runEvents: Array<unknown>;
  /** Pending SSE clients — writers push frames to each. */
  sseClients: Set<WritableStreamDefaultWriter<Uint8Array>>;
  /** Override: when set, the next /api/conversations POST returns this status. */
  nextConversationFailure?: { status: number; body: string };
}

export interface StubServer {
  port: number;
  url: string;
  state: State;
  stop: () => void;
  /** Push an SSE frame to all currently connected stream readers. */
  emit: (event: unknown) => void;
}

export function startStubServer(opts: { apiKey?: string } = {}): StubServer {
  const state: State = {
    projects: [{ id: "global", name: "Global", path: "/" }],
    conversations: new Map(),
    messages: new Map(),
    agents: new Map(),
    extensions: [],
    runEvents: [],
    sseClients: new Set(),
  };
  const encoder = new TextEncoder();
  const requireAuth = opts.apiKey !== undefined;

  const authOk = (req: Request) => {
    if (!requireAuth) return true;
    const h = req.headers.get("Authorization");
    return h === `Bearer ${opts.apiKey}`;
  };

  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });

  const uuid = () =>
    (globalThis.crypto?.randomUUID?.() ?? "00000000-0000-4000-8000-" + Date.now().toString(16).padStart(12, "0"));

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      if (p === "/api/health") return json({ ok: true });

      if (!authOk(req)) return new Response("unauthorized", { status: 401 });

      if (p === "/api/auth/me")
        return json({ id: "stub-user", name: "Stub", email: "stub@example.com", role: "admin" });

      const projectByIdMatch = p.match(/^\/api\/projects\/([^/]+)$/);
      if (projectByIdMatch && req.method === "GET") {
        const proj = state.projects.find((pr) => pr.id === projectByIdMatch[1]);
        return proj ? json(proj) : new Response("not found", { status: 404 });
      }
      if (p === "/api/projects" && req.method === "GET") return json(state.projects);
      if (p === "/api/projects" && req.method === "POST") {
        const body = (await req.json()) as { name: string; path: string };
        const proj = { id: uuid(), ...body };
        state.projects.push(proj);
        return json(proj, { status: 201 });
      }

      if (p === "/api/conversations" && req.method === "GET") {
        const projectId = url.searchParams.get("projectId");
        const list = [...state.conversations.values()].filter(
          (c) => !projectId || c.projectId === projectId,
        );
        return json(list);
      }
      if (p === "/api/conversations" && req.method === "POST") {
        if (state.nextConversationFailure) {
          const f = state.nextConversationFailure;
          state.nextConversationFailure = undefined;
          return new Response(f.body, { status: f.status });
        }
        const body = (await req.json()) as {
          projectId: string;
          title?: string;
          agentConfigId?: string;
          parentConversationId?: string;
          parentMessageId?: string;
        };
        const conv = {
          id: uuid(),
          projectId: body.projectId,
          title: body.title,
          agentConfigId: body.agentConfigId ?? null,
          parentConversationId: body.parentConversationId ?? null,
          parentMessageId: body.parentMessageId ?? null,
        };
        state.conversations.set(conv.id, conv);
        state.messages.set(conv.id, []);
        return json(conv, { status: 201 });
      }

      const convByIdMatch = p.match(/^\/api\/conversations\/([^/]+)$/);
      if (convByIdMatch && req.method === "GET") {
        const conv = state.conversations.get(convByIdMatch[1]!);
        return conv ? json(conv) : new Response("not found", { status: 404 });
      }

      const convMsgMatch = p.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (convMsgMatch) {
        const convId = convMsgMatch[1]!;
        if (!state.conversations.has(convId)) return new Response("not found", { status: 404 });
        if (req.method === "GET") return json(state.messages.get(convId) ?? []);
        if (req.method === "POST") {
          const body = (await req.json()) as { content: string };
          const userMsg = { id: uuid(), role: "user", content: body.content };
          state.messages.get(convId)!.push(userMsg);
          const runId = uuid();
          // Schedule deterministic streaming events on next tick so tests can
          // open the SSE stream before they arrive.
          queueMicrotask(() => {
            emit({ type: "run:start", data: { runId, conversationId: convId } });
            emit({ type: "run:token", data: { runId, token: "ok", kind: "text" } });
            emit({
              type: "run:turn_saved",
              data: { runId, conversationId: convId, messageId: uuid(), content: "ok" },
            });
            emit({ type: "run:complete", data: { runId, conversationId: convId } });
          });
          return json({ userMessage: userMsg, runId, attachments: [] });
        }
      }

      const subConvMatch = p.match(/^\/api\/conversations\/([^/]+)\/sub-conversations$/);
      if (subConvMatch) {
        const parent = subConvMatch[1]!;
        const subs = [...state.conversations.values()].filter(
          (c) => c.parentConversationId === parent,
        );
        return json(subs);
      }

      const cancelMatch = p.match(/^\/api\/conversations\/([^/]+)\/active-run$/);
      if (cancelMatch && req.method === "POST") return json({ ok: true });

      const assignMatch = p.match(
        /^\/api\/conversations\/([^/]+)\/tasks\/([^/]+)\/assign$/,
      );
      const tasksMatch = p.match(/^\/api\/conversations\/([^/]+)\/tasks$/);
      if (tasksMatch && req.method === "GET") {
        return json({ conversationId: tasksMatch[1], tasks: [] });
      }

      if (assignMatch && req.method === "POST") {
        return json({
          assignment: { id: uuid(), agentConfigId: "stub", status: "assigned" },
          snapshot: { tasks: [] },
        });
      }

      const startAssignmentMatch = p.match(
        /^\/api\/conversations\/([^/]+)\/tasks\/([^/]+)\/assignments\/([^/]+)\/start$/,
      );
      if (startAssignmentMatch && req.method === "POST") {
        const parent = startAssignmentMatch[1]!;
        const sub = {
          id: uuid(),
          projectId: state.conversations.get(parent)?.projectId ?? "global",
          parentConversationId: parent,
        };
        state.conversations.set(sub.id, sub);
        state.messages.set(sub.id, []);
        return json({
          assignment: { id: startAssignmentMatch[3], status: "running" },
          runId: uuid(),
          subConversationId: sub.id,
        });
      }

      if (p === "/api/agent-configs" && req.method === "GET")
        return json([...state.agents.values()]);
      if (p === "/api/agent-configs" && req.method === "POST") {
        const body = (await req.json()) as { name: string; prompt: string; category?: string };
        const agent = {
          id: uuid(),
          name: body.name,
          prompt: body.prompt,
          category: body.category,
        };
        state.agents.set(agent.id, agent);
        return json(agent, { status: 201 });
      }
      if (p === "/api/agent-configs/generate" && req.method === "POST") {
        const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
        const last = body.messages[body.messages.length - 1];
        // Two-turn wizard: first turn returns clarifying text, second turn returns config.
        if (body.messages.length === 1) {
          return json({ text: "What should I focus on?", config: null });
        }
        return json({
          text: "Generated",
          config: {
            name: "generated-" + (last?.content ?? "agent").slice(0, 8).toLowerCase(),
            prompt: "You are a helpful agent.",
            description: "generated via stub",
          },
        });
      }

      if (p === "/api/mentions/search") {
        const q = url.searchParams.get("q") ?? "";
        const type = url.searchParams.get("type");
        const hits = [{ name: q + "-match", kind: type ?? "agent", description: "stub hit" }];
        return json(hits);
      }

      if (p === "/api/models") return json([{ id: "claude-sonnet-4-6", provider: "anthropic" }]);
      if (p === "/api/extensions") return json(state.extensions);

      if (p === "/api/runtime-events") {
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        const writer = writable.getWriter();
        state.sseClients.add(writer);
        // Flush any buffered events so late subscribers see recent history
        // (real runtime-events does the same for its short retention window).
        for (const ev of state.runEvents) {
          writer.write(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`)).catch(() => {});
        }
        req.signal.addEventListener("abort", () => {
          state.sseClients.delete(writer);
          writer.close().catch(() => {});
        });
        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  function emit(event: unknown) {
    state.runEvents.push(event);
    const frame = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const w of state.sseClients) {
      w.write(frame).catch(() => state.sseClients.delete(w));
    }
  }

  return {
    port: server.port!,
    url: `http://localhost:${server.port}`,
    state,
    stop: () => {
      for (const w of state.sseClients) w.close().catch(() => {});
      state.sseClients.clear();
      server.stop(true);
    },
    emit,
  };
}
