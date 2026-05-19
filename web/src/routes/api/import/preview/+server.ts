/**
 * POST /api/import/preview — stage an upload and return a checklist.
 *
 * Accepts either a directory-picker upload (`files` parts + parallel
 * `paths`) or a single `archive` (`.zip` / `.tar.gz` / `.tgz`). The
 * upload is staged under `<projectRoot>/.ezcorp/import-staging/<id>`,
 * scanned with the *same* command scanner + skill-bundle scanner the
 * commit step uses, and the staging dir is kept (keyed by
 * `sessionId`) for commit. Abandoned previews are swept opportunistically.
 */

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { discoverProjectCommands } from "$server/runtime/commands/discovery";
import { scanSkillBundles } from "$server/runtime/import/skill-bundle";
import {
  stageDirectoryUpload,
  stageArchiveUpload,
  resolveScanRoot,
  cleanupStagingDir,
  sweepStaleStaging,
  StagingError,
  type StagedUpload,
} from "$server/runtime/import/staging";
import { resolveProjectRoot, commandId, STALE_STAGING_MS } from "../common";

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const scopeErr = requireScope(locals, "read");
    if (scopeErr) return scopeErr;
    requireAuth(locals);

    const ct = request.headers.get("content-type") ?? "";
    if (!ct.startsWith("multipart/form-data")) {
      return errorJson(400, "multipart/form-data required");
    }
    const form = await request.formData().catch(() => null);
    if (!form) return errorJson(400, "Invalid multipart body");

    const pr = await resolveProjectRoot(form.get("projectId"));
    if ("err" in pr) return pr.err;
    const { root } = pr;

    await sweepStaleStaging(root, STALE_STAGING_MS);

    let staged: StagedUpload;
    try {
      const archive = form.get("archive");
      if (archive instanceof File) {
        staged = await stageArchiveUpload({ projectRoot: root, archive });
      } else {
        const files = form
          .getAll("files")
          .filter((x): x is File => x instanceof File);
        const paths = form.getAll("paths").map(String);
        staged = await stageDirectoryUpload({ projectRoot: root, files, paths });
      }
    } catch (e) {
      if (e instanceof StagingError) {
        return errorJson(e.status, e.message, { code: e.code });
      }
      throw e;
    }

    try {
      const scanRoot = await resolveScanRoot(staged.dir);
      const [cmds, skills] = await Promise.all([
        discoverProjectCommands(scanRoot),
        scanSkillBundles(scanRoot),
      ]);
      return json({
        sessionId: staged.sessionId,
        fileCount: staged.fileCount,
        commands: cmds.map((c) => ({
          id: commandId(c.source, c.name),
          name: c.name,
          description: c.description,
          source: c.source,
        })),
        skills: skills.map((s) => ({
          id: s.id,
          name: s.name,
          rawName: s.rawName,
          description: s.description,
          scriptCount: s.scripts.length,
        })),
      });
    } catch (e) {
      await cleanupStagingDir(root, staged.sessionId);
      throw e;
    }
  } catch (e) {
    if (e instanceof Response) return e;
    return errorJson(500, e instanceof Error ? e.message : "Preview failed");
  }
};
