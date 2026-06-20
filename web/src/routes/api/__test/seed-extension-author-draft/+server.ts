/**
 * TEST-ONLY endpoint — gated by `PI_E2E_REAL=1`. Returns 404 (the same
 * shape SvelteKit would emit for an unrouted path) unless the flag is
 * set. In production the route file ships but the handler is inert,
 * so an attacker cannot reach the seed surface even if they discover
 * the URL.
 *
 * Why this exists: the real-auth Playwright harness needs to put an
 * `ez_drafts` row + scaffolded files on disk for a known user before a
 * spec drives the `/extensions/author` preview page. The harness CAN'T
 * open PGlite directly (the running webServer holds the single-writer
 * lock), and there is no public HTTP surface for creating
 * extension-author drafts (the bundled extension reaches the host via
 * reverse-RPC, which only the in-process executor can speak).
 *
 * Side effects:
 *   - INSERT into `ez_drafts` (kind=extension, payload.mode=author)
 *   - mkdir + write scaffolded file map under
 *     `<projectRoot>/.ezcorp/extension-data/extension-author/drafts/
 *      <userId>/<draftId>/`
 *
 * Owner scoping: the calling user (from `requireAuth`) becomes the
 * draft's owner. Cross-user seeding is impossible from this surface.
 */

import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import {
  createDraft,
  getExtensionAuthorDraftDir,
} from "$server/db/queries/ez-drafts";
import { scaffoldExtension, type ExtType } from "@ezcorp/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isTestSurfaceEnabled } from "$lib/server/test-surface";
import type { RequestHandler } from "./$types";

const VALID_TYPES: ReadonlySet<string> = new Set(["tool", "skill", "agent", "multi"]);

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");

  try {
    const user = requireAuth(locals);

    let body: { name?: unknown; type?: unknown; description?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorJson(400, "Invalid JSON body");
    }
    if (typeof body.name !== "string") return errorJson(400, "`name` must be a string");
    if (typeof body.type !== "string" || !VALID_TYPES.has(body.type)) {
      return errorJson(400, "`type` must be one of tool|skill|agent|multi");
    }
    const description = typeof body.description === "string"
      ? body.description
      : "E2E seeded extension";

    // 1) Scaffold pure → file map. Fails fast on bad name BEFORE we
    //    mint a draft row, mirroring the bundled extension's order.
    let scaffold;
    try {
      scaffold = scaffoldExtension({
        name: body.name,
        type: body.type as ExtType,
        description,
      });
    } catch (err) {
      return errorJson(400, `Scaffold failed: ${(err as Error).message}`);
    }

    // 2) Insert the draft row.
    const draft = await createDraft({
      userId: user.id,
      kind: "extension",
      payload: {
        name: body.name,
        type: body.type,
        mode: "author",
        // draftDir is informational; the resolver re-derives the real
        // path from (userId, draftId) so callers cannot inject paths.
        draftDir: "",
      },
    });

    // 3) Write files to the resolver's path.
    const dir = getExtensionAuthorDraftDir(draft.id, user.id);
    await mkdir(dir, { recursive: true });
    for (const [relpath, content] of Object.entries(scaffold.files)) {
      const target = join(dir, relpath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }

    return json(
      {
        draftId: draft.id,
        draftDir: dir,
        userId: user.id,
        files: Object.keys(scaffold.files),
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof Response) return e;
    return errorJson(500, e instanceof Error ? e.message : "Seed failed");
  }
};
