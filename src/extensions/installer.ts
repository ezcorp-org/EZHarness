/**
 * Extension installer — local, GitHub release, and git-based install support.
 */

import type { ExtensionManifestV2, ExtensionPermissions, InstalledExtension } from "./types";
import { compareVersions } from "./manifest";
import { loadManifest } from "./loader";
import { resolveDependencies, formatDepTree } from "./dependency-resolver";
import { computeChecksum, verifyChecksum, computePackageChecksums } from "./checksum";
import { parseSource } from "./source-parser";
import { clone, lsRemoteTags, gitExec } from "./git";
import { ExtensionRegistry } from "./registry";
import {
  runEntityNamespaceMigration,
  type LegacyNamespaceMapping,
} from "./entities/migrate";
import { runEntitySeed } from "./entities/seed";
import {
  createExtension,
  getExtensionByName,
  updateExtension as dbUpdateExtension,
  deleteExtension,
} from "../db/queries/extensions";
import { join } from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// ── Local Install ───────────────────────────────────────────────────

/**
 * v1.4 install-gate options. The bundled-install caller passes
 * `isBundled: true` + the entry's `envEscapeHatch` flag so the gate
 * can allow credential-shaped env grants on the small set of
 * bundled extensions that use them today (`web-search`,
 * `openai-image-gen-2`, `ai-kit`). User installs always pass
 * `isBundled: false` and never hit the escape-hatch branch.
 *
 * Plumbing: explicit parameter (option 4a in the v1.4 spec) rather
 * than reading the manifest, so the caller's `isBundled` decision is
 * the single source of truth — manifests can't smuggle in a bundled
 * trust claim.
 */
export interface InstallFromLocalOpts {
  /** Defaults to false; bundled-install path passes true. */
  isBundled?: boolean;
  /** Defaults to false; bundled-install path passes the entry's
   *  per-manifest opt-in. Ignored when `isBundled` is false. */
  envEscapeHatch?: boolean;
  /**
   * Optional pre-loaded manifest. When provided, `installFromLocal`
   * skips its internal `loadManifest(localPath)` call and trusts the
   * caller-supplied object. This exists for callers (e.g. the
   * extension-author install endpoint) that already loaded the
   * manifest for pre-install validation and would otherwise force a
   * second `await import("ezcorp.config.ts")` — which re-evaluates the
   * extension's `index.ts` top-level code. Scaffolded tool extensions
   * grab `Bun.stdin.stream().getReader()` at top level, and re-import
   * cache-misses after a dir rename, producing
   * `TypeError: ReadableStream is locked` on the second read.
   *
   * Caller responsibility: the manifest must correspond to the same
   * on-disk content at `localPath` (typically the SAME object the
   * caller produced from `loadManifest(localPath)` minutes ago — the
   * `entrypoint` is a relative string, so dir renames are safe).
   */
  preloadedManifest?: ExtensionManifestV2;
  /**
   * Acting user id for entity seed (`scope: "user"` declarations).
   * Bundled boot-time installs pass `null` — seeds run lazily on first
   * access for those. User-driven installs always pass the installing
   * user. Phase 3 wiring; the field is forwarded into `runEntitySeed`.
   */
  userId?: string | null;
  /**
   * Legacy-namespace mappings to migrate at install time. The
   * substack-pilot port (Phase 7) supplies the `post-type:*` → managed
   * mapping here. Other extensions installing for the first time pass
   * an empty array (Phase 3 default) — the renamer is a no-op when
   * no rows match the legacy prefix.
   */
  legacyEntityMappings?: readonly LegacyNamespaceMapping[];
}

/**
 * v1.4 — run the credential-shaped env-name install gate against a
 * parsed manifest. Source-of-truth is `manifest.permissions.env` (the
 * extension's REQUEST), not the caller's `grantedPermissions.env`
 * (which is empty at user-install time — grants happen later, at
 * activate time). Reading the manifest matches the actual threat
 * model: refuse to persist an extension that DECLARES a credential-
 * shaped env name regardless of whether grants are populated yet.
 *
 * Throws `EnvKeyLeakInstallError` when the gate denies; returns
 * silently when the install may proceed. Audit rows are written
 * inside `checkEnvKeyLeakInstallGate` (one per leaked name).
 */
async function runEnvKeyLeakInstallGate(
  manifest: ExtensionManifestV2,
  opts: InstallFromLocalOpts,
): Promise<void> {
  const { checkEnvKeyLeakInstallGate } = await import("./clamp-permissions");
  const gateError = await checkEnvKeyLeakInstallGate(
    manifest.name,
    manifest.permissions?.env,
    {
      isBundled: opts.isBundled === true,
      envEscapeHatch: opts.envEscapeHatch === true,
    },
  );
  if (gateError) throw gateError;
}

/**
 * Phase 3 entity-install hook. Runs the legacy-namespace migration and
 * the seed loop after the extension row is created. Best-effort:
 * failures are surfaced into the install warning log but do NOT abort
 * the install — the user's data still lives at its source keys (the
 * migration is idempotent and can re-run on a later install). Same
 * for seed: a partial seed leaves the install enabled (subsequent
 * installs idempotently fill in the missing slugs).
 *
 * Caller supplies the installing user's id when known (user-driven
 * installs); bundled boot-time installs pass null and the seed loop
 * defers user-scoped records to first access.
 */
async function runEntityInstallHooks(
  extensionId: string,
  installDir: string,
  manifest: ExtensionManifestV2,
  opts: { userId: string | null; legacyEntityMappings?: readonly LegacyNamespaceMapping[] },
): Promise<void> {
  // 1) Migration first — must run before any SDK-served read so the
  //    auto-table sees the migrated namespace from its first call.
  const mappings = opts.legacyEntityMappings ?? [];
  if (mappings.length > 0) {
    try {
      await runEntityNamespaceMigration({
        extensionId,
        mappings,
      });
    } catch (err) {
      // Log + continue. Source keys are intact by contract.
      console.warn(
        `[installer] entity namespace migration failed for ${manifest.name}: ${(err as Error).message}`,
      );
    }
  }
  // 2) Seed — idempotent per-slug.
  if (manifest.entities && manifest.entities.length > 0) {
    try {
      await runEntitySeed({
        extensionId,
        entities: manifest.entities,
        sourceDir: installDir,
        userId: opts.userId,
      });
    } catch (err) {
      console.warn(
        `[installer] entity seed failed for ${manifest.name}: ${(err as Error).message}`,
      );
    }
  }
}

export async function installFromLocal(
  localPath: string,
  grantedPermissions: ExtensionPermissions,
  enabled = false,
  opts: InstallFromLocalOpts = {},
): Promise<InstalledExtension> {
  // Read manifest (or trust the caller-supplied one). The preloaded
  // path exists to avoid a second top-level evaluation of the
  // extension's entrypoint when the caller already loaded the manifest
  // for pre-install validation — see `InstallFromLocalOpts.preloadedManifest`.
  const manifest = opts.preloadedManifest ?? (await loadManifest(localPath));

  // Compute checksum of entrypoint (entrypoint may be optional in v2 for non-tool packages)
  if (!manifest.entrypoint) {
    throw new Error("Cannot install extension without entrypoint");
  }
  const entrypointPath = join(localPath, manifest.entrypoint.replace(/^\.\//, ""));
  const checksum = await computeChecksum(entrypointPath);

  // Compute full-package checksums
  const packageChecksums = await computePackageChecksums(localPath);

  // v1.4 — hard install-time gate for credential-shaped env grants.
  // Run BEFORE `createExtension` so a refused install never persists a
  // row (audit-log writes its forensic trail keyed on manifest name).
  // Bundled extensions with `envEscapeHatch: true` are allowed and
  // emit `ENV_KEY_LEAK_BUNDLED_ESCAPE_HATCH_USED`; everything else
  // throws `EnvKeyLeakInstallError` and the caller surfaces it.
  // Reads the MANIFEST'S declared env, not `grantedPermissions.env`
  // (which is empty for user installs — grants populate at activate
  // time). The threat model is "refuse to persist this extension at
  // all" once it declares a credential-shaped env name.
  await runEnvKeyLeakInstallGate(manifest, opts);

  const source = `local:${localPath}`;

  // Idempotency gate: `ext install <path>` (CLI, author endpoint, and
  // bundled-install all route through here) used to do a bare INSERT
  // and throw a raw `Failed query: insert into "extensions"` unique
  // error on the second run. A blocked in-app agent rationalized that
  // SQL error as "expected" and looped. Mirror the clean dup-error
  // pattern already used by `installFromGit` (~line 409): look up the
  // existing row by name FIRST, then branch on source.
  const existing = await getExtensionByName(manifest.name);
  if (existing) {
    if (existing.source === source) {
      // Same source — refresh in place. Preserve `enabled` and the
      // user's granted permissions (re-installing the same path is an
      // upgrade, not a consent reset). The S6/S9 gates remain the only
      // permission-escalation paths. Do NOT re-run entity install
      // hooks here — a second seed would double-write declared records.
      const refreshed = await dbUpdateExtension(existing.id, {
        version: manifest.version,
        description: manifest.description || "",
        manifest: { ...manifest, checksum, packageChecksums },
        installPath: localPath,
        checksumVerified: true,
      });
      // Registry must observe the refreshed manifest (tool schema fixes
      // etc.). Swallow reload failures the same way the other install
      // paths do — test environments without a live DB still pass.
      try {
        await ExtensionRegistry.getInstance().reload();
      } catch {
        // Registry reload may fail in test environments without DB
      }
      console.log(
        `[installer] Extension "${manifest.name}": already installed from same source — refreshed`,
      );
      return (refreshed ?? existing) as unknown as InstalledExtension;
    }
    // Different source, same name → clean error (not raw SQL). Same
    // string shape as the installFromGit collision branch.
    throw new Error(
      `Extension "${manifest.name}" is already installed (source: ${existing.source})`,
    );
  }

  // Create DB record
  const ext = await createExtension({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description || "",
    manifest: { ...manifest, checksum, packageChecksums },
    source,
    installPath: localPath,
    enabled,
    grantedPermissions,
    checksumVerified: true,
    consecutiveFailures: 0,
  });

  // Phase 3: entity install hooks (migrate legacy namespace + seed
  // declared records). Runs AFTER `createExtension` so the extension
  // row exists for the seed writes to reference; failures are logged
  // but never abort the install.
  await runEntityInstallHooks(ext.id, localPath, manifest, {
    userId: opts.userId ?? null,
    legacyEntityMappings: opts.legacyEntityMappings,
  });

  return ext as unknown as InstalledExtension;
}

// ── GitHub Install ──────────────────────────────────────────────────

function parseRepoSpec(repoSpec: string): { owner: string; repo: string; tag?: string } {
  const [ownerRepo, tag] = repoSpec.split("@");
  const [owner, repo] = ownerRepo!.split("/");
  if (!owner || !repo) throw new Error(`Invalid repo spec: ${repoSpec}. Expected "user/repo" or "user/repo@tag"`);
  return { owner, repo, tag };
}

export async function installFromGitHub(
  repoSpec: string,
  grantedPermissions: ExtensionPermissions,
  enabled = false,
): Promise<InstalledExtension> {
  const { owner, repo, tag } = parseRepoSpec(repoSpec);

  // Fetch release info
  const releaseUrl = tag
    ? `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`
    : `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

  const releaseRes = await fetch(releaseUrl, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!releaseRes.ok) throw new Error(`Failed to fetch release: ${releaseRes.statusText}`);

  const release = (await releaseRes.json()) as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
    tarball_url?: string;
  };

  // Find tarball asset
  const tarballAsset = release.assets.find(
    (a) => a.name.endsWith(".tar.gz") || a.name.endsWith(".tgz"),
  );
  const tarballUrl = tarballAsset?.browser_download_url ?? release.tarball_url;
  if (!tarballUrl) throw new Error("No tarball found in release");

  // Download and extract
  const tempDir = await mkdtemp(join(tmpdir(), "ext-gh-install-"));
  try {
    const tarPath = join(tempDir, "release.tar.gz");

    const tarRes = await fetch(tarballUrl);
    if (!tarRes.ok) throw new Error(`Failed to download tarball: ${tarRes.statusText}`);
    await Bun.write(tarPath, await tarRes.arrayBuffer());

    // Extract
    const extractProc = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", tempDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (extractProc.exitCode !== 0) {
      const stderr = extractProc.stderr?.toString().trim() ?? "";
      throw new Error(`Failed to extract tarball: ${stderr || "tar exited non-zero"}`);
    }

    // Find manifest in extracted content — look for ezcorp.config.ts recursively
    const configPath = await findManifest(tempDir);
    if (!configPath) throw new Error("No ezcorp.config.ts found in extracted tarball");

    const manifestDir = join(configPath, "..");
    const manifest = await loadManifest(manifestDir);

    // v1.4 — hard install-time gate for credential-shaped env grants.
    // GitHub installs are user installs by definition (no bundled
    // path passes through here), so `isBundled: false`. Run BEFORE
    // any persistence (no DB row, no install-dir copy) so a refused
    // install leaves zero residue beyond the audit row written
    // inside `checkEnvKeyLeakInstallGate`.
    await runEnvKeyLeakInstallGate(manifest, { isBundled: false });

    // Verify checksum if provided
    if (!manifest.entrypoint) {
      throw new Error("Cannot install extension without entrypoint");
    }
    const entrypointPath = join(manifestDir, manifest.entrypoint.replace(/^\.\//, ""));
    if (manifest.checksum) {
      const valid = await verifyChecksum(entrypointPath, manifest.checksum);
      if (!valid) throw new Error("Checksum mismatch: entrypoint file does not match manifest checksum");
    }

    // Compute checksum for storage
    const checksum = await computeChecksum(entrypointPath);

    // Copy to persistent install directory. Fail loudly — no silent fallback:
    // if this fails, the later temp-dir cleanup would leave a broken install.
    const extBase = join("data", "extensions");
    await mkdir(extBase, { recursive: true });
    const installDir = join(extBase, manifest.name);
    const copyProc = Bun.spawnSync(["cp", "-r", manifestDir, installDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (copyProc.exitCode !== 0) {
      const stderr = copyProc.stderr?.toString().trim() ?? "";
      throw new Error(
        `Failed to copy extension from ${manifestDir} to ${installDir}: ${stderr || "cp exited non-zero"}`,
      );
    }

    // Compute full-package checksums
    const packageChecksums = await computePackageChecksums(installDir);

    // Create DB record
    const ext = await createExtension({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description || "",
      manifest: { ...manifest, checksum, packageChecksums },
      source: `github:${repoSpec}@${release.tag_name}`,
      installPath: installDir,
      enabled,
      grantedPermissions,
      checksumVerified: !!manifest.checksum,
      consecutiveFailures: 0,
    });

    // Phase 3: entity install hooks. GitHub installs are user-driven
    // but the current callers don't thread the acting user id; pass
    // null so seed loops defer user-scoped records to first access.
    // Phase 7's substack-pilot mappings are scoped to the bundled
    // install path, so GitHub installs always see an empty mapping
    // list — the migration is a no-op.
    await runEntityInstallHooks(ext.id, installDir, manifest, {
      userId: null,
      legacyEntityMappings: [],
    });

    return ext as unknown as InstalledExtension;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Git Install ─────────────────────────────────────────────────────

export interface GitInstallOptions {
  /** Override the base directory for extension installs (for testing). */
  extensionsDir?: string;
  /** Skip registry reload after install (for batch dependency installs). */
  skipReload?: boolean;
  /** Override the install directory name (for multi-version installs). */
  nameOverride?: string;
  /** Callback to prompt user for permission approval before install. */
  onPermissionPrompt?: (manifest: ExtensionManifestV2) => Promise<ExtensionPermissions>;
  /** Enable the extension on install (default: false — requires explicit approval). */
  enabled?: boolean;
}

export async function installFromGit(
  sourceStr: string,
  grantedPermissions: ExtensionPermissions,
  opts?: GitInstallOptions,
): Promise<InstalledExtension> {
  const parsed = parseSource(sourceStr);
  const tempDir = await mkdtemp(join(tmpdir(), "ext-git-install-"));

  const cloneDest = join(tempDir, "repo");

  try {
    // Clone
    const cloneOpts: { depth?: number; branch?: string } = { depth: 1 };
    if (parsed.ref) cloneOpts.branch = parsed.ref;
    const cloneResult = clone(parsed.cloneUrl, cloneDest, cloneOpts);
    if (!cloneResult.ok) {
      throw new Error(`Git clone failed: ${cloneResult.stderr}`);
    }

    // Read and validate manifest
    const manifest = await loadManifest(cloneDest);

    // v1.4 — hard install-time gate for credential-shaped env grants.
    // Git installs are user installs by definition (no bundled path
    // passes through here), so `isBundled: false`. Run BEFORE the
    // permission-prompt callback so a refused install never bothers
    // the user with a permission UI it would never honor anyway.
    await runEnvKeyLeakInstallGate(manifest, { isBundled: false });

    // Prompt for permissions if callback provided (before install)
    let effectivePermissions = grantedPermissions;
    if (opts?.onPermissionPrompt) {
      effectivePermissions = await opts.onPermissionPrompt(manifest);
    }

    // Check name collision (use override name for multi-version installs)
    const installName = opts?.nameOverride ?? manifest.name;
    const existing = await getExtensionByName(installName);
    if (existing) {
      throw new Error(
        `Extension "${installName}" is already installed (source: ${existing.source})`,
      );
    }

    // Move to persistent install directory
    const extBase = opts?.extensionsDir ?? join("data", "extensions");
    const installDir = join(extBase, installName);
    const mvProc = Bun.spawnSync(["mv", cloneDest, installDir], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (mvProc.exitCode !== 0) {
      const stderr = mvProc.stderr?.toString().trim() ?? "";
      throw new Error(
        `Failed to move extension from ${cloneDest} to ${installDir}: ${stderr || "mv exited non-zero"}`,
      );
    }

    // Compute checksum if entrypoint exists
    let checksum: string | undefined;
    if (manifest.entrypoint) {
      const epPath = join(installDir, manifest.entrypoint.replace(/^\.\//, ""));
      checksum = await computeChecksum(epPath);
    }

    // Compute full-package checksums
    const packageChecksums = await computePackageChecksums(installDir);

    // Create DB record
    const ext = await createExtension({
      name: installName,
      version: manifest.version,
      description: manifest.description || "",
      manifest: checksum ? { ...manifest, checksum, packageChecksums } : { ...manifest, packageChecksums },
      source: sourceStr,
      installPath: installDir,
      enabled: opts?.enabled ?? false,
      grantedPermissions: effectivePermissions,
      checksumVerified: !!checksum,
      consecutiveFailures: 0,
    });

    // Phase 3: entity install hooks for git installs. Same rationale
    // as installFromGitHub — no acting user id threaded today; seeds
    // for user-scoped entities defer to first access.
    await runEntityInstallHooks(ext.id, installDir, manifest, {
      userId: null,
      legacyEntityMappings: [],
    });

    if (!opts?.skipReload) {
      try {
        await ExtensionRegistry.getInstance().reload();
      } catch {
        // Registry reload may fail in test environments without DB
      }
    }

    return ext as unknown as InstalledExtension;
  } catch (err) {
    // Clean up on failure
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    // Clean up temp dir (the repo was moved out if successful)
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Update Extension ────────────────────────────────────────────────

export async function updateExtension(
  name: string,
): Promise<{ from: string; to: string }> {
  const ext = await getExtensionByName(name);
  if (!ext) {
    throw new Error(`Extension "${name}" not found`);
  }

  if (ext.source.startsWith("local:")) {
    throw new Error(`Cannot update local extension "${name}". Reinstall from source instead.`);
  }

  if (ext.source.startsWith("mcp:") || !ext.installPath) {
    throw new Error(`Cannot update MCP extension "${name}" via git. Use the refresh endpoint instead.`);
  }

  const installPath = ext.installPath;

  const parsed = parseSource(ext.source);
  const tags = lsRemoteTags(parsed.cloneUrl);

  // Filter to semver tags and sort descending
  const semverTags = tags
    .map((t) => ({ raw: t, version: t.replace(/^v/, "") }))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t.version))
    .sort((a, b) => compareVersions(b.version, a.version));

  if (semverTags.length === 0) {
    throw new Error(`No semver tags found for "${name}"`);
  }

  const latest = semverTags[0]!;
  if (compareVersions(latest.version, ext.version) <= 0) {
    throw new Error(`"${name}" is already at latest version (${ext.version})`);
  }

  // Fetch and checkout latest tag
  gitExec(["fetch", "--tags"], { cwd: installPath });
  const checkoutResult = gitExec(["checkout", latest.raw], { cwd: installPath });
  if (!checkoutResult.ok) {
    throw new Error(`Failed to checkout ${latest.raw}: ${checkoutResult.stderr}`);
  }

  // Re-validate manifest after checkout
  const manifest = await loadManifest(installPath);

  // Recompute checksum
  let checksum: string | undefined;
  if (manifest.entrypoint) {
    const epPath = join(installPath, manifest.entrypoint.replace(/^\.\//, ""));
    checksum = await computeChecksum(epPath);
  }

  const oldVersion = ext.version;

  // Update DB
  await dbUpdateExtension(ext.id, {
    version: manifest.version,
    manifest: checksum ? { ...manifest, checksum } : manifest,
  });

  try {
    await ExtensionRegistry.getInstance().reload();
  } catch {
    // Registry reload may fail in test environments
  }

  return { from: oldVersion, to: manifest.version };
}

// ── Remove Extension ────────────────────────────────────────────────

export async function removeExtension(name: string): Promise<void> {
  const ext = await getExtensionByName(name);
  if (!ext) {
    throw new Error(`Extension "${name}" not found`);
  }

  // Delete DB record
  await deleteExtension(ext.id);

  // Remove install directory (safety check: must be under data/extensions/ or a temp path).
  // MCP-kind extensions have no installPath — skip.
  const instPath = ext.installPath;
  if (instPath && !instPath.startsWith("/")) {
    // Relative path like data/extensions/... — safe to remove
    await rm(instPath, { recursive: true, force: true }).catch(() => {});
  } else if (instPath?.includes("/extensions/")) {
    // Absolute path containing /extensions/ — safe to remove
    await rm(instPath, { recursive: true, force: true }).catch(() => {});
  }

  try {
    await ExtensionRegistry.getInstance().reload();
  } catch {
    // Registry reload may fail in test environments
  }
}

// ── Check for Updates ───────────────────────────────────────────────

export async function checkForUpdates(
  ext: Pick<InstalledExtension, "source" | "version">,
): Promise<{ available: boolean; latestVersion?: string }> {
  if (ext.source.startsWith("local:")) {
    return { available: false };
  }

  const parsed = parseSource(ext.source);
  const tags = lsRemoteTags(parsed.cloneUrl);

  const semverTags = tags
    .map((t) => t.replace(/^v/, ""))
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => compareVersions(b, a));

  if (semverTags.length === 0) {
    return { available: false };
  }

  const latest = semverTags[0]!;
  if (compareVersions(latest, ext.version) > 0) {
    return { available: true, latestVersion: latest };
  }

  return { available: false };
}

// ── Install With Dependencies ────────────────────────────────────────

export async function installWithDependencies(
  sourceStr: string,
  grantedPermissions: ExtensionPermissions,
  opts?: GitInstallOptions & {
    onConfirm?: (tree: string, count: number) => Promise<boolean>;
  },
): Promise<{ root: InstalledExtension; dependencies: InstalledExtension[] }> {
  // Clone root to temp dir first to read its manifest
  const parsed = parseSource(sourceStr);
  const tempDir = await mkdtemp(join(tmpdir(), "ext-dep-resolve-"));
  const cloneDest = join(tempDir, "repo");

  try {
    const cloneOpts: { depth?: number; branch?: string } = { depth: 1 };
    if (parsed.ref) cloneOpts.branch = parsed.ref;
    const cloneResult = clone(parsed.cloneUrl, cloneDest, cloneOpts);
    if (!cloneResult.ok) {
      throw new Error(`Git clone failed: ${cloneResult.stderr}`);
    }

    const rootManifest = await loadManifest(cloneDest);

    // If no dependencies, just install normally
    if (!rootManifest.dependencies || Object.keys(rootManifest.dependencies).length === 0) {
      const root = await installFromGit(sourceStr, grantedPermissions, opts);
      return { root, dependencies: [] };
    }

    // Resolve dependency tree
    const result = await resolveDependencies(rootManifest, {
      getInstalled: async (name: string) => {
        const ext = await getExtensionByName(name);
        if (!ext) return null;
        return { version: ext.version };
      },
      fetchManifest: async (source: string) => {
        const depTemp = await mkdtemp(join(tmpdir(), "ext-dep-fetch-"));
        const depCloneDest = join(depTemp, "repo");
        try {
          const depParsed = parseSource(source);
          const depCloneOpts: { depth?: number; branch?: string } = { depth: 1 };
          if (depParsed.ref) depCloneOpts.branch = depParsed.ref;
          const depCloneResult = clone(depParsed.cloneUrl, depCloneDest, depCloneOpts);
          if (!depCloneResult.ok) {
            throw new Error(`Git clone failed for dependency: ${depCloneResult.stderr}`);
          }

          return await loadManifest(depCloneDest);
        } finally {
          await rm(depTemp, { recursive: true, force: true }).catch(() => {});
        }
      },
    });

    const depsToInstall = result.toInstall.filter((d) => !d.alreadyInstalled);

    if (depsToInstall.length > 0) {
      // Show tree and ask for confirmation
      const treeStr = formatDepTree(result.tree);

      if (opts?.onConfirm) {
        const confirmed = await opts.onConfirm(treeStr, depsToInstall.length);
        if (!confirmed) {
          throw new Error("Installation aborted by user");
        }
      }

      // Install dependencies in topological order (leaves first)
      // Dependencies auto-approve permissions (user approved the dependency tree)
      const installedDeps: InstalledExtension[] = [];
      for (const dep of depsToInstall) {
        const depOpts: GitInstallOptions = {
          ...opts,
          skipReload: true,
          onConfirm: undefined,
          onPermissionPrompt: undefined, // auto-approve deps
        } as GitInstallOptions;

        // Multi-version: use nameOverride for scoped installs
        if (dep.installId.includes("@")) {
          depOpts.nameOverride = dep.installId;
        }

        const installed = await installFromGit(dep.source, grantedPermissions, depOpts);
        installedDeps.push(installed);
      }

      // Install root with skipReload
      const root = await installFromGit(sourceStr, grantedPermissions, {
        ...opts,
        skipReload: true,
        onConfirm: undefined,
      } as GitInstallOptions);

      // Single reload for all
      try {
        await ExtensionRegistry.getInstance().reload();
      } catch {
        // Registry reload may fail in test environments
      }

      return { root, dependencies: installedDeps };
    }

    // All deps already installed, just install root
    const root = await installFromGit(sourceStr, grantedPermissions, opts);
    return { root, dependencies: [] };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

async function findManifest(dir: string): Promise<string | null> {
  const glob = new Bun.Glob("**/ezcorp.config.ts");
  for await (const path of glob.scan({ cwd: dir, absolute: true })) {
    return path;
  }
  return null;
}
