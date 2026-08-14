import { json } from "@sveltejs/kit";
import { getExtension, rehydrateMcpServerSecrets, updateMcpExtension } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { McpClient } from "$server/mcp/client";
import {
  MCP_CONNECT_FAILED_MESSAGE,
  MCP_CONNECT_FAILED_STATUS,
  reportMcpConnectFailure,
} from "$server/mcp/connect-failure";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import { buildMcpAuditMetadata, describeMcpServerForAudit } from "$server/extensions/mcp-audit";
import { mergeMcpServerSecrets } from "$server/extensions/mcp-secret-redaction";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import { updateMcpServerSchema } from "../schema";
import type { RequestHandler } from "./$types";

/**
 * Edit-after-install for an MCP extension. Re-connects with the new config,
 * re-runs tools/list, and persists the new server config + refreshed tool
 * snapshot. Mirrors the install POST: a throwaway client verifies
 * connectivity before any mutation, so a 502 leaves the stored config
 * untouched.
 *
 * - 404 if the id is missing or the extension is not an MCP extension.
 * - 502 if the new config fails to connect / list tools (no mutation).
 * - Blank header value = keep the existing secret (headers are never echoed
 *   back to the client, so the edit form sends blank to mean "unchanged").
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  // F2: admin ROLE *and* (for key principals) the `admin` SCOPE — see the
  // install route. This handler rehydrates stored auth headers, so a
  // read-scoped key must never reach it.
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const id = params.id;
  if (!id) return errorJson(400, "id required");

  const parsed = updateMcpServerSchema.safeParse(await request.json());
  if (!parsed.success) return validationError(parsed.error);

  const existing = await getExtension(id);
  if (!existing) return errorJson(404, "MCP extension not found");
  const manifest = existing.manifest as ExtensionManifestV2;
  if (manifest.kind !== "mcp") return errorJson(404, "Extension is not an MCP extension");

  const { description } = parsed.data;
  // Merge credentials: a blank (or omitted) value preserves the existing secret
  // for that NAME — header keys, stdio env vars, URL query parameters and argv
  // flags alike (issue #205; `mergeMcpServerSecrets` owns the rule). Existing
  // names not present in the incoming definition are also preserved.
  //
  // The stored manifest keeps only value-BLANKED names (the real values live in
  // the extension_secrets store), so rehydrate the real previous values first —
  // otherwise "blank = keep existing" would preserve an empty credential and
  // the re-connect below would authenticate with no token.
  const prevRedacted = manifest.mcpServers?.[0];
  const prevServer = prevRedacted
    ? await rehydrateMcpServerSecrets(existing.name, prevRedacted)
    : undefined;
  const server = mergeMcpServerSecrets(parsed.data.server, prevServer);

  // Verify connectivity + pull the live tool list with a throwaway client
  // BEFORE persisting. `client.connect()` runs the SSRF target guard, and
  // every failure returns the one uniform 502 body (see the install route
  // and `connect-failure.ts`). Failure means no mutation.
  const client = new McpClient(server);
  let cachedTools: Awaited<ReturnType<typeof client.listTools>>;
  try {
    await client.connect();
    cachedTools = await client.listTools();
  } catch (e) {
    await reportMcpConnectFailure(e, {
      route: "PUT /api/mcp-servers/[id]",
      extension: existing.name,
      transport: server.transport,
    });
    return errorJson(MCP_CONNECT_FAILED_STATUS, MCP_CONNECT_FAILED_MESSAGE);
  } finally {
    await client.close().catch(() => {});
  }

  const updated = await updateMcpExtension({ id, description, server, cachedTools });
  if (!updated) return errorJson(404, "MCP extension not found");

  await ExtensionRegistry.getInstance().reload();
  // `prevRedacted` is the value-blanked stored definition — exactly the
  // credential-free view the audit wants, so the before/after diff shows a
  // re-pointed connection without ever holding a secret.
  // `mergeMcpServerSecrets` runs on the rehydrated copy, never on this one.
  try {
    await insertAuditEntry(
      locals.user?.id ?? null,
      EXT_AUDIT_ACTIONS.MCP_SERVER_UPDATED,
      updated.id,
      buildMcpAuditMetadata({
        extensionName: updated.name,
        actorUserId: locals.user?.id ?? "unknown",
        reason: "mcp-update",
        before: prevRedacted ? describeMcpServerForAudit(prevRedacted, manifest.tools) : null,
        after: describeMcpServerForAudit(server, cachedTools),
      }),
    );
  } catch { /* non-fatal — audit is observability, not a gate */ }
  return json(updated);
};
