import { eq, and, sql, isNotNull } from "drizzle-orm";
import { getDb } from "../connection";
import { agentShares, agentConfigs, teams, users, teamMembers } from "../schema";
import type { DbAgentConfig } from "./agent-configs";

export async function shareAgent(agentId: string, teamId: string, sharedBy: string, permission: "read" | "edit" = "read"): Promise<void> {
  await getDb().execute(
    sql`INSERT INTO agent_shares (id, agent_id, team_id, shared_by, permission)
        VALUES (${crypto.randomUUID()}, ${agentId}, ${teamId}, ${sharedBy}, ${permission})
        ON CONFLICT (agent_id, team_id) DO UPDATE SET permission = ${permission}`
  );
}

export async function shareAgentWithUser(
  agentId: string, targetUserId: string, sharedBy: string, permission: "read" | "edit" = "read"
): Promise<void> {
  await getDb().execute(
    sql`INSERT INTO agent_shares (id, agent_id, user_id, shared_by, permission)
        VALUES (${crypto.randomUUID()}, ${agentId}, ${targetUserId}, ${sharedBy}, ${permission})
        ON CONFLICT (agent_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET permission = ${permission}`
  );
}

export async function unshareAgent(agentId: string, teamId: string): Promise<boolean> {
  const rows = await getDb()
    .delete(agentShares)
    .where(and(eq(agentShares.agentId, agentId), eq(agentShares.teamId, teamId)))
    .returning();
  return rows.length > 0;
}

export async function unshareAgentFromUser(agentId: string, targetUserId: string): Promise<boolean> {
  const rows = await getDb()
    .delete(agentShares)
    .where(and(eq(agentShares.agentId, agentId), eq(agentShares.userId, targetUserId)))
    .returning();
  return rows.length > 0;
}

export type AgentShareInfo = {
  teamId: string | null;
  teamName: string | null;
  userId: string | null;
  recipientName: string | null;
  sharedBy: string;
  sharedByName: string;
  permission: "read" | "edit";
  createdAt: Date;
};

export async function getAgentShares(agentId: string): Promise<AgentShareInfo[]> {
  const rows = await getDb().execute(
    sql`SELECT
          ash.team_id AS "teamId", t.name AS "teamName",
          ash.user_id AS "userId", recipient.name AS "recipientName",
          ash.shared_by AS "sharedBy", sharer.name AS "sharedByName",
          ash.permission, ash.created_at AS "createdAt"
        FROM agent_shares ash
        INNER JOIN users sharer ON sharer.id = ash.shared_by
        LEFT JOIN teams t ON t.id = ash.team_id
        LEFT JOIN users recipient ON recipient.id = ash.user_id
        WHERE ash.agent_id = ${agentId}
        ORDER BY ash.created_at ASC`
  );
  return (rows.rows as any[]).map(r => ({
    ...r,
    createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
  }));
}

export type SharedAgentConfig = DbAgentConfig & {
  shared: true;
  sharedBy: string;
  sharedByName: string;
  permission: "read" | "edit";
  teamId: string | null;
  teamName: string | null;
};

export async function getSharedAgentsForUser(userId: string): Promise<SharedAgentConfig[]> {
  // Find agents shared via team membership OR directly to user
  // Deduplicate by agent ID (pick first share if shared multiple ways)
  const rows = await getDb().execute(
    sql`SELECT DISTINCT ON (ac.id)
          ac.id, ac.name, ac.description, ac.capabilities, ac.prompt,
          ac.input_schema AS "inputSchema", ac.output_format AS "outputFormat",
          ac.provider, ac.model, ac.temperature, ac.max_tokens AS "maxTokens",
          ac.category, ac.user_id AS "userId", ac.extensions,
          ac.created_at AS "createdAt", ac.updated_at AS "updatedAt",
          ash.shared_by AS "sharedBy", u.name AS "sharedByName",
          ash.team_id AS "teamId", t.name AS "teamName",
          ash.permission
        FROM agent_shares ash
        INNER JOIN agent_configs ac ON ac.id = ash.agent_id
        INNER JOIN users u ON u.id = ash.shared_by
        LEFT JOIN teams t ON t.id = ash.team_id
        LEFT JOIN team_members tm ON tm.team_id = ash.team_id AND tm.user_id = ${userId}
        WHERE ac.user_id != ${userId}
          AND (
            (ash.team_id IS NOT NULL AND tm.user_id IS NOT NULL)
            OR (ash.user_id = ${userId})
          )
        ORDER BY ac.id, ash.created_at ASC`
  );

  return (rows.rows as any[]).map((r) => ({
    ...r,
    shared: true as const,
    capabilities: typeof r.capabilities === "string" ? JSON.parse(r.capabilities) : r.capabilities,
    extensions: typeof r.extensions === "string" ? JSON.parse(r.extensions) : (r.extensions ?? []),
  }));
}
