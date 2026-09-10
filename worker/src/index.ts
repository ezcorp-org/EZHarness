/**
 * Minimal Worker-native agent runtime.
 *
 * The host AgentExecutor reaches database and native sandbox modules, neither
 * of which can load in workerd. This runtime deliberately owns only the
 * Worker contract: one LLM-only summarizer and bounded ephemeral run inspection.
 */

import { complete, getModels } from "@earendil-works/pi-ai/compat";

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

const MAX_RUNS = 100;

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

function apiKey(providerName: Provider, env: Env): string | undefined {
  if (providerName === "openai") return env.OPENAI_API_KEY;
  if (providerName === "anthropic") return env.ANTHROPIC_API_KEY;
  return env.GOOGLE_API_KEY;
}

function baseUrl(providerName: Provider, env: Env): string | undefined {
  if (providerName === "openai") return env.OPENAI_BASE_URL;
  if (providerName === "anthropic") return env.ANTHROPIC_BASE_URL;
  return env.GOOGLE_BASE_URL;
}

function resolvePortableModel(providerName: Provider, modelId: string, env: Env): Parameters<typeof complete>[0] {
  const known = getModels(providerName).find((candidate) => candidate.id === modelId) ?? getModels(providerName)[0];
  if (!known) throw new Error(`No portable model definition for ${providerName}`);
  return {
    ...known,
    id: modelId,
    name: modelId,
    provider: providerName,
    ...(baseUrl(providerName, env) ? { baseUrl: baseUrl(providerName, env) } : {}),
  } as Parameters<typeof complete>[0];
}

async function completeSummary(providerName: Provider, model: string, prompt: string, env: Env): Promise<Completion> {
  const system = "Summarize the following text concisely.";
  const key = apiKey(providerName, env);
  if (!key) throw new Error(`Missing ${providerName} API key binding`);
  const response = await complete(resolvePortableModel(providerName, model, env), {
    systemPrompt: system,
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, { apiKey: key });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? `${providerName} completion stopped: ${response.stopReason}`);
  }
  const result = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (!result) throw new Error(`${providerName} completion response did not include text content`);
  return { text: result, inputTokens: response.usage.input, outputTokens: response.usage.output };
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
      trimRuns();
      return run;
    }

    try {
      const providerName = provider(input.provider ?? env.DEFAULT_PROVIDER ?? "anthropic");
      const model = text(input.model) ?? text(env.DEFAULT_MODEL);
      if (!model) throw new Error("Missing input.model; provide model or configure DEFAULT_MODEL");
      run.provider = providerName;
      run.model = model;
      run.logs.push({ timestamp: Date.now(), level: "info", message: "Summarizing text..." });
      const result = await completeSummary(providerName, model, source, env);
      run.inputTokens = result.inputTokens;
      run.outputTokens = result.outputTokens;
      run.status = "success";
      run.finishedAt = Date.now();
      run.result = { success: true, output: { summary: result.text } };
      trimRuns();
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.status = "error";
      run.finishedAt = Date.now();
      run.logs.push({ timestamp: Date.now(), level: "error", message });
      run.result = { success: false, output: null, error: message };
      trimRuns();
      return run;
    }
  }
}

function trimRuns(): void {
  while (runs.size > MAX_RUNS) {
    const terminal = [...runs.values()].find((run) => run.status !== "running");
    if (!terminal) return;
    runs.delete(terminal.id);
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
