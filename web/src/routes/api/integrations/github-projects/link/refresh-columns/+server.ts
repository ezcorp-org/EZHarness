/**
 * POST /api/integrations/github-projects/link/refresh-columns
 *
 * Body: `{ projectId, linkId }`.
 *
 * Re-fetch ONE connected board's Status columns (id + name) host-side and
 * persist them onto the link — WITHOUT the user re-pasting their PAT. This
 * self-heals a link whose `status_options` are empty (e.g. a link that predates
 * column persistence: the migration backfilled `[]`, which it can't recover
 * real names for) AND picks up columns a board owner has added / renamed /
 * removed since connect. The column editor then renders named, complete columns
 * instead of falling back to raw option-id labels with the unmapped columns
 * dropped.
 *
 * The credential is resolved host-side (the board's per-board PAT override, else
 * the shared project PAT, else the `gh` CLI identity) — it is NEVER accepted
 * from or echoed to the client. Authed: `extensions` scope + session/key user.
 * RBAC: `configure` — checked after the opaque project/link resolution and
 * before the host-side credential is touched.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import {
  authGithubRoute,
  resolveProject,
  resolveLinkForProject,
  requireGithubScope,
  publicLinkView,
} from "../../_shared";
import { createGithubClient } from "$server/integrations/github-projects/client";
import {
  resolveLinkAuth,
  boardTokenName,
} from "$server/integrations/github-projects/auth";
import { updateLink } from "$server/db/queries/github-projects";
import { hasSecret } from "$server/extensions/secrets-store";
import { extensionLogger } from "$server/logger";

const log = extensionLogger("github-projects", "api.refresh-columns");

export const POST: RequestHandler = async ({ locals, request }) => {
  const auth = authGithubRoute(locals);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return errorJson(400, "Invalid body");

  const projectRes = await resolveProject(
    typeof body.projectId === "string" ? body.projectId : null,
  );
  if ("error" in projectRes) return projectRes.error;

  // A project may link MANY boards — refresh the ONE addressed by linkId.
  const linkRes = await resolveLinkForProject(
    projectRes.projectId,
    typeof body.linkId === "string" ? body.linkId : null,
  );
  if ("error" in linkRes) return linkRes.error;
  const { link } = linkRes;

  // RBAC (after the opaque project/link 404s, before the host credential is
  // resolved): refreshing a board's columns is a `configure` action.
  const denied = await requireGithubScope(locals, projectRes.projectId, "configure");
  if (denied) return denied;

  // Resolve the host-only credential (per-board override / shared PAT / `gh`).
  // A missing/empty credential is a 401 — the board can't be re-read.
  let credential;
  try {
    credential = await resolveLinkAuth(link);
  } catch (err) {
    log.info("refresh-columns: credential resolve failed", {
      projectId: link.projectId,
      authMode: link.authMode,
      error: err instanceof Error ? err.message : "err",
    });
    return errorJson(401, "Could not resolve GitHub credentials for this board");
  }

  // Re-resolve the board to get its CURRENT Status field + options. A GitHub
  // failure (auth/rate-limit/not-found/transport) maps to 502 — the link is
  // left untouched so a transient failure never wipes the saved columns.
  let board;
  try {
    board = await createGithubClient().resolveBoardFromUrl(link.boardUrl, credential);
  } catch (err) {
    log.info("refresh-columns: board re-resolve failed", {
      projectId: link.projectId,
      error: err instanceof Error ? err.message : "err",
    });
    return errorJson(502, "Could not fetch the board's columns from GitHub");
  }

  const updated = await updateLink(link.id, {
    statusOptions: board.statusOptions,
    statusFieldId: board.statusFieldId,
  });
  if (!updated) return errorJson(404, "No GitHub board linked to this project");

  // Mirror the GET/PATCH views: expose the boolean presence of a per-board token
  // override (never the token itself), so the card renders shared-vs-override.
  const hasOverride = await hasSecret(
    "github-projects",
    updated.projectId,
    boardTokenName(updated.id),
  );
  return json({ link: publicLinkView(updated, hasOverride) });
};
