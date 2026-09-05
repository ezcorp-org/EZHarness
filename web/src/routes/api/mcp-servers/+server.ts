import { stageMcpExtension } from "$server/extensions/mcp-control";
import { mcpControlRequest } from "$lib/server/extensions/mcp-request";
import { installMcpServerSchema } from "./schema";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => mcpControlRequest(locals, request, async (actor, body) => {
  const parsed = installMcpServerSchema.safeParse(body);
  if (!parsed.success) throw Object.assign(new Error("Invalid MCP source declaration"), { code: "invalid_input" });
  return stageMcpExtension(actor, parsed.data);
});
