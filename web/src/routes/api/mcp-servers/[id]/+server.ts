import { json } from "@sveltejs/kit";
import { getExtension, updateMcpExtension } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { McpClient } from "$server/mcp/client";
import { requireRole } from "$server/auth/middleware";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import type { ExtensionManifestV2, McpServerDefinition } from "$server/extensions/types";
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
  requireRole(locals, "admin");
  const id = params.id;
  if (!id) return errorJson(400, "id required");

  const parsed = updateMcpServerSchema.safeParse(await request.json());
  if (!parsed.success) return validationError(parsed.error);

  const existing = await getExtension(id);
  if (!existing) return errorJson(404, "MCP extension not found");
  const manifest = existing.manifest as ExtensionManifestV2;
  if (manifest.kind !== "mcp") return errorJson(404, "Extension is not an MCP extension");

  const { description } = parsed.data;
  // Merge headers: a blank (or omitted) header value preserves the existing
  // secret for that key. Existing keys not present in the incoming map are
  // also preserved. stdio transports carry no headers, so this is a no-op
  // for them.
  const prevServer = manifest.mcpServers?.[0];
  const server = mergeHeaders(parsed.data.server, prevServer);

  // Verify connectivity + pull the live tool list with a throwaway client
  // BEFORE persisting. Failure surfaces as 502 with no mutation.
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

  const updated = await updateMcpExtension({ id, description, server, cachedTools });
  if (!updated) return errorJson(404, "MCP extension not found");

  await ExtensionRegistry.getInstance().reload();
  return json(updated);
};

/**
 * For http/sse transports, fill in any blank/absent header values from the
 * previous server config so the edit form never has to re-enter secrets.
 * stdio transports have no headers and pass through unchanged.
 */
function mergeHeaders(
  next: McpServerDefinition,
  prev: McpServerDefinition | undefined,
): McpServerDefinition {
  if (next.transport === "stdio") return next;
  const prevHeaders =
    prev && prev.transport !== "stdio" ? (prev.headers ?? {}) : {};
  const merged: Record<string, string> = { ...prevHeaders };
  for (const [k, v] of Object.entries(next.headers ?? {})) {
    // Blank value = "keep existing" (only overwrite when a fresh value is
    // supplied). A non-blank value replaces; a key with no prior value and a
    // blank new value drops to empty (harmless).
    if (v.trim() === "") continue;
    merged[k] = v;
  }
  return { ...next, headers: merged };
}
