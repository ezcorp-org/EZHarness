// Fixture helpers for installer.ts unit tests (task #4).
//
// The installer has three entry points — installFromLocal, installFromGit,
// installFromGitHub — and each needs different scaffolding. This module
// centralizes the boilerplate so individual tests can stay short.
//
// NOTE: these helpers build REAL on-disk fixtures, NOT mocks. The installer
// reads the filesystem to load manifest + compute checksums; mocking those
// would couple tests to implementation detail. Network is the one layer we
// mock (installFromGitHub's fetch calls), since hitting real GitHub in unit
// tests is both flaky and against team policy.

import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionManifestV2 } from "../../extensions/types";

// ── Manifest builder ────────────────────────────────────────────────

export function makeManifest(
  overrides: Partial<ExtensionManifestV2> = {},
): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "fixture-ext",
    version: "1.0.0",
    description: "Fixture extension for installer tests",
    author: { name: "test" },
    entrypoint: "./index.ts",
    tools: [
      { name: "noop", description: "noop tool", inputSchema: { type: "object", properties: {} } },
    ],
    permissions: {},
    ...overrides,
  };
}

// ── Local package fixture (installFromLocal) ────────────────────────

export interface LocalPackageFixture {
  path: string; // path to the package root
  cleanup: () => void;
}

/**
 * Build a fully-formed local extension package on disk:
 *   <tmp>/<prefix>/
 *     ezcorp.config.ts   — exports the manifest via defineExtension-compatible shape
 *     index.ts           — the entrypoint file (referenced by manifest.entrypoint)
 *
 * The config.ts shape matches what `loadManifest` expects (see loader.ts).
 */
export function makeLocalPackage(
  manifestOverrides: Partial<ExtensionManifestV2> = {},
  entrypointSource = `export default { name: "noop" };\n`,
): LocalPackageFixture {
  const root = mkdtempSync(join(tmpdir(), "installer-fx-local-"));
  const manifest = makeManifest(manifestOverrides);

  // ezcorp.config.ts — the canonical manifest source. loadManifest() imports
  // this file and expects a default export (or named `config` export) of a
  // ExtensionManifestV2-shaped object. Keep in sync with loader.ts.
  const configTs =
    `export default ${JSON.stringify(manifest, null, 2)} as const;\n`;
  writeFileSync(join(root, "ezcorp.config.ts"), configTs);

  // Entrypoint file — computeChecksum() reads it, so content just has to exist.
  const entrypointRel = manifest.entrypoint!.replace(/^\.\//, "");
  writeFileSync(join(root, entrypointRel), entrypointSource);

  return {
    path: root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ── Fake git repo fixture (installFromGit) ──────────────────────────

export interface GitRepoFixture {
  /** file:// URL suitable for `git clone` */
  url: string;
  /** bare repo path (where clones pull from) */
  barePath: string;
  /** optional ref that was created (tag or branch) */
  ref?: string;
  cleanup: () => void;
}

/**
 * Create an on-disk git repo a test can point installFromGit at. We make a
 * bare repo the installer can clone, seeded from a working tree with the
 * extension package inside it.
 *
 * Expected caller flow:
 *   const fx = await makeGitRepo({ tag: "v1.0.0" });
 *   await installFromGit(fx.url + (fx.ref ? "@" + fx.ref : ""), {...});
 */
export async function makeGitRepo(opts: {
  manifestOverrides?: Partial<ExtensionManifestV2>;
  tag?: string;
  branch?: string;
}): Promise<GitRepoFixture> {
  const root = mkdtempSync(join(tmpdir(), "installer-fx-git-"));
  const workTree = join(root, "work");
  const barePath = join(root, "repo.git");
  mkdirSync(workTree, { recursive: true });

  // Seed the working tree with the package files.
  const pkg = makeLocalPackage(opts.manifestOverrides);
  // Move the contents of pkg.path into workTree. (A copy would work too, but
  // moving avoids orphaned fixtures when tests fail before cleanup.)
  await Bun.$`cp -r ${pkg.path}/. ${workTree}`.quiet();
  pkg.cleanup();

  // Initialize + commit on the working tree.
  await Bun.$`git -C ${workTree} init -q -b main`.quiet();
  await Bun.$`git -C ${workTree} config user.email "test@example.com"`.quiet();
  await Bun.$`git -C ${workTree} config user.name "test"`.quiet();
  await Bun.$`git -C ${workTree} add -A`.quiet();
  await Bun.$`git -C ${workTree} commit -q -m "initial"`.quiet();
  if (opts.tag) await Bun.$`git -C ${workTree} tag ${opts.tag}`.quiet();
  if (opts.branch && opts.branch !== "main") {
    await Bun.$`git -C ${workTree} branch ${opts.branch}`.quiet();
  }

  // Clone --bare so the installer can clone from a URL that looks like a repo.
  await Bun.$`git clone --bare -q ${workTree} ${barePath}`.quiet();

  return {
    url: `file://${barePath}`,
    barePath,
    ref: opts.tag ?? opts.branch,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ── Tarball fixture (installFromGitHub) ─────────────────────────────

export interface TarballFixture {
  tarballPath: string;
  bytes: ArrayBuffer;
  cleanup: () => void;
}

/**
 * Build a .tar.gz containing the extension package, ready to be served by a
 * mocked fetch. installFromGitHub downloads it, extracts with `tar -xzf`,
 * and reads the manifest from the extracted directory.
 */
export async function makeTarball(
  manifestOverrides: Partial<ExtensionManifestV2> = {},
): Promise<TarballFixture> {
  const pkg = makeLocalPackage(manifestOverrides);
  const root = mkdtempSync(join(tmpdir(), "installer-fx-tgz-"));
  const tarballPath = join(root, "release.tar.gz");

  // GitHub tarballs nest content under a top-level directory. We mirror that
  // so `findManifest` recursion in installer.ts works the same way.
  await Bun.$`tar -czf ${tarballPath} -C ${pkg.path} .`.quiet();
  const bytes = await Bun.file(tarballPath).arrayBuffer();
  pkg.cleanup();

  return {
    tarballPath,
    bytes,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ── fetch mock for installFromGitHub ────────────────────────────────

export interface GithubFetchMockOptions {
  /** releases/latest or releases/tags/<tag> JSON */
  release?: {
    tag_name: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
    tarball_url?: string;
  };
  /** the tarball bytes to return for the download URL */
  tarballBytes?: ArrayBuffer;
  /** download URL that tarballBytes should serve */
  tarballUrl?: string;
  /** Override to simulate a failed release fetch */
  releaseStatus?: number;
  /** Override to simulate a failed tarball download */
  tarballStatus?: number;
}

/**
 * Build a stub `fetch` function that responds only to the two URLs the
 * installer calls: the GitHub release-info endpoint and the tarball
 * download URL. Any other URL → 404, so a leaky test fails loudly.
 *
 * Returned callable can be installed via `spyOn(globalThis, "fetch")`
 * or mock.module if the caller prefers.
 */
export function buildGithubFetchStub(
  opts: GithubFetchMockOptions,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("api.github.com/repos/")) {
      if (opts.releaseStatus && opts.releaseStatus >= 400) {
        return new Response("github error", { status: opts.releaseStatus });
      }
      return new Response(JSON.stringify(opts.release ?? {}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (opts.tarballUrl && url === opts.tarballUrl) {
      if (opts.tarballStatus && opts.tarballStatus >= 400) {
        return new Response("download error", { status: opts.tarballStatus });
      }
      return new Response(opts.tarballBytes ?? new ArrayBuffer(0), {
        status: 200,
      });
    }

    return new Response(`unmocked URL: ${url}`, { status: 404 });
  }) as typeof globalThis.fetch;
}

// ── Unwritable-dir helper (#9 regression — cp -r failure path) ──────

import { chmodSync } from "node:fs";

export interface UnwritableDirFixture {
  path: string;
  /** Restore write perms so rm can clean up, then rm. Safe to call twice. */
  cleanup: () => void;
}

/**
 * Create a tmpdir and strip write perms (0o555) so a `cp -r <src> <dst>`
 * into it will fail. Used by #9 regression tests that assert the installer
 * fails loudly instead of silently falling back to the source dir.
 *
 * The cleanup function chmods back to 0o755 before rm so the test teardown
 * can remove the directory. Caller MUST call cleanup() in afterEach.
 *
 * Note on SEC-5 (traversal in manifest.name): `makeManifest({ name: "../x" })`
 * already passes the string through unchanged — spread + JSON.stringify both
 * preserve it — so the installer's validation path sees the raw value and
 * can reject it. No extra helper needed.
 */
export function makeUnwritableDir(): UnwritableDirFixture {
  const path = mkdtempSync(join(tmpdir(), "installer-fx-ro-"));
  chmodSync(path, 0o555);
  let cleaned = false;
  return {
    path,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try { chmodSync(path, 0o755); } catch { /* best effort */ }
      rmSync(path, { recursive: true, force: true });
    },
  };
}
