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
 * Legacy rows record `/app/web/.ezcorp/extensions/<name>` instead —
 * `process.cwd()` under the vite-SSR dev server, NOT the project root.
 * Those were not the residue of an old mount: they were WRITTEN that way.
 * `getExtensionAuthorDraftDir()` (db/queries/ez-drafts.ts) resolved draft
 * dirs by walking up from `process.cwd()` looking for `.git`; the dev
 * container bind-mounts the repo at `/repo`, so there is no `/app/.git`,
 * the walk fell back to its start (`/app/web`), and `author-install.ts`
 * — which derives `installedPath` by walking 6 segments up from the draft
 * dir — installed every authored extension under `/app/web/.ezcorp/`.
 * That resolver now uses `getProjectRoot()`, so no NEW row can take this
 * shape; this migration repairs the ones already written.
 *
 * The dev compose stack bound the host `./.ezcorp/extensions` at the same
 * cwd-anchored path, which is why those installs worked at all. With the
 * bind moved to `/app/.ezcorp/extensions` (where every reader looks),
 * un-repaired rows point at a path that no longer exists.
 *
 * This migration rewrites exactly that stale shape, for the project root
 * THIS deployment actually resolved:
 *
 *   install_path  <root>/web/.ezcorp/extensions/<name>
 *              →  <root>/.ezcorp/extensions/<name>
 *   source  local:<root>/web/.ezcorp/extensions/<name>
 *       →   local:<root>/.ezcorp/extensions/<name>
 *
 * ## Why the root is a PARAMETER, not a wildcard
 *
 * The obvious implementation — `regexp_replace(install_path,
 * '^(.*)/web/\.ezcorp/extensions/([^/]+)$', '\1/.ezcorp/extensions/\2')` —
 * silently corrupts a correct deployment. A row is stale iff the `/web`
 * segment is the dev server's cwd hop, and that is only knowable by
 * comparing against the real root. Under the wildcard, a deployment whose
 * project root simply ENDS in `web` (`getProjectRoot() === "/srv/web"`,
 * i.e. the repo cloned into a dir named `web`) has the perfectly canonical
 * `/srv/web/.ezcorp/extensions/foo` rewritten to
 * `/srv/.ezcorp/extensions/foo` — pointing at nothing, on every boot,
 * with the original value destroyed. Anchoring on `<root>` makes that
 * same row a non-match (its stale shape would be
 * `/srv/web/web/.ezcorp/extensions/foo`) while still matching the real
 * `/app/web/.ezcorp/extensions/<name>` rows under root `/app`.
 *
 * Rows recorded under some OTHER deployment's root are deliberately left
 * alone: their files are not on this disk under either spelling, so
 * rewriting them would trade one dangling path for another while
 * destroying the forensic trail.
 *
 * ## Why string functions instead of a regex
 *
 * `<root>` is interpolated data, so a regex would have to escape it —
 * a real root like `/home/dev/work/EZCorp (v2)/app` contains regex
 * metacharacters and would otherwise match the wrong thing or throw.
 * `starts_with`/`substr`/`strpos` compare literals, so there is nothing
 * to escape: the prefix is matched byte-for-byte and the extension name
 * is carried across verbatim, metacharacters and all.
 *
 * Safety properties:
 *   - **Fires only on the stale shape.** A row must start with exactly
 *     `<root>/web/.ezcorp/extensions/` and have a non-empty remainder
 *     containing no `/` — i.e. exactly one `<name>` segment. Everything
 *     else is untouched: already-canonical rows, `github:`/`mcp:`
 *     sources, bundled rows with a NULL or empty `install_path`, paths
 *     nested deeper than one segment, and any path under a different
 *     root.
 *   - **Idempotent.** After the rewrite the value no longer starts with
 *     the stale prefix, so the guard excludes it on every subsequent
 *     run. Re-running is a no-op by construction, not by a version
 *     ledger — which is the contract for everything in this codebase's
 *     boot migration (there is no migration version table).
 *   - **Safe on zero matches.** An `UPDATE ... WHERE <no rows>` is a
 *     no-op, so fresh databases and already-migrated ones both pass
 *     through without touching a row.
 *
 * Applied automatically from src/db/migrate.ts, which resolves the root
 * via `getProjectRoot()` and skips the call entirely if that resolution
 * fails. This file is the single source of truth for the SQL (migrate.ts
 * calls `up()`, it does not re-inline the statements) and parallels
 * add-user-commands-unique-name.ts.
 */
import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** The cwd hop the dev server added between the project root and `.ezcorp`. */
const STALE_INFIX = "/web/.ezcorp/extensions/";
const CANONICAL_INFIX = "/.ezcorp/extensions/";

/**
 * Rewrite `<stalePrefix><name>` → `<canonicalPrefix><name>` on one column.
 *
 * `column` is a compile-time literal from this module, never data, so
 * `sql.raw` cannot carry injection. Both prefixes are bound as
 * parameters and compared with literal string functions — see the
 * "Why string functions instead of a regex" note above.
 *
 * The three predicates are, in order: the prefix matches; the remainder
 * is non-empty; the remainder is a single path segment. Together they
 * are the literal-comparison equivalent of `^<prefix>([^/]+)$`.
 */
function rewritePrefix(
  column: "install_path" | "source",
  stalePrefix: string,
  canonicalPrefix: string,
): ReturnType<typeof sql> {
  const col = sql.raw(column);
  const staleLen = sql`length(${stalePrefix}::text)`;
  const tail = sql`substr(${col}, ${staleLen} + 1)`;
  return sql`
    UPDATE extensions
    SET ${col} = ${canonicalPrefix}::text || ${tail}
    WHERE starts_with(${col}, ${stalePrefix}::text)
      AND length(${col}) > ${staleLen}
      AND strpos(${tail}, '/') = 0
  `;
}

/**
 * @param projectRoot Absolute path `getProjectRoot()` resolved to. Rows
 * are only rewritten when their stale path sits under exactly this root.
 */
export async function up(db: MigrationDb, projectRoot: string): Promise<void> {
  // Tolerate a trailing slash on the root so `/app` and `/app/` build the
  // same prefix instead of a `//web/...` that matches nothing.
  const root = projectRoot.replace(/\/+$/, "");
  const stale = `${root}${STALE_INFIX}`;
  const canonical = `${root}${CANONICAL_INFIX}`;

  // install_path: <root>/web/.ezcorp/extensions/<name> → <root>/.ezcorp/…
  await db.execute(rewritePrefix("install_path", stale, canonical));

  // source: the `local:` install records the same path behind a scheme
  // prefix. installFromLocal() matches an existing row by this exact
  // string, so it has to move in lockstep with install_path or a
  // reinstall would fork a second row for the same extension.
  await db.execute(
    rewritePrefix("source", `local:${stale}`, `local:${canonical}`),
  );
}
