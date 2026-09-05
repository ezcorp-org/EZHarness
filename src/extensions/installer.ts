import type { ExtensionManifestV2, ExtensionPermissions, InstalledExtension } from "./types";
import type { LegacyNamespaceMapping } from "./entities/migrate";

export const AUTO_ENABLE_ON_INSTALL: ReadonlySet<string> = new Set();
export function shouldAutoEnableOnInstall(_name: string): boolean { return false; }

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
  /**
   * The value to PERSIST as `installPath` (and embed in `source`) instead
   * of `localPath`. `localPath` still has to be the real absolute on-disk
   * directory — `loadManifest` / `computeManifestChecksums` read files
   * from it — but persisting that path verbatim bakes in whichever
   * environment ran the installer. The bundled-install caller resolves
   * `localPath` as `join(getProjectRoot(), entry.path)` and passes
   * `persistPath: entry.path` here, so the DB row stores the
   * project-root-RELATIVE form and stays resolvable from any root
   * (`resolveInstallPath()`, `./install-roots.ts`) — a host checkout, a
   * container's `/app`, or a different clone of the same repo. Every
   * other caller (GitHub / git / authored / imported installs) omits
   * this, so their persisted path is `localPath` unchanged, exactly as
   * before.
   */
  persistPath?: string;
}

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

export interface UninstallResult {
  /** The install directory was deleted from disk. */
  installPathRemoved: boolean;
  /** The `.ezcorp/extension-data/<name>/` store was deleted from disk. */
  dataRemoved: boolean;
}

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

export async function installFromLocal(
  localPath: string,
  grantedPermissions: ExtensionPermissions,
  enabled = false,
  opts: InstallFromLocalOpts = {},
): Promise<InstalledExtension>{ throw new Error("EXTENSION_V4_REQUIRED: Use a lifecycle workspace, isolated build, and human-approved release."); }

export async function installFromGitHub(
  repoSpec: string,
  grantedPermissions: ExtensionPermissions,
  enabled = false,
): Promise<InstalledExtension>{ throw new Error("EXTENSION_V4_REQUIRED: Use a lifecycle workspace, isolated build, and human-approved release."); }

export async function installFromGit(
  sourceStr: string,
  grantedPermissions: ExtensionPermissions,
  opts?: GitInstallOptions,
): Promise<InstalledExtension>{ throw new Error("EXTENSION_V4_REQUIRED: Use a lifecycle workspace, isolated build, and human-approved release."); }

export async function updateExtension(
  name: string,
): Promise<{ from: string; to: string }>{ throw new Error("EXTENSION_V4_REQUIRED: Use a lifecycle workspace, isolated build, and human-approved release."); }

export async function uninstallExtension(
  ext: UninstallTarget,
  opts: UninstallOptions = {},
): Promise<UninstallResult>{ throw new Error("EXTENSION_V4_REQUIRED: Use a lifecycle workspace, isolated build, and human-approved release."); }

export async function removeExtension(
  name: string,
  opts: UninstallOptions = {},
): Promise<UninstallResult>{ throw new Error("EXTENSION_V4_REQUIRED: Use a lifecycle workspace, isolated build, and human-approved release."); }

export async function checkForUpdates(
  ext: Pick<InstalledExtension, "source" | "version">,
): Promise<{ available: boolean; latestVersion?: string }>{ throw new Error("EXTENSION_V4_REQUIRED: Use a lifecycle workspace, isolated build, and human-approved release."); }

export async function installWithDependencies(
  sourceStr: string,
  grantedPermissions: ExtensionPermissions,
  opts?: GitInstallOptions & {
    onConfirm?: (tree: string, count: number) => Promise<boolean>;
  },
): Promise<{ root: InstalledExtension; dependencies: InstalledExtension[] }>{ throw new Error("EXTENSION_V4_REQUIRED: Use a lifecycle workspace, isolated build, and human-approved release."); }
