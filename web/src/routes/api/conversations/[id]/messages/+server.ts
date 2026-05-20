import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { logger } from "$server/logger";
import * as convQueries from "$server/db/queries/conversations";
import * as attachmentsDb from "$server/db/queries/attachments";
import { getProject } from "$server/db/queries/projects";
import { requireAuth } from "$server/auth/middleware";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { getExecutor, getGoalHost } from "$lib/server/context";
import { createMessageSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { checkTokenBudget } from "$lib/server/security/resource-quotas";
import { requireScope } from "$lib/server/security/api-keys";
import { getCapabilitiesWithExtensions, classifyMimeWithCaps } from "$server/providers/model-capabilities";
import {
  getConversationExtensionMimes,
  getExtensionMimesByNames,
} from "$server/db/queries/conversation-extensions";
import { parseMentions } from "$lib/mention-logic";
import { stripEzActionTokens } from "$server/runtime/mention-wiring";
import { getEzAction } from "$server/runtime/ez-actions/registry";
import type { EzActionResult } from "$server/runtime/ez-actions/types";
import { isGoalCommand, parseGoalCommand } from "$server/runtime/goal-host";
import { validateAttachment } from "$server/chat/attachments/validator";
import { writeAttachment, deleteForMessage } from "$server/chat/attachments/storage";
import type { StagedAttachment } from "$server/chat/attachments/content-builder";
import type { AttachmentSummary } from "$server/db/queries/conversations";
import { buildCommandResolver } from "$lib/server/command-resolver";
import type { RequestHandler } from "./$types";

const log = logger.child("api.messages");

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conversationId = params.id;

  // Ownership resolves against the ROOT of the parentConversationId
  // chain (sub-convs carry userId=null). For a top-level conversation
  // root === self, so this is identical to the previous direct
  // conv.userId check — pinned by messages-ownership-baseline-api.test.ts.
  // GET reads only by `conversationId` (it never needs the conv row
  // itself), so we discard the resolved pair and keep just the gate —
  // matching the pre-Phase-2 behaviour where the returned conv was
  // unused on this handler.
  const ownership = await resolveRootConversationForOwnership(conversationId, user);
  if (!ownership) return errorJson(404, "Not found");

  const leafMessageId = url.searchParams.get("leafMessageId");
  const all = url.searchParams.get("all");

  if (all === "true") {
    return json(await convQueries.getMessages(conversationId));
  }

  if (leafMessageId) {
    return json(await convQueries.getConversationPath(leafMessageId, conversationId));
  }

  if (url.searchParams.get("withToolCalls") === "true") {
    const base = await convQueries.getMessagesWithToolCalls(conversationId);
    const subConversationToolCalls = await convQueries.getSubConversationToolCalls(conversationId);
    return json({ ...base, subConversationToolCalls });
  }

  const leaf = await convQueries.getLatestLeaf(conversationId);
  if (!leaf) return json([]);

  return json(await convQueries.getConversationPath(leaf.id, conversationId));
};

interface ParsedBody {
  content: string;
  provider?: string;
  model?: string;
  parentMessageId?: string;
  editOf?: string;
  permissionMode?: "ask" | "auto-edit" | "yolo";
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  files: File[];
}

function coerceEnum<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

async function parseMultipart(request: Request): Promise<{ ok: true; body: ParsedBody } | { ok: false; error: string }> {
  const form = await request.formData();
  const content = form.get("content");
  if (typeof content !== "string" || content.length === 0 || content.length > 100_000) {
    return { ok: false, error: "content is required and must be 1-100000 chars" };
  }
  const files = form.getAll("files").filter((v): v is File => v instanceof File);
  const str = (k: string) => { const v = form.get(k); return typeof v === "string" && v.length > 0 ? v : undefined; };
  return {
    ok: true,
    body: {
      content,
      provider: str("provider"),
      model: str("model"),
      parentMessageId: str("parentMessageId"),
      editOf: str("editOf"),
      permissionMode: coerceEnum(form.get("permissionMode"), ["ask", "auto-edit", "yolo"] as const),
      thinkingLevel: coerceEnum(form.get("thinkingLevel"), ["off", "minimal", "low", "medium", "high", "xhigh"] as const),
      files,
    },
  };
}

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conversationId = params.id;

  // Same root-walk ownership as GET. `ownership.conv` (self) drives all
  // conversation-scoped reads (provider/model/projectId/agentConfigId/
  // modeId) — the root only gates access. Top-level convs are unaffected
  // (root === self); the win is a non-admin ROOT owner can now POST into
  // a userId=null sub-conversation they own.
  const ownership = await resolveRootConversationForOwnership(conversationId, user);
  if (!ownership) return errorJson(404, "Not found");
  const conv = ownership.conv;

  const budget = await checkTokenBudget(user.id);
  if (!budget.allowed) {
    return errorJson(429, "Daily token budget exceeded", { resetsAt: budget.resetsAt });
  }

  const contentType = request.headers.get("content-type") ?? "";
  const isMultipart = contentType.startsWith("multipart/form-data");

  let body: ParsedBody;
  if (isMultipart) {
    const parsed = await parseMultipart(request);
    if (!parsed.ok) return errorJson(400, parsed.error);
    body = parsed.body;
  } else {
    const result = createMessageSchema.safeParse(await request.json());
    if (!result.success) return validationError(result.error);
    body = { ...result.data, files: [] };
  }

  // ── /goal: FR-13b lazy GoalRecord rehydrate ───────────────────────
  // Unconditionally run BEFORE the slash-prefix interceptor AND BEFORE
  // `streamChat`. Rebuilds the in-memory `GoalRecord` from
  // `metadata.goal` for conversations whose record was lost across a
  // restart (or created post-boot). The `isGoalCmd` flag suppresses
  // the paused→active flip when the POST is itself a `/goal …` command
  // (I5d) — the parsed subcommand owns resume/clear/replace.
  const goalIsCmd = isGoalCommand(body.content);
  const goalHost = getGoalHost();
  if (goalHost) {
    try {
      await goalHost.ensureGoalRecordRehydrated(conversationId, goalIsCmd);
    } catch (err) {
      log.warn("goal-host rehydrate failed (continuing)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let parentMessageId = body.parentMessageId;
  if (body.editOf) {
    const allMessages = await convQueries.getMessages(conversationId);
    const editedMsg = allMessages.find((m) => m.id === body.editOf);
    if (editedMsg) parentMessageId = editedMsg.parentMessageId ?? undefined;
  } else if (parentMessageId === undefined) {
    // No explicit parent and not an edit → continue the conversation's
    // main thread. Anchoring to the latest real leaf (instead of leaving
    // it null → a root-level branch) closes the race where the composer
    // re-enables the instant a stream ends but `activeLeafId` still
    // points at the soon-to-be-replaced `streaming-<runId>` placeholder:
    // a fast follow-up used to fork a spurious side thread. The first
    // message in a conversation has no leaf → stays root, as before.
    const leaf = await convQueries.getLatestLeaf(conversationId, {
      excludeCapabilityEvents: true,
    });
    if (leaf) parentMessageId = leaf.id;
  }

  // Resolve the effective provider/model early so we can validate files
  // against the model we're about to actually call.
  const provider = body.provider ?? conv.provider ?? undefined;
  const model = body.model ?? conv.model ?? undefined;

  // ── Attachment pipeline ──────────────────────────────────────────
  const stagedAttachments: StagedAttachment[] = [];
  const attachmentSummaries: AttachmentSummary[] = [];
  let userMessage: Awaited<ReturnType<typeof convQueries.createMessage>> | null = null;

  if (body.files.length > 0) {
    if (!provider || !model) {
      return errorJson(400, "provider and model are required when attaching files");
    }
    // Two MIME sources: extensions ALREADY wired to the conversation, plus
    // any `!ext:NAME` mentions in this message's draft text (which will be
    // wired server-side later in the same request lifecycle but aren't yet
    // in `conversation_extensions`). Without the second source, the very
    // first message that wires an extension can't carry an attachment for
    // it — even though the picker accepted the file.
    const mimeSet = new Set<string>();
    try {
      for (const m of await getConversationExtensionMimes(conversationId)) mimeSet.add(m);
    } catch { /* non-fatal: fall back to static caps */ }
    const pendingExtNames = parseMentions(body.content)
      .filter((m) => m.kind === "ext")
      .map((m) => m.name);
    if (pendingExtNames.length > 0) {
      try {
        for (const m of getExtensionMimesByNames(pendingExtNames)) mimeSet.add(m);
      } catch { /* non-fatal */ }
    }
    const caps = getCapabilitiesWithExtensions(provider, model, [...mimeSet]);
    if (body.files.length > caps.maxFilesPerMessage) {
      return errorJson(400, `Too many files (max ${caps.maxFilesPerMessage})`, { code: "TOO_MANY_FILES" });
    }

    const project = await getProject(conv.projectId);
    if (!project?.path) {
      return errorJson(500, "Project path not resolvable for attachment storage");
    }

    // Pre-validate all files before writing anything to disk or DB. A single
    // bad file rejects the whole batch — no partial state.
    const validated: Array<{ bytes: Uint8Array; canonicalMime: string; file: File }> = [];
    for (const file of body.files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // FormData sometimes reports MIME with charset (e.g. "text/plain;charset=utf-8");
      // strip parameters so the whitelist check works on the bare type.
      const claimedMime = (file.type || "application/octet-stream").split(";")[0]!.trim();
      const res = await validateAttachment(bytes, claimedMime, caps);
      if (!res.ok) {
        const status = res.code === "TOO_LARGE" ? 413 : 400;
        return errorJson(status, `File "${file.name}" rejected: ${res.code}`, { code: res.code, file: file.name, detail: res });
      }
      validated.push({ bytes, canonicalMime: res.canonicalMime, file });
    }

    // All validated — persist user message row, then attachments.
    userMessage = await convQueries.createMessage(conversationId, {
      role: "user",
      content: body.content,
      parentMessageId,
    });

    try {
      for (const v of validated) {
        const kind = classifyMimeWithCaps(caps, v.canonicalMime);
        if (!kind) throw new Error(`Unclassifiable MIME ${v.canonicalMime} after validation`);
        const written = await writeAttachment({
          projectRoot: project.path,
          conversationId,
          messageId: userMessage.id,
          filename: v.file.name,
          mimeType: v.canonicalMime,
          bytes: v.bytes,
        });
        const row = await attachmentsDb.insertAttachment({
          messageId: userMessage.id,
          conversationId,
          filename: v.file.name,
          mimeType: v.canonicalMime,
          sizeBytes: written.sizeBytes,
          storagePath: written.storagePath,
          kind,
        });
        stagedAttachments.push({
          id: row.id,
          filename: v.file.name,
          mimeType: v.canonicalMime,
          storagePath: written.storagePath,
        });
        attachmentSummaries.push({
          id: row.id,
          filename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          kind: row.kind,
        });
      }
    } catch (err) {
      // Best-effort rollback: remove disk files + attachment rows for this msg.
      await deleteForMessage({ projectRoot: project.path, conversationId, messageId: userMessage.id }).catch(() => {});
      await attachmentsDb.deleteAttachmentsForMessage(userMessage.id).catch(() => {});
      return errorJson(500, "Failed to persist attachments", { detail: String(err) });
    }
  } else {
    userMessage = await convQueries.createMessage(conversationId, {
      role: "user",
      content: body.content,
      parentMessageId,
    });
  }

  // ── /goal slash-prefix interceptor (PRD §7.2.1, FR-1/2) ───────────
  //
  // NEW non-nullary mechanism. NOT an EZ-action (`stripEzActionTokens`
  // matches only `![EZ:name]`; `EzAction.handler` is nullary + card-
  // only). Sits at the same route position as the EZ scan but is a
  // distinct dispatch with its own return paths:
  //
  //   - `kind:"card"` (status / clear / >4000 reject): persist a
  //     `role:"ez-action-result"` row (FR-19 — row convention only,
  //     NOT the EZ short-circuit at the next block), then return the
  //     `runId:null` card payload. The goal-host's `handleGoalCommand`
  //     itself persists the row; we just surface it in the response.
  //   - `kind:"start-turn"` (set): the goal-host has already written
  //     `metadata.goal`, created the in-memory `GoalRecord`, and
  //     emitted `goal:update {state:"active"}`. We DO NOT return — we
  //     fall through to the existing `streamChat` call so set behaves
  //     exactly like a normal user turn (FR-2-SET / FR-2-RET), with
  //     `body.content` (the literal `/goal <condition>` text) as the
  //     turn's input message.
  //
  // The handler is gated on the canonical `isGoalCommand` predicate
  // (the `/goal` token followed by EOS / whitespace — `/goalpost`
  // does NOT match). FR-13b's `ensureGoalRecordRehydrated` already
  // ran above (~line 145) so the in-memory record is in sync with
  // `metadata.goal` before we dispatch.
  const goalResultMessages: Array<{ id: string; role: string; content: string }> = [];
  if (goalIsCmd) {
    const parsed = parseGoalCommand(body.content);
    if (!goalHost) {
      // EZCORP_GOAL_ENABLED off OR init raced. Surface a disabled card
      // by hand-rolling the same shape `handleGoalCommand` would have
      // returned — keep the route forgiving rather than crashing chat.
      const disabledCard: EzActionResult = {
        kind: "decline",
        card: {
          title: "/goal disabled",
          body: "The /goal feature is disabled on this server.",
          variant: "warning",
        },
      };
      const row = await convQueries.createMessage(conversationId, {
        role: "ez-action-result",
        content: JSON.stringify(disabledCard),
        parentMessageId: userMessage.id,
      });
      return json({
        userMessage: attachmentSummaries.length > 0
          ? { ...userMessage, attachments: attachmentSummaries }
          : userMessage,
        runId: null,
        attachments: attachmentSummaries,
        ezActionResults: [{ id: row.id, role: row.role, content: row.content }],
      });
    }
    const dispatch = await goalHost.handleGoalCommand({
      subcommand: parsed.subcommand,
      ...(parsed.condition !== undefined ? { condition: parsed.condition } : {}),
      conversationId,
      userId: user.id,
      projectId: conv.projectId,
      userMessageId: userMessage.id,
    });
    if (dispatch.kind === "card") {
      // The goal-host returns the persisted row metadata directly
      // (status/clear/reject persist; disabled doesn't — `row:null`).
      // When persist failed mid-call the route surfaces the card
      // inline with a synthetic id so the SSE/UI handlers see a
      // consistent shape.
      const echo = dispatch.row ?? {
        id: crypto.randomUUID(),
        role: "ez-action-result",
        content: JSON.stringify(dispatch.result),
      };
      goalResultMessages.push(echo);
      return json({
        userMessage: attachmentSummaries.length > 0
          ? { ...userMessage, attachments: attachmentSummaries }
          : userMessage,
        runId: null,
        attachments: attachmentSummaries,
        ezActionResults: goalResultMessages,
      });
    }
    // kind === "start-turn" → fall through to the normal streamChat
    // path below; the persisted user row already carries the literal
    // `/goal <condition>` text for history fidelity (FR-2-RET).
  }

  // ── EZ Actions dispatch (Phase 3.3) ────────────────────────────
  // Scan for `![EZ:*]` tokens, fire each action's handler in-process,
  // and persist a synthetic `ez-action-result` message per outcome.
  // The actions run BEFORE streamChat so an action-only message
  // (`stripEzActionTokens(...).stripped.trim() === ""`) can short-
  // circuit the LLM call entirely — no assistant turn fires for a
  // pure side-channel invocation. Mixed messages still get the LLM
  // call (with the tokens stripped from the prompt by build-prompt's
  // own `stripEzActionTokens` pass).
  //
  // Action handlers' OWN auth gates (ownerId match, settings flag)
  // re-verify per-action; this layer only resolves the action by
  // name and passes the conversation context. Unknown action names
  // are silent no-ops (no error message persisted) — mirrors how
  // `applyCommandExpansion` handles unknown slash commands.
  const ezStrip = stripEzActionTokens(body.content);
  const ezResultMessages: Array<{
    id: string;
    role: string;
    content: string;
  }> = [];
  for (const ref of ezStrip.actions) {
    const action = getEzAction(ref.name);
    if (!action) continue; // silent strip; matches command/feature behavior
    let result: EzActionResult;
    try {
      result = await action.handler({
        conversationId,
        userId: user.id,
        projectId: conv.projectId,
      });
    } catch (err) {
      // A handler that throws (rather than returning an `error`
      // result) is a bug; capture it as an error result so the user
      // still sees a card and the conversation history shows what
      // happened.
      log.error("EZ action handler threw", { name: ref.name, error: String(err) });
      result = {
        kind: "error",
        card: {
          title: "Action failed",
          body: `The "${ref.name}" action threw an unexpected error.`,
          variant: "error",
        },
      };
    }
    const persisted = await convQueries.createMessage(conversationId, {
      role: "ez-action-result",
      content: JSON.stringify(result),
      parentMessageId: userMessage.id,
    });
    ezResultMessages.push({
      id: persisted.id,
      role: persisted.role,
      content: persisted.content,
    });
  }

  // No-LLM mode: action-only message → return without streamChat. The
  // user message is already persisted (with the original tokens for
  // history fidelity); the action results are in `ezResultMessages`;
  // no assistant turn is created so the UI never shows a "Thinking..."
  // skeleton.
  if (ezStrip.actions.length > 0 && ezStrip.stripped.trim().length === 0) {
    log.debug("EZ action-only message — skipping LLM call", {
      actions: ezStrip.actions.map((a) => a.name),
    });
    const userMessageWithAttachmentsAo =
      attachmentSummaries.length > 0
        ? { ...userMessage, attachments: attachmentSummaries }
        : userMessage;
    return json({
      userMessage: userMessageWithAttachmentsAo,
      runId: null,
      attachments: attachmentSummaries,
      ezActionResults: ezResultMessages,
    });
  }

  const executor = getExecutor();
  const runId = crypto.randomUUID();

  log.debug("streamChat starting", {
    content: body.content.slice(0, 120),
    attachments: stagedAttachments.length,
    projectId: conv.projectId,
    modeId: conv.modeId,
  });

  const streamPromise = executor.streamChat(conversationId, body.content, {
    projectId: conv.projectId,
    provider,
    model,
    runId,
    parentMessageId: userMessage.id,
    agentConfigId: conv.agentConfigId ?? undefined,
    modeId: conv.modeId ?? undefined,
    permissionMode: body.permissionMode,
    thinkingLevel: body.thinkingLevel,
    attachments: stagedAttachments.length > 0 ? stagedAttachments : undefined,
    commandResolver: buildCommandResolver(user.id, conv.projectId),
  });

  streamPromise.catch((err) => {
    log.error("streamChat error", { error: err instanceof Error ? err.message : String(err) });
  });

  const userMessageWithAttachments =
    attachmentSummaries.length > 0
      ? { ...userMessage, attachments: attachmentSummaries }
      : userMessage;
  return json({
    userMessage: userMessageWithAttachments,
    runId,
    attachments: attachmentSummaries,
    // Mixed messages (action + prose) — `ezActionResults` is empty
    // when the user message had no `![EZ:…]` tokens, so callers can
    // unconditionally consume the field without conditionals.
    ezActionResults: ezResultMessages,
  });
};
