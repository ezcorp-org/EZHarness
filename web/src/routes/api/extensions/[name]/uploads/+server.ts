import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import * as convQueries from "$server/db/queries/conversations";
import * as attachmentsDb from "$server/db/queries/attachments";
import { getProject } from "$server/db/queries/projects";
import { getExtensionByName } from "$server/db/queries/extensions";
import { getConversationExtensionIds } from "$server/db/queries/conversation-extensions";
import { writeAttachment } from "$server/chat/attachments/storage";
import type { AuthUser } from "$server/auth/types";

// ── /api/extensions/[name]/uploads — extension-authored binary uploads ──
//
// Accepts a single audio blob from a card belonging to the calling
// extension. The blob is persisted into the same on-disk store as
// regular message attachments and a `message_attachments` row is
// created pointing at a caller-supplied `messageId` — that message
// MUST already exist (the subprocess calls `ezcorp/append-message`
// FIRST to mint a message id, then uploads to it; option (c) in the
// approved plan).
//
// Auth ladder mirrors `messages/+server.ts:113-115`:
//   1. `requireScope(locals, "chat")`
//   2. `requireAuth(locals)`
//   3. The `[name]` extension must exist + be enabled
//   4. The extension must be wired to `conversationId` (same wiring
//      table the event route + reverse-RPC handlers consult)
//   5. The extension must declare `appendMessages` permission
//   6. The active user must own the conversation
//   7. The supplied `messageId` must belong to the same conversation
//      AND be authored by THIS extension (role:"extension")
//   8. MIME whitelist (audio only for v1)
//   9. Size cap

const NAME_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

/**
 * Allowed upload MIME types for v1. Locked to lossless WAV + lossy MP3
 * because the only consumer today (kokoro-tts) emits WAV; MP3 is
 * accepted because browsers can natively decode it and a future TTS
 * voice may prefer the smaller encoding. `audio/x-wav` and
 * `audio/wave` are accepted as canonical aliases — both Bun's
 * multipart parser and some real browsers normalize `audio/wav` into
 * one of these RFC 2046 historical forms; rejecting them would surface
 * as "browser-encoded blob silently fails" in production. JPEG/PNG/etc.
 * are out of scope — extensions that need image uploads must motivate
 * widening this list with a permission-flag review.
 */
const ALLOWED_MIMES: ReadonlySet<string> = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
]);

/**
 * 25 MB cap. Kokoro's 30-second 24 kHz mono WAV clip is ~1 MB; 25 MB
 * gives generous headroom for a longer message AND covers an MP3
 * encode of the same. Larger uploads are rejected with 413 to match
 * the messages POST cap shape.
 */
const MAX_BYTES = 25 * 1024 * 1024;

async function verifyConversationOwnership(id: string, user: AuthUser) {
  const conv = await convQueries.getConversation(id);
  if (!conv) return null;
  if (conv.userId !== user.id && user.role !== "admin") return null;
  return conv;
}

export const POST: RequestHandler = async ({ request, locals, params }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const name = params.name;
  if (!name || !NAME_REGEX.test(name)) return errorJson(404, "Not found");

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return errorJson(400, "multipart/form-data required");
  }

  const form = await request.formData().catch(() => null);
  if (!form) return errorJson(400, "Invalid multipart body");

  const file = form.get("file");
  const conversationId = form.get("conversationId");
  const messageId = form.get("messageId");

  if (!(file instanceof File)) return errorJson(400, "file is required");
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    return errorJson(400, "conversationId is required");
  }
  if (typeof messageId !== "string" || messageId.length === 0) {
    return errorJson(400, "messageId is required");
  }

  // Conversation ownership FIRST — never leak existence of unrelated
  // resources. 404 (not 403) on miss, mirrors messages/+server.ts.
  const conv = await verifyConversationOwnership(conversationId, user);
  if (!conv) return errorJson(404, "Not found");

  // Extension lookup. Returns null when the name is unknown OR the
  // extension is disabled — both produce the opaque 404.
  const ext = await getExtensionByName(name);
  if (!ext || !ext.enabled) return errorJson(404, "Not found");

  // Extension must be wired to this conversation. The append-message
  // reverse-RPC enforces the same wiring rule on the subprocess side;
  // mirroring it here closes a forgery surface where a user with
  // multiple conversations could upload to the wrong one.
  const wiredIds = await getConversationExtensionIds(conversationId);
  if (!wiredIds.includes(ext.id)) return errorJson(404, "Not found");

  // Manifest must declare `appendMessages`. Without the matching
  // permission the upload would never be linked into a turn (the
  // append-message handler would refuse), so we fail fast here.
  const grantedPerms = ext.grantedPermissions as { appendMessages?: { excludedDefault: boolean } } | null;
  if (!grantedPerms?.appendMessages) {
    return errorJson(403, "Extension lacks appendMessages permission");
  }

  // Validate the supplied messageId. Must be an existing row in the
  // same conversation, authored as role:"extension". This is the
  // "option (c)" guarantee from the plan: the subprocess called
  // `ezcorp/append-message` first to mint this id; the card uploads
  // to it; the host re-keys nothing.
  const allMessages = await convQueries.getMessages(conversationId);
  const targetMsg = allMessages.find((m) => m.id === messageId);
  if (!targetMsg) return errorJson(404, "Not found");
  if (targetMsg.role !== "extension") {
    return errorJson(403, "messageId must belong to an extension-authored turn");
  }

  // MIME validation. We trust the caller's claimed MIME (no magic-byte
  // sniff yet — File.type is set by the browser from the Blob the card
  // built; the upload route already runs server-side after auth). A
  // future tightening should add a magic-byte check via the same
  // validator path as messages/+server.ts.
  const claimedMime = (file.type || "application/octet-stream").split(";")[0]!.trim();
  if (!ALLOWED_MIMES.has(claimedMime)) {
    return errorJson(400, `MIME ${claimedMime} not allowed (audio/wav, audio/mpeg only)`, { code: "UNSUPPORTED_MIME" });
  }

  // Size cap. Read the file into a buffer once — we need the bytes
  // for both the size check and the disk write.
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) {
    return errorJson(413, `File too large (max ${MAX_BYTES} bytes)`, { code: "TOO_LARGE" });
  }
  if (bytes.byteLength === 0) {
    return errorJson(400, "file is empty");
  }

  const project = await getProject(conv.projectId);
  if (!project?.path) {
    return errorJson(500, "Project path not resolvable for attachment storage");
  }

  const written = await writeAttachment({
    projectRoot: project.path,
    conversationId,
    messageId,
    filename: file.name || "audio",
    mimeType: claimedMime,
    bytes,
  });

  const row = await attachmentsDb.insertAttachment({
    messageId,
    conversationId,
    filename: file.name || "audio",
    mimeType: claimedMime,
    sizeBytes: written.sizeBytes,
    storagePath: written.storagePath,
    kind: "audio",
  });

  return json({ attachmentId: row.id });
};
