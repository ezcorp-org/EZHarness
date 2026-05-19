/**
 * POST /api/import/commit — import the selected items.
 *
 * Body: `{ sessionId, projectId, commands: string[], skills: string[] }`
 * (ids from `/api/import/preview`). Commands → `createUserCommand`
 * (DRY: the DB helper, not a self-HTTP). Skills → synthesize a
 * runnable tool extension and hand it to the existing
 * `installFromLocal` pipeline (installed **disabled** — the user
 * reviews + enables it via the normal extensions permission modal).
 * Per-item results are returned so auto-renames / failures are
 * visible. Staging is always `rm -rf`'d in `finally`.
 */

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { discoverProjectCommands } from "$server/runtime/commands/discovery";
import { createUserCommand } from "$server/db/queries/user-commands";
import { getCommandRegistry } from "$lib/server/context";
import {
  scanSkillBundles,
  synthesizeSkillExtension,
} from "$server/runtime/import/skill-bundle";
import {
  resolveScanRoot,
  resolveStagingDir,
  cleanupStagingDir,
  bestEffortRm,
} from "$server/runtime/import/staging";
import { installFromLocal } from "$server/extensions/installer";
import { getExtensionByName } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { filterFrontmatter } from "../../user-commands/schema";
import { resolveProjectRoot, slugifyCommandName, commandId } from "../common";

interface ItemResult {
  kind: "command" | "skill";
  requested: string;
  finalName?: string;
  extId?: string;
  status: "ok" | "error";
  message?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const scopeErr = requireScope(locals, "extensions");
    if (scopeErr) return scopeErr;
    const user = requireAuth(locals);

    const body = (await request.json().catch(() => null)) as {
      sessionId?: unknown;
      projectId?: unknown;
      commands?: unknown;
      skills?: unknown;
    } | null;
    if (!body || typeof body !== "object") {
      return errorJson(400, "Invalid request body");
    }

    const pr = await resolveProjectRoot(body.projectId);
    if ("err" in pr) return pr.err;
    const { root } = pr;

    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId : "";
    const wantCommands = new Set(
      Array.isArray(body.commands) ? body.commands.map(String) : [],
    );
    const wantSkills = new Set(
      Array.isArray(body.skills) ? body.skills.map(String) : [],
    );

    const stagingDir = await resolveStagingDir(root, sessionId);
    if (!stagingDir) {
      return errorJson(410, "Import session expired or not found");
    }

    const results: ItemResult[] = [];
    try {
      const scanRoot = await resolveScanRoot(stagingDir);
      const [cmds, skills] = await Promise.all([
        discoverProjectCommands(scanRoot),
        scanSkillBundles(scanRoot),
      ]);

      for (const c of cmds) {
        if (!wantCommands.has(commandId(c.source, c.name))) continue;
        try {
          const created = await createUserCommand({
            userId: user.id,
            name: slugifyCommandName(c.name),
            description: c.description,
            body: c.body,
            frontmatter: { ...filterFrontmatter(c.frontmatter), imported: c.source },
          });
          results.push({
            kind: "command",
            requested: c.name,
            finalName: created.name,
            status: "ok",
          });
        } catch (e) {
          results.push({
            kind: "command",
            requested: c.name,
            status: "error",
            message: e instanceof Error ? e.message : "create failed",
          });
        }
      }

      for (const b of skills) {
        if (!wantSkills.has(b.id)) continue;
        try {
          let finalName = b.name;
          let i = 2;
          while (
            (await getExtensionByName(finalName)) ||
            existsSync(join(root, ".ezcorp/extensions", finalName))
          ) {
            finalName = `${b.name}-${i++}`.slice(0, 64);
          }
          const destDir = join(root, ".ezcorp/extensions", finalName);
          await synthesizeSkillExtension({ bundle: b, destDir, name: finalName });
          try {
            const inst = await installFromLocal(
              destDir,
              { grantedAt: {} } as never,
              false,
              { isBundled: false, userId: user.id },
            );
            results.push({
              kind: "skill",
              requested: b.rawName,
              finalName,
              extId: inst.id,
              status: "ok",
            });
          } catch (e) {
            await bestEffortRm(destDir);
            results.push({
              kind: "skill",
              requested: b.rawName,
              status: "error",
              message: e instanceof Error ? e.message : "install failed",
            });
          }
        } catch (e) {
          results.push({
            kind: "skill",
            requested: b.rawName,
            status: "error",
            message: e instanceof Error ? e.message : "synthesis failed",
          });
        }
      }

      if (results.some((r) => r.kind === "command" && r.status === "ok")) {
        getCommandRegistry().invalidateUser(user.id);
      }
      if (results.some((r) => r.kind === "skill" && r.status === "ok")) {
        try {
          await ExtensionRegistry.getInstance().reload();
        } catch {
          // Non-fatal — the next reload picks the new row up.
        }
      }
    } finally {
      await cleanupStagingDir(root, sessionId);
    }

    return json({ results });
  } catch (e) {
    if (e instanceof Response) return e;
    return errorJson(500, e instanceof Error ? e.message : "Import failed");
  }
};
