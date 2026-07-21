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
 * `?project=<id>` (the project-scoped hub route) resolves the project
 * row and threads {id,name,path} into the render — consumed only by
 * pages declared `perProject: true`; inert everywhere else. Project
 * context is an ENHANCEMENT, never an addressing requirement: an
 * unresolvable id (unknown, deleted, the synthetic "global" fallback,
 * oversized junk) simply renders the page WITHOUT project context, so
 * pages that worked before ?project= existed keep working. Note ids
 * are not always UUIDs — the seeded self project's id is "self".
 *
 * `?run=<id>` (+ optional `?step=<name>`) select detail render variants,
 * passed opaquely to the extension — the host resolves neither. `?step=`
 * is a sub-variant of `?run=` (one step's detail within a run) and is
 * meaningless without it; `hub-render-pull` drops a stray step. Both are
 * bounded so junk never reaches the render.
 *
 * Rate limit: 12 renders/min/user/page/project+run+step-variant.
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

/** Sanity bound before the DB lookup — project ids are short (UUIDs or
 *  seeded names like "self"); anything longer is junk, not a project. */
const MAX_PROJECT_PARAM_LENGTH = 128;

/** Sanity bound on `?run=<id>` (the run-detail variant). Run ids are short
 *  (`run_<ts>_<rand>`); anything longer is junk, not a run. The value is
 *  passed opaquely to the extension render, which resolves it against its own
 *  store — an unknown id renders an empty/"not found" detail, never an error. */
const MAX_RUN_PARAM_LENGTH = 128;

/** Sanity bound on `?step=<name>` (the step-detail sub-variant of `?run=`).
 *  Step names are short pipeline-step tokens; anything longer is junk. Like
 *  `run`, the value is passed opaquely to the extension render, which validates
 *  it against its own step set — an unknown step renders an empty detail. */
const MAX_STEP_PARAM_LENGTH = 128;

export const GET: RequestHandler = async ({ locals, params, url }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const parsed = parseHubPageId(params.id ?? "");
  if (!parsed) return errorJson(404, "Not found");

  // Optional project context (the project-scoped hub route). Resolved
  // here so the render layer only ever sees a REAL project. Unresolvable
  // values fall back to a context-less (global) render rather than 404 —
  // the client appends ?project= for EVERY page under /project/<id>/hub,
  // including the synthetic "global" fallback and pages that never read
  // project context, and none of those may dead-end.
  const projectParam = url.searchParams.get("project");
  let project: { id: string; name: string; path: string } | undefined;
  if (projectParam && projectParam.length <= MAX_PROJECT_PARAM_LENGTH) {
    const row = await getProject(projectParam);
    if (row) project = { id: row.id, name: row.name, path: row.path };
  }

  // Optional run-detail variant (`?run=<id>`). Passed opaquely to the
  // extension render — the host does not resolve runs; the extension owns that
  // lookup. Bounded like the project param so junk never reaches the render.
  const runParam = url.searchParams.get("run");
  const run =
    runParam && runParam.length <= MAX_RUN_PARAM_LENGTH ? runParam : undefined;

  // Optional step-detail sub-variant (`?step=<name>`). Meaningful only
  // alongside `?run=` (hub-render-pull drops a stray step); still extracted +
  // bounded here so an oversized value never reaches the render or the key.
  const stepParam = url.searchParams.get("step");
  const step =
    stepParam && stepParam.length <= MAX_STEP_PARAM_LENGTH ? stepParam : undefined;

  // The project + run + step variants are part of the limiter key: each project
  // view AND each run/step detail of a page is a distinct render target with its
  // own budget — without this, browsing 12+ projects/runs/steps in a minute 429s
  // on first renders.
  const limit = __rateLimiter.check(
    `hub-render:${user.id}:${params.id}:${project?.id ?? ""}:${run ?? ""}:${step ?? ""}`,
  );
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
      run,
      step,
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
