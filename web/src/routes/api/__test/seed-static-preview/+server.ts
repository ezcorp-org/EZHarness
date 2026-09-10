/**
 * Test-only static-preview fixture. It creates the same registry row and
 * jailed site tree that the preview dispatcher reads, then returns a one-time
 * handoff code for the authenticated test user.
 */
import crypto from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { createConversation } from "$server/db/queries/conversations";
import {
  createPreviewSession,
  getPreviewByIdRaw,
  previewSitesRoot,
  revokePreview,
} from "$server/db/queries/preview-sessions";
import { createProject } from "$server/db/queries/projects";
import { isTestSurfaceEnabled } from "$server/test-surface";
import { mintOneTimeCode } from "$server/runtime/preview/preview-token";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const user = requireAuth(locals);
  const nonce = crypto.randomUUID();
  const project = await createProject({
    name: `Static preview ${nonce.slice(0, 8)}`,
    path: join(tmpdir(), `ezcorp-static-preview-${nonce}`),
  });
  const conversation = await createConversation(project.id, {
    title: "Static preview fixture",
    userId: user.id,
  });
  const staticPath = join(previewSitesRoot(), nonce);
  await mkdir(staticPath, { recursive: true });
  await writeFile(join(staticPath, "index.html"), "<!doctype html><title>E2E static preview</title><h1>E2E static preview</h1>");
  const preview = await createPreviewSession({
    userId: user.id,
    conversationId: conversation.id,
    kind: "static",
    staticPath,
  });
  return json({
    previewId: preview.id,
    code: mintOneTimeCode({ previewId: preview.id, userId: user.id }),
  });
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!isTestSurfaceEnabled()) return errorJson(404, "Not found");
  const user = requireAuth(locals);
  const body = (await request.json().catch(() => ({}))) as { previewId?: unknown };
  if (typeof body.previewId !== "string") return errorJson(400, "`previewId` is required");
  const preview = await getPreviewByIdRaw(body.previewId);
  if (!preview || preview.userId !== user.id) return errorJson(404, "Not found");
  await revokePreview(preview.id, user.id);
  const root = previewSitesRoot();
  if (preview.staticPath?.startsWith(`${root}${sep}`)) {
    await rm(preview.staticPath, { recursive: true, force: true });
  }
  return json({ ok: true });
};
