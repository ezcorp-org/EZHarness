/**
 * GET /api/hub/pages/[id] — render one Hub page for the session user.
 *
 * Uniform contract for core AND extension pages: every tree — no
 * matter who produced it — passes `validatePageTree` before it is
 * served. Render/validation failures return 200 + `{ error }` (the
 * client shows an error card with retry); only unknown ids 404 and
 * rate-limit hits 429.
 *
 *   - `core:<provider>`: provider.render(userId); `allowedEvents` =
 *     the provider's action names.
 *   - `ext:<name>:<pageId>` (Phase 2): cached subprocess render-pull
 *     via `$lib/server/hub-render-pull`; `allowedEvents` = the
 *     extension's granted eventSubscriptions.
 *
 * `?project=<uuid>` (the project-scoped hub route) resolves the project
 * row and threads {id,name,path} into the render — consumed only by
 * pages declared `perProject: true`; inert everywhere else. Malformed
 * or unknown ids 404.
 *
 * Rate limit: 12 renders/min/user/page.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { RateLimiter } from "$lib/server/security/rate-limiter";
import { getHubPageProvider } from "$server/runtime/hub-pages";
import { validatePageTree } from "$server/extensions/page-schema";
import { parseHubPageId } from "$lib/hub";
import { renderExtensionPage } from "$lib/server/hub-render-pull";
import { getProject } from "$server/db/queries/projects";
import { logger } from "$server/logger";

const log = logger.child("api.hub.render");

/** 12 renders per minute per (user, page). Exported for test isolation. */
export const __rateLimiter = new RateLimiter(12, 60_000);

/** `crypto.randomUUID()` shape — the only accepted `?project=` value. */
const PROJECT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: RequestHandler = async ({ locals, params, url }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const parsed = parseHubPageId(params.id ?? "");
  if (!parsed) return errorJson(404, "Not found");

  // Optional project context (the project-scoped hub route). Resolved
  // here so the render layer only ever sees a REAL project; malformed
  // or unknown ids 404 like any other bad page address.
  const projectParam = url.searchParams.get("project");
  let project: { id: string; name: string; path: string } | undefined;
  if (projectParam !== null) {
    if (!PROJECT_ID_REGEX.test(projectParam)) return errorJson(404, "Not found");
    const row = await getProject(projectParam);
    if (!row) return errorJson(404, "Not found");
    project = { id: row.id, name: row.name, path: row.path };
  }

  const limit = __rateLimiter.check(`hub-render:${user.id}:${params.id}`);
  if (!limit.allowed) {
    return errorJson(
      429,
      "Too many refreshes — slow down",
      { retryAfter: limit.retryAfter },
      { "Retry-After": String(limit.retryAfter ?? 1) },
    );
  }

  if (parsed.kind === "ext") {
    const result = await renderExtensionPage(
      parsed.extension,
      parsed.pageId,
      user.id,
      undefined,
      project,
    );
    if (result.notFound) return errorJson(404, "Not found");
    if (result.error !== undefined) return json({ error: result.error });
    return json({
      page: result.page,
      renderedAt: result.renderedAt,
      ...(result.stale ? { stale: true } : {}),
    });
  }

  const provider = getHubPageProvider(parsed.providerId);
  if (!provider) return errorJson(404, "Not found");

  let rawTree: unknown;
  try {
    rawTree = await provider.render({ userId: user.id });
  } catch (err) {
    log.warn("core hub page render failed", {
      providerId: parsed.providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "This page failed to render — try again." });
  }

  // Core trees ALSO pass validation (uniform contract): a core provider
  // bug can never ship an unvalidated node to the renderer.
  const page = validatePageTree(rawTree, {
    allowedEvents: Object.keys(provider.actions ?? {}),
  });
  if (!page) {
    log.warn("core hub page produced an invalid tree", { providerId: parsed.providerId });
    return json({ error: "This page produced invalid content." });
  }

  return json({ page, renderedAt: Date.now() });
};
