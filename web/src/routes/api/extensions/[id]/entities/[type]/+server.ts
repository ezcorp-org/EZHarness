// ── Per-extension entity collection routes ───────────────────────
//
// GET    /api/extensions/[id]/entities/[type]            → list records
// POST   /api/extensions/[id]/entities/[type]            → create a record
//
// Phase 5 of the defineEntity SDK. The settings UI calls these to
// power the auto-generated entity table on /extensions/[id]. They
// mirror the SDK's tool dispatch — same store, same validation, same
// soft-read shape — so the UI and the LLM both see byte-identical
// records.
//
// Auth + scope rules:
//   - `requireScope("extensions")` — the per-API-key gate; same as the
//     settings PUT endpoint
//   - `requireAuth` — must be a logged-in user
//   - The acting user becomes the `user` scope id for the host-side
//     entity store. Cross-user reads aren't supported in v1.
//
// All validation happens server-side using the SDK's `assertRecord`
// against the declaration's JSON Schema — the client form is
// untrusted. Errors translate to:
//   - 400 for shape/validation failures
//   - 404 for unknown extension / unknown entity type
//   - 409 for duplicate-slug create
//   - 500 for storage errors (rare; logged via persistError upstream)

import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { getExtension } from "$server/db/queries/extensions";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { createHostEntityStore } from "$server/extensions/entities/host-store";
import {
  assertRecord,
  assertValidSlug,
  EntityValidationError,
  isValidSlug,
  listEntityRecords,
  readEntityIndex,
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

  // Bind to the per-user scope. `user` scope is the v1 default and
  // the only one with an install-time scopeId. `project` falls back
  // to conversation per the host adapter (no project tier in v1);
  // `conversation` requires a conversation id we don't have here —
  // those entity types are not surfaced through the settings UI.
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

  // Soft-read: every record carries a `_validationWarning` when its
  // body fails the current schema. The UI uses this to render a
  // yellow banner + prevent edits from clobbering unknown fields.
  const items = await listEntityRecords(store, decl.type);
  const enriched = items.map((rec) => {
    const issues = validateRecord(decl.schema, rec.data);
    return issues.length === 0
      ? { slug: rec.slug, data: rec.data }
      : {
          slug: rec.slug,
          data: rec.data,
          _validationWarning: { code: "SCHEMA_DRIFT", issues },
        };
  });

  return json({ items: enriched });
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
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

  const scope = decl.scope ?? "user";
  if (scope === "conversation") {
    return errorJson(
      400,
      "Conversation-scoped entities aren't editable through the settings UI",
    );
  }

  let body: { slug?: unknown; data?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorJson(400, "Invalid JSON body");
  }

  const slug = body.slug;
  const data = body.data;
  if (typeof slug !== "string" || !isValidSlug(slug)) {
    return errorJson(400, "Invalid or missing slug");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return errorJson(400, "Invalid or missing data (must be an object)");
  }

  const store = createHostEntityStore({
    extensionId: ext.id,
    scope,
    scopeId: user.id,
  });

  // Dup guard — same shape as the SDK's create tool. We check the index
  // AND the record; either presence is fatal.
  const indexSlugs = await readEntityIndex(store, decl.type);
  if (indexSlugs.includes(slug)) {
    return errorJson(409, `Entity ${JSON.stringify(slug)} already exists`);
  }
  const existing = await readEntityRecord(store, decl.type, slug);
  if (existing !== null) {
    return errorJson(409, `Entity ${JSON.stringify(slug)} already exists`);
  }

  // Hard-fail validation — server-side gate, the client form is untrusted.
  try {
    assertValidSlug(slug);
    assertRecord(decl.schema, data, `POST entities/${decl.type}`);
  } catch (err) {
    if (err instanceof EntityValidationError) {
      return json(
        { error: err.message, issues: err.issues },
        { status: 400 },
      );
    }
    return errorJson(400, (err as Error).message);
  }

  await writeEntityRecord(store, decl.type, slug, data);
  return json({ slug, data }, { status: 201 });
};
