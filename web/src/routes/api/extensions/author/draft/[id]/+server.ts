/**
 * `/api/extensions/author/draft/[id]` — PUT (save edits) + DELETE (discard).
 *
 * Owner-scoped (`getDraft(id, userId)`). The path-allowlist enforces
 * the scaffolder's known file keys; anything else → 400. The DELETE
 * removes the draft directory AND consumes the row.
 */

import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import {
  discardDraftAndDir,
  getDraft,
  getExtensionAuthorDraftDir,
} from "$server/db/queries/ez-drafts";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RequestHandler } from "./$types";

const ALLOWED_FILES = new Set([
  "ezcorp.config.ts",
  "index.ts",
  "index.test.ts",
  "README.md",
  "package.json",
  "tsconfig.json",
  ".gitignore",
]);

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  try {
    const scopeErr = requireScope(locals, "chat");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);

    const draftId = params.id;
    if (!draftId) return errorJson(400, "Draft id is required");
    if (!/^[a-zA-Z0-9_-]+$/.test(draftId)) return errorJson(400, "Invalid draftId");

    const row = await getDraft(draftId, user.id);
    if (!row) return errorJson(404, "Draft not found, expired, or not owned by the requesting user");
    if (row.kind !== "extension") return errorJson(400, "Draft is not an extension draft");

    let body: { path?: unknown; content?: unknown };
    try {
      body = (await request.json()) as { path?: unknown; content?: unknown };
    } catch {
      return errorJson(400, "Invalid JSON body");
    }
    if (typeof body.path !== "string") return errorJson(400, "`path` must be a string");
    if (typeof body.content !== "string") return errorJson(400, "`content` must be a string");
    if (!ALLOWED_FILES.has(body.path)) {
      return errorJson(400, `Path "${body.path}" not in scaffolder file allowlist`);
    }
    if (body.path.includes("..") || body.path.startsWith("/")) {
      return errorJson(400, "Path must be a relative file name");
    }

    const dir = getExtensionAuthorDraftDir(draftId, user.id);
    if (!existsSync(dir)) return errorJson(404, "Draft directory does not exist");

    const target = join(dir, body.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body.content, "utf8");
    return json({ ok: true, path: body.path });
  } catch (e) {
    if (e instanceof Response) return e;
    return errorJson(500, e instanceof Error ? e.message : "PUT failed");
  }
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  try {
    const scopeErr = requireScope(locals, "chat");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);

    const draftId = params.id;
    if (!draftId) return errorJson(400, "Draft id is required");
    if (!/^[a-zA-Z0-9_-]+$/.test(draftId)) return errorJson(400, "Invalid draftId");

    const row = await getDraft(draftId, user.id);
    if (!row) return errorJson(404, "Draft not found, expired, or not owned by the requesting user");

    await discardDraftAndDir(draftId, user.id);
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof Response) return e;
    return errorJson(500, e instanceof Error ? e.message : "DELETE failed");
  }
};

/**
 * Test-only export: read the file map for a draft from disk. Used by
 * `web/src/__tests__/extension-author-page-logic.test.ts`. Mirrors the
 * `+page.server.ts` load() reader.
 */
export function _readDraftFiles(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const files: Record<string, string> = {};
  for (const name of ALLOWED_FILES) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        files[name] = readFileSync(p, "utf8");
      } catch {
        // skip
      }
    }
  }
  return files;
}
