import { restageMcpExtension } from "$server/extensions/mcp-control";
import { mcpControlRequest } from "$lib/server/extensions/mcp-request";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, params }) => mcpControlRequest(locals, null, async actor => {
  if (!params.id) throw Object.assign(new Error("MCP extension identifier required"), { code: "invalid_input" });
  return restageMcpExtension(actor, params.id);
});
