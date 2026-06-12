/**
 * Extension Pages Hub — extension page discovery + lookup.
 *
 * Enabled extensions declaring `manifest.pages` (validated at install
 * time by `validatePagesArray` in src/extensions/manifest.ts) surface
 * as `ext:<name>:<pageId>` Hub tabs. Declaring a page IS the grant —
 * no separate permission key, so there is no grantedPermissions drift
 * for bundled extensions.
 *
 * Manifest access is defensive (`readManifestPages`) so rows installed
 * before the `pages` field existed — or hand-edited blobs — can never
 * throw out of the Hub list route.
 */
import { listExtensions, getExtensionByName } from "$server/db/queries/extensions";
import type { Extension } from "$server/db/schema";
import type { HubPageListing } from "$lib/hub";

export interface ManifestPageDeclaration {
  id: string;
  title: string;
  icon?: string;
  description?: string;
}

const PAGE_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Defensive reader for `manifest.pages` on a DB extension row. */
export function readManifestPages(manifest: unknown): ManifestPageDeclaration[] {
  if (!manifest || typeof manifest !== "object") return [];
  const pages = (manifest as Record<string, unknown>).pages;
  if (!Array.isArray(pages)) return [];
  const out: ManifestPageDeclaration[] = [];
  for (const raw of pages) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.id !== "string" || !PAGE_ID_REGEX.test(p.id)) continue;
    if (typeof p.title !== "string" || p.title.length === 0) continue;
    out.push({
      id: p.id,
      title: p.title.slice(0, 50),
      ...(typeof p.icon === "string" ? { icon: p.icon } : {}),
      ...(typeof p.description === "string" ? { description: p.description.slice(0, 200) } : {}),
    });
  }
  return out;
}

/** Hub list entries for every enabled extension page. */
export async function listEnabledExtensionPages(): Promise<HubPageListing[]> {
  const extensions = await listExtensions();
  const listings: HubPageListing[] = [];
  for (const ext of extensions) {
    if (!ext.enabled) continue;
    for (const page of readManifestPages(ext.manifest)) {
      listings.push({
        id: `ext:${ext.name}:${page.id}`,
        title: page.title,
        ...(page.icon ? { icon: page.icon } : {}),
        ...(page.description ? { description: page.description } : {}),
        kind: "ext",
      });
    }
  }
  return listings;
}

/**
 * Resolve one declared page on an ENABLED extension. Returns null when
 * the extension is unknown, disabled, or doesn't declare the page —
 * callers 404 without distinguishing the cases (no enumeration oracle).
 */
export async function findEnabledExtensionPage(
  extensionName: string,
  pageId: string,
): Promise<{ extension: Extension; page: ManifestPageDeclaration } | null> {
  const ext = await getExtensionByName(extensionName);
  if (!ext?.enabled) return null;
  const page = readManifestPages(ext.manifest).find((p) => p.id === pageId);
  if (!page) return null;
  return { extension: ext, page };
}
