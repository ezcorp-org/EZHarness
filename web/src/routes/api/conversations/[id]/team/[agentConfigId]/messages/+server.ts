import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import * as convQueries from "$server/db/queries/conversations";
import { getAgentConfig } from "$server/db/queries/agent-configs";
import type { TeamMember } from "$server/types";

/** Fetch messages with tool calls for a conversation, returning only the messages array. */
async function getMessagesForStream(conversationId: string) {
  const { messages } = await convQueries.getMessagesWithToolCalls(conversationId);
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    toolCalls: m.toolCalls.map((tc) => ({
      id: tc.id,
      toolName: tc.toolName,
      input: tc.input,
      outputSummary: tc.outputSummary,
      success: tc.success,
      durationMs: tc.durationMs,
      status: tc.status,
    })),
  }));
}

/**
 * GET — Fetch messages for a team's member sub-conversations.
 * Loads the team config, finds sub-conversations for each member,
 * and returns messages grouped by member.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const conv = await convQueries.getConversation(params.id);
  if (!conv) return errorJson(404, "Not found");
  // sec-H3b: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return errorJson(404, "Not found");

  const teamConfig = await getAgentConfig(params.agentConfigId);
  if (!teamConfig) return errorJson(404, "Team config not found");

  const refs = teamConfig.references as { members?: TeamMember[] } | null;
  const members = refs?.members ?? [];
  if (members.length === 0) {
    return json({
      team: { name: teamConfig.name, members: [] },
      streams: [],
    });
  }

  // Find the team orchestrator's sub-conversation (direct child of parent)
  const parentSubConvs = await convQueries.getSubConversations(params.id);
  const orchestratorConv = parentSubConvs.find(
    (sc) => sc.agentConfigId === params.agentConfigId,
  );

  // Member sub-conversations are children of the ORCHESTRATOR, not the parent.
  // Also check direct children of parent as a fallback (in case members were
  // invoked directly without going through the orchestrator).
  const memberSubConvs = orchestratorConv
    ? await convQueries.getSubConversations(orchestratorConv.id)
    : [];

  // Build a map of agentConfigId -> subConversation (check both levels)
  const subConvByAgent = new Map<string, typeof parentSubConvs[0]>();
  for (const sc of [...memberSubConvs, ...parentSubConvs]) {
    if (sc.agentConfigId && !subConvByAgent.has(sc.agentConfigId)) {
      subConvByAgent.set(sc.agentConfigId, sc);
    }
  }

  // Load agent configs + messages for each team member
  const streams = await Promise.all(
    members.map(async (member) => {
      const memberConfig = await getAgentConfig(member.agentConfigId);
      const subConv = subConvByAgent.get(member.agentConfigId);

      if (!subConv) {
        return {
          agentConfigId: member.agentConfigId,
          agentName: memberConfig?.name ?? "Unknown",
          subConversationId: null,
          messages: [],
        };
      }

      const messages = await getMessagesForStream(subConv.id);
      return {
        agentConfigId: member.agentConfigId,
        agentName: memberConfig?.name ?? subConv.title ?? "Unknown",
        subConversationId: subConv.id,
        messages,
      };
    }),
  );

  // Build member list with resolved names for the frontend
  const memberList = await Promise.all(
    members.map(async (m) => {
      const cfg = await getAgentConfig(m.agentConfigId);
      return { agentConfigId: m.agentConfigId, agentName: cfg?.name ?? "Unknown" };
    }),
  );

  // Include the orchestrator's own conversation if it exists
  let orchestratorStream = null;
  if (orchestratorConv) {
    const orchestratorMessages = await getMessagesForStream(orchestratorConv.id);
    orchestratorStream = {
      agentConfigId: params.agentConfigId,
      agentName: teamConfig.name + " (orchestrator)",
      subConversationId: orchestratorConv.id,
      messages: orchestratorMessages,
    };
  }

  return json({
    team: {
      name: teamConfig.name,
      members: memberList,
    },
    orchestrator: orchestratorStream,
    streams,
  });
};
