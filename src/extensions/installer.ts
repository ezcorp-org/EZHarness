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
  createExtension,
  getExtensionByName,
  updateExtension as dbUpdateExtension,
  deleteExtension,
} from "../db/queries/extensions";
import { join } from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// ── Local Install ───────────────────────────────────────────────────

export async function installFromLocal(
  localPath: string,
  grantedPermissions: ExtensionPermissions,
  enabled = false,
): Promise<InstalledExtension> {
  // Read manifest
  const manifest = await loadManifest(localPath);

  // Compute checksum of entrypoint (entrypoint may be optional in v2 for non-tool packages)
  if (!manifest.entrypoint) {
    throw new Error("Cannot install extension without entrypoint");
  }
  const entrypointPath = join(localPath, manifest.entrypoint.replace(/^\.\//, ""));
  const checksum = await computeChecksum(entrypointPath);

  // Compute full-package checksums
  const packageChecksums = await computePackageChecksums(localPath);

  // Create DB record
  const ext = await createExtension({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description || "",
    manifest: { ...manifest, checksum, packageChecksums },
    source: `local:${localPath}`,
    installPath: localPath,
    enabled,
    grantedPermissions,
    checksumVerified: true,
    consecutiveFailures: 0,
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
