import { json } from "@sveltejs/kit";
import { listExtensions } from "$server/db/queries/extensions";
import { installFromLocal, installFromGitHub, installFromGit } from "$server/extensions/installer";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { cacheableResponse } from "$server/lib/cache-utils";
import { installExtensionSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { requireScope } from "$lib/server/security/api-keys";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS, type ExtensionAuditMetadata } from "$server/extensions/audit-actions";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const extensions = await listExtensions();
  return cacheableResponse(request, extensions, { maxAge: 60, staleWhileRevalidate: 300 });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  // sec-C3: admin role required — requireScope is a no-op for cookie auth, so
  // gating on it allowed any logged-in user to install extensions with
  // attacker-chosen grantedPermissions (e.g. {shell: true, filesystem: ["/"]}).
  // Combined with /api/tool-invoke this was an RCE primitive.
  // requireRole throws a raw Response; SvelteKit does not recognise that and
  // surfaces it as a 500. Catch here so non-admin callers see the intended 403.
  let admin;
  try {
    admin = requireRole(locals, "admin");
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const result = installExtensionSchema.safeParse(await request.json());
  if (!result.success) {
    return validationError(result.error);
  }
  const { source, path, repo, url, ref } = result.data;

  try {
    // Invariant: install never grants permissions. Enable + grant happens via POST /:id/activate.
    const emptyPerms = { grantedAt: {} } as any;
    let ext;
    if (source === "local") {
      ext = await installFromLocal(path!, emptyPerms, false);
    } else if (source === "github") {
      try {
        ext = await installFromGitHub(repo!, emptyPerms, false);
      } catch (e) {
        // Predictable error for the common "repo has no GitHub release" case:
        // point the user at `source:"git"` instead of silently falling back,
        // so they see exactly one install path per request.
        const msg = e instanceof Error ? e.message : String(e);
        if (/No tarball found|Failed to fetch release/.test(msg)) {
          throw new Error(
            `${msg} — no release found; try installing as source:"git" with the repo clone URL instead`,
          );
        }
        throw e;
      }
    } else {
      // source === "git": clone-any-branch path via installFromGit.
      // parseSource takes "<url>[@ref]" as one string.
      const sourceStr = ref ? `${url!}@${ref}` : url!;
      ext = await installFromGit(sourceStr, emptyPerms, { enabled: false });
    }

    await ExtensionRegistry.getInstance().reload();

    // Audit the install. Permissions are empty at this stage (activate
    // step grants them later) — we record `oldValue=undefined, newValue=undefined`
    // so `listAuditForExtension` surfaces "who installed this, from where, when"
    // regardless of later grant activity. One row is enough: downstream
    // grant audits are written by the activate + permissions endpoints.
    try {
      const meta: ExtensionAuditMetadata & { source: string; path?: string; repo?: string; url?: string } = {
        permission: "install",
        oldValue: undefined,
        newValue: undefined,
        actor: admin.id,
        reason: `admin-install from source=${source}`,
        source,
        ...(path ? { path } : {}),
        ...(repo ? { repo } : {}),
        ...(url ? { url } : {}),
      };
      await insertAuditEntry(admin.id, EXT_AUDIT_ACTIONS.PERMISSION_GRANTED, ext.id, meta);
    } catch { /* non-fatal */ }

    return json(ext, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Install failed";
    return errorJson(400, message);
  }
};
