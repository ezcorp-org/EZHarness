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
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  consumeDraft,
  getDraft,
  getExtensionAuthorDraftDir,
} from "../db/queries/ez-drafts";
import { getExtensionByName, updateExtension } from "../db/queries/extensions";
import { installFromLocal } from "./installer";
import { ExtensionRegistry } from "./registry";
import { loadManifest } from "./loader";
import { verifyExtension } from "./sdk/verify";
import type { ExtensionPermissions } from "./types";
import { logger } from "../logger";

const log = logger.child("author-install");

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

/** Kinds that MUST pass the deterministic gate (a passing `smokeTest`
 *  round-trip) before install. skill/agent have no subprocess to
 *  round-trip and skip it. Mirrors the web route verbatim. */
const VERIFY_REQUIRED_TYPES: ReadonlySet<string> = new Set(["tool", "multi"]);

export type AuthorInstallErrorCode =
  | "DRAFT_NOT_FOUND"
  | "NOT_EXTENSION_DRAFT"
  | "DRAFT_DIR_MISSING"
  | "MANIFEST_INVALID"
  | "VERIFY_FAILED"
  | "NAME_COLLISION"
  | "ENV_KEY_LEAK"
  | "INSTALL_FAILED"
  | "ROLLBACK_FAILED";

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

  // 2) Manifest validation via the canonical loader (child-process
  //    import — a malicious manifest cannot run JS in this process).
  const cfgPath = join(draftDir, "ezcorp.config.ts");
  if (!existsSync(cfgPath)) {
    throw new AuthorInstallError("MANIFEST_INVALID", "Missing ezcorp.config.ts", {
      errors: ["Missing ezcorp.config.ts"],
    });
  }
  let manifest: Awaited<ReturnType<typeof loadManifest>>;
  try {
    manifest = await loadManifest(draftDir);
  } catch (e) {
    throw new AuthorInstallError(
      "MANIFEST_INVALID",
      "Manifest invalid or failed to load",
      { errors: [e instanceof Error ? e.message : String(e)] },
    );
  }
  const m = manifest as { name?: unknown };
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw new AuthorInstallError("MANIFEST_INVALID", "Manifest missing name", {
      errors: ["name required"],
    });
  }
  const name = m.name;

  // 2b) Deterministic acceptance gate for tool/multi — HARD-FAIL
  //     unless a declared `smokeTest` round-trip passes.
  const draftPayload = (row.payload ?? {}) as Record<string, unknown>;
  const draftType =
    typeof draftPayload.type === "string" ? draftPayload.type : "";
  if (VERIFY_REQUIRED_TYPES.has(draftType)) {
    const verifyResult = await verifyExtension({ extDir: draftDir });
    if (!verifyResult.pass) {
      const failed = verifyResult.steps.find((s) => !s.ok);
      throw new AuthorInstallError(
        "VERIFY_FAILED",
        "Deterministic acceptance gate failed — a passing `smokeTest` " +
          "is required for tool/multi extensions",
        {
          errors: [failed ? `${failed.name}: ${failed.detail}` : "verify failed"],
          verifyResult: verifyResult as unknown as Record<string, unknown>,
        },
      );
    }
  }

  // 3) Name-collision check + move dir → installed location.
  const existing = await getExtensionByName(name);
  if (existing) {
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
    throw new AuthorInstallError(
      "NAME_COLLISION",
      `Install path "${installedPath}" already exists`,
    );
  }
  await mkdir(dirname(installedPath), { recursive: true });
  await rename(draftDir, installedPath);

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
      ...(requestedPermissions.taskEvents ? { taskEvents: now } : {}),
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
    installed = await installFromLocal(
      installedPath,
      grantedPermissions,
      false,
      { isBundled: false, envEscapeHatch: false, preloadedManifest: manifest },
    );
  } catch (err) {
    try {
      await mkdir(dirname(draftDir), { recursive: true });
      await rename(installedPath, draftDir);
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

  // 4b) Auto-enable BEFORE the registry reload so the reload
  //     materializes it enabled and its tools enter the LLM toolset.
  //     Non-fatal: a failed enable still leaves a valid (disabled)
  //     install the user can flip on manually.
  if (enable) {
    try {
      await updateExtension(installed.id, { enabled: true });
    } catch (e) {
      log.warn("installAuthoredDraft: enable failed (installed but disabled)", {
        extensionId: installed.id,
        error: String(e),
      });
    }
  }

  // 5) Consume the draft row (idempotent).
  await consumeDraft(draftId, userId);

  // 6) Reload the registry so the new row is visible. Non-fatal.
  try {
    await ExtensionRegistry.getInstance().reload();
  } catch {
    /* next reload picks it up */
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
  };
}
