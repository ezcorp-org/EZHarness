/**
 * Normalize legacy extension install paths off the cwd-anchored root.
 *
 * Extension state is anchored to `getProjectRoot()`
 * (src/extensions/bundled.ts) — it resolves via an `import.meta.dir`
 * containing `src/extensions`, so it returns the directory that HOLDS
 * `src/` (`/app` in the container). `registry.ts` injects that value into
 * every sandbox as `EZCORP_EXTENSION_DATA_ROOT`, and `author-install.ts`
 * derives `installedPath` by walking up from a draft dir under the same
 * root. The canonical location is therefore:
 *
 *   <projectRoot>/.ezcorp/extensions/<name>
 *
 * The dev compose stack used to bind the host `./.ezcorp/extensions` at
 * `/app/web/.ezcorp/extensions` — `process.cwd()` under the vite-SSR dev
 * server, NOT the project root. Extensions installed while that bind was
 * live recorded the cwd-anchored path in `extensions.install_path` and in
 * the matching `local:`-prefixed `extensions.source`. Once the bind moves
 * to `/app/.ezcorp/extensions` (where the code already looks), those rows
 * point at a path that no longer exists and the extensions fail to load.
 *
 * This migration rewrites exactly that stale shape:
 *
 *   install_path  <X>/web/.ezcorp/extensions/<name>
 *              →  <X>/.ezcorp/extensions/<name>
 *   source  local:<X>/web/.ezcorp/extensions/<name>
 *       →   local:<X>/.ezcorp/extensions/<name>
 *
 * Deployment-agnostic by construction: `<X>` is captured, never assumed,
 * so no `/app` (or any other root) is hardcoded — the same statement is
 * correct for a container, a bare-metal install, or a test fixture.
 *
 * Safety properties:
 *   - **Fires only on the stale shape.** The `~` guard + the `[^/]+$`
 *     anchor mean a path must end in exactly one `<name>` segment under
 *     `/web/.ezcorp/extensions/`. Anything else (already-canonical rows,
 *     `github:`/`mcp:` sources, bundled rows with NULL install_path, an
 *     unrelated directory that merely contains `web`) is left untouched.
 *   - **Idempotent.** After the rewrite the value no longer contains
 *     `/web/.ezcorp/extensions/`, so the guard excludes it on every
 *     subsequent run. Re-running is a no-op by construction, not by a
 *     version ledger — which is the contract for everything in this
 *     codebase's boot migration (there is no migration version table).
 *   - **Safe on zero matches.** An `UPDATE ... WHERE <no rows>` is a
 *     no-op, so fresh databases and already-migrated ones both pass
 *     through without touching a row.
 *
 * Applied automatically from src/db/migrate.ts. This file is the single
 * source of truth for the SQL (migrate.ts calls `up()`, it does not
 * re-inline the statements) and parallels
 * add-user-commands-unique-name.ts.
 */
import { sql } from "drizzle-orm";

/**
 * POSIX-regex fragments. `\\.` keeps the dot in `.ezcorp` literal, and
 * `([^/]+)$` anchors the match to exactly ONE trailing name segment so
 * nothing deeper than `<root>/web/.ezcorp/extensions/<name>` can match.
 * `\\1` / `\\2` are backreferences to the captured deployment root and
 * extension name — both are preserved verbatim, which is what keeps this
 * migration deployment-agnostic.
 */
const STALE_INFIX = "/web/\\.ezcorp/extensions/";
const CANONICAL_SUB = "/.ezcorp/extensions/";
const INSTALL_PATH_MATCH = `^(.*)${STALE_INFIX}([^/]+)$`;
const INSTALL_PATH_SUB = `\\1${CANONICAL_SUB}\\2`;
const SOURCE_MATCH = `^local:(.*)${STALE_INFIX}([^/]+)$`;
const SOURCE_SUB = `local:\\1${CANONICAL_SUB}\\2`;

export async function up(db: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<void> {
  // install_path: <X>/web/.ezcorp/extensions/<name> → <X>/.ezcorp/…
  await db.execute(sql`
    UPDATE extensions
    SET install_path = regexp_replace(install_path, ${INSTALL_PATH_MATCH}, ${INSTALL_PATH_SUB})
    WHERE install_path ~ ${INSTALL_PATH_MATCH}
  `);

  // source: the `local:` install records the same path behind a scheme
  // prefix. installFromLocal() matches an existing row by this exact
  // string, so it has to move in lockstep with install_path or a
  // reinstall would fork a second row for the same extension.
  await db.execute(sql`
    UPDATE extensions
    SET source = regexp_replace(source, ${SOURCE_MATCH}, ${SOURCE_SUB})
    WHERE source ~ ${SOURCE_MATCH}
  `);
}
