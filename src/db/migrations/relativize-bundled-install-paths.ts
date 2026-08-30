/**
 * Relativize BUNDLED extensions' `install_path` off the current project root.
 *
 * `ensureBundledExtensions()` (src/extensions/bundled.ts) used to persist
 * `install_path` as `join(getProjectRoot(), entry.path)` — an ABSOLUTE path
 * baked in by whichever environment ran the install. `getProjectRoot()`
 * cwd-falls-back to `/app` in the shipped container (no `EZCORP_PROJECT_ROOT`,
 * no `.git` in the image — see `src/extensions/project-root.ts`), so every
 * bundled row installed by a container boot records `/app/docs/extensions/
 * examples/<name>` (or `/app/extensions/<name>`, `/app/packages/@ezcorp/
 * ai-kit`). That path is meaningless to a HOST-side process reading the same
 * (shared, external-Postgres) database: `/app` doesn't exist there, every
 * lookup 404s, and — before the companion fix in
 * `src/extensions/subprocess.ts` — the resulting "Module not found" spawn
 * failures were indistinguishable from a genuine crash-loop and permanently
 * auto-disabled the extensions.
 *
 * The code now persists the RELATIVE `entry.path` instead (matching
 * `getBundledExtensionPath()`'s own return shape) and reconstructs the
 * absolute path per-process via `resolveInstallPath()`
 * (`../../extensions/install-roots.ts`). This migration puts EXISTING rows
 * into that same shape:
 *
 *   install_path  <root>/<entry.path>  →  <entry.path>
 *   source        local:<root>/<entry.path>  →  local:<entry.path>
 *
 * ## Why the root is a PARAMETER, scoped to `is_bundled = true`
 *
 * Same rationale as `./normalize-extension-state-root.ts`: the root is
 * PASSED IN (this deployment's own `getProjectRoot()`), never wildcarded,
 * and matched by literal string comparison (`starts_with`/`substr`), never a
 * regex — a real root can contain characters that would be regex
 * metacharacters. A row recorded under some OTHER root does not match and is
 * left alone (its files are not on THIS disk under either spelling, so
 * rewriting would only destroy the forensic trail; the install-path
 * pre-check in `subprocess.ts` is what keeps that case from silently
 * corrupting extension state either way).
 *
 * `is_bundled = true` is the scoping condition, not a root/shape match on
 * `install_path` alone — a user running `ezcorp ext install ./my-ext` from
 * the project root ends up with an absolute `install_path` that ALSO starts
 * with `<root>/`, and that row must never be touched: its on-disk location
 * genuinely IS environment-specific, and there is no `entry.path` to
 * reconstruct it from.
 *
 * ## Safety properties
 *
 *   - **Fires only on bundled rows.** `is_bundled = true` in the WHERE
 *     clause of both column rewrites.
 *   - **Idempotent.** After the rewrite the value no longer starts with
 *     `<root>/`, so the guard excludes it on every subsequent run. There is
 *     no migration-version table in this codebase (see
 *     docs/features/platform/database-and-migrations.md) — every migration
 *     here is idempotent by construction, not by a ledger.
 *   - **Safe on zero matches.** An `UPDATE ... WHERE <no rows>` is a no-op —
 *     a fresh install (already relative), an already-migrated database, and
 *     a bundled row with a NULL `install_path` (none exist today, but
 *     `IS NOT NULL` guards the case) all pass through untouched.
 *   - **`install_path` and `source` are rewritten independently** (two
 *     UPDATEs), so a row that was hand-repaired on one column but not the
 *     other still converges.
 */
import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * Rewrite `<stalePrefix><remainder>` → `<canonicalPrefix><remainder>` on one
 * column, for BUNDLED rows where the stale prefix is an exact match with a
 * non-empty remainder.
 *
 * `column` is a compile-time literal from this module, never data, so
 * `sql.raw` cannot carry injection. Both prefixes are bound as parameters
 * and compared with literal string functions (`starts_with`/`substr`),
 * never interpolated into a regex — see the module header. Mirrors
 * `./normalize-extension-state-root.ts`'s `rewritePrefix`; `canonicalPrefix`
 * is `""` for `install_path` (nothing survives ahead of the remainder) and
 * `"local:"` for `source` (the scheme survives; only the root segment is
 * stripped).
 */
function rewritePrefixOnBundledRows(
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
    WHERE is_bundled = true
      AND ${col} IS NOT NULL
      AND starts_with(${col}, ${stalePrefix}::text)
      AND length(${col}) > ${staleLen}
  `;
}

/**
 * @param projectRoot Absolute path `getProjectRoot()` resolved to in THIS
 * process. Only bundled rows recorded under exactly this root are rewritten.
 */
export async function up(db: MigrationDb, projectRoot: string): Promise<void> {
  // Tolerate a trailing slash so `/app` and `/app/` build the same prefix
  // instead of a `//docs/...` that matches nothing.
  const root = projectRoot.replace(/\/+$/, "");

  // install_path: <root>/<entry.path> → <entry.path>
  await db.execute(rewritePrefixOnBundledRows("install_path", `${root}/`, ""));

  // source: the `local:` scheme carries the same path behind a prefix.
  // installFromLocal() matches an existing bundled row by this exact
  // string (`source === \`local:${persistPath}\``), so it has to move in
  // lockstep with install_path or the NEXT boot's refresh-in-place check
  // would miss and fork a "different source, same name" error instead. The
  // scheme prefix itself (`local:`) is CANONICAL, not stale — only the root
  // segment after it is stripped.
  await db.execute(rewritePrefixOnBundledRows("source", `local:${root}/`, "local:"));
}
