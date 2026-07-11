/**
 * Tests for src/dev-git-info.ts — the dev-mode git badge info reader.
 *
 * getDevGitInfo is gated on EZCORP_DEV_INDICATOR=1; the on-path runs real
 * `git rev-parse` against this worktree (no mock.module). escapeAttr and
 * devIndicatorAttrs are pure string builders exercised on both branches.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devIndicatorAttrs, devPageTransform, escapeAttr, getDevGitInfo } from "../dev-git-info";

// This test file lives at <worktree>/src/__tests__/; that dir is inside a real
// git working tree, so `git rev-parse` (which walks up) succeeds from here.
const REPO_DIR = import.meta.dir;

const SAVED_ENV_KEYS = [
  "EZCORP_DEV_INDICATOR",
  "EZCORP_PROJECT_ROOT",
  "EZCORP_SELF_PROJECT_PATH",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(SAVED_ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("getDevGitInfo", () => {
  test("returns null when EZCORP_DEV_INDICATOR is not '1'", () => {
    delete process.env.EZCORP_DEV_INDICATOR;
    expect(getDevGitInfo(REPO_DIR)).toBeNull();
  });

  test("returns real branch + short commit for a repo cwd in dev mode", () => {
    process.env.EZCORP_DEV_INDICATOR = "1";
    const info = getDevGitInfo(REPO_DIR);
    expect(info).not.toBeNull();
    expect(typeof info!.branch).toBe("string");
    expect(info!.branch.length).toBeGreaterThan(0);
    expect(info!.commit).toMatch(/^[0-9a-f]+$/);
  });

  test("returns null when cwd is not a git repository", () => {
    process.env.EZCORP_DEV_INDICATOR = "1";
    const dir = mkdtempSync(join(tmpdir(), "dev-git-info-"));
    try {
      expect(getDevGitInfo(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without cwd, EZCORP_PROJECT_ROOT takes precedence", () => {
    process.env.EZCORP_DEV_INDICATOR = "1";
    process.env.EZCORP_PROJECT_ROOT = REPO_DIR;
    // Would fail if the (broken) self path were consulted first.
    process.env.EZCORP_SELF_PROJECT_PATH = "/nonexistent-self-path";
    expect(getDevGitInfo()).not.toBeNull();
  });

  test("without cwd or EZCORP_PROJECT_ROOT, falls back to EZCORP_SELF_PROJECT_PATH", () => {
    // The compose dev container case: /app has no .git, but the full
    // checkout is the self-project mount (/repo).
    process.env.EZCORP_DEV_INDICATOR = "1";
    delete process.env.EZCORP_PROJECT_ROOT;
    process.env.EZCORP_SELF_PROJECT_PATH = REPO_DIR;
    const info = getDevGitInfo();
    expect(info).not.toBeNull();
    expect(info!.commit).toMatch(/^[0-9a-f]+$/);
  });
});

describe("escapeAttr", () => {
  test('escapes &, <, >, " with ampersand first', () => {
    expect(escapeAttr('a&<>"b')).toBe("a&amp;&lt;&gt;&quot;b");
  });
});

describe("devIndicatorAttrs", () => {
  test("returns '' when not in dev mode", () => {
    delete process.env.EZCORP_DEV_INDICATOR;
    expect(devIndicatorAttrs(REPO_DIR)).toBe("");
  });

  test("returns escaped data attrs when in dev mode", () => {
    process.env.EZCORP_DEV_INDICATOR = "1";
    const attrs = devIndicatorAttrs(REPO_DIR);
    expect(attrs).toContain(' data-dev-branch="');
    expect(attrs).toContain(' data-dev-commit="');
    // Values pass through escapeAttr — the escaped forms appear verbatim.
    const info = getDevGitInfo(REPO_DIR)!;
    expect(attrs).toContain(escapeAttr(info.branch));
    expect(attrs).toContain(escapeAttr(info.commit));
  });
});

describe("devPageTransform", () => {
  test("returns undefined when not in dev mode", () => {
    delete process.env.EZCORP_DEV_INDICATOR;
    expect(devPageTransform(REPO_DIR)).toBeUndefined();
  });

  test("stamps dev attrs, DEV title and dev favicons in dev mode", () => {
    process.env.EZCORP_DEV_INDICATOR = "1";
    const transform = devPageTransform(REPO_DIR);
    expect(transform).toBeDefined();
    const out = transform!({
      html:
        '<html lang="en"><head><title>EZCorp | AI Platform</title>' +
        '<link href="/favicon.ico" /><link href="/favicon-192.png" /></head>',
    });
    expect(out).toContain('<html data-dev-indicator="1" data-dev-branch="');
    expect(out).toContain(' data-dev-commit="');
    expect(out).toContain('lang="en"');
    expect(out).toContain("<title>DEV EZCorp | AI Platform</title>");
    expect(out).toContain('href="/favicon-dev.ico"');
    expect(out).toContain('href="/favicon-dev-192.png"');
    // Badge values ride through escaped, same as devIndicatorAttrs.
    const info = getDevGitInfo(REPO_DIR)!;
    expect(out).toContain(escapeAttr(info.branch));
    expect(out).toContain(escapeAttr(info.commit));
  });

  test("leaves an already-prefixed DEV title untouched", () => {
    process.env.EZCORP_DEV_INDICATOR = "1";
    const transform = devPageTransform(REPO_DIR)!;
    expect(transform({ html: "<title>DEV EZCorp</title>" })).toBe(
      "<title>DEV EZCorp</title>",
    );
  });
});
