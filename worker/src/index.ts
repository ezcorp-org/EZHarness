/**
 * Minimal Worker-native agent runtime.
 *
 * The host AgentExecutor reaches database and native sandbox modules, neither
 * of which can load in workerd. This runtime deliberately owns only the
 * Worker contract: one LLM-only summarizer and ephemeral run inspection.
 */

type Provider = "anthropic" | "google" | "openai";
type RunStatus = "running" | "success" | "error";

interface Env {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  DEFAULT_MODEL?: string;
  DEFAULT_PROVIDER?: Provider;
  GOOGLE_API_KEY?: string;
  GOOGLE_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
}

interface AgentResult {
  success: boolean;
  output: unknown;
  error?: string;
}

interface AgentRun {
  id: string;
  agentName: string;
  inputTokens?: number;
  provider?: Provider;
  model?: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  logs: Array<{ timestamp: number; level: "info" | "error"; message: string }>;
  result?: AgentResult;
  outputTokens?: number;
}

interface Completion {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const agents = [{
  name: "summarizer",
  description: "Summarize text using an LLM",
  capabilities: ["llm"],
  inputSchema: {
    text: { type: "text", label: "Text", description: "Text to summarize", required: true },
    provider: { type: "select", label: "Provider", options: ["anthropic", "google", "openai"], default: "anthropic" },
    model: { type: "string", label: "Model", description: "Override model name" },
  },
}];

const runs = new Map<string, AgentRun>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function provider(value: unknown): Provider {
  if (value === "anthropic" || value === "google" || value === "openai") return value;
  throw new Error(`Unsupported provider: ${String(value)}`);
}

function endpoint(baseUrl: string | undefined, fallback: string, path: string): string {
  return new URL(path, `${baseUrl ?? fallback}`.replace(/\/?$/, "/")).toString();
}

async function failure(response: Response, providerName: Provider): Promise<never> {
  const body = (await response.text()).slice(0, 500);
  throw new Error(`${providerName} completion failed (${response.status}): ${body || response.statusText}`);
}

async function complete(providerName: Provider, model: string, prompt: string, env: Env): Promise<Completion> {
  const system = "Summarize the following text concisely.";
  if (providerName === "openai") {
    const response = await fetch(endpoint(env.OPENAI_BASE_URL, "https://api.openai.com/v1", "chat/completions"), {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    });
    if (!response.ok) return failure(response, providerName);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const result = body.choices?.[0]?.message?.content;
    if (!result) throw new Error("openai completion response did not include choices[0].message.content");
    return { text: result, inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens };
  }

  if (providerName === "anthropic") {
    const response = await fetch(endpoint(env.ANTHROPIC_BASE_URL, "https://api.anthropic.com/v1", "messages"), {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01", "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY ?? "" },
      body: JSON.stringify({ model, max_tokens: 1024, system, messages: [{ role: "user", content: prompt }] }),
    });
    if (!response.ok) return failure(response, providerName);
    const body = await response.json() as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const result = body.content?.find((part) => part.type === "text")?.text;
    if (!result) throw new Error("anthropic completion response did not include text content");
    return { text: result, inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens };
  }

  const response = await fetch(`${endpoint(env.GOOGLE_BASE_URL, "https://generativelanguage.googleapis.com/v1beta", `models/${model}:generateContent`)}?key=${encodeURIComponent(env.GOOGLE_API_KEY ?? "")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }] }),
  });
  if (!response.ok) return failure(response, providerName);
  const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  const result = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
  if (!result) throw new Error("google completion response did not include candidate text");
  return { text: result, inputTokens: body.usageMetadata?.promptTokenCount, outputTokens: body.usageMetadata?.candidatesTokenCount };
}

class WorkerExecutor {
  async listRuns(): Promise<AgentRun[]> {
    return [...runs.values()].sort((left, right) => right.startedAt - left.startedAt);
  }

  async getRun(id: string): Promise<AgentRun | undefined> {
    return runs.get(id);
  }

  async runAgent(name: string, input: Record<string, unknown>, env: Env): Promise<AgentRun> {
    if (name !== "summarizer") throw new Error(`Agent not found: ${name}`);
    const run: AgentRun = { id: crypto.randomUUID(), agentName: name, status: "running", startedAt: Date.now(), logs: [] };
    runs.set(run.id, run);
    const source = text(input.text);
    if (!source) {
      run.status = "success";
      run.finishedAt = Date.now();
      run.result = { success: false, output: null, error: "Missing input.text" };
      return run;
    }

    try {
      const providerName = provider(input.provider ?? env.DEFAULT_PROVIDER ?? "anthropic");
      const model = text(input.model) ?? text(env.DEFAULT_MODEL);
      if (!model) throw new Error("Missing input.model; provide model or configure DEFAULT_MODEL");
      run.provider = providerName;
      run.model = model;
      run.logs.push({ timestamp: Date.now(), level: "info", message: "Summarizing text..." });
      const result = await complete(providerName, model, source, env);
      run.inputTokens = result.inputTokens;
      run.outputTokens = result.outputTokens;
      run.status = "success";
      run.finishedAt = Date.now();
      run.result = { success: true, output: { summary: result.text } };
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.status = "error";
      run.finishedAt = Date.now();
      run.logs.push({ timestamp: Date.now(), level: "error", message });
      run.result = { success: false, output: null, error: message };
      return run;
    }
  }
}

const executor = new WorkerExecutor();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (pathname === "/api/agents" && request.method === "GET") return json(agents);
    if (pathname === "/api/runs" && request.method === "GET") return json(await executor.listRuns());

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && request.method === "GET") {
      const run = await executor.getRun(runMatch[1]!);
      return run ? json(run) : json({ error: "Not found" }, 404);
    }

    const agentRunMatch = pathname.match(/^\/api\/agents\/([^/]+)\/run$/);
    if (agentRunMatch && request.method === "POST") {
      try {
        const input = await request.json() as Record<string, unknown>;
        return json(await executor.runAgent(agentRunMatch[1]!, input, env));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
    return json({ error: "Not found" }, 404);
  },
};
