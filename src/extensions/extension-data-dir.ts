/**
 * Where an extension keeps its persistent user-visible state, and whether
 * an uninstall is allowed to `rm -rf` that directory.
 *
 * ONE module for both, for the same reason `install-roots.ts` owns the
 * install paths AND the rule for deleting inside them: a directory is
 * deletable exactly because the host created it, and splitting the two
 * apart is how a hand-written comment ends up describing a check that
 * does something else. The layout itself is binding — see
 * `src/extensions/CLAUDE.md` ("Extension data") and
 * `docs/extensions/data-storage.md`.
 *
 * Before this module the literal `.ezcorp/extension-data` was spelled
 * independently in `chat/attachments/ext-files-resolver.ts` and
 * `extensions/mcp-sandbox.ts`. Both now import from here, so an uninstall
 * cannot delete one directory while the sandbox mounts another.
 *
 * A leaf module (`node:path` + `./project-root`) on purpose: the same
 * constraint `install-roots.ts` documents. Nothing here may reach the DB
 * or the registry.
 */

import { join, resolve, sep } from "node:path";
import { getProjectRoot } from "./project-root";

/** Base directory holding every extension's data store, under `root`. */
export function extensionDataBaseDir(root: string = getProjectRoot()): string {
  return join(root, ".ezcorp", "extension-data");
}

/**
 * An extension's own data store: `<root>/.ezcorp/extension-data/<name>`.
 *
 * `name` is the manifest slug, NOT the row's UUID — that is the directory
 * the SDK's storage handlers, the sandbox bind-mount and the
 * `/api/extensions/:name/data/*` route all agree on.
 */
export function extensionDataDir(
  name: string,
  root: string = getProjectRoot(),
): string {
  return join(extensionDataBaseDir(root), name);
}

/**
 * True iff {@link extensionDataDir} for `name` resolves STRICTLY INSIDE
 * the base directory — the containment rule for the uninstall `rm -rf`.
 *
 * The check is not theatre even though `manifest.ts` already pins
 * installer-side names to `/^[a-z0-9][a-z0-9-_.]{0,63}$/`: this function
 * is handed a name read back out of the DB, and the delete it authorizes
 * is recursive and irreversible. `resolve()` before comparing is what
 * turns `../../etc` and an absolute `/etc` into refusals; the trailing
 * `sep` is what keeps a sibling like `extension-data-backup` out, which a
 * bare `startsWith(base)` would admit.
 *
 * Deliberately LEXICAL — no `realpath()` — matching
 * `isRemovableInstallPath`: `rm(path, {recursive, force})` on a symlink
 * unlinks the LINK and leaves its target alone, which is the correct
 * uninstall, whereas resolving first would move the decision onto the
 * target.
 */
export function isRemovableDataDir(
  name: string | null | undefined,
  root: string = getProjectRoot(),
): boolean {
  // `join(base, "")` is `base` itself, so a blank name would otherwise
  // resolve to "delete every extension's data".
  if (typeof name !== "string" || name.length === 0) return false;
  const base = resolve(extensionDataBaseDir(root));
  const dir = resolve(extensionDataDir(name, root));
  return dir !== base && dir.startsWith(base + sep);
}
