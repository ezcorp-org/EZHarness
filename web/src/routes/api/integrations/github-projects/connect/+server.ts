/**
 * POST /api/integrations/github-projects/connect
 *
 * Body: `{ projectId, boardUrl, authMode: 'pat'|'gh', token?, tokenScope? }`.
 *
 * Connects ANOTHER board to a project (multi-board): re-connecting the same
 * board updates it, a new board adds a card. Resolve the pasted board URL →
 * board ref, then VALIDATE the auth against that board (the single egress call;
 * it MUST succeed before anything is persisted). On a scope failure we return
 * the named missing scopes and store NOTHING.
 *
 * Credentials (pat mode): a board uses the SHARED project token by default;
 * `tokenScope: 'board'` stores a per-board OVERRIDE instead. The effective
 * VALIDATION token is the provided `token` if any, else the existing shared
 * project token (so a 2nd board can connect WITHOUT re-pasting the PAT). It is
 * a 400 when pat and neither is available. On success:
 *   - scope 'board' → `setSecret(apiToken:<linkId>, token)` (token required),
 *   - scope 'shared' → `setSecret(apiToken, token)` only when a token was given.
 * For `gh` no token is stored (the daemon resolves `gh auth token` host-side).
 *
 * The plaintext token is NEVER echoed back; the response carries only the
 * resolved board metadata + granted scopes + the new linkId.
 *
 * Authed: `extensions` scope + session/key user. RBAC: `configure` (always),
 * plus `secrets` when the body carries a token to be written — checked after
 * project resolution (opaque 404 first) and before any secret read or egress.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { authGithubRoute, resolveProject, requireGithubScope, parseDefaultModelInput, parsePermissionModeInput, parseTokenScope } from "../_shared";
import { createGithubClient } from "$server/integrations/github-projects/client";
import type {
  GithubAuth,
  GithubAuthMode,
} from "$server/integrations/github-projects/types";
import { setSecret, getSecret, deleteSecret } from "$server/extensions/secrets-store";
import { upsertLink, listLinksByProjectId, deleteLink } from "$server/db/queries/github-projects";
import { boardTokenName } from "$server/integrations/github-projects/auth";
import { extensionLogger } from "$server/logger";

const log = extensionLogger("github-projects", "api.connect");

interface ConnectBody {
  projectId?: unknown;
  boardUrl?: unknown;
  authMode?: unknown;
  token?: unknown;
  tokenScope?: unknown;
  defaultModel?: unknown;
  defaultPermissionMode?: unknown;
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

  // Validate the optional default model + permission mode + token scope fast
  // (before any egress).
  const dmParsed = parseDefaultModelInput(body.defaultModel);
  if ("error" in dmParsed) return errorJson(400, dmParsed.error);
  const pmParsed = parsePermissionModeInput(body.defaultPermissionMode);
  if ("error" in pmParsed) return errorJson(400, pmParsed.error);
  const scopeParsed = parseTokenScope(body.tokenScope);
  if ("error" in scopeParsed) return errorJson(400, scopeParsed.error);
  const tokenScope = scopeParsed.scope;

  // The token the user typed this request (may be empty when connecting a 2nd
  // board against the existing SHARED project token).
  const providedToken = typeof body.token === "string" ? body.token : "";

  const projectRes = await resolveProject(
    typeof body.projectId === "string" ? body.projectId : null,
  );
  if ("error" in projectRes) return projectRes.error;
  const { projectId } = projectRes;

  // RBAC (after the opaque project 404, before any secret read or egress):
  // connecting/re-connecting a board is a `configure` action; WRITING a token
  // (the body carries one) additionally requires `secrets`.
  const configureDenied = await requireGithubScope(locals, projectId, "configure");
  if (configureDenied) return configureDenied;
  if (providedToken !== "") {
    const secretsDenied = await requireGithubScope(locals, projectId, "secrets");
    if (secretsDenied) return secretsDenied;
  }

  // The effective VALIDATION token for pat mode: the provided token, else the
  // existing shared project token (so a 2nd board connects without re-pasting).
  // A per-board override REQUIRES an explicit token (it can't reuse the shared
  // one — that's just the shared default). 400 when pat and neither resolves.
  let token = providedToken;
  if (authMode === "pat") {
    if (!token && tokenScope === "shared") {
      token = (await getSecret("github-projects", projectId, "apiToken")) ?? "";
    }
    if (!token) {
      return tokenScope === "board"
        ? errorJson(400, "token is required for a per-board override")
        : errorJson(400, "token is required for authMode 'pat'");
    }
  }

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

  // 3. Persist. Upsert the link FIRST so a per-board override can key off its id
  //    (the link still has a usable credential — either the shared token already
  //    stored, or the override we write immediately below). The secrets store
  //    encrypts (AAD-bound) + audits SECRET_SET.
  //
  // PATs are PROJECT-scoped, not user-scoped (no `userId` in the secret's
  // scope): the poller daemon resolves them with no user context, and any user
  // in the project shares the board credential. We still pass `actorUserId` so
  // the SECRET_SET / SECRET_DELETED audit row is attributed to the connecting
  // user (the row stays project-scoped — `actorUserId` is audit-only).
  //
  // Whether this board was ALREADY connected (the upsert will UPDATE, not
  // INSERT) decides two policies below: (a) a RE-CONNECT must carry the
  // existing board's config through the upsert — upsertLink's
  // onConflictDoUpdate resets omitted fields, so a "Replace token" that
  // omitted them would wipe the column mapping, poll interval and paused
  // state; (b) the partial-failure policy for a per-board override — a FRESH
  // board whose override fails to persist must be rolled back (else it would
  // silently fall back to the shared token, defeating the isolation the user
  // asked for), while a PRE-EXISTING board is never destroyed by a failed
  // re-connect.
  const existing = (await listLinksByProjectId(projectId)).find(
    (l) => l.boardNodeId === board.boardNodeId,
  );
  const wasPreExisting = existing !== undefined;

  const link = await upsertLink({
    projectId,
    boardNodeId: board.boardNodeId,
    boardUrl,
    boardTitle: board.title,
    ownerLogin: board.ownerLogin,
    statusFieldId: board.statusFieldId,
    // Persist the board's columns so the mapping editor renders full, named
    // columns after a reload (the connect response carries them only transiently).
    statusOptions: board.statusOptions,
    // Optional per-board default model ("<provider>:<model>"); null = instance
    // default. Body-ABSENT on a re-connect means "keep the existing value"
    // (the replace-token flow doesn't send it); body-PRESENT (incl. null/"")
    // still applies — the connect form legitimately sets or clears it.
    defaultModel: body.defaultModel !== undefined ? dmParsed.value : (existing?.defaultModel ?? null),
    // Optional per-board default permission mode ("ask"|"auto-edit"|"yolo");
    // null = the spawn bridge's "yolo" fallback. Same body-absent = keep rule.
    defaultPermissionMode:
      body.defaultPermissionMode !== undefined ? pmParsed.value : (existing?.defaultPermissionMode ?? null),
    // Re-connect preserves the board's user-edited config (column mapping,
    // poll cadence, paused state); a fresh connect leaves them undefined so
    // upsertLink applies its defaults ({}, 60, true).
    columnActionMap: existing?.columnActionMap,
    pollIntervalSec: existing?.pollIntervalSec,
    enabled: existing?.enabled,
    authMode,
    createdByUserId: user.id,
  });

  if (authMode === "pat") {
    // scope 'board' → a per-board override (apiToken:<linkId>); always carries a
    // token (validated above). scope 'shared' → the project token, written ONLY
    // when the user actually provided one (a 2nd board reusing the existing
    // shared token must not re-write — and never write the resolved shared token
    // back to itself).
    const secretName = tokenScope === "board" ? boardTokenName(link.id) : "apiToken";
    const shouldWrite = tokenScope === "board" || providedToken !== "";
    if (shouldWrite) {
      try {
        await setSecret("github-projects", projectId, secretName, token, { actorUserId: user.id });
      } catch (err) {
        log.warn("token persist failed", { error: err instanceof Error ? err.message : "err" });
        // A per-board override that can't persist would leave the board silently
        // resolving via the SHARED token — the opposite of the isolation asked
        // for. Roll back a FRESHLY-inserted board (no orphan); never delete a
        // pre-existing board (a failed re-connect must not destroy prior state).
        if (tokenScope === "board" && !wasPreExisting) {
          await deleteLink(link.id).catch(() => {});
        }
        return errorJson(500, "Failed to store credentials");
      }
    }
    // A pre-existing board re-connecting at the SHARED scope must not leave a
    // stale per-board override behind — resolveLinkAuth prefers the override,
    // so the new shared token would never take effect for this board.
    // deleteSecret is idempotent (mirrors the gh branch below).
    if (tokenScope === "shared" && wasPreExisting) {
      await deleteSecret("github-projects", projectId, boardTokenName(link.id), {
        actorUserId: user.id,
      }).catch(() => {});
    }
  } else {
    // Re-connecting THIS board from PAT → gh must not leave a stale stored
    // override behind. deleteSecret is idempotent; a missing secret is a no-op.
    // The SHARED project token is left alone — other boards may still use it.
    await deleteSecret("github-projects", projectId, boardTokenName(link.id), {
      actorUserId: user.id,
    }).catch(() => {});
  }

  // Response: board metadata + scopes ONLY. Never the token.
  return json({
    linkId: link.id,
    boardTitle: board.title,
    ownerLogin: board.ownerLogin,
    statusOptions: board.statusOptions,
    scopes: validation.scopes,
    canComment: validation.canComment,
  });
};
