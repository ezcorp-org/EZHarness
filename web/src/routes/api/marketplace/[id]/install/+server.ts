import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { getListingById, incrementInstallCount } from "$server/db/queries/marketplace";
import { getLatestVersion, getVersion } from "$server/db/queries/marketplace-versions";
import { createAgentConfig, getAgentConfigByName } from "$server/db/queries/agent-configs";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { upsertSetting } from "$server/db/queries/settings";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const listing = await getListingById(params.id);
  if (!listing) {
    return json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const requestedVersion = (body as { version?: string }).version;

  const versionRecord = requestedVersion
    ? await getVersion(listing.id, requestedVersion)
    : await getLatestVersion(listing.id);

  if (!versionRecord) {
    return json({ error: "Version not found" }, { status: 404 });
  }

  const manifest = versionRecord.manifest as ExtensionManifestV2;
  if (!manifest.agent) {
    return json({ error: "Listing has no agent definition" }, { status: 400 });
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
