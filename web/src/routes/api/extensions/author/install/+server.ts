/**
 * `/api/extensions/author/install` — install an extension-author
 * draft as a real, user-installed extension (web-form path).
 *
 * The actual pipeline lives in the shared host module
 * `$server/extensions/author-install` (`installAuthoredDraft`) so this
 * route and the in-chat agent-driven install run the IDENTICAL secure
 * steps. This handler only owns HTTP concerns: auth/scope, `draftId`
 * shape validation, and mapping the typed `AuthorInstallError` back to
 * the status/body contract clients already depend on.
 *
 * The installed extension is `enabled: false` here (the user enables it
 * from the library) — `enable:false` is passed to the shared pipeline.
 */

import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import {
  installAuthoredDraft,
  AuthorInstallError,
} from "$server/extensions/author-install";
import { verifyExtension } from "$server/extensions/sdk/verify";
import type { RequestHandler } from "./$types";

/**
 * @internal Back-compat thin wrapper kept because the route's public
 * surface historically exported it. The deterministic gate now runs
 * inside `installAuthoredDraft`; this remains a stable entry point for
 * any external importer/test.
 */
export async function _verifyDraft(draftDir: string) {
  return verifyExtension({ extDir: draftDir });
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const scopeErr = requireScope(locals, "chat");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);

    let body: { draftId?: unknown };
    try {
      body = (await request.json()) as { draftId?: unknown };
    } catch {
      return errorJson(400, "Invalid JSON body");
    }
    if (typeof body.draftId !== "string") {
      return errorJson(400, "`draftId` must be a string");
    }
    const draftId = body.draftId;
    if (!/^[a-zA-Z0-9_-]+$/.test(draftId)) {
      return errorJson(400, "Invalid draftId");
    }

    try {
      const result = await installAuthoredDraft({
        draftId,
        userId: user.id,
        enable: false,
      });
      return json(
        { extensionId: result.extensionId, redirectUrl: result.redirectUrl },
        { status: 201 },
      );
    } catch (e) {
      if (!(e instanceof AuthorInstallError)) throw e;
      const d = e.details ?? {};
      switch (e.code) {
        case "DRAFT_NOT_FOUND":
        case "DRAFT_DIR_MISSING":
          return errorJson(404, e.message);
        case "NOT_EXTENSION_DRAFT":
          return errorJson(400, e.message);
        case "NAME_COLLISION":
          return errorJson(409, e.message);
        case "MANIFEST_INVALID":
          return json(
            { message: e.message, errors: d.errors ?? [e.message] },
            { status: 422 },
          );
        case "VERIFY_FAILED":
          return json(
            {
              message: e.message,
              errors: d.errors ?? ["verify failed"],
              verifyResult: d.verifyResult,
            },
            { status: 422 },
          );
        case "ENV_KEY_LEAK":
          return json(
            {
              message: e.message,
              errors: d.errors ?? [e.message],
              leakedNames: d.leakedNames ?? [],
            },
            { status: 422 },
          );
        case "INSTALL_FAILED":
          return json(
            { message: e.message, errors: d.errors ?? [e.message] },
            { status: 422 },
          );
        case "ROLLBACK_FAILED":
          return json(
            { message: e.message, errors: d.errors ?? [e.message] },
            { status: 500 },
          );
        default:
          return errorJson(500, e.message);
      }
    }
  } catch (e) {
    if (e instanceof Response) return e;
    return errorJson(500, e instanceof Error ? e.message : "Install failed");
  }
};
