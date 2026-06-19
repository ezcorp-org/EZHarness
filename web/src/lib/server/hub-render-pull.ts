/**
 * Extension Pages Hub — host render-pull (spec §2.3).
 *
 * Resolves `ext:<name>:<pageId>` Hub renders:
 *
 *   1. Extension enabled + page declared (else notFound → 404).
 *   2. Page cache (60s TTL): fresh → instant; stale → serve +
 *      `stale: true` + fire-and-forget background refresh.
 *   3. Miss: lazy-spawn the subprocess (`registry.getProcess` — first
 *      open costs 1–3s; the Hub skeleton covers it), wire reverse-RPC
 *      (same `ensureSubprocessRpcWired` recipe as the events route's
 *      messageToolbar branch), then `proc.call("ezcorp/page.render")`
 *      raced against a 10s timeout. NOTE: `ExtensionProcess.call`'s
 *      built-in 30s timeout KILLS the subprocess on expiry — too
 *      aggressive for a render (the same process may be serving tool
 *      calls), so we race a NON-lethal 10s timer and leave the
 *      built-in as the backstop.
 *   4. `validatePageTree` with `allowedEvents` = the extension's
 *      GRANTED eventSubscriptions (the runtime grant, not the manifest
 *      request — keeps render-time action gating aligned with the
 *      events route's POST-time `isRegisteredExtensionEvent` gate,
 *      which is also grant-fed). Invalid/error → `{error}` envelope
 *      (HTTP 200) → client error card with retry.
 *
 * Dependency injection: the production collaborators (registry spawn +
 * wire) are injectable so unit tests drive every branch without real
 * subprocesses.
 */
import { validatePageTree, type HubPageTree } from "$server/extensions/page-schema";
import { getPageCache, type ExtensionPageCache } from "$server/extensions/page-cache";
import type { ExtensionPermissions } from "$server/extensions/types";
import type { JsonRpcResponse } from "$server/extensions/types";
import { findEnabledExtensionPage } from "$lib/server/hub-extension-pages";
import type { Extension } from "$server/db/schema";
import { logger } from "$server/logger";

const log = logger.child("hub.render-pull");

export const RENDER_PULL_TIMEOUT_MS = 10_000;

export type RenderExtensionPageResult =
  | { notFound: true; error?: undefined; page?: undefined; renderedAt?: undefined; stale?: undefined }
  | { notFound?: undefined; error: string; page?: undefined; renderedAt?: undefined; stale?: undefined }
  | {
      notFound?: undefined;
      error?: undefined;
      page: HubPageTree;
      renderedAt: number;
      stale?: boolean;
    };

export interface RenderPullDeps {
  findPage: typeof findEnabledExtensionPage;
  /** Spawn (if needed) + wire the subprocess, returning a caller. The
   *  viewing `userId` scopes the render's reverse-RPC provenance so the
   *  subprocess can read its OWN extension data (config/state) during
   *  render — see `productionCallPage`. */
  callPage: (extension: Extension, pageId: string, userId: string) => Promise<JsonRpcResponse>;
  cache: ExtensionPageCache;
  timeoutMs: number;
}

/** Non-lethal timeout race — unlike `ExtensionProcess.call`'s built-in
 *  race, expiry rejects WITHOUT killing the subprocess. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`page render timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Production subprocess caller — spawn, wire reverse-RPC, request.
 *  Collaborators are LATE-BOUND (dynamic imports) so the heavy
 *  registry/executor module graph loads only when a pull actually
 *  happens, and test-time module mocks bind regardless of import
 *  order. */
async function productionCallPage(
  extension: Extension,
  pageId: string,
  userId: string,
): Promise<JsonRpcResponse> {
  const [
    { ExtensionRegistry },
    { ToolExecutor },
    { getPermissionEngine },
    { getBus },
    { registerCallProvenance, releaseCallProvenance },
  ] = await Promise.all([
    import("$server/extensions/registry"),
    import("$server/extensions/tool-executor"),
    import("$server/extensions/permission-engine"),
    import("$lib/server/context"),
    import("$server/extensions/call-provenance"),
  ]);
  const registry = ExtensionRegistry.getInstance();
  const proc = await registry.getProcess(extension.id);
  // Same boot recipe as the events route's messageToolbar branch — the
  // PDP singleton is boot-wired before any HTTP route can fire.
  const engine = getPermissionEngine();
  const wirer = new ToolExecutor(registry, engine, { bus: getBus() });
  await wirer.ensureSubprocessRpcWired(extension.id, proc);
  // A page render is a HOST-issued forward call, exactly like a tool
  // call: mint a provenance token scoped to the viewing user + this
  // extension and stamp it on `_meta.ezCallId`. The SDK channel binds it
  // for the duration of the render handler, so any reverse-RPC the page
  // makes (e.g. `fs.read` of its own config/state) carries the token and
  // is authorized — without this the render's reads fail the provenance
  // gate ("unresolved") and the page silently renders empty. Released in
  // `finally` the moment the render returns (token kind: "render").
  const ezCallId = registerCallProvenance({
    onBehalfOf: userId,
    conversationId: null,
    runId: null,
    parentCallId: null,
    actorExtensionId: extension.id,
    kind: "render",
    ownerless: false,
  });
  try {
    return await proc.call("ezcorp/page.render", { pageId, _meta: { ezCallId } });
  } finally {
    releaseCallProvenance(ezCallId);
  }
}

function defaultDeps(): RenderPullDeps {
  return {
    findPage: findEnabledExtensionPage,
    callPage: productionCallPage,
    cache: getPageCache(),
    timeoutMs: RENDER_PULL_TIMEOUT_MS,
  };
}

function grantedEvents(extension: Extension): string[] {
  const granted = extension.grantedPermissions as ExtensionPermissions | null;
  const subs = granted?.eventSubscriptions;
  return Array.isArray(subs) ? subs : [];
}

/** Pull + validate + cache. Returns the error string on any failure. */
async function pullAndCache(
  extension: Extension,
  pageId: string,
  userId: string,
  deps: RenderPullDeps,
): Promise<{ tree: HubPageTree } | { error: string }> {
  let response: JsonRpcResponse;
  try {
    response = await withTimeout(deps.callPage(extension, pageId, userId), deps.timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("extension page render failed", { extension: extension.name, pageId, error: message });
    return { error: "This page failed to render — try again." };
  }
  if (response.error) {
    log.warn("extension page render returned an error", {
      extension: extension.name,
      pageId,
      code: response.error.code,
      message: response.error.message,
    });
    return { error: "This page failed to render — try again." };
  }

  const tree = validatePageTree(response.result, {
    allowedEvents: grantedEvents(extension),
  });
  if (!tree) {
    log.warn("extension page produced an invalid tree", { extension: extension.name, pageId });
    return { error: "This page produced invalid content." };
  }

  deps.cache.set(extension.id, pageId, tree);
  return { tree };
}

export async function renderExtensionPage(
  extensionName: string,
  pageId: string,
  userId: string,
  depsOverride?: Partial<RenderPullDeps>,
): Promise<RenderExtensionPageResult> {
  const deps: RenderPullDeps = { ...defaultDeps(), ...depsOverride };

  const found = await deps.findPage(extensionName, pageId);
  if (!found) return { notFound: true };
  const { extension } = found;

  const cached = deps.cache.get(extension.id, pageId);
  if (cached && !cached.stale) {
    return { page: cached.tree, renderedAt: cached.renderedAt };
  }
  if (cached) {
    // Serve stale instantly; refresh in the background so the NEXT
    // request (or the client's invalidation-driven re-pull) is fresh.
    void pullAndCache(extension, pageId, userId, deps).catch((err) => {
      log.warn("background page refresh failed", {
        extension: extension.name,
        pageId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return { page: cached.tree, renderedAt: cached.renderedAt, stale: true };
  }

  const pulled = await pullAndCache(extension, pageId, userId, deps);
  if ("error" in pulled) return { error: pulled.error };
  return { page: pulled.tree, renderedAt: Date.now() };
}
