import { json } from "@sveltejs/kit";
import { ExtensionRegistry } from "$server/extensions/registry";
import {
  MCP_CONNECT_FAILED_MESSAGE,
  MCP_CONNECT_FAILED_STATUS,
  reportMcpConnectFailure,
} from "$server/mcp/connect-failure";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, locals }) => {
  // F2: admin ROLE *and* (for key principals) the `admin` SCOPE — see the
  // install route. Refresh re-connects to the configured MCP server, so it
  // is an instance-state action, not a read.
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const id = params.id;
  if (!id) return errorJson(400, "id required");

  // `refreshMcpTools` re-connects to the STORED config, so it re-runs the
  // SSRF target guard on every call — a config that has since been rebound
  // to an internal address is refused here, not just at install time.
  //
  // The raw error is never echoed: it used to carry the transport's own
  // words (ECONNREFUSED vs timeout vs protocol error), which is the same
  // port-scan oracle the install route had. Uniform 502, real cause logged.
  try {
    const tools = await ExtensionRegistry.getInstance().refreshMcpTools(id);
    return json({ id, tools });
  } catch (e) {
    await reportMcpConnectFailure(e, {
      route: "POST /api/mcp-servers/[id]/refresh",
      extension: id,
    });
    return errorJson(MCP_CONNECT_FAILED_STATUS, MCP_CONNECT_FAILED_MESSAGE);
  }
};
