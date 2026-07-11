/**
 * Dev-mode git badge info.
 *
 * Reads the current branch + short commit for the dev indicator badge shown
 * bottom-right in the UI. Gated on EZCORP_DEV_INDICATOR=1 — the same dev
 * container env that stamps `data-dev-indicator` on `<html>` in
 * hooks.server.ts — so it is inert in production. Thin layer over `gitExec`.
 */

import { gitExec } from "./extensions/git";

export interface DevGitInfo {
  branch: string;
  commit: string;
}

/**
 * Current branch + short commit, or null when not in dev mode.
 *
 * `cwd` defaults to EZCORP_PROJECT_ROOT (undefined is fine — gitExec passes it
 * straight through to Bun.spawnSync, which then resolves against the process
 * cwd). Returns null if either rev-parse call fails or yields empty stdout.
 */
export function getDevGitInfo(cwd?: string): DevGitInfo | null {
  if (process.env.EZCORP_DEV_INDICATOR !== "1") return null;

  const dir = cwd ?? process.env.EZCORP_PROJECT_ROOT;
  const branch = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  const commit = gitExec(["rev-parse", "--short", "HEAD"], { cwd: dir });

  if (!branch.ok || !branch.stdout) return null;
  if (!commit.ok || !commit.stdout) return null;

  return { branch: branch.stdout, commit: commit.stdout };
}

/**
 * Escape a string for interpolation into an HTML attribute value. Ampersand is
 * replaced first so the entities introduced afterwards aren't double-escaped.
 */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * `""` when not in dev mode, else a leading-space run of
 * ` data-dev-branch="…" data-dev-commit="…"` (values escaped) ready to splice
 * into the `<html …>` open tag.
 */
export function devIndicatorAttrs(cwd?: string): string {
  const info = getDevGitInfo(cwd);
  if (!info) return "";
  return ` data-dev-branch="${escapeAttr(info.branch)}" data-dev-commit="${escapeAttr(info.commit)}"`;
}

/**
 * The dev-indicator `transformPageChunk` for hooks.server.ts, or undefined
 * when not in dev mode. Stamps `data-dev-indicator` + the git branch/commit
 * attrs on `<html>`, prefixes the title with "DEV " (idempotent — an existing
 * prefix is left alone) and swaps in the dev favicons. hooks.server.ts calls
 * this once per request, right before resolve(), so the git info is fresh on
 * every reload but never re-read per streamed chunk. When git is unavailable
 * the badge attrs are simply omitted while the indicator itself still stamps.
 */
export function devPageTransform(
  cwd?: string,
): (({ html }: { html: string }) => string) | undefined {
  if (process.env.EZCORP_DEV_INDICATOR !== "1") return undefined;
  const attrs = devIndicatorAttrs(cwd);
  return ({ html }) =>
    html
      .replace("<html ", `<html data-dev-indicator="1"${attrs} `)
      .replace(/<title>(?!DEV )([^<]*)<\/title>/g, "<title>DEV $1</title>")
      .replaceAll("/favicon-192.png", "/favicon-dev-192.png")
      .replaceAll("/favicon.ico", "/favicon-dev.ico");
}
