/**
 * `ezcorp/drafts` reverse-RPC handler — bundled-only authoring of
 * `ez_drafts` rows.
 *
 * Created for the bundled `extension-author` extension so its
 * `create_extension` tool can produce a proposal-card draft (the
 * `EzToolResultCard.svelte` consumer renders `result.openUrl` as a
 * one-button "Open prefilled form"). The draft row's `payload`
 * carries `{ draftDir, name, type, mode: "author" }` — read by the
 * editable preview page at `/extensions/author?prefill=<id>`.
 *
 * Defense-in-depth: bundled-only via the explicit
 * `BUNDLED_DRAFTS_ALLOWLIST` set below — checked by the calling
 * extension's NAME, not by manifest-declared permissions. A user-
 * installed extension can declare `permissions.custom.drafts.kinds`
 * in its manifest, but the handler refuses to honor it because the
 * name isn't in the allowlist. This is intentional: the bundled
 * ceiling DOES NOT block `custom.drafts.*` for user-installed names
 * (`getCeiling()` returns null for unknown names; `clampToBundledCeiling`
 * passes the request through unchanged), so the allowlist IS the
 * gate.
 *
 * Methods (all owner-scoped via `ctx.userId` — extension subprocesses
 * cannot forge identity):
 *   - `create({ kind, payload, ttlMs?, files? })` → `{ draftId, openUrl }`
 *     For kind=extension + mode=author, mints + namespaces a draft
 *     directory under `drafts/<userId>/<draftId>/`, materializes the
 *     `files` map to disk HOST-SIDE (the subprocess does no fs on the
 *     create path), and stamps the dir into `payload.draftDir`.
 *     `files` is REQUIRED for that kind; materialization failure is
 *     transactional (row discarded, -32603 returned).
 *   - `consume({ draftId })` → `{ ok: boolean }`
 *   - `resolveDir({ draftId })` → `{ draftDir }`
 *     Returns the absolute directory path ONLY if the caller owns the
 *     draft. -32603 on miss / expired / wrong-owner (existence opaque).
 *     This is the ONLY supported path for the bundled extension to map
 *     a draftId → directory; never compute the path from draftId alone.
 *   - `listForUser()` → `{ drafts: [{ draftId, name?, type?, createdAt }] }`
 *     Active (non-expired) drafts belonging to the caller. Used by
 *     `list_drafts` instead of an fs glob.
 *   - `discard({ draftId })` → `{ ok: boolean }`
 *     Owner-scoped consume + recursive directory removal in one round
 *     trip. The bundled extension's `fsUnlink` cannot recurse-remove a
 *     non-empty dir, so this path moves the removal to the host.
 */

import type { ExtensionPermissions, JsonRpcRequest, JsonRpcResponse } from "./types";
import { rpcError, rpcResult } from "./json-rpc";
import {
  createDraft,
  consumeDraft,
  discardDraftAndDir,
  getDraft,
  getExtensionAuthorDraftDir,
  listActiveDraftsForUser,
  writeExtensionAuthorDraftFiles,
  type EzDraftKind,
} from "../db/queries/ez-drafts";
import { logger } from "../logger";

const log = logger.child("ext.drafts-handler");

/**
 * Bundled extensions allowed to create drafts via `ezcorp/drafts`.
 *
 * This is the SOLE gate — it's checked by extension NAME (not id, not
 * manifest, not granted permissions) so a compromised manifest cannot
 * widen the allowlist. Adding an entry here is a security-relevant
 * decision that MUST be reviewed at the same level as a
 * `BUNDLED_CEILING` change.
 */
export const BUNDLED_DRAFTS_ALLOWLIST: ReadonlySet<string> = new Set([
  "extension-author",
]);

/**
 * Whitelist of `EzDraftKind` values. The `ez_drafts` schema currently
 * accepts `'project' | 'agent' | 'extension'` — keep this in lockstep.
 */
const VALID_DRAFT_KINDS: ReadonlySet<EzDraftKind> = new Set([
  "project",
  "agent",
  "extension",
]);

/**
 * Per-kind URL prefix for the proposal-card "Open prefilled form" link.
 * The `extension-author` flow uses `/extensions/author?prefill=<id>` —
 * different from the other kinds which point to their existing pages.
 * Keep entries in lockstep with the destination pages' `?prefill=<id>`
 * hydration logic.
 */
const OPEN_URL_PREFIX: Record<EzDraftKind, string> = {
  project: "/projects/new?prefill=",
  agent: "/agents/new?prefill=",
  extension: "/extensions/author?prefill=",
};

export interface DraftsContext {
  /** The user the call is on behalf of. Pulled from `currentUserId`
   *  on the executor — never trusted from the RPC. */
  userId: string;
  /** Granted permissions for the calling extension. The handler reads
   *  `custom.drafts.kinds` from this; empty/missing → reject. */
  grantedPermissions: ExtensionPermissions;
}

interface DraftsCreateParams {
  kind?: EzDraftKind;
  payload?: Record<string, unknown>;
  ttlMs?: number;
  /**
   * Scaffolded file map (`relpath → content`). REQUIRED for
   * extension-author drafts (`kind === "extension"` AND
   * `payload.mode === "author"`); the host materializes these to disk
   * itself so the sandboxed subprocess does no filesystem ops on the
   * create path. A sibling of `payload` (NOT inside it) so the file
   * bytes never bloat the persisted `ez_drafts.payload` row.
   */
  files?: Record<string, string>;
}

interface DraftsConsumeParams {
  draftId?: string;
}

interface DraftsResolveDirParams {
  draftId?: string;
}

interface DraftsDiscardParams {
  draftId?: string;
}

interface DraftsVerifyParams {
  draftId?: string;
}

interface DraftsInstallParams {
  draftId?: string;
}

/**
 * Look up the calling extension's allowed kinds. Returns the array
 * verbatim from `granted.custom.drafts.kinds`, or `null` when:
 *   - `granted.custom` is missing
 *   - `granted.custom.drafts` is missing
 *   - `granted.custom.drafts.kinds` is not an array of strings
 */
function getDeclaredKinds(granted: ExtensionPermissions): string[] | null {
  const drafts = granted.custom?.drafts;
  if (!drafts || typeof drafts !== "object") return null;
  const kinds = (drafts as { kinds?: unknown }).kinds;
  if (!Array.isArray(kinds)) return null;
  if (!kinds.every((k) => typeof k === "string")) return null;
  return kinds as string[];
}

/**
 * Top-level handler. Routes on `params.action` (matching the storage-
 * handler shape) — the wire format is `{ jsonrpc: "2.0", method:
 * "ezcorp/drafts", params: { action, ... } }`.
 */
export async function handleDraftsRpc(
  extensionName: string,
  req: JsonRpcRequest,
  ctx: DraftsContext,
): Promise<JsonRpcResponse> {
  // 1) Bundled-only allowlist. CHECKED BY NAME — a compromised manifest
  //    can't widen this set. Reject with -32603 (internal/unknown
  //    capability) so the subprocess sees a non-recoverable response;
  //    the matching test pins this code.
  if (!BUNDLED_DRAFTS_ALLOWLIST.has(extensionName)) {
    log.warn("ezcorp/drafts rejected: extension not in bundled allowlist", {
      extensionName,
    });
    return rpcError(req.id, -32603, "ezcorp/drafts is bundled-only");
  }

  // 2) The calling manifest must declare what kinds it can create.
  //    Missing / malformed `custom.drafts.kinds` → -32603 (matching
  //    the storage-handler "permission not granted" shape — drafts
  //    isn't a primary permission, so we use the same code).
  const declaredKinds = getDeclaredKinds(ctx.grantedPermissions);
  if (!declaredKinds) {
    return rpcError(req.id, -32603, "custom.drafts.kinds not granted");
  }

  const params = (req.params ?? {}) as Record<string, unknown>;
  const action = params.action as string;
  if (!action) return rpcError(req.id, -32602, "Missing 'action' parameter");

  switch (action) {
    case "create":
      return handleCreate(req, params as DraftsCreateParams, ctx, declaredKinds);
    case "consume":
      return handleConsume(req, params as DraftsConsumeParams, ctx);
    case "resolveDir":
      return handleResolveDir(req, params as DraftsResolveDirParams, ctx);
    case "listForUser":
      return handleListForUser(req, ctx);
    case "discard":
      return handleDiscard(req, params as DraftsDiscardParams, ctx);
    case "verify":
      return handleVerify(req, params as DraftsVerifyParams, ctx);
    case "install":
      return handleInstall(req, params as DraftsInstallParams, ctx);
    default:
      return rpcError(req.id, -32602, `Unknown action: ${action}`);
  }
}

async function handleCreate(
  req: JsonRpcRequest,
  params: DraftsCreateParams,
  ctx: DraftsContext,
  declaredKinds: string[],
): Promise<JsonRpcResponse> {
  // ── Param validation ─────────────────────────────────────────────
  const kind = params.kind;
  if (!kind || typeof kind !== "string") {
    return rpcError(req.id, -32602, "Missing or invalid 'kind'");
  }
  if (!VALID_DRAFT_KINDS.has(kind as EzDraftKind)) {
    return rpcError(req.id, -32602, `Unknown kind: ${kind}`);
  }
  if (!declaredKinds.includes(kind)) {
    return rpcError(
      req.id,
      -32603,
      `kind '${kind}' not in granted custom.drafts.kinds`,
    );
  }

  const payload = params.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return rpcError(req.id, -32602, "Missing or invalid 'payload' (must be an object)");
  }

  // ttlMs is optional. When provided, must be a positive finite number
  // ≤ 24h * 30 (30-day cap to prevent indefinite drafts; the default is
  // 24h via createDraft itself).
  const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  let ttlMs: number | undefined;
  if (params.ttlMs !== undefined) {
    if (
      typeof params.ttlMs !== "number" ||
      !Number.isFinite(params.ttlMs) ||
      params.ttlMs <= 0
    ) {
      return rpcError(req.id, -32602, "ttlMs must be a positive number");
    }
    if (params.ttlMs > MAX_TTL_MS) {
      return rpcError(req.id, -32602, `ttlMs exceeds 30-day cap (${MAX_TTL_MS}ms)`);
    }
    ttlMs = params.ttlMs;
  }

  // ── Extension-author create is HOST-OWNED ───────────────────────
  //
  // For extension-author drafts (`kind === "extension"` AND
  // `payload.mode === "author"`) the host materializes the draft
  // directory + scaffold files itself. The sandboxed subprocess does
  // NO filesystem ops on the create path — that removes the bootstrap
  // deadlock where the host fs gate denied the first `fsMkdir`
  // because the granted `.ezcorp/extension-data/extension-author`
  // dir didn't exist yet. `files` is a REQUIRED sibling param for
  // this kind. Shape-check it here (fail fast, BEFORE minting a row);
  // the deep per-entry / allowlist validation lives in
  // `writeExtensionAuthorDraftFiles`.
  const pObj = payload as Record<string, unknown>;
  const isAuthorDraft = kind === "extension" && pObj.mode === "author";
  if (isAuthorDraft) {
    const f = params.files;
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      return rpcError(
        req.id,
        -32602,
        "extension-author drafts require a 'files' object (relpath → content)",
      );
    }
  }

  // ── Insert the row ───────────────────────────────────────────────
  //
  // For extension-author drafts we mint a userId-namespaced draftDir
  // and stamp it into the persisted payload. The bundled extension
  // reads it back via `resolveDir({ draftId })` — it must NEVER
  // compute the path itself from the draftId, because doing so would
  // expose a guess-and-read attack across users (reviewer C1).
  let row;
  try {
    row = await createDraft({
      userId: ctx.userId,
      kind: kind as EzDraftKind,
      payload: payload as Record<string, unknown>,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    });
  } catch (err) {
    log.error("ezcorp/drafts.create failed", {
      userId: ctx.userId,
      kind,
      error: String(err),
    });
    return rpcError(req.id, -32603, `Failed to create draft: ${String(err)}`);
  }

  // Materialize the draft dir + files HOST-SIDE, then stamp the
  // resolved dir into the payload. Materialization is FATAL — a
  // half-created draft (row but no/partial files) is useless and the
  // LLM can't recover it, so we treat the row as transactional:
  // best-effort discard + a clean error rather than a silent stub.
  // The draftDir stamp itself stays best-effort (every consumer
  // re-derives the dir from `getExtensionAuthorDraftDir`, so a failed
  // stamp is non-fatal).
  if (isAuthorDraft) {
    let draftDir: string;
    try {
      ({ draftDir } = await writeExtensionAuthorDraftFiles(
        row.id,
        ctx.userId,
        params.files as Record<string, string>,
      ));
    } catch (err) {
      log.error("ezcorp/drafts.create: failed to materialize draft files", {
        draftId: row.id,
        userId: ctx.userId,
        error: String(err),
      });
      try {
        await discardDraftAndDir(row.id, ctx.userId);
      } catch (discardErr) {
        log.warn("ezcorp/drafts.create: rollback discard failed", {
          draftId: row.id,
          error: String(discardErr),
        });
      }
      return rpcError(
        req.id,
        -32603,
        `Failed to materialize draft files: ${String(err)}`,
      );
    }
    try {
      const { getDb } = await import("../db/connection");
      const { ezDrafts } = await import("../db/schema");
      const { eq } = await import("drizzle-orm");
      await getDb()
        .update(ezDrafts)
        .set({ payload: { ...pObj, draftDir } })
        .where(eq(ezDrafts.id, row.id));
    } catch (err) {
      log.warn("ezcorp/drafts.create: failed to stamp draftDir", {
        draftId: row.id,
        userId: ctx.userId,
        error: String(err),
      });
    }
  }

  const openUrl = `${OPEN_URL_PREFIX[kind as EzDraftKind]}${row.id}`;

  return rpcResult(req.id, {
    draftId: row.id,
    openUrl,
  });
}

async function handleConsume(
  req: JsonRpcRequest,
  params: DraftsConsumeParams,
  ctx: DraftsContext,
): Promise<JsonRpcResponse> {
  const draftId = params.draftId;
  if (!draftId || typeof draftId !== "string") {
    return rpcError(req.id, -32602, "Missing or invalid 'draftId'");
  }

  const row = await consumeDraft(draftId, ctx.userId);
  // consumeDraft returns undefined when the row is missing, expired, or
  // owned by a different user. Mirror that as `ok: false` (idempotent
  // shape: a second consume of the same id by the same owner returns
  // `ok: true` with the same row).
  return rpcResult(req.id, { ok: row != null });
}

/**
 * Owner-scoped path resolver. The bundled extension calls this BEFORE
 * any per-draft filesystem op (read / write / discard / validate).
 *
 * Returns `-32603` (NOT 404, NOT -32000) on miss / expired / wrong-owner
 * so the existence of a draft id is opaque to a cross-user probe. The
 * matching test pins this exact code.
 */
async function handleResolveDir(
  req: JsonRpcRequest,
  params: DraftsResolveDirParams,
  ctx: DraftsContext,
): Promise<JsonRpcResponse> {
  const draftId = params.draftId;
  if (!draftId || typeof draftId !== "string") {
    return rpcError(req.id, -32602, "Missing or invalid 'draftId'");
  }

  const row = await getDraft(draftId, ctx.userId);
  if (!row) {
    // Opaque error: a non-owner sees the same response as a missing /
    // expired draft. Do NOT leak whether the id exists.
    return rpcError(req.id, -32603, "Draft not found");
  }

  // Only extension-author drafts have an on-disk dir. Other kinds
  // (project / agent) don't — reject explicitly.
  const payload = row.payload as Record<string, unknown> | null;
  if (row.kind !== "extension" || !payload || payload.mode !== "author") {
    return rpcError(req.id, -32603, "Draft does not have a directory");
  }

  let draftDir: string;
  try {
    draftDir = getExtensionAuthorDraftDir(row.id, row.userId);
  } catch (err) {
    log.warn("resolveDir: getExtensionAuthorDraftDir threw", {
      draftId,
      error: String(err),
    });
    return rpcError(req.id, -32603, "Failed to resolve draft directory");
  }

  return rpcResult(req.id, { draftDir });
}

/**
 * Run the deterministic acceptance gate (`verifyExtension`) against an
 * owner-scoped draft dir, HOST-SIDE. The bundled `extension-author`
 * subprocess cannot import `src/extensions/sdk/verify.ts` (sandbox-
 * preload poisons fs; the host module isn't reachable from the
 * subprocess), so `validate_extension` reverse-RPCs here instead of
 * self-judging. The structured `VerifyResult` is the machine verdict
 * the LLM sees — root-cause fix #4 (hand-rolled bypass) of the loop
 * incident: the author path is the only path that yields a real PASS.
 *
 * Owner-scoping is identical to `handleResolveDir` — a non-owner /
 * missing / non-author draft gets the same opaque -32603.
 */
async function handleVerify(
  req: JsonRpcRequest,
  params: DraftsVerifyParams,
  ctx: DraftsContext,
): Promise<JsonRpcResponse> {
  const draftId = params.draftId;
  if (!draftId || typeof draftId !== "string") {
    return rpcError(req.id, -32602, "Missing or invalid 'draftId'");
  }

  const row = await getDraft(draftId, ctx.userId);
  if (!row) {
    return rpcError(req.id, -32603, "Draft not found");
  }

  const payload = row.payload as Record<string, unknown> | null;
  if (row.kind !== "extension" || !payload || payload.mode !== "author") {
    return rpcError(req.id, -32603, "Draft does not have a directory");
  }

  let draftDir: string;
  try {
    draftDir = getExtensionAuthorDraftDir(row.id, row.userId);
  } catch (err) {
    log.warn("verify: getExtensionAuthorDraftDir threw", {
      draftId,
      error: String(err),
    });
    return rpcError(req.id, -32603, "Failed to resolve draft directory");
  }

  // Lazy import so the subprocess sandbox-preload graph (which cannot
  // touch fs) never pulls verify.ts; this handler runs in the HOST.
  const { verifyExtension } = await import("./sdk/verify");
  const result = await verifyExtension({ extDir: draftDir });
  return rpcResult(req.id, result as unknown as Record<string, unknown>);
}

/**
 * Install an authored draft as a real, ENABLED extension.
 *
 * This action only ever runs AFTER the tool-call permission gate for
 * `ezcorp:extension:install` was explicitly approved by the user (the
 * gate is enforced host-side in `tool-executor.ts` BEFORE the
 * `install_draft` tool body issues this reverse-RPC — see the
 * always-prompt carve-outs in `permission-engine.ts`). It performs NO
 * approval of its own; it runs the exact same secure pipeline the web
 * form uses (`installAuthoredDraft` — owner scope, `verifyExtension`
 * hard-gate, `installFromLocal` env-key-leak gate, `isBundled:false`)
 * with `enable:true` so the just-approved extension is immediately
 * testable.
 *
 * Lazy-imported (mirrors `handleVerify`) so the sandbox-preload graph
 * never pulls the host-only install modules; this runs in the HOST.
 */
async function handleInstall(
  req: JsonRpcRequest,
  params: DraftsInstallParams,
  ctx: DraftsContext,
): Promise<JsonRpcResponse> {
  const draftId = params.draftId;
  if (!draftId || typeof draftId !== "string") {
    return rpcError(req.id, -32602, "Missing or invalid 'draftId'");
  }

  const { installAuthoredDraft, AuthorInstallError } = await import(
    "./author-install"
  );
  try {
    const result = await installAuthoredDraft({
      draftId,
      userId: ctx.userId,
      enable: true,
    });
    // D1/D2: surface the host-revalidated relative deep-link so the
    // `EzToolResultCard` "Open extension" button can render it. Keep
    // `{ ok, extensionId, name }` exactly for back-compat (existing
    // tool-result consumers + the bundled extension's `install_draft`
    // body keyed on those three). `openUrl` is OMITTED when the
    // pipeline withheld it (name failed the host NAME_REGEX re-check)
    // — never emit a malformed URL.
    return rpcResult(req.id, {
      ok: true,
      extensionId: result.extensionId,
      name: result.name,
      ...(result.openUrl !== undefined ? { openUrl: result.openUrl } : {}),
    });
  } catch (err) {
    if (err instanceof AuthorInstallError) {
      log.warn("ezcorp/drafts.install rejected", {
        draftId,
        userId: ctx.userId,
        code: err.code,
        error: err.message,
      });
      return rpcError(req.id, -32603, `${err.code}: ${err.message}`);
    }
    log.error("ezcorp/drafts.install failed", {
      draftId,
      userId: ctx.userId,
      error: String(err),
    });
    return rpcError(req.id, -32603, `Install failed: ${String(err)}`);
  }
}

/**
 * Owner-scoped active-drafts listing. Bundled extension's `list_drafts`
 * uses this instead of an fs glob (the fs glob would surface dirs from
 * a previous user's session on a shared install, plus it leaks the
 * existence of OTHER users' drafts to the bundled extension's logger
 * stream).
 */
async function handleListForUser(
  req: JsonRpcRequest,
  ctx: DraftsContext,
): Promise<JsonRpcResponse> {
  const rows = await listActiveDraftsForUser(ctx.userId);
  const drafts = rows
    .filter((r) => {
      const p = r.payload as Record<string, unknown> | null;
      return r.kind === "extension" && p && p.mode === "author";
    })
    .map((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      return {
        draftId: r.id,
        name: typeof p.name === "string" ? p.name : undefined,
        type: typeof p.type === "string" ? p.type : undefined,
        createdAt: r.createdAt.getTime(),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return rpcResult(req.id, { drafts });
}

/**
 * Owner-scoped consume-and-remove-dir in one round trip. Replaces the
 * bundled extension's previous recursive-fsUnlink approach (which left
 * the directory itself behind because `fsUnlink(dir)` returns EISDIR;
 * see reviewer C2).
 *
 * Idempotent: a second discard returns `{ ok: true }` whether the row
 * was already swept or the dir already removed.
 */
async function handleDiscard(
  req: JsonRpcRequest,
  params: DraftsDiscardParams,
  ctx: DraftsContext,
): Promise<JsonRpcResponse> {
  const draftId = params.draftId;
  if (!draftId || typeof draftId !== "string") {
    return rpcError(req.id, -32602, "Missing or invalid 'draftId'");
  }

  // Owner check — same opacity rule as resolveDir.
  const row = await getDraft(draftId, ctx.userId);
  if (!row) {
    return rpcError(req.id, -32603, "Draft not found");
  }

  try {
    const result = await discardDraftAndDir(draftId, ctx.userId);
    return rpcResult(req.id, result);
  } catch (err) {
    log.error("ezcorp/drafts.discard failed", {
      draftId,
      userId: ctx.userId,
      error: String(err),
    });
    return rpcError(req.id, -32603, `Failed to discard draft: ${String(err)}`);
  }
}
