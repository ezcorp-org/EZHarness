/**
 * POST /api/integrations/github-projects/link/refresh-columns
 *
 * Body: `{ projectId, linkId }`.
 *
 * Re-fetch the addressed board's Status columns (id + name) host-side and
 * persist them onto the link — WITHOUT the user re-pasting their PAT. This
 * self-heals a link whose `status_options` are empty (e.g. a link that predates
 * column persistence: the migration backfilled `[]`, which it can't recover
 * real names for) AND picks up columns a board owner has added / renamed /
 * removed since connect. The column editor then renders named, complete columns
 * instead of falling back to raw option-id labels with the unmapped columns
 * dropped.
 *
 * The credential is resolved host-side (the encrypted PAT from the secrets
 * store, or the `gh` CLI identity) — it is NEVER accepted from or echoed to the
 * client. Authed: `extensions` scope + session/key user.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import {
  authGithubRoute,
  resolveProject,
  resolveLinkForProject,
  publicLinkView,
} from "../../_shared";
import { createGithubClient } from "$server/integrations/github-projects/client";
import { resolveLinkAuth } from "$server/integrations/github-projects/auth";
import { updateLink } from "$server/db/queries/github-projects";
import { logger } from "$server/logger";

const log = logger.child("api.github-projects.refresh-columns");

export const POST: RequestHandler = async ({ locals, request }) => {
  const auth = authGithubRoute(locals);
  if ("error" in auth) return auth.error;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return errorJson(400, "Invalid body");

  const projectRes = await resolveProject(
    typeof body.projectId === "string" ? body.projectId : null,
  );
  if ("error" in projectRes) return projectRes.error;

  const linkRes = await resolveLinkForProject(
    projectRes.projectId,
    typeof body.linkId === "string" ? body.linkId : null,
  );
  if ("error" in linkRes) return linkRes.error;
  const { link } = linkRes;

  // Resolve the host-only credential (encrypted PAT or `gh` identity). A
  // missing/empty credential is a 401 — the board can't be re-read.
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

  return json({ link: publicLinkView(updated) });
};
