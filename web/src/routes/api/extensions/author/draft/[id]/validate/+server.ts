/**
 * `/api/extensions/author/draft/[id]/validate` — run the host-side
 * `validateManifestV2` against a draft's `ezcorp.config.ts`. Returns
 * `{ ok, errors }` (200 on success or validation failure; 4xx only on
 * auth/lookup errors).
 */
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getDraft, getExtensionAuthorDraftDir } from "$server/db/queries/ez-drafts";
import { loadManifest } from "$server/extensions/loader";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ params, locals }) => {
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

    const dir = getExtensionAuthorDraftDir(draftId, user.id);
    const cfgPath = join(dir, "ezcorp.config.ts");
    if (!existsSync(cfgPath)) {
      return json({ ok: false, errors: ["Missing ezcorp.config.ts"] });
    }

    // Use the canonical loader (child-process compile via Bun's
    // import pipeline) — replaces the prior `new Function(body)` eval
    // (reviewer S5). `loadManifest` runs `validateManifestV2`
    // internally and throws on either load failure or validation
    // failure. We only need to distinguish ok/!ok here, not parse the
    // error message.
    try {
      await loadManifest(dir);
      return json({ ok: true, errors: [] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The loader throws messages like `Invalid manifest: <errors>`
      // when validation fails. Strip the prefix so the UI shows the
      // raw error list. Other errors (no default export, file load
      // error) come through unchanged.
      const match = msg.match(/^Invalid manifest:\s*(.+)$/);
      const errors = match
        ? match[1]!.split(",").map((s) => s.trim()).filter(Boolean)
        : [msg];
      return json({ ok: false, errors });
    }
  } catch (e) {
    if (e instanceof Response) return e;
    return errorJson(500, e instanceof Error ? e.message : "Validate failed");
  }
};
