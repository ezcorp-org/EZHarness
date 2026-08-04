import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import { listKBFiles, insertKBFile, updateKBFile, insertKBChunk } from "$server/db/queries/knowledge-base";
import { isAllowedFile, chunkText } from "$server/memory/chunking";
import { generateEmbedding } from "$server/memory/embeddings";
import { requireAuth } from "$server/auth/middleware";
import { uploadKBFileSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { checkStorageQuota } from "$lib/server/security/resource-quotas";
import { requireScope } from "$lib/server/security/api-keys";
import { logger } from "$server/logger";

const log = logger.child("api.knowledge-base");

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) {
    return errorJson(400, "projectId query parameter required");
  }

  const files = await listKBFiles(projectId);
  // ── KB-SHARED-NULL-OWNER — canonical rationale; do NOT "fail closed" here ──
  //
  // `userId IS NULL` means SHARED, not orphaned. An ownerless KB file is
  // readable by every authenticated caller **on purpose**, and that is the
  // platform's only sharing mechanism for the knowledge base.
  //
  // This predicate is one half of a TWO-SIDED contract. The other half is the
  // identical check in `[id]/+server.ts` (GET). They are ONE invariant and must
  // move together or not at all:
  //   - tightening detail alone → a row the user sees in the list and cannot
  //     open (list-but-404);
  //   - tightening list alone → a row that is fetchable by id but invisible.
  // `src/__tests__/security/kb-ownerless-rows-are-shared.test.ts` asserts
  // list-visibility and detail-reachability agree row-for-row, for every
  // caller, so the two sides cannot drift apart.
  //
  // Why NULL is read as "shared" rather than "orphaned":
  //   1. It cannot arise by accident, and it does not linger by accident either.
  //      `POST` (below) always stamps `userId: user.id`, so no upload can mint
  //      an ownerless row — and `src/db/migrate.ts` actively RECLAIMS them:
  //      every boot runs `UPDATE knowledge_base_files SET user_id = (first
  //      admin) WHERE user_id IS NULL`. A row that is ownerless at read time is
  //      therefore something an operator put there deliberately since the last
  //      boot (or an instance with no admin user at all) — never drift.
  //   2. There is nothing else to say it with. The platform has no
  //      project-membership model, so per-file `userId` is the ONLY access axis
  //      KB reads have; a null owner IS "shared with the project".
  //   3. Retrieval already reads it that way. `searchKBChunks`
  //      (`src/db/queries/knowledge-base.ts`) filters only on `project_id` +
  //      `status = 'ready'` — never on `user_id` — so an ownerless file's chunks
  //      are already injected into every project member's chat turn. Hiding the
  //      row from the API would not hide the content; it would only make the UI
  //      disagree with the prompt the model actually sees.
  //
  // KNOWN LIMIT (not a licence to tighten this predicate): because of the
  // reclaim in (1), sharing does NOT survive a restart — the next boot adopts
  // the row to the first admin and it silently stops being shared. The read
  // rule below is correct; making shared files durable is a separate decision
  // about that migration, and needs a human. Documented in
  // docs/features/chat/knowledge-base.md.
  //
  // Sharing is READ-ONLY. Writes stay fail-closed on the same rows: `DELETE`
  // of a null-owner file is admin-only (sec-H3, `[id]/+server.ts`). "Everyone
  // may read it" must never be widened into "anyone may destroy it".
  const userFiles = files.filter(f => !f.userId || f.userId === user.id);
  return json(userFiles);
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "write");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const rawProjectId = formData.get("projectId") as string | null;

  const result = uploadKBFileSchema.safeParse({ projectId: rawProjectId });
  if (!result.success) {
    return validationError(result.error);
  }

  const { projectId } = result.data;

  // Check storage quota before processing upload
  const existingFiles = await listKBFiles(projectId);
  const userFiles = existingFiles.filter(f => !f.userId || f.userId === user.id);
  const quota = await checkStorageQuota(user.id, "KnowledgeBase", userFiles.length);
  if (!quota.allowed) {
    return errorJson(429, "Knowledge base file limit reached");
  }

  if (!file) {
    return errorJson(400, "file is required");
  }

  if (!isAllowedFile(file.name)) {
    return errorJson(400, `File type not allowed: ${file.name}`);
  }

  if (file.size > MAX_FILE_SIZE) {
    return errorJson(400, `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
  }

  // Read file text eagerly before the response lifecycle ends
  const text = await file.text();

  // Insert file record with "processing" status
  let kbFile;
  try {
    kbFile = await insertKBFile({
      projectId,
      filename: file.name,
      mimeType: file.type || "text/plain",
      fileSize: file.size,
      status: "processing",
      userId: user.id,
    });
  } catch (err) {
    log.error("failed to insert file record", {
      error: err instanceof Error ? err.message : String(err),
      projectId,
      filename: file.name,
    });
    return errorJson(500, "Failed to create file record");
  }

  // Process async: chunk and embed (fire-and-forget)
  const fileId = kbFile.id;
  (async () => {
    try {
      const chunks = chunkText(text);

      for (const chunk of chunks) {
        const embedding = await generateEmbedding(chunk.content);
        await insertKBChunk({
          fileId,
          content: chunk.content,
          chunkIndex: chunk.index,
          embedding,
        });
      }

      await updateKBFile(fileId, { status: "ready", chunkCount: chunks.length });
    } catch (err) {
      log.error("file processing failed", {
        error: err instanceof Error ? err.message : String(err),
        fileId,
      });
      await updateKBFile(fileId, { status: "error" }).catch(() => {});
    }
  })();

  return json({ id: kbFile.id, status: "processing" }, { status: 201 });
};
