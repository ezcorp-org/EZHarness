import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import {
  getChatActivity,
  getModelUsage,
  getAgentStats,
  getExtensionStats,
  getUserStats,
  getToolUsageByTool,
  getToolUsageByAgent,
  getToolUsageByUser,
  getToolUsageByModel,
} from "$server/db/queries/analytics";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    requireRole(locals, "admin");

    const days = Math.min(
      Math.max(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1),
      365,
    );

    const [
      chatActivity,
      modelUsage,
      agentStats,
      extensionStats,
      userStats,
      toolUsageByTool,
      toolUsageByAgent,
      toolUsageByUser,
      toolUsageByModel,
    ] = await Promise.all([
      getChatActivity(days),
      getModelUsage(days),
      getAgentStats(),
      getExtensionStats(),
      getUserStats(),
      getToolUsageByTool(days),
      getToolUsageByAgent(days),
      getToolUsageByUser(days),
      getToolUsageByModel(days),
    ]);

    return json({
      chatActivity,
      modelUsage,
      agentStats,
      extensionStats,
      userStats,
      toolUsage: {
        byTool: toolUsageByTool,
        byAgent: toolUsageByAgent,
        byUser: toolUsageByUser,
        byModel: toolUsageByModel,
      },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
