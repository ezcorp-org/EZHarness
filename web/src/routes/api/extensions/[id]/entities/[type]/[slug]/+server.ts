// ── Per-record entity routes ────────────────────────────────────
//
// GET    /api/extensions/[id]/entities/[type]/[slug]   → get one
// PUT    /api/extensions/[id]/entities/[type]/[slug]   → shallow-merge update
// DELETE /api/extensions/[id]/entities/[type]/[slug]   → delete + index update
//
// Phase 5 of the defineEntity SDK. Sibling to the collection route
// (`[type]/+server.ts`); same store, same validation, same soft-read
// shape. Slug is taken from the URL path — `body.slug` (if present)
// is ignored on update (slug is immutable per the SDK contract).

import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { getExtension } from "$server/db/queries/extensions";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { createHostEntityStore } from "$server/extensions/entities/host-store";
import {
  assertRecord,
  deleteEntityRecord,
  EntityValidationError,
  isValidSlug,
  readEntityRecord,
  validateRecord,
  writeEntityRecord,
  type EntityDeclaration,
} from "@ezcorp/sdk/entities";
import type { ExtensionManifestV2 } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

function findEntityDeclaration(
  manifest: ExtensionManifestV2,
  type: string,
): EntityDeclaration | null {
  return manifest.entities?.find((e) => e.type === type) ?? null;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Extension not found");
  const decl = findEntityDeclaration(
    ext.manifest as ExtensionManifestV2,
    params.type,
  );
  if (!decl) return errorJson(404, "Entity type not declared by this extension");
  if (!isValidSlug(params.slug)) return errorJson(400, "Invalid slug");

  const scope = decl.scope ?? "user";
  if (scope === "conversation") {
    return errorJson(
      400,
      "Conversation-scoped entities aren't editable through the settings UI",
    );
  }
  const store = createHostEntityStore({
    extensionId: ext.id,
    scope,
    scopeId: user.id,
  });
  const rec = await readEntityRecord(store, decl.type, params.slug);
  if (rec === null) return errorJson(404, "Record not found");
  const issues = validateRecord(decl.schema, rec.data);
  return json(
    issues.length === 0
      ? { slug: rec.slug, data: rec.data }
      : {
          slug: rec.slug,
          data: rec.data,
          _validationWarning: { code: "SCHEMA_DRIFT", issues },
        },
  );
};

export const PUT: RequestHandler = async ({ params, locals, request }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Extension not found");
  const decl = findEntityDeclaration(
    ext.manifest as ExtensionManifestV2,
    params.type,
  );
  if (!decl) return errorJson(404, "Entity type not declared by this extension");
  if (!isValidSlug(params.slug)) return errorJson(400, "Invalid slug");

  const scope = decl.scope ?? "user";
  if (scope === "conversation") {
    return errorJson(
      400,
      "Conversation-scoped entities aren't editable through the settings UI",
    );
  }

  let body: { patch?: unknown; data?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorJson(400, "Invalid JSON body");
  }

  // Accept either `{patch: {...}}` (matches the SDK tool) or
  // `{data: {...}}` (a more REST-y alias the UI uses for "save"
  // submits where the full record is sent). Both shallow-merge onto
  // the existing record so a partial UI form doesn't blow away
  // fields the form didn't render.
  const patch = body.patch ?? body.data;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return errorJson(400, "Invalid or missing patch / data (must be an object)");
  }
  if ((patch as { slug?: unknown }).slug !== undefined) {
    return errorJson(
      400,
      "slug is immutable — delete and recreate to change a record's slug",
    );
  }

  const store = createHostEntityStore({
    extensionId: ext.id,
    scope,
    scopeId: user.id,
  });
  const current = await readEntityRecord(store, decl.type, params.slug);
  if (current === null) return errorJson(404, "Record not found");

  const next: Record<string, unknown> = {
    ...(current.data as Record<string, unknown>),
    ...(patch as Record<string, unknown>),
  };

  try {
    assertRecord(decl.schema, next, `PUT entities/${decl.type}/${params.slug}`);
  } catch (err) {
    if (err instanceof EntityValidationError) {
      return json(
        { error: err.message, issues: err.issues },
        { status: 400 },
      );
    }
    return errorJson(400, (err as Error).message);
  }

  await writeEntityRecord(store, decl.type, params.slug, next);
  return json({ slug: params.slug, data: next });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Extension not found");
  const decl = findEntityDeclaration(
    ext.manifest as ExtensionManifestV2,
    params.type,
  );
  if (!decl) return errorJson(404, "Entity type not declared by this extension");
  if (!isValidSlug(params.slug)) return errorJson(400, "Invalid slug");

  const scope = decl.scope ?? "user";
  if (scope === "conversation") {
    return errorJson(
      400,
      "Conversation-scoped entities aren't editable through the settings UI",
    );
  }

  const store = createHostEntityStore({
    extensionId: ext.id,
    scope,
    scopeId: user.id,
  });
  const deleted = await deleteEntityRecord(store, decl.type, params.slug);
  return json({ deleted });
};
