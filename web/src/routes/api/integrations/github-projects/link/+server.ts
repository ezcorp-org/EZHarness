/**
 * /api/integrations/github-projects/link
 *
 *   GET    ?projectId=…  → `{ links: [...] }`, EVERY board linked to the project
 *                         (one card each), each enriched with hasTokenOverride.
 *   PATCH               → update columnActionMap / pollIntervalSec / enabled /
 *                         defaultModel of ONE board. Body: `{ projectId, linkId, ... }`.
 *   DELETE              → disconnect ONE board: purge its per-board override,
 *                         cancel active proposals, drop the link; purge the
 *                         SHARED project token only when no boards remain.
 *                         Body: `{ projectId, linkId }`.
 *
 * Authed: `extensions` scope + session/key user. Never echoes the token.
 * RBAC: GET → `use`; PATCH / DELETE → `configure` — checked after the opaque
 * project/link resolution so the 404 semantics stay first. A PATCH that turns
 * a column's `autoSpawn` ON additionally requires `approve-runs` (auto-spawn
 * pre-authorizes future agent runs), so a configure-only grantee can edit the
 * map but never flip autoSpawn on.
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
  parseDefaultModelInput,
  parsePermissionModeInput,
} from "../_shared";
import {
  updateLink,
  setLinkEnabled,
  deleteLink,
  cancelActiveProposalsForLink,
  listLinksByProjectId,
} from "$server/db/queries/github-projects";
import { deleteSecret, hasSecret } from "$server/extensions/secrets-store";
import { boardTokenName } from "$server/integrations/github-projects/auth";
import type {
  GithubColumnAction,
  GithubColumnActionMap,
  GithubProposalAction,
  GithubSpawnPermissionMode,
} from "$server/integrations/github-projects/types";
import { getGithubProjectsEmit } from "$server/integrations/github-projects/bus-registry";
import { GITHUB_PROJECTS_EVENT } from "$server/integrations/github-projects/types";
import { extensionLogger } from "$server/logger";

const log = extensionLogger("github-projects", "api.link");

const MIN_POLL_SEC = 15;
const MAX_POLL_SEC = 3600;

const VALID_ACTIONS = new Set<GithubProposalAction>(["plan", "execute"]);
const VALID_PERMISSION_MODES = new Set<GithubSpawnPermissionMode>([
  "default",
  "plan",
  "acceptEdits",
]);

/** Validate + normalise an untrusted columnActionMap from the request body.
 *  Returns the sanitised map or an error string. autoSpawn defaults OFF.
 *
 *  @param raw            - untrusted body value
 *  @param validOptionIds - the board's known Status option ids (from the
 *                          persisted link). When non-empty, doneStatusOptionId
 *                          must be one of them. When empty (legacy links whose
 *                          statusOptions were never persisted) any non-empty
 *                          string is accepted so we don't break legacy configs. */
function parseColumnActionMap(
  raw: unknown,
  validOptionIds: string[],
): { map: GithubColumnActionMap } | { error: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "columnActionMap must be an object" };
  }
  const out: GithubColumnActionMap = {};
  const knownIds = new Set(validOptionIds);
  for (const [optionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!optionId) return { error: "columnActionMap has an empty option id" };
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      return { error: `columnActionMap[${optionId}] must be an object` };
    }
    const v = value as Record<string, unknown>;
    if (!VALID_ACTIONS.has(v.action as GithubProposalAction)) {
      return { error: `columnActionMap[${optionId}].action must be 'plan' or 'execute'` };
    }
    const entry: GithubColumnAction = {
      action: v.action as GithubProposalAction,
      // Defense-in-depth: auto-spawn is OFF unless explicitly true.
      autoSpawn: v.autoSpawn === true,
    };
    if (v.agentName !== undefined) {
      if (typeof v.agentName !== "string") {
        return { error: `columnActionMap[${optionId}].agentName must be a string` };
      }
      if (v.agentName) entry.agentName = v.agentName;
    }
    if (v.permissionMode !== undefined) {
      if (!VALID_PERMISSION_MODES.has(v.permissionMode as GithubSpawnPermissionMode)) {
        return { error: `columnActionMap[${optionId}].permissionMode is invalid` };
      }
      entry.permissionMode = v.permissionMode as GithubSpawnPermissionMode;
    }
    if (v.doneStatusOptionId !== undefined) {
      if (typeof v.doneStatusOptionId !== "string") {
        return { error: `columnActionMap[${optionId}].doneStatusOptionId must be a string` };
      }
      if (v.doneStatusOptionId) {
        // Defense-in-depth: only accept a value that belongs to this board's
        // known Status options. Skip the check for legacy links whose
        // statusOptions were never persisted (knownIds empty) to avoid
        // breaking existing configurations.
        if (knownIds.size > 0 && !knownIds.has(v.doneStatusOptionId)) {
          return { error: `columnActionMap[${optionId}].doneStatusOptionId is not a valid status option for this board` };
        }
        entry.doneStatusOptionId = v.doneStatusOptionId;
      }
      // empty string → omit the field (no-op on the card)
    }
    out[optionId] = entry;
  }
  return { map: out };
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const auth = authGithubRoute(locals);
  if ("error" in auth) return auth.error;

  const projectRes = await resolveProject(url.searchParams.get("projectId"));
  if ("error" in projectRes) return projectRes.error;

  // RBAC: reading the project's board links is a `use` action.
  const denied = await requireGithubScope(locals, projectRes.projectId, "use");
  if (denied) return denied;

  // EVERY board linked to the project (oldest-first → stable card order). Each
  // is enriched with hasTokenOverride — the boolean presence of a per-board
  // token (never the token), so the card can show "shared token" vs "override".
  const links = await listLinksByProjectId(projectRes.projectId);
  const views = await Promise.all(
    links.map(async (link) => {
      const hasOverride = await hasSecret(
        "github-projects",
        link.projectId,
        boardTokenName(link.id),
      );
      return publicLinkView(link, hasOverride);
    }),
  );
  return json({ links: views });
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
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

  // RBAC (after the opaque project/link 404s): editing a board's config is a
  // `configure` action.
  const denied = await requireGithubScope(locals, projectRes.projectId, "configure");
  if (denied) return denied;

  // Build the patch from only the fields present in the body.
  const patch: {
    columnActionMap?: GithubColumnActionMap;
    pollIntervalSec?: number;
    enabled?: boolean;
    defaultModel?: string | null;
    defaultPermissionMode?: string | null;
  } = {};

  if (body.columnActionMap !== undefined) {
    const validOptionIds = (link.statusOptions ?? []).map((o) => o.id);
    const parsed = parseColumnActionMap(body.columnActionMap, validOptionIds);
    if ("error" in parsed) return errorJson(400, parsed.error);
    patch.columnActionMap = parsed.map;
    // Turning a column's autoSpawn ON pre-authorizes future agent runs — that
    // is the `approve-runs` scope's domain, not merely `configure`. So a map
    // that flips autoSpawn ON for ANY column additionally requires
    // `approve-runs` (a configure-only grantee may still edit actions /
    // agentName / permissionMode / doneStatusOptionId and set autoSpawn:false).
    // Kept AFTER the opaque link/project resolution so the 404 semantics stay
    // first — this extra scope check never leaks whether an id exists.
    if (Object.values(parsed.map).some((c) => c.autoSpawn === true)) {
      const deniedAutoSpawn = await requireGithubScope(
        locals,
        projectRes.projectId,
        "approve-runs",
      );
      if (deniedAutoSpawn) return deniedAutoSpawn;
    }
  }

  if (body.pollIntervalSec !== undefined) {
    const n = Number(body.pollIntervalSec);
    if (!Number.isFinite(n)) return errorJson(400, "pollIntervalSec must be a number");
    // Clamp to a sane band so a typo can't hammer GitHub or stall the poller.
    patch.pollIntervalSec = Math.min(MAX_POLL_SEC, Math.max(MIN_POLL_SEC, Math.round(n)));
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return errorJson(400, "enabled must be a boolean");
    patch.enabled = body.enabled;
  }

  if (body.defaultModel !== undefined) {
    const parsed = parseDefaultModelInput(body.defaultModel);
    if ("error" in parsed) return errorJson(400, parsed.error);
    patch.defaultModel = parsed.value;
  }

  if (body.defaultPermissionMode !== undefined) {
    const parsed = parsePermissionModeInput(body.defaultPermissionMode);
    if ("error" in parsed) return errorJson(400, parsed.error);
    patch.defaultPermissionMode = parsed.value;
  }

  if (Object.keys(patch).length === 0) {
    return errorJson(400, "No updatable fields provided");
  }

  // `enabled`-only patches go through setLinkEnabled for clarity; otherwise a
  // single updateLink carries the merged patch (enabled included).
  const updated =
    Object.keys(patch).length === 1 && patch.enabled !== undefined
      ? await setLinkEnabled(link.id, patch.enabled)
      : await updateLink(link.id, patch);
  if (!updated) return errorJson(404, "No GitHub board linked to this project");

  // Nudge the Hub (pause/resume + map changes alter what it should show).
  getGithubProjectsEmit()?.(GITHUB_PROJECTS_EVENT, { projectId: updated.projectId });

  // Mirror GET/refresh-columns: report the boolean presence of a per-board
  // token override (never the token) — the page adopts this response wholesale
  // (replaceLink), so omitting it would mislabel an override board as "shared
  // token" after every save/pause until a reload.
  const hasOverride = await hasSecret(
    "github-projects",
    updated.projectId,
    boardTokenName(updated.id),
  );
  return json({ link: publicLinkView(updated, hasOverride) });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
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

  // RBAC (after the opaque project/link 404s): disconnecting a board is a
  // `configure` action.
  const denied = await requireGithubScope(locals, projectRes.projectId, "configure");
  if (denied) return denied;

  // Disconnect order: cancel active proposals (so no orphan shows "running" on
  // the Hub), drop the link, then purge THIS board's per-board override. The
  // SHARED project token is purged ONLY when this was the project's last board —
  // other boards may still resolve via it. deleteSecret is idempotent; a missing
  // secret is a no-op. `actorUserId` is audit-only (attributes SECRET_DELETED).
  // A failed purge is non-fatal (the disconnect itself succeeded) but never
  // silent — an orphaned encrypted PAT with no audit trail is a security smell.
  const warnPurgeFailure = (what: string) => (err: unknown) => {
    log.warn(`${what} purge failed on disconnect`, {
      linkId: link.id,
      projectId: link.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  };
  const cancelled = await cancelActiveProposalsForLink(link.id);
  await deleteLink(link.id);
  await deleteSecret("github-projects", link.projectId, boardTokenName(link.id), {
    actorUserId: auth.user.id,
  }).catch(warnPurgeFailure("board override token"));
  const remaining = await listLinksByProjectId(link.projectId);
  if (remaining.length === 0) {
    await deleteSecret("github-projects", link.projectId, "apiToken", {
      actorUserId: auth.user.id,
    }).catch(warnPurgeFailure("shared token"));
  }

  getGithubProjectsEmit()?.(GITHUB_PROJECTS_EVENT, { projectId: link.projectId });

  return json({ disconnected: true, cancelledProposals: cancelled });
};
