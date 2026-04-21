import { eq, and } from "drizzle-orm";
import { getDb } from "../connection";
import { teams, teamMembers, users } from "../schema";
import type { Team, TeamMember } from "../schema";

export type { Team, TeamMember };

export async function createTeam(name: string): Promise<Team> {
  const rows = await getDb().insert(teams).values({ name }).returning();
  return rows[0]!;
}

export async function getTeam(id: string): Promise<Team | undefined> {
  const rows = await getDb().select().from(teams).where(eq(teams.id, id));
  return rows[0];
}

export async function listTeams(): Promise<Team[]> {
  return getDb().select().from(teams);
}

export async function updateTeamName(id: string, name: string): Promise<Team | undefined> {
  const rows = await getDb().update(teams).set({ name }).where(eq(teams.id, id)).returning();
  return rows[0];
}

export async function deleteTeam(id: string): Promise<boolean> {
  const rows = await getDb().delete(teams).where(eq(teams.id, id)).returning();
  return rows.length > 0;
}

export async function addTeamMember(
  teamId: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
): Promise<TeamMember> {
  const rows = await getDb()
    .insert(teamMembers)
    .values({ teamId, userId, role })
    .returning();
  return rows[0]!;
}

export async function removeTeamMember(teamId: string, userId: string): Promise<boolean> {
  const rows = await getDb()
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .returning();
  return rows.length > 0;
}

export async function updateTeamMemberRole(
  teamId: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
): Promise<boolean> {
  const rows = await getDb()
    .update(teamMembers)
    .set({ role })
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .returning();
  return rows.length > 0;
}

export async function getTeamMembers(
  teamId: string,
): Promise<(TeamMember & { userName: string; userEmail: string })[]> {
  const rows = await getDb()
    .select({
      id: teamMembers.id,
      teamId: teamMembers.teamId,
      userId: teamMembers.userId,
      role: teamMembers.role,
      createdAt: teamMembers.createdAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId));
  return rows as (TeamMember & { userName: string; userEmail: string })[];
}

export async function getUserTeams(userId: string): Promise<(Team & { role: string })[]> {
  const rows = await getDb()
    .select({
      id: teams.id,
      name: teams.name,
      createdAt: teams.createdAt,
      role: teamMembers.role,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId));
  return rows as (Team & { role: string })[];
}

export async function getTeamMembership(
  userId: string,
  teamId: string,
): Promise<TeamMember | undefined> {
  const rows = await getDb()
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)));
  return rows[0];
}
