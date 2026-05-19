import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAuth } from "$server/auth/middleware";
import { getListingById, incrementInstallCount } from "$server/db/queries/marketplace";
import { getLatestVersion, getVersion } from "$server/db/queries/marketplace-versions";
import { createAgentConfig, getAgentConfigByName } from "$server/db/queries/agent-configs";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { upsertSetting } from "$server/db/queries/settings";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Boundary validation. The handler reads exactly one optional field —
// `version` — off the body; an empty body is valid (handler falls
// through to getLatestVersion). Schema requires non-empty when
// present so a `{version: ""}` payload doesn't sneak past as
// "requested but blank".
const installPostSchema = z.object({
  version: z.string().min(1).optional(),
}).passthrough();

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const listing = await getListingById(params.id);
  if (!listing) {
    return errorJson(404, "Not found");
  }

  const parsed = installPostSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "Invalid request body");
  }
  const requestedVersion = parsed.data.version;

  const versionRecord = requestedVersion
    ? await getVersion(listing.id, requestedVersion)
    : await getLatestVersion(listing.id);

  if (!versionRecord) {
    return errorJson(404, "Version not found");
  }

  const manifest = versionRecord.manifest as ExtensionManifestV2;
  if (!manifest.agent) {
    return errorJson(400, "Listing has no agent definition");
  }

  // Handle name collision: append suffix if name already exists for this user
  let name = manifest.name;
  const existing = await getAgentConfigByName(name);
  if (existing) {
    name = `${name} (Marketplace)`;
  }

  const agentConfig = await createAgentConfig({
    name,
    description: manifest.description,
    prompt: manifest.agent.prompt,
    capabilities: manifest.agent.capabilities as any,
    category: manifest.agent.category,
    temperature: manifest.agent.temperature,
    maxTokens: manifest.agent.maxTokens,
    outputFormat: manifest.agent.outputFormat,
    inputSchema: manifest.agent.inputSchema as any,
    userId: user.id,
  });

  // Track installation provenance
  await upsertSetting(`marketplace:installed:${agentConfig.id}`, {
    listingId: listing.id,
    version: versionRecord.version,
    installedAt: new Date().toISOString(),
  });

  await incrementInstallCount(listing.id);
  await insertAuditEntry(user.id, "marketplace:install", listing.id, {
    version: versionRecord.version,
    agentConfigId: agentConfig.id,
  });

  return json({ agentConfig, extensionsNeeded: [] }, { status: 201 });
};
