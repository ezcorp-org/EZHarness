import { restageMcpExtension } from "$server/extensions/mcp-control";
import { mcpControlRequest } from "$lib/server/extensions/mcp-request";
import { updateMcpServerSchema } from "../schema";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async ({ request, locals, params }) => mcpControlRequest(locals, request, async (actor, body) => {
  const parsed = updateMcpServerSchema.safeParse(body);
  if (!parsed.success || !params.id) throw Object.assign(new Error("Invalid MCP source declaration"), { code: "invalid_input" });
  return restageMcpExtension(actor, params.id, parsed.data);
});
