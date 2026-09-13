import { getExtension, getExtensionsByIds } from "$server/db/queries/extensions";
import { getReleaseNamesByInstallationIds } from "$server/db/queries/extension-releases";
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

/**
 * Display names for a LIST of installations, as a `Map<installationId, name>`.
 * An installation with no known name is absent from the map, so a caller can
 * fall back to the id it already has.
 *
 * Two batch queries at most, never a per-installation `inspect`: the author
 * page lists every workspace an actor owns, and reading each one's full state
 * to reach `releases` would cost a round-trip per row. The reserved
 * active-release name answers the same question in bulk, then the legacy
 * `extensions` rows name whatever is left (a bundled source shares its id with
 * one). An empty list queries nothing.
 *
 * This is a deliberately narrower resolver than {@link resolveInstallationName}
 * above, which has the whole state in hand: an installation whose newest
 * release was built but never activated is named there and unnamed here,
 * because nothing reserved its name yet. The list falls back to the id for
 * exactly those rows, and opening one resolves the fuller name.
 */
export async function resolveInstallationNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const names = await getReleaseNamesByInstallationIds(ids);
  const unnamed = ids.filter((id) => !names.has(id));
  if (unnamed.length === 0) return names;
  for (const [id, extension] of await getExtensionsByIds(unnamed)) names.set(id, extension.name);
  return names;
}
