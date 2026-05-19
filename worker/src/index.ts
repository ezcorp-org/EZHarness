import type {
  AgentDefinition,
  AgentContext,
  AgentEvents,
} from "../../src/types";
import { EventBus } from "../../src/runtime/events";
import { AgentExecutor } from "../../src/runtime/executor";
import { loadAgentsStatic } from "../../src/runtime/loader";

// ── LLM-only agents for Workers ────────────────────────────────────

const summarizer: AgentDefinition = {
  name: "summarizer",
  description: "Summarize text using an LLM",
  capabilities: ["llm"],
  inputSchema: {
    text: { type: "text", label: "Text", description: "Text to summarize", required: true },
    provider: { type: "select", label: "Provider", options: ["anthropic", "google", "openai"], default: "anthropic" },
    model: { type: "string", label: "Model", description: "Override model name" },
  },
  async execute(ctx: AgentContext) {
    const text = ctx.input.text as string | undefined;
    if (!text) return { success: false, output: null, error: "Missing input.text" };

    ctx.log("Summarizing text...");
    const response = await ctx.llm.complete(
      [{ role: "user", content: text }],
      {
        system: "Summarize the following text concisely.",
        provider: (ctx.input.provider as string) ?? undefined,
        model: ctx.input.model as string | undefined,
      },
    );
    return { success: true, output: { summary: response.text } };
  },
};

// ── Stub providers for shell/file (not available on Workers) ───────

const stubShell = {
  async run() {
    throw new Error("Shell is not available on Cloudflare Workers");
  },
} as AgentContext["shell"];

const stubFile = {
  async read() {
    throw new Error("File system is not available on Cloudflare Workers");
  },
  async write() {
    throw new Error("File system is not available on Cloudflare Workers");
  },
  async exists() {
    throw new Error("File system is not available on Cloudflare Workers");
  },
} as AgentContext["file"];

// ── Worker entry ───────────────────────────────────────────────────

const agents = loadAgentsStatic([summarizer]);
const bus = new EventBus<AgentEvents>();
const executor = new AgentExecutor(agents, bus, {
  shell: stubShell,
  file: stubFile,
});

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET /api/agents
    if (pathname === "/api/agents" && request.method === "GET") {
      const list = executor.listAgents().map((a) => ({
        name: a.name,
        description: a.description,
        capabilities: a.capabilities,
        inputSchema: a.inputSchema,
      }));
      return json(list);
    }

    // GET /api/runs
    if (pathname === "/api/runs" && request.method === "GET") {
      return json(executor.listRuns());
    }

    // GET /api/runs/:id
    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && request.method === "GET") {
      const run = executor.getRun(runMatch[1]!);
      return run ? json(run) : json({ error: "Not found" }, 404);
    }

    // POST /api/agents/:name/run
    const agentRunMatch = pathname.match(/^\/api\/agents\/([^/]+)\/run$/);
    if (agentRunMatch && request.method === "POST") {
      try {
        const input = (await request.json()) as Record<string, unknown>;
        const run = await executor.runAgent(agentRunMatch[1]!, input);
        return json(run);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: message }, 400);
      }
    }

    return json({ error: "Not found" }, 404);
  },
};
