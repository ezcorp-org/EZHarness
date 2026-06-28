/**
 * /api/integrations/github-projects/link
 *
 *   GET    ?projectId=…  → the project's board connection + health + pause state.
 *   PATCH               → update columnActionMap / pollIntervalSec / enabled
 *                         (pause/resume). Body: `{ projectId, ... }`.
 *   DELETE              → disconnect: purge the encrypted PAT, cancel active
 *                         proposals, drop the link. Body: `{ projectId }`.
 *
 * Authed: `extensions` scope + session/key user. Never echoes the token.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import {
  authGithubRoute,
  resolveProject,
  resolveLink,
  publicLinkView,
  parseDefaultModelInput,
} from "../_shared";
import {
  updateLink,
  setLinkEnabled,
  deleteLink,
  cancelActiveProposalsForLink,
} from "$server/db/queries/github-projects";
import { deleteSecret } from "$server/extensions/secrets-store";
import type {
  GithubColumnAction,
  GithubColumnActionMap,
  GithubProposalAction,
  GithubSpawnPermissionMode,
} from "$server/integrations/github-projects/types";
import { getGithubProjectsEmit } from "$server/integrations/github-projects/bus-registry";
import { GITHUB_PROJECTS_EVENT } from "$server/integrations/github-projects/types";

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

  const linkRes = await resolveLink(projectRes.projectId);
  if ("error" in linkRes) return linkRes.error;

  return json({ link: publicLinkView(linkRes.link) });
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

  const linkRes = await resolveLink(projectRes.projectId);
  if ("error" in linkRes) return linkRes.error;
  const { link } = linkRes;

  // Build the patch from only the fields present in the body.
  const patch: {
    columnActionMap?: GithubColumnActionMap;
    pollIntervalSec?: number;
    enabled?: boolean;
    defaultModel?: string | null;
  } = {};

  if (body.columnActionMap !== undefined) {
    const validOptionIds = (link.statusOptions ?? []).map((o) => o.id);
    const parsed = parseColumnActionMap(body.columnActionMap, validOptionIds);
    if ("error" in parsed) return errorJson(400, parsed.error);
    patch.columnActionMap = parsed.map;
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

  return json({ link: publicLinkView(updated) });
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

  const linkRes = await resolveLink(projectRes.projectId);
  if ("error" in linkRes) return linkRes.error;
  const { link } = linkRes;

  // Disconnect order: purge the credential, mark active proposals cancelled
  // (so no orphan shows "running" on the Hub), then drop the link. Proposals
  // CASCADE on link delete too, but the explicit cancel keeps history honest.
  // Project-scoped secret (userId=null) — same slot connect wrote + the daemon
  // reads. deleteSecret is idempotent; a missing secret is a no-op. `actorUserId`
  // is audit-only (attributes SECRET_DELETED to the disconnecting user).
  await deleteSecret("github-projects", link.projectId, "apiToken", {
    actorUserId: auth.user.id,
  }).catch(() => {});
  const cancelled = await cancelActiveProposalsForLink(link.id);
  await deleteLink(link.id);

  getGithubProjectsEmit()?.(GITHUB_PROJECTS_EVENT, { projectId: link.projectId });

  return json({ disconnected: true, cancelledProposals: cancelled });
};
