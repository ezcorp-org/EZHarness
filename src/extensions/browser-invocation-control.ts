import { getDb } from "../db/connection";
import type { MigrationDb } from "../db/migrations/types";
import { BrowserInvocationStore, type BrowserInvocationIdentity, type BrowserInvocationInput, type BrowserInvocationOutcome } from "../db/queries/extension-browser-requests";
import { awaitMcpSignal as awaitSignal } from "../mcp/cancellation";

export type { BrowserInvocationIdentity, BrowserInvocationInput, BrowserInvocationOutcome } from "../db/queries/extension-browser-requests";

function defaultStore(): BrowserInvocationStore { return new BrowserInvocationStore(getDb()); }
export function prepareBrowserInvocation(input: BrowserInvocationInput, store = defaultStore()) { return store.prepare(input); }
export function cancelBrowserInvocation(identity: BrowserInvocationIdentity, requestId: string, store = defaultStore()) { return store.cancel(identity, requestId); }

export async function claimBrowserInvocation(identity: BrowserInvocationIdentity, requestId: string, payloadDigest: string, store = defaultStore()) {
  identity = { ...identity };
  const claim = await store.claim(identity, requestId, payloadDigest);
  const controller = new AbortController();
  let disposed = false;
  let polling: Promise<void> | undefined;
  const assertActive = async (transaction?: MigrationDb): Promise<void> => {
    controller.signal.throwIfAborted();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(0, Math.min(1000, claim.deadline - store.now())))]);
    try { await awaitSignal(store.assertActive(identity, requestId, claim.executionId, transaction), signal); }
    catch (error) { controller.abort(error); throw error; }
    controller.signal.throwIfAborted();
  };
  const poll = (): void => {
    if (disposed || polling) return;
    polling = assertActive().catch(() => { clearInterval(timer); }).finally(() => { polling = undefined; });
  };
  const timer = setInterval(poll, 100);
  const deadline = setTimeout(() => controller.abort(new Error("Browser invocation deadline exceeded")), Math.max(0, claim.deadline - store.now()));
  timer.unref();
  deadline.unref();
  const stop = async (reason: string): Promise<void> => {
    disposed = true;
    clearInterval(timer);
    clearTimeout(deadline);
    controller.abort(new Error(reason));
    await polling;
  };
  return {
    signal: controller.signal,
    assertActive,
    finish: async (outcome: BrowserInvocationOutcome): Promise<void> => {
      await stop("Browser invocation finished");
      await store.finish(identity, requestId, claim.executionId, outcome);
    },
    dispose: async (): Promise<void> => {
      await stop("Browser invocation disposed");
      await store.finish(identity, requestId, claim.executionId, "outcome_unknown");
    },
  };
}
