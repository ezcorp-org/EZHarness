/**
 * POST /api/integrations/github-projects/connect
 *
 * Body: `{ projectId, boardUrl, authMode: 'pat'|'gh', token? }`.
 *
 * Resolve the pasted board URL → board ref, then VALIDATE the auth against
 * that board (the single egress call; it MUST succeed before anything is
 * persisted). On a scope failure we return the named missing scopes and store
 * NOTHING. On success: for `authMode==='pat'` the token is `encrypt()`-ed and
 * written to `githubTokenSettingKey(projectId)`; for `gh` no token is stored
 * (the daemon resolves `gh auth token` host-side). Then upsert the link.
 *
 * The plaintext token is NEVER echoed back; the response carries only the
 * resolved board metadata + granted scopes.
 *
 * Authed: `extensions` scope + session/key user.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { authGithubRoute, resolveProject } from "../_shared";
import { createGithubClient } from "$server/integrations/github-projects/client";
import type {
  GithubAuth,
  GithubAuthMode,
} from "$server/integrations/github-projects/types";
import { githubTokenSettingKey } from "$server/integrations/github-projects/types";
import { encrypt } from "$server/providers/encryption";
import { upsertSetting } from "$server/db/queries/settings";
import { upsertLink } from "$server/db/queries/github-projects";
import { logger } from "$server/logger";

const log = logger.child("api.github-projects.connect");

interface ConnectBody {
  projectId?: unknown;
  boardUrl?: unknown;
  authMode?: unknown;
  token?: unknown;
}

function isAuthMode(v: unknown): v is GithubAuthMode {
  return v === "pat" || v === "gh";
}

export const POST: RequestHandler = async ({ locals, request }) => {
  const auth = authGithubRoute(locals);
  if ("error" in auth) return auth.error;
  const { user } = auth;

  const body = (await request.json().catch(() => null)) as ConnectBody | null;
  if (!body || typeof body !== "object") return errorJson(400, "Invalid body");

  const boardUrl = typeof body.boardUrl === "string" ? body.boardUrl.trim() : "";
  if (!boardUrl) return errorJson(400, "boardUrl is required");

  if (!isAuthMode(body.authMode)) {
    return errorJson(400, "authMode must be 'pat' or 'gh'");
  }
  const authMode: GithubAuthMode = body.authMode;

  // A PAT auth MUST carry a token; gh auth resolves host-side at poll time.
  let token = "";
  if (authMode === "pat") {
    token = typeof body.token === "string" ? body.token : "";
    if (!token) return errorJson(400, "token is required for authMode 'pat'");
  }

  const projectRes = await resolveProject(
    typeof body.projectId === "string" ? body.projectId : null,
  );
  if ("error" in projectRes) return projectRes.error;
  const { projectId } = projectRes;

  const client = createGithubClient();
  const credential: GithubAuth = { mode: authMode, token };

  // 1. Resolve the board from the URL (a 404/invalid board never persists).
  let board;
  try {
    board = await client.resolveBoardFromUrl(boardUrl, credential);
  } catch (err) {
    log.info("board resolve failed", { error: err instanceof Error ? err.message : "err" });
    return errorJson(404, "Could not resolve that GitHub Projects board URL");
  }

  // 2. Validate the auth against the resolved board. This is the ONLY egress
  //    that must succeed before we persist; on missing scopes we store nothing
  //    and name what's missing so the UI can guide the fix.
  let validation;
  try {
    validation = await client.validateAuth(credential, board.boardNodeId);
  } catch (err) {
    log.info("auth validation threw", { error: err instanceof Error ? err.message : "err" });
    return errorJson(401, "Could not validate GitHub credentials");
  }
  if (!validation.ok) {
    return errorJson(403, "GitHub token is missing required scopes", {
      missingScopes: validation.missingScopes,
      scopes: validation.scopes,
    });
  }

  // 3. Persist. Encrypt + store the PAT FIRST (so a link never points at a
  //    board with no usable credential), then upsert the link.
  if (authMode === "pat") {
    try {
      await upsertSetting(githubTokenSettingKey(projectId), encrypt(token));
    } catch (err) {
      log.warn("token persist failed", { error: err instanceof Error ? err.message : "err" });
      return errorJson(500, "Failed to store credentials");
    }
  } else {
    // Re-connecting from PAT → gh must not leave a stale encrypted PAT behind.
    // deleteSetting is idempotent; a missing key is a no-op.
    const { deleteSetting } = await import("$server/db/queries/settings");
    await deleteSetting(githubTokenSettingKey(projectId)).catch(() => {});
  }

  const link = await upsertLink({
    projectId,
    boardNodeId: board.boardNodeId,
    boardUrl,
    boardTitle: board.title,
    ownerLogin: board.ownerLogin,
    statusFieldId: board.statusFieldId,
    authMode,
    createdByUserId: user.id,
  });

  // Response: board metadata + scopes ONLY. Never the token.
  return json({
    linkId: link.id,
    boardTitle: board.title,
    ownerLogin: board.ownerLogin,
    statusOptions: board.statusOptions,
    scopes: validation.scopes,
  });
};
