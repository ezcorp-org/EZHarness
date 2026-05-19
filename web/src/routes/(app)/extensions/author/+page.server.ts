/**
 * Editable preview page for the bundled `extension-author` extension.
 *
 * Hydrates form state from `?prefill=<draftId>`. Reads the draft row
 * via `getDraft(id, userId)` (owner-scoped) and reads the on-disk
 * file map fresh — the file system is the source of truth, the DB
 * payload is just a pointer.
 *
 * 404 path covers: missing id, expired draft, wrong owner. Same gates
 * as `/api/ez/drafts/[id]`.
 */

import { error } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { getDraft, getExtensionAuthorDraftDir } from "$server/db/queries/ez-drafts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PageServerLoad } from "./$types";

const ALLOWED_FILES = new Set([
  "ezcorp.config.ts",
  "index.ts",
  "index.test.ts",
  "README.md",
  "package.json",
  "tsconfig.json",
  ".gitignore",
]);

/**
 * Read the draft's file map fresh from disk. Filesystem is the source
 * of truth; the DB payload only holds the (advisory) draftDir pointer.
 * Exported for the +page.server.ts load() test.
 *
 * Underscore prefix is required by SvelteKit's `+page.server.ts`
 * export convention — non-prefixed top-level exports must be one of
 * the framework's reserved names (load, actions, etc.).
 */
export function _readDraftFiles(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (!ALLOWED_FILES.has(name)) continue;
    try {
      files[name] = readFileSync(join(dir, name), "utf8");
    } catch {
      // skip unreadable
    }
  }
  return files;
}

export const load: PageServerLoad = async ({ url, locals }) => {
  const user = requireAuth(locals);
  const draftId = url.searchParams.get("prefill");
  if (!draftId) throw error(400, "Missing ?prefill=<draftId>");
  // Strict id-shape gate, separate from the 404 path so a leaked id
  // with a bad shape returns 400, not 404 (the 404 codepath would
  // otherwise be confused with "expired").
  if (!/^[a-zA-Z0-9_-]+$/.test(draftId)) throw error(400, "Invalid draftId");

  const row = await getDraft(draftId, user.id);
  if (!row) throw error(404, "Draft not found, expired, or not owned by the requesting user");
  if (row.kind !== "extension") throw error(400, "Draft is not an extension draft");

  // Resolve the dir via the shared helper. userId scoping is in the
  // path — even with a leaked id, a non-owner gets the 404 above.
  const dir = getExtensionAuthorDraftDir(draftId, user.id);
  const files = _readDraftFiles(dir);

  return {
    draft: {
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    },
    files,
  };
};
