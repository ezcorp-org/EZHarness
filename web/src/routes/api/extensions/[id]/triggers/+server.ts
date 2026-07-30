import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getExtension } from "$server/db/queries/extensions";
import { errorJson } from "$lib/server/http-errors";
import {
  listDynamicCrons,
  listDynamicWebhooks,
} from "$server/extensions/triggers-store";

/**
 * GET /api/extensions/[id]/triggers
 *
 * The DYNAMIC triggers an extension has minted at runtime via
 * `ctx.triggers` (C2) — the operator's view of what an install is actually
 * scheduled to do.
 *
 * This exists because dynamic rows are, by construction, invisible
 * everywhere the manifest is the source of truth: they are absent from the
 * manifest, absent from the clamped grant, and skipped by both reconcilers.
 * Without this route the only trace of a user-created job is an audit row,
 * which tells you one was created but not whether it still exists or still
 * fires.
 *
 * Admin-only. The rows expose hook URLs and cron schedules for every user
 * of the extension, which is operator information, not end-user
 * information. Secrets are NEVER included — a hook's token is obtainable
 * only through the shown-once rotate route.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  requireRole(locals, "admin");

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Extension not found");

  // Schedules key on the extension UUID; webhooks key on the NAME (they FK
  // `extensions.name` so the session-less hook route can resolve them).
  const [crons, hooks] = await Promise.all([
    listDynamicCrons(ext.id),
    listDynamicWebhooks(ext.name),
  ]);

  return json({
    triggers: [
      ...crons.map((r) => ({
        kind: "cron" as const,
        key: r.key,
        cron: r.cron,
        timezone: r.timezone,
        enabled: r.enabled,
        maxRunsPerDay: r.maxRunsPerDay,
        nextFireAt: r.nextFireAt.toISOString(),
        lastFireAt: r.lastFireAt?.toISOString() ?? null,
        lastFireStatus: r.lastFireStatus ?? null,
        consecutiveErrors: r.consecutiveErrors,
      })),
      ...hooks.map((r) => ({
        kind: "webhook" as const,
        key: r.key,
        slug: r.slug,
        url: `/api/hooks/${ext.name}/${r.slug}`,
        enabled: r.enabled,
        lastDeliveryAt: r.lastDeliveryAt?.toISOString() ?? null,
        lastDeliveryStatus: r.lastDeliveryStatus ?? null,
      })),
    ],
  });
};
