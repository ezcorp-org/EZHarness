/**
 * TEST-ONLY endpoint — gated by `PI_E2E_REAL=1`. Returns 404 unless
 * the flag is set; the route file ships in production but is inert.
 *
 * Removes:
 *   - the `extensions` row whose `name === body.name`
 *   - the on-disk install dir
 *     `<projectRoot>/.ezcorp/extensions/<name>/`
 *
 * Both cleanups are best-effort + idempotent: a missing row OR a
 * missing dir is `{ ok: true }`. Re-runs of a Playwright spec must
 * never trip on "already-cleaned" state.
 *
 * Owner scoping: cleanup is admin-only — a spec running as the
 * first-boot admin can drop any test-installed extension. Non-admin
 * cookie auth gets a 403 (matches `requireRole("admin")`'s contract).
 */

import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireRole } from "$server/auth/middleware";
import { deleteExtension, getExtensionByName } from "$server/db/queries/extensions";
import { getProjectRoot } from "$server/extensions/bundled";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");

  try {
    requireRole(locals, "admin");

    let body: { name?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorJson(400, "Invalid JSON body");
    }
    if (typeof body.name !== "string" || body.name.length === 0) {
      return errorJson(400, "`name` must be a non-empty string");
    }
    // Defensive shape check — same regex used everywhere extension
    // names are validated.
    if (!/^[a-z0-9][a-z0-9-_.]{0,63}$/.test(body.name) || body.name.includes("..")) {
      return errorJson(400, "Invalid extension name");
    }

    let rowDeleted = false;
    const row = await getExtensionByName(body.name);
    if (row) {
      rowDeleted = await deleteExtension(row.id);
    }

    // Best-effort fs cleanup. Re-derive the path from the canonical
    // project-root resolver shared with `ensureBundledExtensions` —
    // never trust the row's `install_path` (could be NULL or diverged
    // after a manual move).
    const root = getProjectRoot();
    const installedPath = join(root, ".ezcorp/extensions", body.name);
    let dirRemoved = false;
    if (existsSync(installedPath)) {
      await rm(installedPath, { recursive: true, force: true });
      dirRemoved = true;
    }

    return json({ ok: true, rowDeleted, dirRemoved });
  } catch (e) {
    if (e instanceof Response) return e;
    return errorJson(500, e instanceof Error ? e.message : "Cleanup failed");
  }
};
