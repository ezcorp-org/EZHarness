import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { getAgentConfig } from "$server/db/queries/agent-configs";
import { shareAgent, shareAgentWithUser, unshareAgent, unshareAgentFromUser, getAgentShares } from "$server/db/queries/agent-shares";
import { getTeamMembership } from "$server/db/queries/teams";
import { getUserById } from "$server/db/queries/users";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { requireScope } from "$lib/server/security/api-keys";

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
    const body = await request.json();
    const { teamIds, userIds, permission = "read" } = body as {
      teamIds?: string[];
      userIds?: string[];
      permission?: "read" | "edit";
    };

    if (permission !== "read" && permission !== "edit") {
      return json({ error: "permission must be 'read' or 'edit'" }, { status: 400 });
    }

    const hasTeams = Array.isArray(teamIds) && teamIds.length > 0;
    const hasUsers = Array.isArray(userIds) && userIds.length > 0;

    if (!hasTeams && !hasUsers) {
      return json({ error: "teamIds or userIds array is required" }, { status: 400 });
    }

    if (hasTeams) {
      for (const teamId of teamIds!) {
        if (user.role !== "admin") {
          const membership = await getTeamMembership(user.id, teamId);
          if (!membership || membership.role === "viewer") {
            return json({ error: `Insufficient permissions for team ${teamId}` }, { status: 403 });
          }
        }
        await shareAgent(agent.id, teamId, user.id, permission);
      }
    }

    if (hasUsers) {
      for (const targetUserId of userIds!) {
        const targetUser = await getUserById(targetUserId);
        if (!targetUser) {
          return json({ error: `User ${targetUserId} not found` }, { status: 404 });
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
    const body = await request.json();
    const { teamId, userId } = body as { teamId?: string; userId?: string };

    if (!teamId && !userId) {
      return json({ error: "teamId or userId is required" }, { status: 400 });
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
