import { json } from "@sveltejs/kit";
import { sealPublishedRelease } from "@ezcorp/extension-contract";
import { requireSessionAuth } from "$server/auth/middleware";
import { createListing } from "$server/db/queries/marketplace";
import { createVersion } from "$server/db/queries/marketplace-versions";
import { getExtensionLifecycle, getExtensionRunner } from "$server/extensions/extension-lifecycle-service";
import { LifecycleError, type InstallationState } from "$server/extensions/v4/types";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import { resolveControlActor } from "$lib/server/extensions/control-actor";
import { extensionControlError } from "$lib/server/extensions/control-errors";
import { readBoundedJson } from "$lib/server/security/bounded-json";
import type { RequestHandler } from "./$types";

function verifiedRelease(state: InstallationState, ownerId: string, releaseId: string) {
  const release = state.releases[releaseId];
  const operation = Object.values(state.operations).find((candidate) => candidate.releaseId === releaseId && candidate.state === "verified");
  if (state.installation.ownerId !== ownerId || state.installation.uninstalled || !release || !operation) throw new LifecycleError("not_found", "Verified owned release not found.");
  return { release, operation };
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return json({ message: "Not found" }, { status: 404 });
  try {
    const user = requireSessionAuth(locals);
    if (user instanceof Response) return user;
    const body = await readBoundedJson(request, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "installationId" && key !== "releaseId")) throw new LifecycleError("invalid_input", "Provide only installationId and releaseId.");
    const { installationId, releaseId } = body as Record<string, unknown>;
    if (typeof installationId !== "string" || typeof releaseId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(installationId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(releaseId)) throw new LifecycleError("invalid_input", "Provide valid release coordinates.");
    const actor = await resolveControlActor(user, "human", installationId);
    const lifecycle = await getExtensionLifecycle();
    const { release, operation } = verifiedRelease(await lifecycle.inspect(actor, installationId), user.id, releaseId);
    const artifacts = await (await getExtensionRunner()).collectArtifacts(release.artifactDigest);
    const published = await sealPublishedRelease({ operationId: operation.id, state: "succeeded", sourceDigest: release.sourceDigest, artifactDigest: release.artifactDigest, imageDigest: release.imageDigest, manifest: release.manifest, evidence: release.evidence, diagnostics: [] }, artifacts);
    verifiedRelease(await lifecycle.inspect(actor, installationId), user.id, releaseId);
    const listing = await createListing({ authorId: user.id, name: release.manifest.name, description: release.manifest.description, category: "tools", tags: [], latestVersion: release.manifest.version });
    const version = await createVersion(listing.id, release.manifest.version, release.manifest, undefined, published);
    return json({ versionId: version.id }, { status: 201 });
  } catch (cause) { return extensionControlError(cause); }
};
