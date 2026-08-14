import { json } from "@sveltejs/kit";
import { ExtensionRegistry } from "$server/extensions/registry";
import { getExtension } from "$server/db/queries/extensions";
import {
  MCP_CONNECT_FAILED_MESSAGE,
  MCP_CONNECT_FAILED_STATUS,
  reportMcpConnectFailure,
} from "$server/mcp/connect-failure";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import { buildMcpAuditMetadata, describeMcpServerForAudit } from "$server/extensions/mcp-audit";
import type { ExtensionManifestV2 } from "$server/extensions/types";
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
    // Snapshot the PRE-refresh tool list first: `refreshMcpTools` writes the
    // new manifest back, so reading after it would diff a row against itself
    // and the audit row would claim every refresh was a no-op.
    //
    // Guarded on its own, because this read exists ONLY to shape the audit
    // row. Audit is best-effort by contract (see the insert below and
    // `permissions-and-grants.md`), so a failing read must degrade the trail,
    // never the refresh — and certainly never surface as a "server
    // unreachable" 502, which would blame the MCP server for a database
    // problem and send the operator hunting the wrong fault.
    let before: Awaited<ReturnType<typeof getExtension>> = null;
    try {
      before = await getExtension(id);
    } catch { /* non-fatal — the refresh proceeds, unaudited */ }
    const beforeManifest = before?.manifest as ExtensionManifestV2 | undefined;
    const tools = await ExtensionRegistry.getInstance().refreshMcpTools(id);
    // The connection is untouched by a refresh — the diff that matters is the
    // tool snapshot, so both sides describe the SAME stored (value-blanked)
    // server definition and differ only in `toolCount` / `toolNames`.
    const serverDef = beforeManifest?.mcpServers?.[0];
    if (before && serverDef) {
      try {
        await insertAuditEntry(
          locals.user?.id ?? null,
          EXT_AUDIT_ACTIONS.MCP_SERVER_REFRESHED,
          before.id,
          buildMcpAuditMetadata({
            extensionName: before.name,
            actorUserId: locals.user?.id ?? "unknown",
            reason: "mcp-refresh",
            before: describeMcpServerForAudit(serverDef, beforeManifest?.tools),
            after: describeMcpServerForAudit(serverDef, tools),
          }),
        );
      } catch { /* non-fatal — audit is observability, not a gate */ }
    }
    return json({ id, tools });
  } catch (e) {
    await reportMcpConnectFailure(e, {
      route: "POST /api/mcp-servers/[id]/refresh",
      extension: id,
    });
    return errorJson(MCP_CONNECT_FAILED_STATUS, MCP_CONNECT_FAILED_MESSAGE);
  }
};
