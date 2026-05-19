/**
 * Re-open an installed extension as an author-mode draft.
 *
 * This is the inverse of `installAuthoredDraft`: it takes a
 * user-owned, admin-`modifiable`, non-bundled installed extension and
 * mints a fresh author draft seeded with its on-disk files, so the
 * ENTIRE existing edit pipeline (`read_draft` / `write_draft_file` /
 * `validate_extension` / `install_draft`) works unchanged. The draft
 * carries `payload.modifyOf = <extension.id>` so `installAuthoredDraft`
 * treats the same-name re-install as the sanctioned in-place upgrade
 * (it RE-authorizes against the DB) rather than a `NAME_COLLISION`.
 *
 * Shared by BOTH the in-chat reverse-RPC (`ezcorp/drafts.reopen`) and
 * the web Modify route — one owner-scoped, opaque authorization path.
 * There is intentionally NO admin-override edit path: an admin's power
 * is flipping the `modifiable` flag; editing an extension is strictly
 * owner-only ("modify only the ones they created").
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getUserModifiableExtension } from "../db/queries/extensions";
import {
  SCAFFOLD_DRAFT_FILES,
  createDraft,
  discardDraftAndDir,
  writeExtensionAuthorDraftFiles,
} from "../db/queries/ez-drafts";
import type { ExtensionManifestV2 } from "./types";
import { logger } from "../logger";

const log = logger.child("reopen-extension");

export type ReopenErrorCode =
  | "NOT_FOUND_OR_NOT_MODIFIABLE"
  | "NO_INSTALL_PATH"
  | "NO_FILES"
  | "DRAFT_FAILED";

/** Typed failure so the RPC handler maps to `rpcError` and the web
 *  route maps to an HTTP status without knowing each other. */
export class ReopenError extends Error {
  readonly code: ReopenErrorCode;
  constructor(code: ReopenErrorCode, message: string) {
    super(message);
    this.name = "ReopenError";
    this.code = code;
  }
}

/**
 * Map the manifest's component shape back to the scaffold "type" the
 * draft pipeline expects. Only the tool/multi distinction is
 * load-bearing: `installAuthoredDraft`'s `VERIFY_REQUIRED_TYPES` gate
 * re-runs the `smokeTest` round-trip for those, so anything that ships
 * a subprocess tool server still has to pass acceptance after a modify.
 */
function scaffoldType(
  m: ExtensionManifestV2,
): "tool" | "skill" | "agent" | "multi" {
  const hasTools = Array.isArray(m.tools) && m.tools.length > 0;
  const hasSkills = Array.isArray(m.skills) && m.skills.length > 0;
  const hasAgent = m.agent != null;
  if (hasTools && (hasSkills || hasAgent)) return "multi";
  if (hasTools) return "tool";
  if (hasAgent) return "agent";
  return "skill";
}

export async function reopenInstalledAsDraft(
  nameOrId: string,
  userId: string,
): Promise<{ draftId: string; name: string }> {
  // Owner + modifiable + not-bundled, opaque (miss ≡ not-owned ≡
  // flag-off ≡ bundled). Mirrors `ez_drafts.getDraft` so a caller can
  // never probe another user's extensions.
  const ext = await getUserModifiableExtension(nameOrId, userId);
  if (!ext) {
    throw new ReopenError(
      "NOT_FOUND_OR_NOT_MODIFIABLE",
      'Extension not found, not yours, or modification is not enabled. ' +
        'To enable it, an admin must open this extension\'s detail page ' +
        '(Library → click the extension), scroll to the "Settings" ' +
        'section, and turn ON the "Allow extension to be modified" ' +
        'checkbox. Built-in (bundled) extensions can never be made ' +
        'modifiable.',
    );
  }

  const installPath = ext.installPath;
  if (!installPath || !existsSync(installPath)) {
    throw new ReopenError(
      "NO_INSTALL_PATH",
      "Installed extension has no on-disk source to re-open",
    );
  }

  // Seed the draft from the installed files, restricted to the
  // scaffold allowlist (same set `writeExtensionAuthorDraftFiles`
  // enforces — anything else would be rejected on write anyway).
  const files: Record<string, string> = {};
  for (const fname of SCAFFOLD_DRAFT_FILES) {
    const p = join(installPath, fname);
    if (!existsSync(p)) continue;
    try {
      files[fname] = await readFile(p, "utf8");
    } catch {
      // Skip unreadable; ezcorp.config.ts presence is asserted below.
    }
  }
  if (!files["ezcorp.config.ts"]) {
    throw new ReopenError(
      "NO_FILES",
      "Installed extension is missing a readable ezcorp.config.ts",
    );
  }

  const manifest = ext.manifest as ExtensionManifestV2;
  let row: Awaited<ReturnType<typeof createDraft>>;
  try {
    row = await createDraft({
      userId,
      kind: "extension",
      payload: {
        name: ext.name,
        type: scaffoldType(manifest),
        // `mode:"author"` so the WHOLE existing pipeline treats this
        // identically — resolveDir / read_draft / write_draft_file /
        // verify / install all gate on `mode === "author"`.
        mode: "author",
        // Sanctioned-modify marker. Set ONLY here (the LLM cannot
        // inject payload keys via create_extension / write_draft_file).
        // `installAuthoredDraft` re-authorizes it against the DB before
        // performing the in-place replace.
        modifyOf: ext.id,
      },
    });
  } catch (err) {
    throw new ReopenError(
      "DRAFT_FAILED",
      `Failed to create draft: ${String(err)}`,
    );
  }

  try {
    await writeExtensionAuthorDraftFiles(row.id, userId, files);
  } catch (err) {
    // Transactional: a row with no files is useless and unrecoverable
    // by the LLM. Best-effort discard, then a clean error.
    try {
      await discardDraftAndDir(row.id, userId);
    } catch (discardErr) {
      log.warn("reopenInstalledAsDraft: rollback discard failed", {
        draftId: row.id,
        error: String(discardErr),
      });
    }
    throw new ReopenError(
      "DRAFT_FAILED",
      `Failed to materialize draft files: ${String(err)}`,
    );
  }

  return { draftId: row.id, name: ext.name };
}
