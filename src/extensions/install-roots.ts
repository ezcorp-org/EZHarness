/**
 * Where the host installs extensions, and which of those directories an
 * uninstall is allowed to `rm -rf` inside of.
 *
 * ONE module for both because they are the same fact read in two
 * directions: a directory is deletable exactly because the host created
 * it. Splitting them is how the original bug happened — `removeExtension`
 * carried a hand-written "must be under data/extensions/" comment over a
 * check that actually accepted any relative path and any absolute path
 * containing the substring `/extensions/`, so `ezcorp ext remove` deleted
 * bundled extensions' git-tracked source trees.
 *
 * A leaf module (`node:path` + `./project-root`) rather than a section of
 * `installer.ts`, because two of the four spellings of the
 * `.ezcorp/extensions` layout are SvelteKit routes (`api/import/commit`,
 * `api/__test/cleanup-extension`) that must not pull in the installer's
 * git/checksum/registry closure to spell a path.
 *
 * Every spelling in the repo goes through here: `installer.ts`,
 * `author-install.ts`, `web/src/routes/api/import/commit/+server.ts` and
 * `web/src/routes/api/__test/cleanup-extension/+server.ts`.
 */

import { isAbsolute, join, resolve, sep } from "node:path";
import { getProjectRoot } from "./project-root";

/**
 * Install base for DOWNLOADED extensions — `installFromGitHub` and
 * `installFromGit`. RELATIVE by design: it resolves against
 * `process.cwd()`, the deployment's working directory (`WORKDIR /app` in
 * the container), and the relative string is what gets persisted into
 * `extensions.install_path`.
 */
export function downloadedExtensionsDir(): string {
  return join("data", "extensions");
}

/**
 * Install base for AUTHORED and IMPORTED extensions, under `root`.
 *
 * `root` is NOT always `getProjectRoot()`, and assuming it was is what
 * made the first cut of this rule a regression: `installAuthoredDraft`
 * derives it from the draft dir (so, the project root), while
 * `POST /api/import/commit` resolves it from the `projects.path` COLUMN of
 * the project the user is importing into — an arbitrary directory. In the
 * shipped compose stack those differ: `EZCORP_SELF_PROJECT_PATH=/repo`
 * (docker-compose.yml) against `WORKDIR /app` (Dockerfile).
 */
export function authoredExtensionsDir(root: string): string {
  return join(root, ".ezcorp", "extensions");
}

/**
 * Every directory an uninstall may delete inside of, absolute and
 * resolved. One entry per host-owned install writer:
 *
 *   1. `<cwd>/data/extensions`               — installFromGitHub / installFromGit
 *   2. `<projectRoot>/.ezcorp/extensions`    — author-install.ts
 *   3. `<project.path>/.ezcorp/extensions`   — POST /api/import/commit,
 *      one per row of the `projects` table (`projectPaths`)
 *
 * Callers that can reach the DB pass the registered project paths;
 * callers that cannot (unit tests, CLI before `initDb`) pass nothing and
 * get roots 1–2. Omitting a root only ever costs a refused delete — the
 * files stay and the refusal is logged — so the fallback is fail-closed.
 *
 * Every OTHER `install_path` in the table points at content the host did
 * not create and must never delete: `installFromLocal` stores the path it
 * was handed, so bundled extensions record their GIT-TRACKED source
 * directory (`<root>/docs/extensions/examples/<name>`,
 * `<root>/extensions/<name>`, `<root>/packages/@ezcorp/ai-kit`) and
 * `ezcorp ext install ./my-ext` records the user's own working copy.
 */
export function allowedInstallRoots(projectPaths: readonly string[] = []): string[] {
  return [
    resolve(process.cwd(), downloadedExtensionsDir()),
    resolve(authoredExtensionsDir(getProjectRoot())),
    ...projectPaths.map((path) => resolve(authoredExtensionsDir(path))),
  ];
}

/**
 * True iff `instPath` resolves STRICTLY INSIDE one of
 * {@link allowedInstallRoots} — the containment rule for the uninstall
 * `rm -rf`.
 *
 * `resolve(process.cwd(), …)` before comparing is the whole fix: it is
 * what turns `../../etc` (which the old "doesn't start with `/`, so it
 * must be relative to data/extensions" branch accepted) and
 * `/home/user/extensions/notes` (which the old substring branch accepted)
 * into refusals.
 *
 * `startsWith(root + sep)` is what keeps `data/extensions-backup` out;
 * bare `startsWith(root)` would admit it. The `p !== root` clause is
 * REDUNDANT with that — `"/a/b".startsWith("/a/b" + "/")` is already
 * false, and mutation-testing the clause out leaves the suite green — but
 * it is kept deliberately: it states the "never delete the base itself"
 * intent locally, so a later refactor of the separator handling cannot
 * silently make `install_path = "data/extensions"` mean "delete every
 * installed extension".
 *
 * Deliberately LEXICAL — no `realpath()` — for the general symlinked
 * install case: `rm(path, { recursive, force })` on a symlink unlinks the
 * LINK and leaves its target intact (verified), which is the correct
 * uninstall, whereas resolving first would move the decision onto the
 * target and could authorize deleting a source tree that merely happened
 * to be linked in. (`@ezcorp/ai-kit`'s dev-link flow —
 * `packages/@ezcorp/ai-kit/src/cli/install.ts:217` — is what such a link
 * looks like in this repo; note it writes no DB row, so it is not itself
 * an uninstall path today. ai-kit's row comes from `bundled.ts` and points
 * at `<projectRoot>/packages/@ezcorp/ai-kit`, which this refuses.)
 *
 * Known, unreachable gap: a symlinked root — or a symlinked ANCESTOR of
 * one — would let the `rm` traverse outside the roots. No writer can
 * produce one (every install dir is a single-segment name joined onto a
 * base; `manifest.ts:31` pins installer-side names to
 * `/^[a-z0-9][a-z0-9-_.]{0,63}$/`), and it was equally true of the
 * pre-containment code, so it is a lab curiosity rather than a bypass.
 */
export function isRemovableInstallPath(
  instPath: string | null | undefined,
  projectPaths: readonly string[] = [],
): boolean {
  // Not just defensive: `resolve(cwd, "")` is `cwd`, so a blank
  // `install_path` on a process running from inside an install root would
  // otherwise resolve to "delete my working directory".
  if (typeof instPath !== "string" || instPath.length === 0) return false;
  const p = resolve(process.cwd(), instPath);
  return allowedInstallRoots(projectPaths).some(
    (root) => p !== root && p.startsWith(root + sep),
  );
}

/**
 * Resolve a stored `extensions.install_path` to an on-disk absolute path,
 * against `root` (defaults to {@link getProjectRoot}).
 *
 * BUNDLED extensions record install paths RELATIVE to the project root —
 * exactly the same string as the entry's `path` in `bundled.ts`
 * (`docs/extensions/examples/<name>`, `extensions/<name>`,
 * `packages/@ezcorp/ai-kit`) — precisely so the row is portable: the
 * database is shared between a containerised app (root `/app`) and a
 * host-side process (root = wherever the checkout lives), and an absolute
 * path baked in by whichever one wrote the row is unresolvable from the
 * other. `join(root, instPath)` reconstructs the correct absolute path
 * from WHICHEVER root the CURRENT process resolves — see
 * `../db/migrations/relativize-bundled-install-paths.ts` for the migration
 * that puts existing rows into this shape.
 *
 * An already-absolute `instPath` is returned unchanged — that is the
 * ENTIRE handling for every genuinely external install (GitHub release /
 * git clone under `data/extensions`, `ezcorp ext install <path>`, an
 * imported project's `.ezcorp/extensions`): their on-disk location is not
 * derivable from `root` at all, so there is nothing to reconstruct and
 * nothing to break here.
 *
 * `null`/`undefined`/empty in, `null` out — mirrors the nullable
 * `install_path` column (MCP-kind extensions have none).
 */
export function resolveInstallPath(
  instPath: string | null | undefined,
  root: string = getProjectRoot(),
): string | null {
  if (typeof instPath !== "string" || instPath.length === 0) return null;
  return isAbsolute(instPath) ? instPath : join(root, instPath);
}
