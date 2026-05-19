import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { getExtension } from "$server/db/queries/extensions";
import { listExpiredGrantsForExtension } from "$server/db/queries/expired-grants";
import { getSetting } from "$server/db/queries/settings";
import type { RequestHandler } from "./$types";

/**
 * GET /api/extensions/[id]/expired-grants
 *
 * Phase 4 (capability-expiry) — feeds the settings-page
 * `ExpiredGrantsBanner.svelte`. Returns the audit rows the sweep wrote
 * for THIS extension within the last 7 days, projected onto the
 * banner's `ExpiredGrant` prop shape.
 *
 * Phase 56 (per-capability TTL UI): each row is additively enriched
 * with `stickyTtlMs: number | null` — the user's previously-chosen
 * picker TTL for the row's `capabilityKind`, read from settings KV
 * (`user:<userId>:reapprove:lastTtl:<kind>`). Front-end uses this to
 * seed the modal picker's initialTtlMs; absent / malformed → null →
 * front-end falls back to DEFAULT_TTL_FIRST_USE_MS (30d).
 *
 * Per the plan's "no new endpoint" contract, this batch read happens
 * here rather than via a sibling endpoint. The settings KV table is
 * small (≤ 12 expiry kinds per user); even with N rows we issue ≤ N
 * point reads — acceptable for the banner's load cadence (page mount).
 *
 * Auth: any authenticated user — the rows reveal "this extension's
 * grant for shell expired 2 days ago", which is the user's own
 * permission state on the page they're already looking at. The
 * detailed audit drill-down at /api/extensions/[id]/audit remains
 * admin-only because it surfaces actor identifiers + system-internal
 * fields.
 *
 * 404 on unknown extension so the URL doesn't probe the extension id
 * space.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const grants = await listExpiredGrantsForExtension(params.id);

  // Phase 56 — batch-read sticky last-pick per row. `capability` is the
  // row's CapabilityExpiryKind (already coerced by the query helper);
  // we read `user:<id>:reapprove:lastTtl:<kind>` and project a typed
  // `stickyTtlMs` field onto the response. Absent / non-numeric values
  // collapse to null so the front-end never has to defend against
  // typeof drift.
  const enriched = await Promise.all(
    grants.map(async (row) => {
      const key = `user:${user.id}:reapprove:lastTtl:${row.capability}`;
      // Defensive: a settings-read failure must not brick the banner
      // load. Failed reads collapse to null (front-end falls back to
      // DEFAULT_TTL_FIRST_USE_MS). The sticky read is best-effort.
      let raw: unknown;
      try {
        raw = await getSetting(key);
      } catch {
        raw = undefined;
      }
      const stickyTtlMs =
        typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
      // `capabilityKind` is the field name the front-end + the Wave 0
      // sticky-pick test consume. The query helper exposes `capability`;
      // we mirror it onto `capabilityKind` for forward compatibility
      // (`capability` stays as the legacy field).
      return { ...row, capabilityKind: row.capability, stickyTtlMs };
    }),
  );

  return json({ grants: enriched });
};
