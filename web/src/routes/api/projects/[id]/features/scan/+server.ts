import { isAbsolute, resolve } from "node:path";
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import * as projectQueries from "$server/db/queries/projects";
import * as featureQueries from "$server/db/queries/features";
import { scanProject } from "$server/runtime/scan/feature-scan";
import type { RequestHandler } from "./$types";

/**
 * Feature Index — synchronous scan endpoint.
 *
 * POST /api/projects/:id/features/scan
 *
 * Walks the project's filesystem (via `scanProject`), upserts the
 * results as `source='agent'` features, and replaces each agent
 * feature's `source='scan'` files. User-pinned files
 * (`source='user'`) and user-renamed features (`source='user'`)
 * survive every rescan — the load-bearing invariant.
 *
 * Returns `{ features, notice }`: `features` is the post-scan list with
 * file counts (same row shape as GET /api/projects/:id/features) so the
 * UI can render in one round trip; `notice` is a human-readable string
 * (or null) explaining a legitimate 0-feature result.
 *
 * Failure surfacing (was silently a 200-with-[]): an unresolvable
 * working directory — a missing dir or a stale/relative path that
 * resolves against the server CWD — returns `400` with an actionable
 * message rather than an empty index that reads as "no features".
 *
 * Synchronous: the scan is sub-second on real-world projects (no
 * LLM calls, plain FS walk). If that ever becomes false, the
 * design doc has us deferring async/streaming progress to a follow-up.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const project = await projectQueries.getProject(params.id);
  if (!project) return errorJson(404, "Project not found");
  if (!project.path) return errorJson(400, "Project has no filesystem path configured");

  // Resolve to absolute so symlink-escape gets the canonical root.
  const projectRoot = resolve(project.path);
  const scan = await scanProject(projectRoot);
  if (!scan.ok) {
    // Unresolvable working directory (missing dir, or a stale/relative
    // path that resolves against the server CWD). Surface it instead of
    // answering 200-with-[] — a silent empty index reads as "no features"
    // and hides the real breakage. Include the relative-path hint only
    // when the configured path isn't already absolute.
    const hint = isAbsolute(project.path)
      ? ""
      : " Set an absolute path in project settings.";
    return errorJson(
      400,
      `Working directory "${project.path}" does not exist on the server ` +
        `(resolved to "${projectRoot}").${hint}`,
    );
  }
  const scanned = scan.features;

  // Index existing features twice: once by `originPath` (the scanner-
  // recorded source dir, immutable across renames), once by `name` (a
  // back-compat fallback for legacy rows that predate the originPath
  // column or hand-created user features that happen to collide on
  // slug). Match originPath FIRST — that's how a user-renamed feature
  // stays linked to its source dir on rescan instead of being silently
  // shadowed by a fresh agent row under the original slug.
  //
  // Pulling all features once (per project, sub-100 features in
  // practice) is cheaper than a per-candidate round trip.
  const existing = await featureQueries.listFeatures(params.id);
  const byOriginPath = new Map<string, (typeof existing)[number]>();
  const byName = new Map<string, (typeof existing)[number]>();
  for (const f of existing) {
    if (f.originPath) byOriginPath.set(f.originPath, f);
    byName.set(f.name, f);
  }

  for (const candidate of scanned) {
    // Prefer originPath match (survives renames). Fall back to name
    // for legacy rows where originPath is null — those will be
    // backfilled on this same pass so subsequent scans use the fast
    // path. Avoid double-binding a single existing row to two scanned
    // candidates: a name-fallback hit is only valid if the row has no
    // originPath yet (otherwise it's already linked to a different
    // dir and we should treat the slug-collision candidate as new).
    let prior = byOriginPath.get(candidate.originPath);
    let priorMatchedByName = false;
    if (!prior) {
      const byNameMatch = byName.get(candidate.name);
      if (byNameMatch && !byNameMatch.originPath) {
        prior = byNameMatch;
        priorMatchedByName = true;
      }
    }

    if (!prior) {
      // Brand-new agent-discovered feature.
      const created = await featureQueries.createFeature({
        projectId: params.id,
        name: candidate.name,
        description: candidate.description,
        source: "agent",
        originPath: candidate.originPath,
      });
      await featureQueries.replaceAgentFiles(created.id, candidate.files);
      continue;
    }

    // Backfill originPath on legacy rows we matched by name, so the
    // next rescan can use the fast path (and survive a future rename).
    // Don't overwrite a non-null originPath even if the matched row
    // somehow had a stale one — that would be lossy.
    if (priorMatchedByName && !prior.originPath) {
      await featureQueries.updateFeature(prior.id, { originPath: candidate.originPath });
    }

    if (prior.source === "user") {
      // User has claimed this row (renamed or hand-created) — do NOT
      // touch name, description, or source. Refresh only the agent
      // file slice (replaceAgentFiles never deletes user-pinned rows,
      // so this is safe even on user-owned features).
      await featureQueries.replaceAgentFiles(prior.id, candidate.files);
      continue;
    }

    // Agent-owned feature: refresh the description (keeps the
    // "Files under <relpath>" placeholder in sync if the dir was moved
    // and re-discovered) + replace its agent file slice.
    if (prior.description !== candidate.description) {
      await featureQueries.updateFeature(prior.id, {
        description: candidate.description,
      });
    }
    await featureQueries.replaceAgentFiles(prior.id, candidate.files);
  }

  // Note: features that EXISTED before but did NOT appear in this
  // scan are deliberately not deleted. The directory may have been
  // temporarily moved or the user may have pinned files there; the
  // user can delete the row explicitly. Matches the design doc's
  // hybrid-ownership intent ("rescans never clobber user edits").

  const updated = await featureQueries.listFeatures(params.id);

  // Explain WHY only when the user actually sees an empty index: the scan
  // discovered zero feature directories AND no prior rows survived. A
  // project can carry user-pinned / hand-created features that outlive a
  // 0-discovery scan — pairing "found nothing" with a populated list would
  // be contradictory. A scan that found features, or a list with surviving
  // rows, needs no notice.
  const notice =
    scan.features.length === 0 && updated.length === 0
      ? scan.usedTopLevelFallback
        ? `No feature directories found under ${scan.realRoot} (scanned top-level fallback)`
        : `No feature directories found under ${scan.realRoot} (scanned source roots)`
      : null;

  return json({ features: updated, notice });
};
