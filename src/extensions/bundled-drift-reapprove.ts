/** Exact grant review for immutable releases, shared by approval and publication. */
import { canonicalJson, type ExtensionManifestV4 } from "@ezcorp/extension-contract";

export function requestedReleaseGrants(manifest: ExtensionManifestV4): string[] {
  const permissions = { ...manifest.permissions, ...(manifest.acceptsCallerCaps === undefined ? {} : { acceptsCallerCaps: manifest.acceptsCallerCaps }), ...(manifest.escalateChildCaps === undefined ? {} : { escalateChildCaps: manifest.escalateChildCaps }) };
  return Object.entries(permissions).map(([name, value]) => canonicalJson([name, value])).sort();
}

export function hasExactReleaseGrants(manifest: ExtensionManifestV4, grants: readonly string[]): boolean {
  return canonicalJson([...new Set(grants)].sort()) === canonicalJson(requestedReleaseGrants(manifest));
}
