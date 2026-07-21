import type { JsonRpcRequest, JsonRpcResponse } from "../types";
import type { ExtensionRegistry } from "../registry";
import type { PermissionEngine } from "../permission-engine";
import { checkFilesystemPermission } from "../permissions";
import { denyAndDisable } from "../security";
import {
  handleFsReadRpc,
  handleFsWriteRpc,
  handleFsListRpc,
  handleFsStatRpc,
  handleFsExistsRpc,
  handleFsMkdirRpc,
  handleFsUnlinkRpc,
  type FsHandlerContext,
  type FsRpcResponse,
} from "../fs-handler";
import { resolveReverseRpcMeta } from "./provenance";

/** The `ToolExecutor` state an fs.* handler reads: the PDP + the registry. */
export interface FsRpcDeps {
  engine: PermissionEngine;
  registry: ExtensionRegistry;
}

/**
 * Phase 3: tracks which extensions have already received the
 * `ezcorp/fs` deprecation warning. The shim emits exactly ONE warn
 * per extension per process — repeat calls are silent.
 *
 * Cleared per-extension when the registry's `cleanupExtTmpDir(extId)`
 * runs (on uninstall) so a reinstalled extension gets a fresh warning
 * on its next legacy-shim call (validator nit #5 / N2). Cleared
 * wholesale by `_resetFsDeprecationWarningsForTests` for unit tests.
 */
export const fsDeprecationWarned = new Set<string>();

/** Test-only: clear the deprecation-warning tracker. */
export function _resetFsDeprecationWarningsForTests(): void {
  fsDeprecationWarned.clear();
}

/**
 * Drop the deprecation-warning entry for one extension. Called from
 * `registry.cleanupExtTmpDir` (uninstall path) so a reinstalled
 * extension warns afresh on its first legacy-shim call instead of
 * staying silently in the Set forever.
 */
export function clearFsDeprecationForExtension(extensionId: string): void {
  fsDeprecationWarned.delete(extensionId);
}

/**
 * @deprecated Phase 3: replaced by `ezcorp/fs.{read,write,list,stat,
 * exists,mkdir,unlink}` host-mediated handlers (`../fs-handler.ts`).
 * The path-check shim stays for one release so existing extensions
 * keep working unchanged. Phase 6 deletes it.
 *
 * Behavior:
 *  - Validates params (path, operation).
 *  - Runs `checkFilesystemPermission` (default mode "read") for the
 *    same allow/deny decision the old handler returned.
 *  - On allow: returns `{allowed, resolvedPath}` — IDENTICAL to the
 *    pre-Phase-3 shape. The subprocess still does the actual IO,
 *    using the now-poisoned `Bun.file` / `node:fs` primitives — which
 *    means **bundled extensions still calling this shim will have to
 *    route their reads through `ezcorp/fs.read` once they're
 *    migrated**. The shim itself doesn't fail; it just prints a
 *    warning so authors know to migrate.
 *  - On deny: same `denyAndDisable` + -32001 as before.
 *  - One-time `console.warn` per extension on FIRST call only (a
 *    Set tracks which extensions have already warned). Stops noisy
 *    repeated warns at runtime; tests reset via
 *    `_resetDeprecationWarningsForTests`.
 */
export async function handlePiFs(
  registry: ExtensionRegistry,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  if (!fsDeprecationWarned.has(extensionId)) {
    fsDeprecationWarned.add(extensionId);
    console.warn(
      `[ezcorp/fs] deprecated: extension "${extensionId}" called the path-check shim. ` +
        "Migrate to ezcorp/fs.read | write | list | stat | exists | mkdir | unlink " +
        "(host-mediated; SDK helpers in @ezcorp/sdk/runtime). " +
        "This shim is removed in milestone v2.",
    );
  }
  const params = (req.params ?? {}) as Record<string, unknown>;
  const operation = params.operation as string;
  const path = params.path as string;

  if (!path || !operation) {
    return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "Missing path or operation" } };
  }

  const granted = registry.getGrantedPermissions(extensionId);
  const installPath = registry.getInstallPath(extensionId);

  if (!granted || !installPath) {
    return { jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "Extension not found in registry" } };
  }

  const result = await checkFilesystemPermission(path, granted, installPath);

  if (!result.allowed) {
    await denyAndDisable(extensionId, `Filesystem access denied: ${operation} on ${path} (resolved: ${result.resolvedPath})`, result.resolvedPath);
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32001, message: `Filesystem access denied: ${path} is outside declared permission paths. Extension has been disabled.` },
    };
  }

  return {
    jsonrpc: "2.0",
    id: req.id,
    result: { allowed: true, resolvedPath: result.resolvedPath },
  };
}

// ── Phase 3: per-operation `ezcorp/fs.*` handlers ─────────────────

/**
 * Build the FsHandlerContext shared by every fs.* handler.
 *
 * Provenance (userId / conversationId) is resolved from the
 * host-issued `ezCallId` correlation token the subprocess echoed
 * back — IDENTICAL to `handlePiDrafts` / `handlePiAppendMessage` —
 * NOT from the process-wide `currentUserId` / `currentConversationId`
 * singletons (wrong under concurrency and for background fires; this
 * is the latent half of the reverse-RPC provenance bug). The PDP
 * (`engine.authorize`) and audit log inside `fs-handler.ts` consume
 * `ctx.userId` / `ctx.conversationId`, so they MUST be the true
 * caller. The path-allowlist (`checkFilesystemPermission`) is keyed
 * on the extension's declared grant + install path, never the user —
 * so resolving real provenance here does not weaken it.
 *
 * On an unresolved (-32602) or ownerless (-32106) token, returns the
 * resolver's verbatim error response; the caller MUST return it. A
 * background fire hitting fs.* SHOULD cleanly fail, never silently
 * act as the "unknown" user.
 */
export function buildFsHandlerCtx(
  deps: FsRpcDeps,
  extensionId: string,
  req: JsonRpcRequest,
):
  | { ok: true; ctx: FsHandlerContext }
  | { ok: false; errorResponse: JsonRpcResponse } {
  const resolved = resolveReverseRpcMeta(extensionId, req);
  if (!resolved.ok) return { ok: false, errorResponse: resolved.errorResponse };
  return {
    ok: true,
    ctx: {
      extensionId,
      conversationId: resolved.conversationId ?? "unknown",
      userId: resolved.onBehalfOf,
      engine: deps.engine,
      registry: deps.registry,
    },
  };
}

/** `ezcorp/fs.read` — host-mediated read. Streams >1MB responses. */
export async function handlePiFsRead(deps: FsRpcDeps, extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
  const built = buildFsHandlerCtx(deps, extensionId, req);
  if (!built.ok) return built.errorResponse;
  return handleFsReadRpc(req, built.ctx);
}

/** `ezcorp/fs.write` — host-mediated write. */
export async function handlePiFsWrite(deps: FsRpcDeps, extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
  const built = buildFsHandlerCtx(deps, extensionId, req);
  if (!built.ok) return built.errorResponse;
  return handleFsWriteRpc(req, built.ctx);
}

/** `ezcorp/fs.list` — host-mediated directory list. */
export async function handlePiFsList(deps: FsRpcDeps, extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
  const built = buildFsHandlerCtx(deps, extensionId, req);
  if (!built.ok) return built.errorResponse;
  return handleFsListRpc(req, built.ctx);
}

/** `ezcorp/fs.stat` — host-mediated stat. */
export async function handlePiFsStat(deps: FsRpcDeps, extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
  const built = buildFsHandlerCtx(deps, extensionId, req);
  if (!built.ok) return built.errorResponse;
  return handleFsStatRpc(req, built.ctx);
}

/** `ezcorp/fs.exists` — host-mediated existence check. */
export async function handlePiFsExists(deps: FsRpcDeps, extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
  const built = buildFsHandlerCtx(deps, extensionId, req);
  if (!built.ok) return built.errorResponse;
  return handleFsExistsRpc(req, built.ctx);
}

/** `ezcorp/fs.mkdir` — host-mediated mkdir. */
export async function handlePiFsMkdir(deps: FsRpcDeps, extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
  const built = buildFsHandlerCtx(deps, extensionId, req);
  if (!built.ok) return built.errorResponse;
  return handleFsMkdirRpc(req, built.ctx);
}

/** `ezcorp/fs.unlink` — host-mediated unlink. */
export async function handlePiFsUnlink(deps: FsRpcDeps, extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
  const built = buildFsHandlerCtx(deps, extensionId, req);
  if (!built.ok) return built.errorResponse;
  return handleFsUnlinkRpc(req, built.ctx);
}
