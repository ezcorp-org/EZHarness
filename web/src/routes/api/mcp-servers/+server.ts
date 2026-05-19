import { json } from "@sveltejs/kit";
import { installMcpExtension } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { McpClient } from "$server/mcp/client";
import { requireRole } from "$server/auth/middleware";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import { installMcpServerSchema } from "./schema";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  requireRole(locals, "admin");

  const parsed = installMcpServerSchema.safeParse(await request.json());
  if (!parsed.success) return validationError(parsed.error);

  const { name, description, server } = parsed.data;

  // Open a throwaway client to verify connectivity + pull the live tool list
  // before persisting. Failures surface as 502 so the UI can explain.
  const client = new McpClient(server);
  let cachedTools;
  try {
    await client.connect();
    cachedTools = await client.listTools();
  } catch (e) {
    const message = e instanceof Error ? e.message : "MCP connect failed";
    return errorJson(502, `MCP connect failed: ${message}`);
  } finally {
    await client.close().catch(() => {});
  }

  try {
    const ext = await installMcpExtension({
      name,
      description,
      server,
      cachedTools,
    });
    await ExtensionRegistry.getInstance().reload();
    return json(ext, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "MCP install failed";
    return errorJson(400, message);
  }
};
