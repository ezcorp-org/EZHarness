import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { EzcorpClient } from "../client.js";
import { createMcpServer } from "./server.js";

/**
 * Stateless Streamable HTTP handler for the EZCorp MCP server.
 *
 * Mount this from a SvelteKit +server.ts route:
 * ```ts
 * // web/src/routes/api/mcp/+server.ts
 * import { handleMcpRequest } from "@ezcorp/ai-kit/mcp-http";
 * export const GET = handleMcpRequest;
 * export const POST = handleMcpRequest;
 * export const DELETE = handleMcpRequest;
 * ```
 *
 * EZCORP_BASE_URL and EZCORP_API_KEY are read from env; callers may pass an
 * explicit client to override (e.g. in tests).
 */
export async function handleMcpRequest(
  req: Request,
  clientOverride?: EzcorpClient,
): Promise<Response> {
  const client =
    clientOverride ??
    new EzcorpClient({
      baseUrl: process.env["EZCORP_BASE_URL"],
      apiKey: process.env["EZCORP_API_KEY"],
    });

  // Stateless mode: one transport per request, no session state.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  const server = createMcpServer(client);
  await server.connect(transport);

  const response = await transport.handleRequest(req);

  // Close the transport after the response is done so there are no leaks.
  response.clone().body?.cancel().catch(() => {});
  // Schedule cleanup — we must not close before the response body is consumed
  // by the caller, so we do it asynchronously.
  queueMicrotask(() => {
    transport.close().catch(() => {});
  });

  return response;
}
