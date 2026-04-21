import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import * as convQueries from "$server/db/queries/conversations";
import { getAgentConfig } from "$server/db/queries/agent-configs";
import { getExecutor, getBus } from "$lib/server/context";
import { enqueue } from "$server/runtime/pending-messages";
import { buildCommandResolver } from "$lib/server/command-resolver";
import { CURRENT_MODEL_SENTINEL } from "$server/types";

/**
 * POST — Send a user message into an agent's sub-conversation.
 *
 * If the agent is currently running, the message is queued and picked up
 * after the current run completes (auto-continue). If idle, a new run
 * is started immediately.
 *
 * Body: { content: string }
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const body = await request.json().catch(() => null);
  const content = body?.content?.trim();
  if (!content) return json({ error: "content is required" }, { status: 400 });

  // Verify this is a sub-conversation (has a parent)
  const subConv = await convQueries.getConversation(params.id);
  if (!subConv) return json({ error: "Not found" }, { status: 404 });
  if (!subConv.parentConversationId) {
    return json({ error: "Not a sub-conversation" }, { status: 400 });
  }

  // Walk up the parent chain to find the ROOT conversation (the user's
  // actual chat). Teams nest sub-conversations one level deep —
  // member sub-conversations are children of the orchestrator, which
  // is itself a child of the user's main chat. We need the root for
  // both the ownership check (sub-convs have userId=null) and for
  // emitting agent:complete with the right parentConversationId so
  // the chat page's listener actually matches.
  const directParent = await convQueries.getConversation(subConv.parentConversationId);
  if (!directParent) return json({ error: "Parent not found" }, { status: 404 });

  let rootConv = directParent;
  // Bound the walk so a corrupt cycle can't infinite-loop the request.
  for (let depth = 0; depth < 8 && rootConv.parentConversationId; depth++) {
    const next = await convQueries.getConversation(rootConv.parentConversationId);
    if (!next) break;
    rootConv = next;
  }

  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (rootConv.userId !== user.id && user.role !== "admin") {
    return json({ error: "Not found" }, { status: 404 });
  }
  // Use directParent for model/provider/projectId fallbacks (closer scope),
  // but rootConv.id for agent:complete so the main chat page can refresh.
  const parentConv = directParent;

  // Save user message to the sub-conversation (appears in feed immediately)
  const leaf = await convQueries.getLatestLeaf(params.id);
  const userMessage = await convQueries.createMessage(params.id, {
    role: "user",
    content,
    parentMessageId: leaf?.id,
  });

  // Check if there's a running agent on this sub-conversation
  const executor = getExecutor();
  const activeRun = executor.getActiveRunForConversation(params.id);

  if (activeRun) {
    // Agent is running — queue the message for auto-continue after run completes
    enqueue(params.id, {
      messageId: userMessage.id,
      content,
      createdAt: userMessage.createdAt instanceof Date ? userMessage.createdAt.toISOString() : String(userMessage.createdAt),
    });
    return json({ status: "queued", messageId: userMessage.id });
  }

  // Agent is idle — start a new run immediately
  const agentConfigId = subConv.agentConfigId ?? undefined;
  const config = agentConfigId ? await getAgentConfig(agentConfigId) : null;
  const projectId = parentConv.projectId ?? "global";
  const runId = crypto.randomUUID();

  const streamPromise = executor.streamChat(params.id, content, {
    projectId,
    agentConfigId,
    runId,
    parentMessageId: userMessage.id,
    model: config?.model === CURRENT_MODEL_SENTINEL
      ? (parentConv.model ?? undefined)
      : (config?.model ?? parentConv.model ?? undefined),
    provider: config?.provider === CURRENT_MODEL_SENTINEL
      ? (parentConv.provider ?? undefined)
      : (config?.provider ?? parentConv.provider ?? undefined),
    system: config?.prompt ?? subConv.systemPrompt ?? undefined,
    commandResolver: buildCommandResolver(user.id, projectId),
  });

  // Emit agent:spawn so the UI shows the agent as running again.
  // Use rootConv.id so the main chat page (which keys listeners by its
  // own convId) actually receives this — using the direct parent would
  // route nested team-member events to the orchestrator sub-conv,
  // which has no UI listener.
  const bus = getBus();
  bus.emit("agent:spawn", {
    runId,
    agentRunId: runId,
    subConversationId: params.id,
    agentName: config?.name ?? "Agent",
    agentConfigId: agentConfigId ?? "",
    task: content,
    parentConversationId: rootConv.id,
  });

  const agentName = config?.name ?? "Agent";
  const parentConversationId = rootConv.id;
  streamPromise.then(async () => {
    const leaf = await convQueries.getLatestLeaf(params.id);
    const preview = leaf?.content?.slice(0, 200) ?? "";
    bus.emit("agent:complete", {
      runId,
      agentRunId: runId,
      subConversationId: params.id,
      agentName,
      agentConfigId: agentConfigId ?? "",
      success: true,
      resultPreview: preview,
      parentConversationId,
    });
  }).catch((err) => {
    console.error("[agent-chat] streamChat error:", err instanceof Error ? err.message : err);
    bus.emit("agent:complete", {
      runId,
      agentRunId: runId,
      subConversationId: params.id,
      agentName,
      agentConfigId: agentConfigId ?? "",
      success: false,
      resultPreview: err instanceof Error ? err.message.slice(0, 200) : "Unknown error",
      parentConversationId,
    });
  });

  return json({ status: "started", messageId: userMessage.id, runId });
};
