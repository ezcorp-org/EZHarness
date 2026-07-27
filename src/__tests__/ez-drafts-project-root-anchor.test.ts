import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExtensionAuthorDraftDir } from "../db/queries/ez-drafts";
import { getProjectRoot, __resetProjectRootCacheForTests } from "../extensions/bundled";

/**
 * Regression: extension-author draft dirs must anchor on getProjectRoot(),
 * never on process.cwd().
 *
 * This is the source of the legacy `/app/web/.ezcorp/extensions/<name>`
 * rows, and it is worth being precise about, because the obvious story is
 * wrong. Those rows were NOT the residue of a stale mount — they were
 * being written by live code:
 *
 *   getExtensionAuthorDraftDir() used a `.git` walk-up from process.cwd().
 *   In the dev container the repo is bind-mounted at /repo, so there is no
 *   /app/.git; the walk ran to / without a hit and fell back to its start,
 *   process.cwd() = /app/web under the vite-SSR dev server. author-install
 *   then derives installedPath by walking 6 segments up from the draft
 *   dir, so every authored extension installed to
 *   /app/web/.ezcorp/extensions/<name> — while registry.ts hands sandboxes
 *   EZCORP_EXTENSION_DATA_ROOT=/app and permissions.ts expands $CWD to
 *   /app.
 *
 * Moving the compose bind alone would not have fixed that: the next
 * authored install would recreate the stale path. So this asserts the
 * property directly — the draft root tracks getProjectRoot() and is
 * immune to cwd.
 */

let savedEnv: string | undefined;
let root = "";

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ezd-anchor-")));
  // getProjectRoot() only accepts an env root that looks like the repo.
  mkdirSync(join(root, "docs", "extensions", "examples"), { recursive: true });
  savedEnv = process.env.EZCORP_PROJECT_ROOT;
  process.env.EZCORP_PROJECT_ROOT = root;
  __resetProjectRootCacheForTests();
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env.EZCORP_PROJECT_ROOT;
  else process.env.EZCORP_PROJECT_ROOT = savedEnv;
  __resetProjectRootCacheForTests();
  if (root) try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});

const DRAFT = "draft-abc";
const USER = "user-1";

function expectedDir(base: string): string {
  return join(base, ".ezcorp/extension-data/extension-author/drafts", USER, DRAFT);
}

describe("extension-author draft dirs anchor on the project root", () => {
  test("resolves under getProjectRoot(), not the process cwd", () => {
    expect(getProjectRoot()).toBe(root);
    expect(getExtensionAuthorDraftDir(DRAFT, USER)).toBe(expectedDir(root));
  });

  test("a chdir does not move the draft dir", () => {
    // The old `.git` walk-up started at process.cwd(), so chdir'ing into a
    // marker-free dir relocated every draft. Now it cannot.
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "ezd-cwd-")));
    const prev = process.cwd();
    try {
      process.chdir(elsewhere);
      expect(getExtensionAuthorDraftDir(DRAFT, USER)).toBe(expectedDir(root));
    } finally {
      process.chdir(prev);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("the derived install path is a sibling of extension-data, under the same root", () => {
    // author-install.ts walks 6 segments up from the draft dir to get the
    // root it joins `.ezcorp/extensions/<name>` onto. Reproduce that walk
    // so a change to the draft-dir DEPTH is caught here rather than by a
    // wrong install_path in production.
    const draftDir = getExtensionAuthorDraftDir(DRAFT, USER);
    const derived = join(draftDir, "..", "..", "..", "..", "..", "..");
    expect(join(derived)).toBe(root);
    expect(join(derived, ".ezcorp/extensions", "my-ext")).toBe(
      join(root, ".ezcorp/extensions/my-ext"),
    );
  });

  test("an explicit projectRoot argument still wins", () => {
    // The sweep passes a resolved root explicitly; that must not regress.
    expect(getExtensionAuthorDraftDir(DRAFT, USER, "/srv/custom")).toBe(
      expectedDir("/srv/custom"),
    );
  });
});
