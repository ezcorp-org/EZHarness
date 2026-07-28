/**
 * Shared host-side "install an extension-author draft" pipeline.
 *
 * The exact secure install steps used to live inline in
 * `web/src/routes/api/extensions/author/install/+server.ts`. They are
 * now hoisted here so BOTH the web form route AND the in-chat
 * agent-driven install (`ezcorp/drafts` action `install`, gated by a
 * mandatory user-approval prompt — see `drafts-handler.ts`) run the
 * IDENTICAL pipeline. There is intentionally no second, weaker install
 * path: same owner scope, same `verifyExtension` hard-gate, same
 * `installFromLocal` env-key-leak gate (`isBundled:false`).
 *
 * The only difference between callers is `enable`: the web form leaves
 * the new extension disabled (user flips it on in the library); the
 * in-chat path passes `enable:true` so an explicitly user-approved
 * install is immediately testable.
 *
 * Errors are surfaced as a typed {@link AuthorInstallError} so the
 * route can map them to its existing HTTP status/body contract without
 * the pipeline knowing anything about HTTP.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  consumeDraft,
  getDraft,
  getExtensionAuthorDraftDir,
} from "../db/queries/ez-drafts";
import { getExtensionByName, updateExtension } from "../db/queries/extensions";
import { installFromLocal } from "./installer";
import { ExtensionRegistry } from "./registry";
import { runAuthorAcceptanceGate } from "./author-gate";
import { isPreinstalledDependencySource } from "./dependency-source";
import { resolvePreinstalledDependency } from "./dependency-resolver";
import type { ExtensionManifestV2, ExtensionPermissions } from "./types";
import { extensionLogger } from "../logger";

// Host-side extension logging is namespaced `ext.<name>[.<component>]`
// (binding rule — src/extensions/CLAUDE.md). This module is the
// extension-author install pipeline, so it logs under
// `ext.extension-author.author-install` and an operator can raise it
// with `EZCORP_DEBUG=ext.extension-author` (or `EZCORP_DEBUG=ext`).
// The previous `logger.child("author-install")` had no `ext.` prefix at
// all, so neither toggle ever reached it.
const log = extensionLogger("extension-author", "author-install");

/**
 * Move a directory, tolerating cross-filesystem boundaries.
 *
 * The install pipeline relocates a verified draft from
 * `.ezcorp/extension-data/extension-author/drafts/…` to
 * `.ezcorp/extensions/<name>`. Those two subtrees are SIBLINGS under
 * `.ezcorp/`, but deployments may bind-mount them independently (the
 * scoped host bind mounts in `docker-compose.yml` / `compose.prod.yml`
 * expose each on a separate mount so authored extensions land in the
 * host tree). `rename(2)` refuses to cross a mount point even when both
 * sides are the same physical filesystem — it throws `EXDEV`. A bare
 * `rename` therefore silently couples this security-relevant pipeline
 * to a single-volume layout. Fall back to a recursive copy + delete so
 * the move is correct under ANY mount topology. The non-atomicity of
 * the fallback is safe here: the source is already fully verified
 * (`loadManifestFresh` + `verifyExtension` ran on it upstream), the
 * destination's non-existence was just asserted by the caller, and the
 * pipeline already rolls back on any post-move failure.
 */
async function moveDir(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await cp(src, dest, { recursive: true });
    await rm(src, { recursive: true, force: true });
  }
}

/**
 * Carry non-draft files forward across a sanctioned in-place modify.
 *
 * A reopen draft is seeded from only the 7 `SCAFFOLD_DRAFT_FILES`, but
 * the install replaces the extension directory WHOLESALE and then
 * deletes the pre-modify backup. Every other entry that lived in the
 * installed dir — `node_modules/` from `npm-deps`, an assets folder, a
 * lockfile — was therefore destroyed by a modify, permanently.
 *
 * Copy back every TOP-LEVEL entry that exists in the backup and NOT in
 * the freshly-installed dir. The draft's own copy always wins (we never
 * overwrite), so an edited file keeps its edit; only entries the author
 * flow cannot represent are restored. This is safe against "the user
 * deleted that file on purpose" because the draft surface is
 * write-only over a fixed allowlist — it has no delete affordance at
 * all, so an absent entry never encodes intent.
 */
async function carryForwardUnauthoredEntries(
  backupDir: string,
  installedPath: string,
): Promise<void> {
  const entries = await readdir(backupDir);
  for (const entry of entries) {
    const dest = join(installedPath, entry);
    if (existsSync(dest)) continue;
    await cp(join(backupDir, entry), dest, { recursive: true });
  }
}

/**
 * Strict manifest-name shape. Intentionally INLINED here (a verbatim
 * copy of `src/extensions/manifest.ts`'s module-private `NAME_REGEX`)
 * rather than imported — the same host-boundary convention
 * `db/queries/ez-drafts.ts` documents for `SCAFFOLD_DRAFT_FILES`: a
 * security-relevant constant must not be trusted/transited across a
 * module the install path doesn't already hard-depend on. This is the
 * D2 defence-in-depth re-check: `name` is the manifest name that
 * already passed `validateManifestV2` upstream, but we re-assert it
 * HERE before shaping it into a user-clickable `openUrl` so a future
 * regression elsewhere can never emit an attacker-shaped URL. A name
 * that fails this (it never should at this point) yields NO `openUrl`
 * — the install still succeeds; only the deep-link is omitted.
 */
const NAME_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

export type AuthorInstallErrorCode =
  | "DRAFT_NOT_FOUND"
  | "NOT_EXTENSION_DRAFT"
  | "DRAFT_DIR_MISSING"
  | "MANIFEST_INVALID"
  | "VERIFY_FAILED"
  | "NAME_COLLISION"
  | "ENV_KEY_LEAK"
  // A declared `bundled`/`local` dependency is not actually installed
  // (or is installed at an incompatible version). The author flow's
  // composition picker only ever offers INSTALLED extensions, so this
  // means the target was uninstalled/downgraded between compose and
  // install — installing anyway would silently produce an extension
  // whose cross-extension calls are all denied at runtime.
  | "DEPENDENCY_UNSATISFIED"
  | "INSTALL_FAILED"
  | "ROLLBACK_FAILED"
  // ── Post-install failures ────────────────────────────────────────
  // The files landed and the row exists, but the extension is NOT in
  // the state the caller asked for. These used to be a `log.warn` and
  // an empty `catch {}`, so the caller got `{ok:true}` and the install
  // card told the user "installed and enabled" for an extension that
  // was neither enabled nor loaded. They are failures.
  | "ENABLE_FAILED"
  | "REGISTRY_RELOAD_FAILED";

/** Typed pipeline failure. `details` carries the structured body the
 *  web route already returns (errors[], leakedNames, verifyResult). */
export class AuthorInstallError extends Error {
  readonly code: AuthorInstallErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(
    code: AuthorInstallErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuthorInstallError";
    this.code = code;
    if (details) this.details = details;
  }
}

export interface AuthorInstallResult {
  extensionId: string;
  name: string;
  redirectUrl: string;
  /**
   * D2 same-origin relative deep-link to the freshly installed
   * extension (`"/extensions/" + name`). ONLY present when `name`
   * passes the host-side `NAME_REGEX` re-check — omitted (undefined)
   * otherwise so a malformed name can never reach the UI as a
   * clickable href. Distinct from `redirectUrl` (which the web form
   * route's existing HTTP contract returns unconditionally and MUST
   * stay byte-identical — D5): `openUrl` is the agent-card affordance
   * the `EzToolResultCard` button binds to.
   */
  openUrl?: string;
  /**
   * Non-fatal problems the caller should still SEE (today: a
   * pre-modify backup directory that could not be deleted, which
   * leaves an inert `*.modify-bak-*` dir behind). Previously these
   * vanished into a `log.warn` no user ever reads. Omitted when empty.
   */
  warnings?: string[];
}

/**
 * Install an extension-author draft. Owner-scoped on `userId`
 * throughout. `draftId` shape is assumed pre-validated by the caller
 * (the web route + the bundled extension both regex-gate it); we still
 * fail closed via the owner-scoped `getDraft`.
 */
export async function installAuthoredDraft(args: {
  draftId: string;
  userId: string;
  /** true → also enable the row before the registry reload, so the
   *  new extension's tools enter the LLM toolset immediately. */
  enable: boolean;
}): Promise<AuthorInstallResult> {
  const { draftId, userId, enable } = args;

  // 1) Owner-scoped lookup. Miss/expired/not-owner are indistinguishable.
  const row = await getDraft(draftId, userId);
  if (!row) {
    throw new AuthorInstallError(
      "DRAFT_NOT_FOUND",
      "Draft not found, expired, or not owned by the requesting user",
    );
  }
  if (row.kind !== "extension") {
    throw new AuthorInstallError(
      "NOT_EXTENSION_DRAFT",
      "Draft is not an extension draft",
    );
  }

  let draftDir: string;
  try {
    draftDir = getExtensionAuthorDraftDir(draftId, userId);
  } catch (e) {
    throw new AuthorInstallError(
      "DRAFT_DIR_MISSING",
      `Failed to resolve draft directory: ${(e as Error).message}`,
    );
  }
  if (!existsSync(draftDir)) {
    throw new AuthorInstallError(
      "DRAFT_DIR_MISSING",
      "Draft directory does not exist",
    );
  }

  // 2) Acceptance gate — the SAME `runAuthorAcceptanceGate` the web
  //    preview page's Validate button runs, so "validated green" and
  //    "installable" can never diverge again. Manifest validation goes
  //    through the canonical loader (child-process import — a malicious
  //    manifest cannot run JS in this process); tool/multi drafts
  //    additionally HARD-FAIL unless a declared `smokeTest` round-trips
  //    in a real sandbox.
  const draftPayload = (row.payload ?? {}) as Record<string, unknown>;
  const draftType =
    typeof draftPayload.type === "string" ? draftPayload.type : "";
  const gate = await runAuthorAcceptanceGate({ draftDir, draftType });
  if (!gate.ok) {
    const code = gate.code ?? "VERIFY_FAILED";
    const details: Record<string, unknown> = { errors: gate.errors };
    // The web route's 422 body carries `verifyResult` for a gate
    // failure — keep that field byte-compatible with the old shape.
    if (code === "VERIFY_FAILED") {
      details.verifyResult = { pass: false, steps: gate.steps };
    }
    throw new AuthorInstallError(
      code,
      code === "MANIFEST_INVALID"
        ? "Manifest invalid or failed to load"
        : "Deterministic acceptance gate failed — a passing `smokeTest` " +
            "is required for tool/multi extensions",
      details,
    );
  }
  // `ok` guarantees both of these are set.
  const manifest = gate.manifest as ExtensionManifestV2;
  const name = manifest.name;

  // 2b) PREINSTALLED dependency preflight. `bundled`/`local` dependency
  //     sources mean "this extension must ALREADY be installed" — this
  //     pipeline never clones anything, so the installed set is the only
  //     possible resolution. Check it HERE, before anything has moved,
  //     so the failure is clean (no rollback) and actionable.
  //
  //     Silently proceeding is the outcome this guards against: the
  //     registry's `buildDepRoutes` drops a dependency name it cannot
  //     match, so the extension installs "successfully" and then every
  //     cross-extension `ezcorp/invoke` it makes is denied by
  //     `resolveDepTool` with nothing pointing at the cause.
  const depErrors: string[] = [];
  for (const [depName, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (!isPreinstalledDependencySource(spec.source)) continue;
    try {
      await resolvePreinstalledDependency(depName, spec, async (n) => {
        const ext = await getExtensionByName(n);
        return ext ? { version: ext.version } : null;
      });
    } catch (e) {
      depErrors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (depErrors.length > 0) {
    throw new AuthorInstallError(
      "DEPENDENCY_UNSATISFIED",
      `Extension "${name}" declares ${depErrors.length} dependenc${depErrors.length === 1 ? "y" : "ies"} that cannot be resolved`,
      { errors: depErrors },
    );
  }

  // Pre-modify backup dir, set only on a sanctioned in-place modify
  // that displaces existing installed files. Function-scoped so the
  // rollback catch can restore it and the success tail can delete it.
  let modifyBackupDir: string | null = null;

  // 3) Name-collision check + move dir → installed location.
  //
  // Sanctioned in-place MODIFY: a draft minted by the "reopen my
  // installed extension" flow carries `payload.modifyOf =
  // <sourceExtensionId>` (it is otherwise a normal author draft, so the
  // entire read/validate/install pipeline is unchanged). When the
  // still-installed target genuinely belongs to this user, an admin has
  // flagged it `modifiable`, and it is not bundled, a same-name install
  // is the INTENDED upgrade — not a collision. Re-authorize HERE
  // against the DB (an admin may have toggled `modifiable` off, or
  // ownership changed, between reopen and install) so the gate is the
  // install-time state, never the stale reopen-time decision. Anything
  // that fails the re-check falls through to the normal NAME_COLLISION
  // — the generic create flow still "asks the user".
  const modifyOf =
    typeof draftPayload.modifyOf === "string" ? draftPayload.modifyOf : null;
  const existing = await getExtensionByName(name);
  const sanctionedModify =
    modifyOf !== null &&
    existing !== null &&
    existing.id === modifyOf &&
    existing.creatorUserId === userId &&
    existing.modifiable === true &&
    existing.isBundled === false;
  if (existing && !sanctionedModify) {
    throw new AuthorInstallError(
      "NAME_COLLISION",
      `Extension "${name}" is already installed`,
    );
  }
  // `<root>/.ezcorp/extension-data/extension-author/drafts/<uid>/<did>`
  // → walk up 6 segments to the project root.
  const root = dirname(
    dirname(dirname(dirname(dirname(dirname(draftDir))))),
  );
  const installedPath = join(root, ".ezcorp/extensions", name);
  if (existsSync(installedPath)) {
    if (!sanctionedModify) {
      throw new AuthorInstallError(
        "NAME_COLLISION",
        `Install path "${installedPath}" already exists`,
      );
    }
    // Sanctioned replace: move the old files ASIDE (not delete) so a
    // post-move install failure can restore them — no data loss on a
    // failed modify. The DB row is intentionally LEFT INTACT: the
    // `installFromLocal(installedPath, …)` below matches the existing
    // row's `local:<installedPath>` source and refreshes it in place,
    // preserving id/enabled/grants/creatorUserId AND the modifiable
    // flag. The backup is deleted on success, restored on rollback.
    modifyBackupDir = `${installedPath}.modify-bak-${Date.now()}`;
    await rename(installedPath, modifyBackupDir);
  }
  await mkdir(dirname(installedPath), { recursive: true });
  await moveDir(draftDir, installedPath);

  // 3b) MODIFY DATA-LOSS FIX. A reopen draft is seeded from only the 7
  //     `SCAFFOLD_DRAFT_FILES`, but the move above replaced the install
  //     directory WHOLESALE and the success tail deletes the backup —
  //     so every other entry (installed `node_modules/`, an assets dir,
  //     a lockfile…) used to be destroyed by a modify. Carry forward
  //     anything the draft does not itself provide. The draft's copy
  //     always wins; nothing is overwritten. Inside the same try as the
  //     install below so a failure here takes the existing rollback.

  // 4) installFromLocal — env-key-leak gate runs HERE with
  //    `isBundled:false`. On any failure, roll the dir back so the
  //    user can fix + retry.
  //
  // IMPORTANT: authored installs have already passed an explicit user
  // approval gate before reaching this pipeline. Persist the manifest's
  // declared permissions as the granted runtime set; otherwise an
  // extension that correctly declares `permissions.network` installs
  // successfully but every runtime fetch is denied as "missing capability".
  const now = Date.now();
  const requestedPermissions = manifest.permissions ?? {};
  // `eventSubscriptions` has two manifest shapes: the legacy `string[]`
  // and the Phase-51.4 `{ events: string[] }` object form. Normalize to
  // the array so the "has any subscription" length check is shape-safe
  // (the granted runtime set only carries the `string[]` form).
  const eventSubs = Array.isArray(requestedPermissions.eventSubscriptions)
    ? requestedPermissions.eventSubscriptions
    : (requestedPermissions.eventSubscriptions?.events ?? []);
  // The manifest's permission block is the *requested* (loosely-typed)
  // shape; `ExtensionPermissions` is the *granted* (clamped) shape. They
  // diverge structurally for the Phase-51 surfaces (e.g. manifest
  // `llm.maxCallsPerHour` is optional, granted is required) — the host
  // clamps these downstream. Bridge with the same cast the spawn-
  // assignment handler uses for the identical requested→granted hop.
  const grantedPermissions = {
    ...requestedPermissions,
    eventSubscriptions: eventSubs,
    grantedAt: {
      ...(requestedPermissions.network && requestedPermissions.network.length > 0 ? { network: now } : {}),
      ...(requestedPermissions.filesystem && requestedPermissions.filesystem.length > 0 ? { filesystem: now } : {}),
      ...(requestedPermissions.shell ? { shell: now } : {}),
      ...(requestedPermissions.env && requestedPermissions.env.length > 0 ? { env: now } : {}),
      ...(requestedPermissions.storage ? { storage: now } : {}),
      ...(requestedPermissions.lifecycleHooks ? { lifecycleHooks: now } : {}),
      ...(eventSubs.length > 0 ? { eventSubscriptions: now } : {}),
      ...(requestedPermissions.webhooks && requestedPermissions.webhooks.length > 0 ? { webhooks: now } : {}),
      ...(requestedPermissions.taskEvents ? { taskEvents: now } : {}),
      ...(requestedPermissions.loopEvents ? { loopEvents: now } : {}),
      ...(requestedPermissions.agentConfig ? { agentConfig: now } : {}),
      ...(requestedPermissions.spawnAgents ? { spawnAgents: now } : {}),
      ...(requestedPermissions.appendMessages ? { appendMessages: now } : {}),
      ...(requestedPermissions.llm ? { llm: now } : {}),
      ...(requestedPermissions.memory ? { memory: now } : {}),
      ...(requestedPermissions.lessons ? { lessons: now } : {}),
      ...(requestedPermissions.schedule ? { schedule: now } : {}),
      ...(requestedPermissions.custom ? { custom: now } : {}),
    },
  } as ExtensionPermissions;

  let installed: Awaited<ReturnType<typeof installFromLocal>>;
  try {
    if (modifyBackupDir) {
      await carryForwardUnauthoredEntries(modifyBackupDir, installedPath);
    }
    installed = await installFromLocal(
      installedPath,
      grantedPermissions,
      false,
      {
        isBundled: false,
        envEscapeHatch: false,
        preloadedManifest: manifest,
        // Attribute the row to the draft owner — this is the ONLY path
        // that records a creator, gating the admin-only modify flow.
        creatorUserId: userId,
      },
    );
  } catch (err) {
    try {
      await mkdir(dirname(draftDir), { recursive: true });
      await moveDir(installedPath, draftDir);
      // Sanctioned-modify rollback: restore the original installed
      // files so a failed modify never loses the user's extension.
      if (modifyBackupDir) {
        await moveDir(modifyBackupDir, installedPath);
        modifyBackupDir = null;
      }
    } catch (rollbackErr) {
      throw new AuthorInstallError(
        "ROLLBACK_FAILED",
        "Install failed AND rollback failed",
        {
          errors: [
            err instanceof Error ? err.message : String(err),
            `rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          ],
        },
      );
    }
    const errName = err instanceof Error ? err.name : "Error";
    const errMsg = err instanceof Error ? err.message : "Install failed";
    if (errName === "EnvKeyLeakInstallError") {
      const leakedNames =
        (err as { leakedNames?: readonly string[] }).leakedNames ?? [];
      throw new AuthorInstallError("ENV_KEY_LEAK", errMsg, {
        errors: [`env-key-leak: ${leakedNames.join(", ")}`],
        leakedNames,
      });
    }
    throw new AuthorInstallError("INSTALL_FAILED", errMsg, { errors: [errMsg] });
  }

  // ── Post-install steps ───────────────────────────────────────────
  //
  // From here the files are in place and the row exists, so an
  // ABORT-AND-THROW would skip the draft consume + backup cleanup and
  // leave more mess than it prevents. Instead: run every remaining
  // step, record the first hard failure, and throw at the END. What is
  // NOT acceptable (and is what this code used to do) is returning
  // `{ok:true}` for an extension the caller asked to have enabled and
  // loaded that is neither — the install card then tells the user
  // "installed and enabled" about an extension with no live tools.
  let postFailure: { code: AuthorInstallErrorCode; message: string } | null =
    null;
  const warnings: string[] = [];

  // 4b) Auto-enable BEFORE the registry reload so the reload
  //     materializes it enabled and its tools enter the LLM toolset.
  if (enable) {
    try {
      await updateExtension(installed.id, { enabled: true });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log.error("installAuthoredDraft: enable failed (installed but disabled)", {
        extensionId: installed.id,
        error: detail,
      });
      postFailure = {
        code: "ENABLE_FAILED",
        message:
          `Extension "${name}" was installed but could NOT be enabled ` +
          `(${detail}). Its tools are not available. Enable it from the ` +
          `Extensions library, or uninstall and retry.`,
      };
    }
  }

  // 5) Consume the draft row (idempotent).
  await consumeDraft(draftId, userId);

  // 6) Reload the registry so the new row is visible. A failure here
  //    means the extension is installed but NOT loaded — none of its
  //    tools exist in this process until something else reloads.
  try {
    await ExtensionRegistry.getInstance().reload();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log.error("installAuthoredDraft: registry reload failed after install", {
      extensionId: installed.id,
      error: detail,
    });
    postFailure ??= {
      code: "REGISTRY_RELOAD_FAILED",
      message:
        `Extension "${name}" was installed but the extension registry ` +
        `failed to reload (${detail}). Its tools are not loaded yet — ` +
        `restart the server or reload the extensions library.`,
    };
  }

  // Sanctioned-modify succeeded — drop the pre-modify backup. A
  // leftover `*.modify-bak-*` dir is inert (not a valid extension dir,
  // never in the registry — `.ezcorp/extensions` is enumerated by DB
  // row, not by directory scan) but it is NOT invisible: it eats disk
  // and confuses anyone reading the directory, so surface it.
  if (modifyBackupDir) {
    try {
      await rm(modifyBackupDir, { recursive: true, force: true });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      log.warn("installAuthoredDraft: modify backup cleanup failed", {
        extensionId: installed.id,
        backupDir: modifyBackupDir,
        error: detail,
      });
      warnings.push(
        `Could not remove the pre-modify backup directory ` +
          `"${modifyBackupDir}" (${detail}). It is inert but must be ` +
          `deleted by hand.`,
      );
    }
  }

  if (postFailure) {
    throw new AuthorInstallError(postFailure.code, postFailure.message, {
      errors: [postFailure.message, ...warnings],
      extensionId: installed.id,
      name,
    });
  }

  // D2 defence in depth: re-assert the strict name shape HERE, right
  // before minting a user-clickable deep-link. `name` is the manifest
  // name that already passed `validateManifestV2` upstream — this
  // re-check exists so NO code path between here and the rendered
  // button can ever emit an attacker-shaped URL. On the (should-be-
  // impossible) failure we omit `openUrl` entirely; the install itself
  // is unaffected and `redirectUrl` (the web form's byte-identical
  // HTTP contract — D5) is returned unchanged.
  const redirectUrl = `/extensions/${name}`;
  const openUrl = NAME_REGEX.test(name) ? redirectUrl : undefined;
  if (openUrl === undefined) {
    log.warn(
      "installAuthoredDraft: manifest name failed host NAME_REGEX re-check — omitting openUrl deep-link",
      { extensionId: installed.id, name },
    );
  }
  return {
    extensionId: installed.id,
    name,
    redirectUrl,
    ...(openUrl !== undefined ? { openUrl } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
