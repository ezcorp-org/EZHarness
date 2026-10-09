import { json } from "@sveltejs/kit";
import { z } from "zod";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import { checkProjectWorkAccess, requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import * as convQueries from "$server/db/queries/conversations";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { getAgentConfig } from "$server/db/queries/agent-configs";
import { getExecutor, getBus } from "$lib/server/context";
import { logger } from "$server/logger";
import { enqueue } from "$server/runtime/pending-messages";
import { buildCommandResolver } from "$lib/server/command-resolver";
import { runStartPolicyDenial, runStartToolPolicyOptions } from "$server/auth/tool-policy";
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

type Conversation = NonNullable<Awaited<ReturnType<typeof convQueries.getConversation>>>;
type UserMessage = Awaited<ReturnType<typeof convQueries.createMessage>>;
type ChatBody = { content: string; bodyProvider?: string; bodyModel?: string };
type ChatScope = {
  subConv: Conversation;
  parentConv: Conversation;
  rootConversationId: string;
  projectId: string;
};
type RouteLocals = App.Locals;

async function readAgentChatBody(request: Request): Promise<ChatBody | Response> {
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

  return { content, bodyProvider, bodyModel };
}

async function authorizeAgentChat(
  conversationId: string,
  user: ReturnType<typeof requireAuth>,
  locals: RouteLocals,
): Promise<ChatScope | Response> {
  // Verify this is a sub-conversation (has a parent)
  const subConv = await convQueries.getConversation(conversationId);
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
  const ownership = await resolveRootConversationForOwnership(conversationId, user);
  if (!ownership) return errorJson(404, "Not found");
  const rootConv = ownership.root;

  // Use directParent for model/provider/projectId fallbacks (closer scope),
  // but rootConv.id for agent:complete so the main chat page can refresh.
  const parentConv = directParent;
  const projectId = parentConv.projectId ?? "global";
  const projectDenial = await checkProjectWorkAccess(locals, projectId);
  if (projectDenial) return projectDenial;

  return { subConv, parentConv, rootConversationId: rootConv.id, projectId };
}

function steerOrQueueAgentChat(
  conversationId: string,
  content: string,
  userMessage: UserMessage,
  executor: ReturnType<typeof getExecutor>,
): Response {
  // Agent is running (P2). Steer the live run so the message lands mid-run
  // at the next turn boundary instead of waiting for the run to finish. The
  // decision is ATOMIC — EITHER steer OR enqueue, never both — keyed on the
  // steerConversation result. steer() is best-effort: the executor
  // shadow-tracks the message and calls the fallback below if it reaches the
  // run's terminal undelivered (abort / failover swap / loop already past
  // its final steering poll), so nothing is silently lost and branch (1)
  // still drains it. Content is passed verbatim to match branch (1)'s
  // verbatim pending-message re-prompt (start-assignment.ts).
  //
  // P4 §1.2: pass the persisted row id so the executor can re-parent it to
  // the actual injection position at delivery (the request-time parent is the
  // leaf-at-request, which diverges from where the LLM sees the steer). The
  // route persists the row up-front (above) for immediate feed visibility; the
  // reconciliation fixes its branch position without deferring that.
  const pending = {
    messageId: userMessage.id,
    content,
    createdAt: userMessage.createdAt instanceof Date ? userMessage.createdAt.toISOString() : String(userMessage.createdAt),
  };
  const enqueuePending = () => enqueue(conversationId, pending);
  const steerResult = executor.steerConversation(conversationId, content, enqueuePending, userMessage.id);
  if (steerResult.status === "steered") {
    return json({ status: "steered", messageId: userMessage.id });
  }
  // Every non-`steered` result → enqueue exactly as before so branch (1)
  // drains it at the current run's completion. This covers `no-live-run` /
  // `no-agent` (the run ended or is in its pre-first-token window) AND P4's
  // `guarded` (an autonomous / structured-output child that must take user
  // messages at the run boundary, not mid-run) — the pre-P2 queued behavior,
  // preserved for exactly those children.
  enqueuePending();
  return json({ status: "queued", messageId: userMessage.id });
}

function resolveAgentSelection(
  override: string | undefined,
  persisted: string | null,
  configured: string | null | undefined,
  parent: string | null,
): string | undefined {
  return override ?? persisted ?? (configured === CURRENT_MODEL_SENTINEL
    ? parent ?? undefined
    : configured ?? parent ?? undefined);
}

async function startAgentChat(input: {
  conversationId: string;
  userId: string;
  body: ChatBody;
  scope: ChatScope;
  userMessage: UserMessage;
  executor: ReturnType<typeof getExecutor>;
  toolPolicy: RouteLocals["apiKeyToolPolicy"];
}): Promise<Response> {
  const { conversationId, userId, body, scope, userMessage, executor, toolPolicy } = input;
  const { content, bodyProvider, bodyModel } = body;
  const { subConv, parentConv, rootConversationId, projectId } = scope;
  // Agent is idle — start a new run immediately
  const agentConfigId = subConv.agentConfigId ?? undefined;
  const config = agentConfigId ? await getAgentConfig(agentConfigId) : null;
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
  const streamPromise = executor.streamChat(conversationId, content, {
    workspacePrincipal: { userId },
    projectId,
    agentConfigId,
    runId,
    parentMessageId: userMessage.id,
    model: resolveAgentSelection(bodyModel, subConv.model, config?.model, parentConv.model),
    provider: resolveAgentSelection(bodyProvider, subConv.provider, config?.provider, parentConv.provider),
    system: config?.prompt ?? subConv.systemPrompt ?? undefined,
    // The sub-conversation's OWN persisted mode governs its run, exactly as
    // `conv.modeId` governs the messages route's. Without this the Boundary-2
    // check above would gate the reach and then run the turn unfiltered — a
    // lock that admits the request and drops the mode is not a lock. Spawned
    // sub-conversations carry no mode (`createSubConversation` never sets one),
    // so this is `undefined` — today's behaviour — unless the row was pinned to
    // a mode explicitly.
    modeId: subConv.modeId ?? undefined,
    commandResolver: buildCommandResolver(userId, projectId),
    // Boundary 3 — see the messages route. A sub-agent run started by a
    // policied key is still that key's run: it must not hold the spawn
    // primitives the key's route allowlist denies over HTTP.
    ...runStartToolPolicyOptions(toolPolicy),
  });

  // Emit agent:spawn so the UI shows the agent as running again.
  // Use rootConversationId so the main chat page (which keys listeners by its
  // own convId) actually receives this — using the direct parent would
  // route nested team-member events to the orchestrator sub-conv,
  // which has no UI listener.
  const bus = getBus();
  bus.emit("agent:spawn", {
    runId,
    agentRunId: runId,
    subConversationId: conversationId,
    agentName: config?.name ?? "Agent",
    agentConfigId: agentConfigId ?? "",
    task: content,
    parentConversationId: rootConversationId,
  });

  const agentName = config?.name ?? "Agent";
  const parentConversationId = rootConversationId;
  streamPromise.then(async () => {
    const leaf = await convQueries.getLatestLeaf(conversationId);
    const preview = leaf?.content?.slice(0, 200) ?? "";
    bus.emit("agent:complete", {
      runId,
      agentRunId: runId,
      subConversationId: conversationId,
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
      subConversationId: conversationId,
      agentName,
      agentConfigId: agentConfigId ?? "",
      success: false,
      resultPreview: err instanceof Error ? err.message.slice(0, 200) : "Unknown error",
      parentConversationId,
    });
  });

  return json({ status: "started", messageId: userMessage.id, runId });
}

/** Send a message to an authorized agent sub-conversation. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const body = await readAgentChatBody(request);
  if (body instanceof Response) return body;
  const scope = await authorizeAgentChat(params.id, user, locals);
  if (scope instanceof Response) return scope;
  // Keep the mode guard at the handler boundary, before any message or run
  // effect. It checks the same persisted row whose mode starts the run.
  // Only the messages route arms /goal; literal text here is not a command.
  const policyDenial = runStartPolicyDenial(locals.apiKeyToolPolicy, scope.subConv, {
    isGoalCommand: false,
  });
  if (policyDenial) {
    return errorJson(403, policyDenial.message, { field: policyDenial.field });
  }
  const leaf = await convQueries.getLatestLeaf(params.id);
  const userMessage = await convQueries.createMessage(params.id, {
    role: "user",
    content: body.content,
    parentMessageId: leaf?.id,
  });
  const executor = getExecutor();
  if (executor.getActiveRunForConversation(params.id)) {
    return steerOrQueueAgentChat(params.id, body.content, userMessage, executor);
  }
  return startAgentChat({
    conversationId: params.id,
    userId: user.id,
    body,
    scope,
    userMessage,
    executor,
    toolPolicy: locals.apiKeyToolPolicy,
  });
};
