import { json } from "@sveltejs/kit";
import { z } from "zod";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import * as convQueries from "$server/db/queries/conversations";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { getAgentConfig } from "$server/db/queries/agent-configs";
import { getExecutor, getBus } from "$lib/server/context";
import { logger } from "$server/logger";
import { enqueue } from "$server/runtime/pending-messages";
import { buildCommandResolver } from "$lib/server/command-resolver";
import { CURRENT_MODEL_SENTINEL } from "$server/types";

const log = logger.child("api.agent-chat");

// Boundary validation: `content` is the required user message. The
// optional `provider`/`model` pair lets the sub-chat caller pin the run
// to a specific model (overrides the agent-config + parent-conv fallback
// chain — see the idle-run branch below). Either both are present or
// both are absent; partial bodies are rejected so half-resolved
// (one-of-two) requests can't silently fall back to the agent default.
// The handler then trims `content` and rejects empty/whitespace-only
// strings — schema accepts any string, the post-trim "content is
// required" check stays so the test contract on that exact message is
// preserved.
const agentChatBodySchema = z
  .object({
    content: z.string(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .passthrough()
  .refine(
    (b) =>
      (b.provider === undefined && b.model === undefined) ||
      (typeof b.provider === "string" && typeof b.model === "string"),
    { message: "provider and model must be provided together" },
  );

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

  const raw = await request.json().catch(() => null);
  // First-pass: peek at the raw shape so we can keep the legacy
  // "content is required" 400 message (clients + tests assert on that
  // exact string) before zod refinement rejects e.g. a partial
  // provider/model pair.
  const rawContent =
    raw && typeof raw === "object" && typeof (raw as { content?: unknown }).content === "string"
      ? ((raw as { content: string }).content as string).trim()
      : undefined;
  if (!rawContent) return errorJson(400, "content is required");

  const parsed = agentChatBodySchema.safeParse(raw);
  if (!parsed.success) {
    // The remaining schema rejections are model/provider shape (empty
    // string, type mismatch) and the both-or-neither refinement. All
    // are 400s.
    const issue = parsed.error.issues[0];
    return errorJson(400, issue?.message ?? "Invalid body");
  }
  const content = parsed.data.content.trim();
  if (!content) return errorJson(400, "content is required");
  const bodyProvider = parsed.data.provider;
  const bodyModel = parsed.data.model;

  // Verify this is a sub-conversation (has a parent)
  const subConv = await convQueries.getConversation(params.id);
  if (!subConv) return errorJson(404, "Not found");
  if (!subConv.parentConversationId) {
    return errorJson(400, "Not a sub-conversation");
  }

  // The direct parent is still looked up here (NOT via the ownership
  // helper) for two reasons the helper deliberately does NOT own:
  //   1. agent-chat uses the DIRECT parent (closer scope) for the
  //      model / provider / projectId fallback chain below — the root
  //      would be the wrong scope (a nested team member's model should
  //      fall back to its orchestrator, not the user's main chat).
  //   2. agent-chat surfaces a distinct "Parent not found" 404 when the
  //      immediate parent row is missing (a different signal from the
  //      generic ownership 404). Preserving that exact message keeps the
  //      existing agent-chat test contract green.
  const directParent = await convQueries.getConversation(subConv.parentConversationId);
  if (!directParent) return errorJson(404, "Parent not found");

  // Ownership: walk to the ROOT and authorize there. Teams nest
  // sub-conversations — member sub-conversations are children of the
  // orchestrator, which is itself a child of the user's main chat. The
  // shared helper performs the bounded parent walk and the sec-H3
  // fail-closed check. We need the root for BOTH the ownership gate
  // (sub-convs have userId=null) and for emitting agent:complete with
  // the right parentConversationId so the chat page's listener
  // actually matches. We resolve from `subConv` itself: the legacy
  // inline walk here seeded its loop at the DIRECT PARENT and took up
  // to 8 more hops, so the helper's self-seeded walk uses a bound of
  // 8 + 1 (MAX_PARENT_DEPTH) — the extra hop is the one onto the
  // direct parent — which makes it reach the EXACT same root the old
  // walk-from-directParent did (no behaviour change; see the
  // equivalence note in conversation-ownership.ts).
  const ownership = await resolveRootConversationForOwnership(params.id, user);
  if (!ownership) return errorJson(404, "Not found");
  const rootConv = ownership.root;

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

  // Model/provider resolution (idle-run only): body override > sub-conv
  // row > agent config (CURRENT_MODEL_SENTINEL resolves to parent conv)
  // > parent conv > undefined.
  //
  // `subConv` sits ahead of `parentConv` so the sub-chat picker's PUT
  // to `/api/conversations/[id]` (which writes `model`/`provider` onto
  // the sub-conv row) actually takes effect on the NEXT idle send. The
  // active-run branch above still drops `bodyModel` — queued messages
  // drain on the original run's model (see
  // `start-assignment.ts:auto-continue`); v1 doesn't thread overrides
  // through the active-run drain.
  const streamPromise = executor.streamChat(params.id, content, {
    projectId,
    agentConfigId,
    runId,
    parentMessageId: userMessage.id,
    model: bodyModel
      ?? subConv.model
      ?? (config?.model === CURRENT_MODEL_SENTINEL
        ? (parentConv.model ?? undefined)
        : (config?.model ?? parentConv.model ?? undefined)),
    provider: bodyProvider
      ?? subConv.provider
      ?? (config?.provider === CURRENT_MODEL_SENTINEL
        ? (parentConv.provider ?? undefined)
        : (config?.provider ?? parentConv.provider ?? undefined)),
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
    log.error("streamChat error", { error: err instanceof Error ? err.message : String(err) });
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
