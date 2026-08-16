/**
 * Ambient principal id for the request whose async subtree we are in.
 *
 * Two settlement gates need to ask "is the principal answering now the same
 * one that asked earlier?" across a boundary where no `locals` survives — a
 * permission gate and a remote tool call, both parked in memory by a run that
 * outlives its request. `principalId` (`./principal-id.ts`) answers WHO; this
 * module is how that answer reaches the gate without threading a parameter
 * through `streamChat` → the executor loop → each tool's `execute`.
 *
 * ONE writer establishes the scope — `hooks.server.ts`, around the single
 * post-auth `resolve(event)` — so a run started by ANY route (chat send,
 * agent-chat, retry, and anything added later) is attributed without that
 * route knowing this exists. A run detached from the request (`streamPromise`
 * is deliberately not awaited) keeps the store, because the promise chain was
 * created inside the scope.
 *
 * ## Why this is a leaf module
 *
 * It lives here, importing nothing, rather than inside
 * `src/runtime/tools/permissions.ts` where it started, because
 * `src/runtime/remote-tool-registry.ts` is a SECOND reader — and that registry
 * is imported by an API route, which must not pull the tools layer (and
 * through it pi-agent-core) into its module graph. A leaf keeps one
 * AsyncLocalStorage instance for both readers; a copy in each would be two
 * stores, and the writer only ever fills one of them.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const gateInitiatorAls = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `initiator` as the ambient gate initiator.
 *
 * An `undefined` initiator runs `fn` OUTSIDE any scope rather than storing
 * `undefined` — so an unauthenticated request cannot shadow an outer scope,
 * and the "no initiator" case has exactly one representation.
 */
export function runWithGateInitiator<T>(
  initiator: string | undefined,
  fn: () => T,
): T {
  return initiator === undefined ? fn() : gateInitiatorAls.run(initiator, fn);
}

/**
 * The initiator for the current async subtree, or `undefined` outside any
 * request scope — a goal-autopilot re-entry, a briefing, a github-projects
 * spawn, a CLI run.
 *
 * Read by gate PRODUCERS at creation time, never from anything the answering
 * request supplies. Every consumer treats `undefined` as "cannot be shown to
 * match", i.e. the deny side.
 */
export function getAmbientGateInitiator(): string | undefined {
  return gateInitiatorAls.getStore();
}
