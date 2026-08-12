/**
 * Extension installer — local, GitHub release, and git-based install support.
 */

import type { ExtensionManifestV2, ExtensionPermissions, InstalledExtension } from "./types";
import { clampExtensionPermissions } from "./clamp-permissions";
import { compareVersions } from "./manifest";
import { formatNpmDepError, verifyNpmDependencies } from "./npm-deps";
import { loadManifest } from "./loader";
import { resolveDependencies, formatDepTree } from "./dependency-resolver";
import {
  computeChecksum,
  computeManifestChecksums,
  verifyChecksum,
  computePackageChecksums,
  PACKAGE_CHECKSUM_ALGO,
} from "./checksum";
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
import { getSetting } from "../db/queries/settings";
import { listProjects } from "../db/queries/projects";
import {
  allowedInstallRoots,
  downloadedExtensionsDir,
  isRemovableInstallPath,
} from "./install-roots";
import {
  extensionDataBaseDir,
  extensionDataDir,
  isRemovableDataDir,
} from "./extension-data-dir";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * Registered project roots, for the uninstall containment check —
 * `POST /api/import/commit` installs into `<project.path>/.ezcorp/extensions/`,
 * so those directories are host-created and removable (see
 * `allowedInstallRoots`).
 *
 * Returns `[]` when the DB is unreachable: `getDb()` THROWS on an
 * uninitialized connection rather than lazily booting one, so this costs
 * nothing (and touches no filesystem) in a CLI run before `initDb` or in
 * a unit test with the DB layer stubbed. The consequence of the empty
 * fallback is a refused delete, never a wrong one.
 */
async function registeredProjectPaths(): Promise<string[]> {
  try {
    const rows = await listProjects();
    return rows.map((row) => row.path).filter((path) => path.length > 0);
  } catch {
    return [];
  }
}

// ── Auto-enable-on-install allowlist ─────────────────────────────────

/**
 * Extensions that auto-enable (and have their declared manifest
 * permissions granted) the moment they're installed via the Library /
 * marketplace API — a deliberate, admin-gated carve-out of the
 * install≠enable invariant (sec-C3/sec-C4).
 *
 * These five used to ship as bundled extensions: installed + enabled +
 * declared-permissions-granted at boot. They were removed from
 * `BUNDLED_EXTENSIONS` so they no longer force-install, but the product
 * expectation is that installing one still lands it ready to use rather
 * than disabled with empty permissions. All five are first-party,
 * code-reviewed, in-repo example extensions — the same trust class they
 * had as bundled entries — so restoring the enabled posture for exactly
 * these names (and no others) is safe. Every other extension keeps the
 * explicit `POST /:id/activate` consent step.
 */
export const AUTO_ENABLE_ON_INSTALL: ReadonlySet<string> = new Set([
  "task-stack",
  "property-intelligence-agent",
  "substack-pipeline",
  "excel",
  "substack-pilot",
]);

export function shouldAutoEnableOnInstall(name: string): boolean {
  return AUTO_ENABLE_ON_INSTALL.has(name);
}

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
   * Creator attribution for the persisted `extensions` row. Set ONLY by
   * the authored-install path (`installAuthoredDraft` passes the draft
   * owner). Deliberately SEPARATE from `userId` (the entity-seed acting
   * user) so a bundled/CLI install that happens to carry a `userId` for
   * seeding can never be mis-attributed as user-created — creator-
   * attribution gates the admin-only modify flow, so it must be
   * unambiguous. Omitted → column stays NULL (not user-modifiable).
   */
  creatorUserId?: string | null;
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
 * Refuse an install whose declared third-party npm dependencies can't be
 * resolved from the on-disk install path (verify-only v1 — the packages
 * must already be present in the deployment's node_modules; the host does
 * NOT install them). Same refusal mechanics as the env-leak gate so the
 * API response carries the actionable message. Called by every install
 * source (local / git / tarball) once the files are at their final
 * install dir, so a broken deployment fails LOUD at install instead of
 * crash-looping the subprocess into auto-disable (live incident
 * 2026-07-11). See `verifyNpmDependencies` / `formatNpmDepError`.
 */
function runNpmDependencyInstallGate(
  manifest: ExtensionManifestV2,
  installDir: string,
): void {
  const check = verifyNpmDependencies(manifest.npmDependencies, installDir);
  if (!check.ok) {
    throw new Error(formatNpmDepError(manifest.name, check.issues));
  }
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

  // Entrypoint hash + full-package checksums. The entrypoint is OPTIONAL
  // in v2 for non-tool packages (agent-/skill-kind manifests have no
  // subprocess to run) — `validateManifestV2` only *requires* an
  // entrypoint when `tools[]` is declared. The old unconditional
  // `Cannot install extension without entrypoint` throw here mismatched
  // the validator and broke the bundled agent-kind extensions
  // (`research-agent`, `multi-agent-orchestrator`) on every boot;
  // `computeManifestChecksums` hashes the entrypoint only when present.
  const checksumFields = await computeManifestChecksums(localPath, manifest.entrypoint);
  const checksum = checksumFields.checksum;

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

  // Refuse the install if a declared npm dependency can't be resolved from
  // the install path (verify-only; same refusal surface as the env gate).
  runNpmDependencyInstallGate(manifest, localPath);

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
      //
      // Re-clamp the stored grants against the REFRESHED manifest for
      // NON-BUNDLED refreshes: a refreshed manifest that drops shell /
      // a network host must drop the matching grant, or the registry
      // spawn options (`networkAllowed`/`shellAllowed`) keep the stale
      // looser sandbox. Bundled boot refreshes are exempt — the S6/S9
      // bundled-install gates already clamp those with their own
      // ceiling rules, and double-clamping here would fight them.
      const refreshUpdate: Parameters<typeof dbUpdateExtension>[1] = {
        version: manifest.version,
        description: manifest.description || "",
        manifest: { ...manifest, ...checksumFields },
        installPath: localPath,
        checksumVerified: !!checksum,
      };
      if (opts.isBundled !== true) {
        refreshUpdate.grantedPermissions = clampExtensionPermissions(
          (existing.grantedPermissions ?? { grantedAt: {} }) as Partial<ExtensionPermissions>,
          manifest.permissions ?? {},
          {
            acceptsCallerCaps: manifest.acceptsCallerCaps,
            escalateChildCaps: manifest.escalateChildCaps,
            name: manifest.name,
          },
        );
      }
      const refreshed = await dbUpdateExtension(existing.id, refreshUpdate);
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

  // Auto-`modifiable` for user-authored extensions, gated by an
  // opt-in deployment setting. `creatorUserId != null` ⟺ this is the
  // authored-install path (bundled/github/mcp/CLI leave it NULL), so a
  // non-authored install can NEVER become auto-modifiable regardless of
  // the setting. Strict `=== true` so an unset/non-boolean setting
  // fail-safes to the historical secure default (`false`) — an upgrade
  // never silently removes the admin sign-off layer on a shared
  // deployment. Going-forward only: same-name reinstall / in-place
  // modify preserves the existing `modifiable` (author-install.ts) and
  // the "already installed — refreshed" branch above never touches it,
  // so this default applies solely on a FIRST authored install. The
  // residual "LLM can't silently rewrite" guarantee is unaffected —
  // it's held by reopen owner-scoping + the never-persisted
  // always-prompt on `ezcorp:extension:modify`, not by this flag.
  const authorAutoModifiable =
    opts.creatorUserId != null &&
    (await getSetting("extensions:authorAutoModifiable")) === true;

  // Create DB record
  const ext = await createExtension({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description || "",
    manifest: { ...manifest, ...checksumFields },
    source,
    installPath: localPath,
    enabled,
    grantedPermissions,
    checksumVerified: !!checksum,
    consecutiveFailures: 0,
    // NULL unless the authored-install path supplied it (bundled/
    // github/mcp/CLI leave it NULL → never user-modifiable).
    creatorUserId: opts.creatorUserId ?? null,
    modifiable: authorAutoModifiable,
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

    // Verify + compute the entrypoint checksum when one is declared.
    // Entrypoint is optional for non-tool packages (agent-/skill-kind) —
    // mirror `installFromLocal` / `installFromGit` and skip the checksum
    // step entirely rather than failing closed on a valid entrypoint-less
    // manifest.
    let checksum: string | undefined;
    if (manifest.entrypoint) {
      const entrypointPath = join(manifestDir, manifest.entrypoint.replace(/^\.\//, ""));
      if (manifest.checksum) {
        const valid = await verifyChecksum(entrypointPath, manifest.checksum);
        if (!valid) throw new Error("Checksum mismatch: entrypoint file does not match manifest checksum");
      }
      checksum = await computeChecksum(entrypointPath);
    }

    // Copy to persistent install directory. Fail loudly — no silent fallback:
    // if this fails, the later temp-dir cleanup would leave a broken install.
    const extBase = downloadedExtensionsDir();
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

    // Refuse the install if a declared npm dependency can't be resolved
    // from the FINAL install dir (verify-only; same surface as the env gate).
    runNpmDependencyInstallGate(manifest, installDir);

    // Create DB record
    const ext = await createExtension({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description || "",
      manifest: { ...manifest, checksum, packageChecksums, packageChecksumsAlgo: PACKAGE_CHECKSUM_ALGO },
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
    const extBase = opts?.extensionsDir ?? downloadedExtensionsDir();
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

    // Refuse the install if a declared npm dependency can't be resolved
    // from the FINAL install dir (verify-only; same surface as the env gate).
    runNpmDependencyInstallGate(manifest, installDir);

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

  // Fetch and checkout latest tag. Remember the pre-update ref so a
  // refused update (env-leak gate below) can restore the working tree —
  // the DB row keeps the OLD manifest on refusal, and the subprocess
  // spawns from DISK, so leaving the new tag checked out would run new
  // code under old grants.
  const prevHead = gitExec(["rev-parse", "HEAD"], { cwd: installPath });
  gitExec(["fetch", "--tags"], { cwd: installPath });
  const checkoutResult = gitExec(["checkout", latest.raw], { cwd: installPath });
  if (!checkoutResult.ok) {
    throw new Error(`Failed to checkout ${latest.raw}: ${checkoutResult.stderr}`);
  }

  let manifest: ExtensionManifestV2;
  try {
    // Re-validate manifest after checkout
    manifest = await loadManifest(installPath);

    // v1.4 env-leak gate — same rule as every install path: refuse to
    // persist a manifest that DECLARES a credential-shaped env name.
    // Updates are never bundled (bundled extensions are local:-sourced
    // and rejected above), so no escape hatch applies. Runs BEFORE the
    // DB write; the catch below restores the previous checkout so a
    // refused update leaves disk AND DB at the old version.
    await runEnvKeyLeakInstallGate(manifest, { isBundled: false });
  } catch (err) {
    if (prevHead.ok && prevHead.stdout) {
      gitExec(["checkout", prevHead.stdout], { cwd: installPath });
    }
    throw err;
  }

  // Recompute checksum
  let checksum: string | undefined;
  if (manifest.entrypoint) {
    const epPath = join(installPath, manifest.entrypoint.replace(/^\.\//, ""));
    checksum = await computeChecksum(epPath);
  }

  const oldVersion = ext.version;

  // Re-clamp the stored grants against the NEW manifest. Without this,
  // a new tag that DROPS a permission (shell, a network host, …) left
  // the old grant in place — the registry spawn options
  // (registry.ts `networkAllowed`/`shellAllowed`) would keep the looser
  // sandbox forever. Clamping grant∩new-manifest preserves everything
  // the new manifest still declares (grantedAt survives via the clamp)
  // and drops what it no longer requests. `enabled` is untouched.
  const reclamped = clampExtensionPermissions(
    (ext.grantedPermissions ?? { grantedAt: {} }) as Partial<ExtensionPermissions>,
    manifest.permissions ?? {},
    {
      acceptsCallerCaps: manifest.acceptsCallerCaps,
      escalateChildCaps: manifest.escalateChildCaps,
      name: manifest.name,
    },
  );

  // Update DB
  await dbUpdateExtension(ext.id, {
    version: manifest.version,
    manifest: checksum ? { ...manifest, checksum } : manifest,
    grantedPermissions: reclamped,
  });

  try {
    await ExtensionRegistry.getInstance().reload();
  } catch {
    // Registry reload may fail in test environments
  }

  return { from: oldVersion, to: manifest.version };
}

// ── Remove Extension ────────────────────────────────────────────────

/** What {@link uninstallExtension} actually removed, for the caller to report. */
export interface UninstallResult {
  /** The install directory was deleted from disk. */
  installPathRemoved: boolean;
  /** The `.ezcorp/extension-data/<name>/` store was deleted from disk. */
  dataRemoved: boolean;
}

/**
 * The fields an uninstall needs off an extension row. Spelled structurally
 * rather than as `Pick<InstalledExtension, …>` because `installPath` is
 * NULLABLE on the DB row (MCP-kind extensions have no install directory)
 * and non-null on `InstalledExtension`.
 */
export interface UninstallTarget {
  id: string;
  name: string;
  installPath: string | null;
}

export interface UninstallOptions {
  /**
   * Also delete `<projectRoot>/.ezcorp/extension-data/<name>/` — everything
   * the extension saved (task stores, note vaults, config).
   *
   * OFF by default, and there is no "sensible default" to infer: the data
   * is the user's, deleting it cannot be undone, and keeping it means a
   * reinstall picks straight back up. Every caller states an intent — the
   * HTTP route takes it from an explicit choice in the confirm dialog.
   */
  purgeData?: boolean;
}

/**
 * Uninstall an extension: unregister the row, then remove what the HOST
 * created on disk.
 *
 * The MECHANISM, with no policy in it. Both callers — `ezcorp ext remove`
 * and `DELETE /api/extensions/:id` — need every step here, and the HTTP
 * route used to have none of them: it deleted the row and left the install
 * directory and the data store behind, so "Uninstall" in the UI was really
 * "unregister". Policy stays with the callers; the route is the surface
 * that refuses to uninstall a built-in.
 *
 * Order matters. The row goes FIRST so a failure mid-way leaves files
 * without a row (inert, and re-installable) rather than a row pointing at
 * deleted files (a broken extension the registry keeps trying to spawn).
 */
export async function uninstallExtension(
  ext: UninstallTarget,
  opts: UninstallOptions = {},
): Promise<UninstallResult> {
  const name = ext.name;
  const result: UninstallResult = { installPathRemoved: false, dataRemoved: false };

  // Read the registered project paths BEFORE the row goes. This is a DB
  // query, and once the row is deleted a throw here would strand the whole
  // teardown: no `rm`, no `reload()`, and (in the HTTP route) no page-cache
  // invalidation, leaving the registry serving a deleted extension's tools.
  const projectPaths = ext.installPath ? await registeredProjectPaths() : [];

  // Delete DB record. FK cascades clear the rest of this extension's rows
  // (storage, secrets, RBAC grants, schedules, webhooks, triggers,
  // capability calls, quotas, conversation wiring) — see src/db/schema.ts.
  await deleteExtension(ext.id);

  // Retire the running extension BEFORE deleting anything on disk.
  //
  // `reload()` reads the DB, so it has to come after the row delete — but it
  // must come before the `rm`, because the subprocess is still live until it
  // does. For an MCP-kind extension the data directory being deleted is
  // literally the sandbox's only read-write mount (`mcp-sandbox.ts`), so a
  // running child can re-create files underneath the walk; `dataRemoved:
  // true` would then be a claim about a directory that exists again.
  // (`retireProcess` still DEFERS the kill while a call is in flight, so a
  // busy extension can outlive this by the length of that call — bounded,
  // and strictly better than deleting its files with it running.)
  await reloadRegistryQuietly();

  // Remove the install directory — ONLY when it resolves strictly inside
  // an allowed install root (`isRemovableInstallPath`). Anything else is
  // content the host never created: a bundled extension's git-tracked
  // source tree, or the working copy a user pointed `ext install` at.
  // MCP-kind extensions have no installPath — nothing to remove, nothing
  // to warn about.
  const instPath = ext.installPath;
  if (instPath) {
    // `rm` the RESOLVED path, not the raw one — the same string the
    // predicate decided on. They agree today; spelling it once means a
    // future normalization step cannot make the check and the delete
    // disagree about which directory is meant.
    const resolved = resolve(process.cwd(), instPath);
    if (isRemovableInstallPath(instPath, projectPaths)) {
      if (existsSync(resolved)) {
        // The flag must report what HAPPENED, not what was attempted. The
        // `rm` is swallowed (an uninstall must not throw once the row is
        // gone), so claiming success unconditionally would have a
        // read-only filesystem or an EACCES report `installPathRemoved:
        // true` over files that are still there.
        result.installPathRemoved = await rm(resolved, { recursive: true, force: true })
          .then(() => true)
          .catch((err) => {
            console.warn(
              `[installer] Extension "${name}": failed to delete install path ` +
                `"${resolved}" — ${String(err)}. The row is unregistered; the ` +
                `files are still on disk.`,
            );
            return false;
          });
      } else {
        // A RELATIVE install_path always resolves under the CURRENT cwd,
        // so it always passes containment — even when the directory it
        // names is somewhere else entirely. That happens whenever the
        // removing process' cwd differs from the installing one's (dev
        // from `web/`, container from `/app`), and `force: true` makes
        // the miss silent. Say it out loud instead: the real directory is
        // still on disk, and nothing else will mention it.
        console.warn(
          `[installer] Extension "${name}": install path "${instPath}" resolved ` +
            `to "${resolved}", which does not exist — nothing was deleted. A ` +
            `relative install path is resolved against the current working ` +
            `directory (${process.cwd()}); if the extension was installed from a ` +
            `different one, its files are still on disk there.`,
        );
      }
    } else {
      // Never silent: the row is gone but the files are not, and an
      // operator who expected a full uninstall needs to know which path
      // was kept and why.
      console.warn(
        `[installer] Extension "${name}": unregistered, but its install path ` +
          `"${instPath}" was NOT deleted — it is not inside an allowed install ` +
          `root (${allowedInstallRoots(projectPaths).join(", ")}). Remove the ` +
          `files by hand if they are yours to remove.`,
      );
    }
  }

  // The extension's own data store. Opt-in (see `purgeData`) — and the
  // containment predicate still runs, because `name` arrives from a DB row
  // and the delete it authorizes is recursive.
  if (opts.purgeData) {
    if (isRemovableDataDir(name)) {
      const dataDir = extensionDataDir(name);
      if (existsSync(dataDir)) {
        // Same as the install path above: report the outcome, not the
        // attempt. This one matters more — the user explicitly asked for
        // this data to be gone, so a silent failure that reports success
        // is the difference between "deleted" and "still on disk".
        result.dataRemoved = await rm(dataDir, { recursive: true, force: true })
          .then(() => true)
          .catch((err) => {
            console.warn(
              `[installer] Extension "${name}": failed to delete stored data at ` +
                `"${dataDir}" — ${String(err)}. It is still on disk.`,
            );
            return false;
          });
      }
    } else {
      // Unreachable for any name the installer accepted, but a refused
      // delete must never be silent — the user asked for the data to go.
      console.warn(
        `[installer] Extension "${name}": stored data was NOT deleted — the ` +
          `name does not resolve inside ${extensionDataBaseDir()}.`,
      );
    }
  }

  return result;
}

/**
 * `ExtensionRegistry.reload()`, swallowing failure.
 *
 * Never throws: a reload failure in a test environment (or a transient DB
 * blip) must not abort an uninstall that has already deleted the row —
 * that would leave the disk work undone with no way to retry it.
 */
async function reloadRegistryQuietly(): Promise<void> {
  try {
    await ExtensionRegistry.getInstance().reload();
  } catch {
    // Registry reload may fail in test environments
  }
}

/**
 * Uninstall by manifest name. The `ezcorp ext remove <name>` entry point —
 * a name lookup in front of {@link uninstallExtension}.
 */
export async function removeExtension(
  name: string,
  opts: UninstallOptions = {},
): Promise<UninstallResult> {
  const ext = await getExtensionByName(name);
  if (!ext) {
    throw new Error(`Extension "${name}" not found`);
  }
  return uninstallExtension(ext, opts);
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
