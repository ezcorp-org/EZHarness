#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EzcorpClient, callContext, type AiKitCallContext } from "../client.js";
import { register as registerDiscover } from "./tools/discover.js";
import { register as registerChat } from "./tools/chat.js";
import { register as registerAgents } from "./tools/agents.js";
import { register as registerOrchestrate } from "./tools/orchestrate.js";

/** Monkey-patch `server.tool` to transparently pick the per-call context
 *  (on-behalf-of user id, default model, default provider) out of each
 *  incoming call's `_meta` side channel and run the original handler
 *  inside a `callContext` AsyncLocalStorage scope.
 *
 *  The EZCorp tool executor injects these fields into every bundled-
 *  extension tools/call request (see src/extensions/tool-executor.ts):
 *    - `_meta.ezOnBehalfOf` — the user id of the calling conversation's
 *      owner.
 *    - `_meta.ezModel` / `_meta.ezProvider` — the model + provider the
 *      calling conversation is using, so a new chat spawned through
 *      `start_chat` inherits those settings rather than falling back to
 *      an unrelated server default.
 *    - `_meta.ezPublicUrl` — the user-facing origin of the EZCorp web
 *      UI (e.g. `https://ezcorp.example.com`). Tool responses use this
 *      to build clickable links back to produced entities; without it
 *      the client falls back to its `baseUrl`, which may be loopback.
 *
 *  Because `_meta` lives outside the LLM-visible tool arguments, an LLM
 *  cannot forge or override it via prompt injection — the values are
 *  always server-supplied. The LLM CAN still set `model` / `provider` in
 *  its explicit tool args, and when it does, the client-side merge lets
 *  that explicit value win over the inherited default. */
function wrapToolRegistrationsWithContext(server: McpServer): void {
  const original = server.tool.bind(server);
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (
    ...args: unknown[]
  ) => {
    // `server.tool` has several overloads — the callback is always the
    // LAST argument (a function). We replace it in-place with an ALS-
    // wrapping proxy.
    const lastIdx = args.length - 1;
    const cb = args[lastIdx];
    if (typeof cb !== "function") return original(...(args as Parameters<typeof original>));

    args[lastIdx] = async (...cbArgs: unknown[]) => {
      // MCP SDK calls handlers with either (args, extra) or (extra,) for
      // zero-arg tools. The `extra` object always has `_meta` if the
      // request carried metadata.
      const extra = (cbArgs.length === 1 ? cbArgs[0] : cbArgs[1]) as
        | { _meta?: Record<string, unknown> }
        | undefined;
      const meta = extra?._meta ?? {};
      const ctx: AiKitCallContext = {};
      const obo = meta["ezOnBehalfOf"];
      if (typeof obo === "string" && obo.length > 0) ctx.onBehalfOf = obo;
      const model = meta["ezModel"];
      if (typeof model === "string" && model.length > 0) ctx.defaultModel = model;
      const provider = meta["ezProvider"];
      if (typeof provider === "string" && provider.length > 0) ctx.defaultProvider = provider;
      const publicUrl = meta["ezPublicUrl"];
      if (typeof publicUrl === "string" && publicUrl.length > 0) ctx.publicUrl = publicUrl;

      // If nothing was populated, skip the ALS scope — no observable
      // difference from the unwrapped handler.
      if (!ctx.onBehalfOf && !ctx.defaultModel && !ctx.defaultProvider && !ctx.publicUrl) {
        return (cb as (...a: unknown[]) => unknown)(...cbArgs);
      }
      return callContext.run(ctx, () => (cb as (...a: unknown[]) => unknown)(...cbArgs));
    };
    return original(...(args as Parameters<typeof original>));
  };
}

export function createMcpServer(client?: EzcorpClient): McpServer {
  const resolvedClient =
    client ??
    new EzcorpClient({
      baseUrl: process.env["EZCORP_BASE_URL"],
      apiKey: process.env["EZCORP_API_KEY"],
    });

  const server = new McpServer(
    { name: "ezcorp-ai-kit", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "This MCP server exposes the EZCorp HTTP API as typed tools. Use list_projects to orient yourself, then start_chat + send_message to drive conversations. Use spawn_chats for N parallel root-level conversations, or spawn_agents/spawn_team/assign_task for fan-out within a single chat.",
    },
  );

  wrapToolRegistrationsWithContext(server);

  registerDiscover(server, resolvedClient);
  registerChat(server, resolvedClient);
  registerAgents(server, resolvedClient);
  registerOrchestrate(server, resolvedClient);

  return server;
}

// Run as stdio MCP server when executed directly. Single-line guard so it is
// covered on import; the body only runs on a direct `bun server.ts` spawn.
if (import.meta.main) await createMcpServer().connect(new StdioServerTransport());
