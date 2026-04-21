import { json } from "@sveltejs/kit";
import * as convQueries from "$server/db/queries/conversations";
import * as attachmentsDb from "$server/db/queries/attachments";
import { getProject } from "$server/db/queries/projects";
import { requireAuth } from "$server/auth/middleware";
import type { AuthUser } from "$server/auth/types";
import { getExecutor } from "$lib/server/context";
import { createMessageSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { checkTokenBudget } from "$lib/server/security/resource-quotas";
import { requireScope } from "$lib/server/security/api-keys";
import { getCapabilities, classifyMime } from "$server/providers/model-capabilities";
import { validateAttachment } from "$server/chat/attachments/validator";
import { writeAttachment, deleteForMessage } from "$server/chat/attachments/storage";
import type { StagedAttachment } from "$server/chat/attachments/content-builder";
import { buildCommandResolver } from "$lib/server/command-resolver";
import type { RequestHandler } from "./$types";

async function verifyConversationOwnership(id: string, user: AuthUser) {
  const conv = await convQueries.getConversation(id);
  if (!conv) return null;
  // sec-H3: fail-closed — unowned rows (null userId) are admin-only
  if (conv.userId !== user.id && user.role !== "admin") return null;
  return conv;
}

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conversationId = params.id;

  const conv = await verifyConversationOwnership(conversationId, user);
  if (!conv) return json({ error: "Not found" }, { status: 404 });

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

  const conv = await verifyConversationOwnership(conversationId, user);
  if (!conv) return json({ error: "Not found" }, { status: 404 });

  const budget = await checkTokenBudget(user.id);
  if (!budget.allowed) {
    return json({ error: "Daily token budget exceeded", resetsAt: budget.resetsAt }, { status: 429 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  const isMultipart = contentType.startsWith("multipart/form-data");

  let body: ParsedBody;
  if (isMultipart) {
    const parsed = await parseMultipart(request);
    if (!parsed.ok) return json({ error: parsed.error }, { status: 400 });
    body = parsed.body;
  } else {
    const result = createMessageSchema.safeParse(await request.json());
    if (!result.success) return validationError(result.error);
    body = { ...result.data, files: [] };
  }

  let parentMessageId = body.parentMessageId;
  if (body.editOf) {
    const allMessages = await convQueries.getMessages(conversationId);
    const editedMsg = allMessages.find((m) => m.id === body.editOf);
    if (editedMsg) parentMessageId = editedMsg.parentMessageId ?? undefined;
  }

  // Resolve the effective provider/model early so we can validate files
  // against the model we're about to actually call.
  const provider = body.provider ?? conv.provider ?? undefined;
  const model = body.model ?? conv.model ?? undefined;

  // ── Attachment pipeline ──────────────────────────────────────────
  let stagedAttachments: StagedAttachment[] = [];
  let userMessage: Awaited<ReturnType<typeof convQueries.createMessage>> | null = null;

  if (body.files.length > 0) {
    if (!provider || !model) {
      return json({ error: "provider and model are required when attaching files" }, { status: 400 });
    }
    const caps = getCapabilities(provider, model);
    if (body.files.length > caps.maxFilesPerMessage) {
      return json({ error: `Too many files (max ${caps.maxFilesPerMessage})`, code: "TOO_MANY_FILES" }, { status: 400 });
    }

    const project = await getProject(conv.projectId);
    if (!project?.path) {
      return json({ error: "Project path not resolvable for attachment storage" }, { status: 500 });
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
        return json({ error: `File "${file.name}" rejected: ${res.code}`, code: res.code, file: file.name, detail: res }, { status });
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
        const kind = classifyMime(v.canonicalMime);
        if (!kind) throw new Error(`Unclassifiable MIME ${v.canonicalMime} after validation`);
        const written = await writeAttachment({
          projectRoot: project.path,
          conversationId,
          messageId: userMessage.id,
          filename: v.file.name,
          mimeType: v.canonicalMime,
          bytes: v.bytes,
        });
        await attachmentsDb.insertAttachment({
          messageId: userMessage.id,
          conversationId,
          filename: v.file.name,
          mimeType: v.canonicalMime,
          sizeBytes: written.sizeBytes,
          storagePath: written.storagePath,
          kind,
        });
        stagedAttachments.push({
          filename: v.file.name,
          mimeType: v.canonicalMime,
          storagePath: written.storagePath,
        });
      }
    } catch (err) {
      // Best-effort rollback: remove disk files + attachment rows for this msg.
      await deleteForMessage({ projectRoot: project.path, conversationId, messageId: userMessage.id }).catch(() => {});
      await attachmentsDb.deleteAttachmentsForMessage(userMessage.id).catch(() => {});
      return json({ error: "Failed to persist attachments", detail: String(err) }, { status: 500 });
    }
  } else {
    userMessage = await convQueries.createMessage(conversationId, {
      role: "user",
      content: body.content,
      parentMessageId,
    });
  }

  const executor = getExecutor();
  const runId = crypto.randomUUID();

  console.log("[messages] streamChat starting", {
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
    console.error("[messages] streamChat error:", err instanceof Error ? err.message : err);
  });

  return json({ userMessage, runId, attachments: stagedAttachments });
};
