import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { getAgentConfig } from "$server/db/queries/agent-configs";
import { shareAgent, shareAgentWithUser, unshareAgent, unshareAgentFromUser, getAgentShares } from "$server/db/queries/agent-shares";
import { getTeamMembershipsByTeams } from "$server/db/queries/teams";
import { getUsersByIds } from "$server/db/queries/users";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";

// Boundary validation for share POST/DELETE bodies. The handlers have
// existing 400 messages that the test contract pins (e.g. `"permission
// must be 'read' or 'edit'"` and `"teamIds or userIds array is
// required"`), so the schema is permissive and the inline checks below
// handle the dispatch. Zod here just shapes the wire types — the
// per-field error messages stay verbatim.
const sharePostSchema = z.object({
  teamIds: z.array(z.string()).optional(),
  userIds: z.array(z.string()).optional(),
  // permission stays a permissive string here so the handler's inline
  // "permission must be 'read' or 'edit'" 400 (test-pinned) still fires
  // for invalid values rather than getting overridden by a Zod issue.
  permission: z.string().optional(),
}).strict();

const shareDeleteSchema = z.object({
  teamId: z.string().optional(),
  userId: z.string().optional(),
}).strict();

async function verifyOwnerOrAdmin(locals: App.Locals, agentId: string) {
  const user = requireAuth(locals);
  const agent = await getAgentConfig(agentId);
  if (!agent) {
    throw new Response(JSON.stringify({ error: "Agent not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (agent.userId !== user.id && user.role !== "admin") {
    throw new Response(JSON.stringify({ error: "Agent not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return { user, agent };
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  try {
    const { agent } = await verifyOwnerOrAdmin(locals, params.id);
    const shares = await getAgentShares(agent.id);
    return json({ shares });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  try {
    const { user, agent } = await verifyOwnerOrAdmin(locals, params.id);
    const parsed = sharePostSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return errorJson(400, "Invalid request body");
    }
    const { teamIds, userIds, permission = "read" } = parsed.data;

    if (permission !== "read" && permission !== "edit") {
      return errorJson(400, "permission must be 'read' or 'edit'");
    }

    const hasTeams = Array.isArray(teamIds) && teamIds.length > 0;
    const hasUsers = Array.isArray(userIds) && userIds.length > 0;

    if (!hasTeams && !hasUsers) {
      return errorJson(400, "teamIds or userIds array is required");
    }

    if (hasTeams) {
      // Batched membership lookup. Admins skip the membership gate
      // entirely (matching the per-iteration form), so we only spend a
      // query when the caller is non-admin.
      const memberships =
        user.role === "admin"
          ? null
          : await getTeamMembershipsByTeams(user.id, teamIds!);
      for (const teamId of teamIds!) {
        if (memberships) {
          const membership = memberships.get(teamId);
          if (!membership || membership.role === "viewer") {
            return errorJson(403, `Insufficient permissions for team ${teamId}`);
          }
        }
        await shareAgent(agent.id, teamId, user.id, permission);
      }
    }

    if (hasUsers) {
      // Batched recipient lookup; the loop below preserves the
      // original short-circuit on first missing user.
      const targetUsers = await getUsersByIds(userIds!);
      for (const targetUserId of userIds!) {
        const targetUser = targetUsers.get(targetUserId);
        if (!targetUser) {
          return errorJson(404, `User ${targetUserId} not found`);
        }
        await shareAgentWithUser(agent.id, targetUserId, user.id, permission);
      }
    }

    await insertAuditEntry(user.id, "agent:shared", agent.id, {
      teamIds: teamIds ?? [],
      userIds: userIds ?? [],
      permission,
      agentName: agent.name,
    });

    return json({ ok: true });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  try {
    const { user, agent } = await verifyOwnerOrAdmin(locals, params.id);
    const parsed = shareDeleteSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return errorJson(400, "Invalid request body");
    }
    const { teamId, userId } = parsed.data;

    if (!teamId && !userId) {
      return errorJson(400, "teamId or userId is required");
    }

    let removed = false;
    if (teamId) {
      removed = await unshareAgent(agent.id, teamId);
    } else if (userId) {
      removed = await unshareAgentFromUser(agent.id, userId);
    }

    if (removed) {
      await insertAuditEntry(user.id, "agent:unshared", agent.id, {
        teamId: teamId ?? null,
        userId: userId ?? null,
        agentName: agent.name,
      });
    }

    return json({ ok: true, removed });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
