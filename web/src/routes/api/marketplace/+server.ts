import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { browseMarketplace, createListing, getFeaturedListings, getListingsByAuthor } from "$server/db/queries/marketplace";
import { createVersion, getLatestVersion } from "$server/db/queries/marketplace-versions";
import { getAgentConfig } from "$server/db/queries/agent-configs";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { validateManifestV2, compareVersions, generateSlug } from "$server/extensions/manifest";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import { publishListingSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  // Browse is public — no auth required
  const q = url.searchParams.get("q") ?? undefined;
  const category = url.searchParams.get("category") ?? undefined;
  const tag = url.searchParams.get("tag") ?? undefined;
  const sort = (url.searchParams.get("sort") ?? "popular") as "rating" | "popular" | "newest";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const listings = await browseMarketplace({ query: q, category, tag, sort, limit, offset });

  const withRating = listings.map((l) => ({
    ...l,
    ratingPercent: l.ratingTotal > 0 ? Math.round((l.ratingPositive / l.ratingTotal) * 100) : 0,
  }));

  const result: Record<string, unknown> = { listings: withRating };

  if (offset === 0) {
    result.featured = await getFeaturedListings(6);
  }

  return json(result);
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const result = publishListingSchema.safeParse(await request.json());
  if (!result.success) {
    return validationError(result.error);
  }
  const { agentConfigId, version: requestedVersion, changelog, tags } = result.data;

  const config = await getAgentConfig(agentConfigId);
  if (!config) {
    return errorJson(404, "Agent config not found");
  }
  if (config.userId !== user.id) {
    return errorJson(404, "Not found");
  }

  const version = requestedVersion ?? "1.0.0";
  const agent: ExtensionManifestV2["agent"] = {
    prompt: config.prompt,
    category: config.category ?? "Other",
    capabilities: config.capabilities as string[],
  };
  if (config.temperature != null) agent.temperature = config.temperature;
  if (config.maxTokens != null) agent.maxTokens = config.maxTokens;
  if (config.outputFormat != null) agent.outputFormat = config.outputFormat as "text" | "json";
  if (config.inputSchema != null) agent.inputSchema = config.inputSchema as Record<string, unknown>;

  // manifest.name must be filesystem-safe (used as a directory name under
  // data/extensions/<name> when installed); slugify the display name so
  // "Code Reviewer" becomes "code-reviewer". Display name stays on the
  // listing row.
  const manifest: ExtensionManifestV2 = {
    schemaVersion: 2,
    name: generateSlug(config.name),
    version,
    description: config.description,
    author: { name: user.name, id: user.id },
    agent,
    permissions: {},
    tags: tags ?? [],
  };

  const validation = validateManifestV2(manifest);
  if (!validation.valid) {
    return errorJson(400, "Invalid manifest", { errors: validation.errors });
  }

  // Check if listing already exists for this agentConfigId
  const existingListings = await getListingsByAuthor(user.id);
  const existingListing = existingListings.find((l) => l.agentConfigId === agentConfigId);

  if (existingListing) {
    // Republish: validate version is higher
    const latestVer = await getLatestVersion(existingListing.id);
    if (latestVer && compareVersions(version, latestVer.version) <= 0) {
      return errorJson(
        400,
        `Version ${version} must be higher than current ${latestVer.version}`,
      );
    }

    const newVersion = await createVersion(existingListing.id, version, manifest, changelog);
    await insertAuditEntry(user.id, "marketplace:publish", existingListing.id, { version });

    return json({ listing: existingListing, version: newVersion }, { status: 201 });
  }

  // New listing
  const listing = await createListing({
    authorId: user.id,
    agentConfigId,
    name: config.name,
    description: config.description,
    category: config.category ?? "Other",
    tags: tags ?? [],
    latestVersion: version,
  });

  const newVersion = await createVersion(listing.id, version, manifest, changelog);
  await insertAuditEntry(user.id, "marketplace:publish", listing.id, { version });

  return json({ listing, version: newVersion }, { status: 201 });
};
