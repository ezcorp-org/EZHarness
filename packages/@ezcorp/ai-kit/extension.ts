import { createRuntimeExtension, getInvocationContext, serve } from "@ezcorp/sdk/v4";
import { createToolDispatcher, getChannel, type ToolHandler } from "@ezcorp/sdk/runtime";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import manifest from "./ezcorp.config";
import { EzcorpClient, callContext } from "./src/client";
import { register as registerDiscover } from "./src/mcp/tools/discover";
import { register as registerChat } from "./src/mcp/tools/chat";
import { register as registerAgents } from "./src/mcp/tools/agents";
import { register as registerOrchestrate } from "./src/mcp/tools/orchestrate";

export function createBrokerFetch(requestHost: <Result>(method: string, input: unknown) => Promise<Result> = (method, input) => getChannel().request(method, input)): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://extension-api.invalid") throw new Error("Invalid host API origin");
    if (url.pathname === "/api/runtime-events") {
      let cursor: string | undefined;
      let cancelled = false;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (cancelled) return;
          if (request.signal.aborted) {
            controller.close();
            return;
          }
          try {
            const batch = await requestHost<{ cursor: string; events: unknown[]; done?: boolean }>("ezcorp/api.events", { cursor, waitMs: 1000 });
            if (cancelled) return;
            cursor = batch.cursor;
            for (const event of batch.events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            if (batch.done) controller.close();
          } catch (error) {
            if (!cancelled) controller.error(error);
          }
        },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    const result = await requestHost<{ status: number; body: string; headers?: Record<string, string> }>("ezcorp/api.request", {
      path: url.pathname + url.search,
      method: request.method,
      ...(body === undefined ? {} : { body }),
    });
    return new Response(result.status === 204 ? null : result.body, { status: result.status, headers: result.headers });
  }) as typeof fetch;
}

export function register(): void {
  const client = new EzcorpClient({ baseUrl: "https://extension-api.invalid", publicUrl: "", apiKey: "", sessionCookie: "", fetch: createBrokerFetch() });
  const tools: Record<string, ToolHandler> = Object.create(null);
  const registrar = {
    tool(name: string, _description: string, schema: z.ZodRawShape, callback: (...args: unknown[]) => unknown) {
      if (tools[name]) throw new Error(`Duplicate MCP tool: ${name}`);
      const validator = z.object(schema);
      tools[name] = async (args) => {
        const metadata = getInvocationContext()?.metadata ?? {};
        return await callContext.run({
          defaultModel: typeof metadata.ezModel === "string" ? metadata.ezModel : undefined,
          defaultProvider: typeof metadata.ezProvider === "string" ? metadata.ezProvider : undefined,
          publicUrl: typeof metadata.ezPublicUrl === "string" ? metadata.ezPublicUrl : undefined,
        }, async () => await callback(validator.parse(args), {}) as Awaited<ReturnType<ToolHandler>>);
      };
    },
  } as unknown as McpServer;
  registerDiscover(registrar, client);
  registerChat(registrar, client);
  registerAgents(registrar, client);
  registerOrchestrate(registrar, client);
  getChannel();
  createToolDispatcher(tools);
}

if (import.meta.main) await serve(await createRuntimeExtension({ manifest, register }));
