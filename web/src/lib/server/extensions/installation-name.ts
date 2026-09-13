import { getExtension } from "$server/db/queries/extensions";
import type { InstallationState } from "$server/extensions/v4/types";

/**
 * Display name for a version-4 installation.
 *
 * Releases carry the manifest name: the active release wins, then the newest
 * release. A bundled source that has never built has no release yet but shares
 * its id with the legacy `extensions` row, so that row's name is the last
 * resort. A fresh user workspace has neither and resolves to `null`.
 */
export async function resolveInstallationName(state: InstallationState | null): Promise<string | null> {
  if (!state) return null;
  const active = state.releases[state.installation.activeReleaseId ?? ""];
  if (active) return active.manifest.name;
  const newest = Object.values(state.releases).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (newest) return newest.manifest.name;
  return (await getExtension(state.installation.id))?.name ?? null;
}
