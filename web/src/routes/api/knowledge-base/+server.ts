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
  // Filter to user's files (KB files with userId set must match)
  const userFiles = files.filter(f => !f.userId || f.userId === user.id);
  return json(userFiles);
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "read");
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
    console.error("[api/knowledge-base] Failed to insert file record:", err);
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
      console.error("[api/knowledge-base] Processing failed:", err);
      await updateKBFile(fileId, { status: "error" }).catch(() => {});
    }
  })();

  return json({ id: kbFile.id, status: "processing" }, { status: 201 });
};
