import { expect } from "vitest";

/**
 * Shared builders for the fake SvelteKit `RequestEvent` that ~185
 * `*.server.test.ts` files used to hand-roll (as local `makeEvent` /
 * `makeGetEvent` / `makePostEvent` functions), plus the `expectThrownResponse`
 * try/catch pattern for asserting on a thrown `Response`.
 *
 * `makeRequestEvent` is deliberately low-level: it does not guess at method
 * defaults, content-type headers, or body serialization — callers pass a
 * `RequestInit` exactly as they want it, same as the `new Request(href, init)`
 * calls it replaces. That keeps every call site's existing behavior (which
 * varies file to file — some default GET, some POST, some conditionally set
 * headers only when a body is present) unchanged; this helper only removes
 * the repeated `new URL` / `new Request` / `locals ?? {}` / `as any`
 * boilerplate around it.
 */

export interface MakeRequestEventOptions {
  /**
   * Passed straight through to `new Request(href, request)`. Pass `null` to
   * omit `event.request` entirely (some routes never read it).
   */
  request?: RequestInit | null;
  /**
   * Route params for `event.params`. Omit to leave `params` unset on the
   * fake event (some routes never read it).
   */
  params?: Record<string, string | undefined>;
  /** `event.locals`. Defaults to `{}` when omitted. */
  locals?: Record<string, unknown>;
  /** Set to `null` to omit `event.url` entirely (some routes never read it). */
  url?: null;
  /** Anything else a route handler reads off the event (cookies,
   * getClientAddress, route, setHeaders, fetch, isDataRequest,
   * isSubRequest, platform, ...) — passed through verbatim. */
  [extra: string]: unknown;
}

/**
 * Builds a fake `RequestEvent`-shaped object: `{ url, request, ...rest }`.
 *
 * `url` is `new URL(href)` unless `opts.url` is explicitly `null`, in which
 * case the field is omitted entirely (some routes never read `event.url`).
 * `request` is `new Request(href, opts.request)` unless `opts.request` is
 * explicitly `null`, in which case the field is omitted entirely (some
 * routes never read `event.request`).
 */
export function makeRequestEvent(href: string, opts: MakeRequestEventOptions = {}): any {
  const { request: requestInit, url: urlOverride, params, locals, ...rest } = opts;
  const event: Record<string, unknown> = {};
  if (urlOverride !== null) event.url = new URL(href);
  event.locals = locals ?? {};
  if (params !== undefined) event.params = params;
  if (requestInit !== null) event.request = new Request(href, requestInit);
  return Object.assign(event, rest);
}

/**
 * Awaits `fn()` and returns its Response — whether it was returned directly
 * or thrown (SvelteKit's `error()`/`json()` helpers throw a `Response`).
 * Asserts the thrown/returned value actually is a `Response`.
 */
export async function expectThrownOrResponse(fn: () => Promise<Response> | Response): Promise<Response> {
  let res: Response;
  try {
    res = await fn();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    res = thrown as Response;
  }
  // Asserted on BOTH paths, not just the catch. Seven of the local copies this
  // replaced checked it unconditionally, so restricting it to the throw path
  // would let a handler that RETURNS a non-Response (e.g. a bare object, or
  // `undefined` from an early return) slip through with only `.status` read off
  // it as undefined. Strictly additive — no caller depends on skipping it.
  expect(res).toBeInstanceOf(Response);
  return res;
}

/** Same as {@link expectThrownOrResponse}, plus an assertion on `.status`. */
export async function expectThrownResponse(
  fn: () => Promise<Response> | Response,
  status: number,
): Promise<Response> {
  const res = await expectThrownOrResponse(fn);
  expect(res.status).toBe(status);
  return res;
}
