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

import { dirname, join, resolve } from "node:path";
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
 * Name pattern an extension data directory may be deleted under.
 *
 * Deliberately IDENTICAL to `manifest.ts`'s `NAME_REGEX` — restated rather
 * than imported to keep this module a leaf (see the header; `manifest.ts`
 * pulls in the whole validation closure). `src/__tests__/extension-data-dir.test.ts`
 * pins the two together so they cannot drift.
 */
const DATA_DIR_NAME_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

/**
 * True iff `name` names ONE directory directly inside the base — the
 * containment rule for the uninstall `rm -rf`.
 *
 * **Identity, not merely containment.** Containment alone is not enough,
 * and assuming it was is a real hole this function shipped with: a name
 * like `../extension-data/task-tracking` walks OUT of the base and back
 * IN, so it stays "inside" while naming a DIFFERENT extension's store.
 * `DELETE /api/extensions/:id?purgeData=1` on a row carrying that name
 * would erase a built-in's task store. The premise that no such name can
 * exist — `manifest.ts` pins installer-side names — was false, because
 * `installMcpExtension` synthesises its manifest and never goes through
 * `manifest.ts`. Requiring a single well-formed segment kills the class
 * for EVERY writer, present and future, which is why the rule lives here
 * rather than only in the one schema that was missing it.
 *
 * Three independent gates, each redundant with the others on purpose:
 *   1. the name matches the manifest name pattern (no `/`, `\`, `..`,
 *      leading dot, or empty string);
 *   2. its resolved directory's PARENT is exactly the base — the
 *      structural statement of "one level down, no walking";
 *   3. it is not the base itself.
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
  // Gate 1. Also covers the empty string: `join(base, "")` is `base`, so a
  // blank name would otherwise mean "delete every extension's data".
  if (typeof name !== "string" || !DATA_DIR_NAME_REGEX.test(name)) return false;
  // Gates 2 and 3. `dirname` is the whole fix: `startsWith(base + sep)` is
  // true for any depth and for any path that walks back in, `dirname(...)
  // === base` is true only for a direct child.
  const base = resolve(extensionDataBaseDir(root));
  const dir = resolve(extensionDataDir(name, root));
  return dir !== base && dirname(dir) === base;
}
