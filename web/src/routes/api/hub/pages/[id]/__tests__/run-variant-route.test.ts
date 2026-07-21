/**
 * Route unit tests for GET /api/hub/pages/[id] — the `?run=<id>` (run-detail)
 * variant threading (auditor CRITICAL gap: the server side of the run-links
 * feature had no direct coverage).
 *
 * Lives in a `__tests__/` subdir (NOT as `+server.test.ts`) because SvelteKit
 * reserves every `+`-prefixed filename in the routes tree — a `+server.test.ts`
 * there fails `bun run build`. This mirrors the established route-test harness
 * at web/src/routes/api/extensions/__tests__/secrets-route.test.ts.
 *
 * Collaborators are mocked so the tests are pure and focus on the handler's
 * run-param handling:
 *   - `?run=<id>` is passed through to renderExtensionPage (the 6th arg) AND
 *     folded into the rate-limiter variant key,
 *   - a `?run=` over MAX_RUN_PARAM_LENGTH (128) is clamped to undefined (junk
 *     never reaches the render, never buckets the limiter),
 *   - two distinct run values land in SEPARATE limiter buckets.
 *
 * The render-pull's OWN run-variant threading is covered by
 * web/src/lib/server/hub-render-pull.run-variant.unit.test.ts; here we prove the
 * ROUTE hands the param off correctly.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../../../../../../../src/__tests__/helpers/mock-cleanup";
import {
  MEMBER_USER,
  createMockEvent,
} from "../../../../../../../../src/__tests__/helpers/mock-request";

const PAGE_ID = "ext:ez-code-factory:dashboard";

// Generated SvelteKit `$types` doesn't exist under bun:test — stub it (the
// handler imports `./$types`, which resolves to `[id]/$types`, i.e. `../$types`
// from here).
mock.module("../$types", () => ({}));

// Response helper — a minimal real-equivalent so error branches produce a
// Response with the right status (the happy 200 path never calls it).
mock.module("$lib/server/http-errors", () => ({
  errorJson: (status: number, message: string, extra?: object, headers?: object) =>
    new Response(JSON.stringify({ error: message, ...(extra ?? {}) }), {
      status,
      headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    }),
}));

// requireAuth: returns the locals user, throws a 401 Response when absent
// (mirrors the real middleware's contract closely enough for the handler).
mock.module("$server/auth/middleware", () => ({
  requireAuth: (locals: { user?: typeof MEMBER_USER }) => {
    if (!locals?.user) throw new Response("Unauthorized", { status: 401 });
    return locals.user;
  },
}));

// Scope gate: allowed by default; overridable per-test.
let scopeResponse: Response | null = null;
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => scopeResponse,
}));

// Hub id parser — an EXT parse for the known id, null otherwise (parsing itself
// is covered by $lib/hub's own tests).
mock.module("$lib/hub", () => ({
  parseHubPageId: (id: string) =>
    id === PAGE_ID
      ? { kind: "ext", extension: "ez-code-factory", pageId: "dashboard" }
      : null,
}));

// Rate limiter — a fake that records every key it checks, so we can assert the
// run id is part of the variant key and that distinct runs bucket separately.
const limiterKeys: string[] = [];
let limiterAllowed = true;
mock.module("$lib/server/security/rate-limiter", () => ({
  // The fake ignores the (max, windowMs) ctor args the route passes to
  // `new RateLimiter(...)` — the default constructor accepts and drops them.
  RateLimiter: class {
    check(key: string) {
      limiterKeys.push(key);
      return limiterAllowed ? { allowed: true } : { allowed: false, retryAfter: 1 };
    }
  },
}));

// renderExtensionPage — record the positional args (esp. project + run) it sees.
const renderCalls: Array<{
  extension: string;
  pageId: string;
  userId: string;
  project: unknown;
  run: unknown;
}> = [];
mock.module("$lib/server/hub-render-pull", () => ({
  renderExtensionPage: async (
    extension: string,
    pageId: string,
    userId: string,
    _deps: unknown,
    project: unknown,
    run: unknown,
  ) => {
    renderCalls.push({ extension, pageId, userId, project, run });
    return { page: { title: "T", nodes: [] }, renderedAt: 123 };
  },
}));

// No `?project=` in these tests, so getProject is never called; a stub keeps the
// query layer from touching a DB if the handler is ever changed to call it.
mock.module("$server/db/queries/projects", () => ({ getProject: async () => undefined }));

// Collaborators the ext branch doesn't exercise, but which import at module load.
mock.module("$server/runtime/hub-pages", () => ({ getHubPageProvider: () => undefined }));
mock.module("$server/extensions/page-schema", () => ({ validatePageTree: (t: unknown) => t }));
mock.module("$server/logger", () => ({
  logger: { child: () => ({ warn() {}, info() {}, error() {} }) },
}));

// Import the handler AFTER the mocks are registered.
const { GET } = await import("../+server");

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  scopeResponse = null;
  limiterAllowed = true;
  limiterKeys.length = 0;
  renderCalls.length = 0;
});

function getEvent(query: string) {
  return createMockEvent({
    method: "GET",
    url: `http://localhost/api/hub/pages/${PAGE_ID}${query}`,
    params: { id: PAGE_ID },
    user: MEMBER_USER,
  });
}

async function run(event: unknown): Promise<Response> {
  try {
    return await (GET as (e: unknown) => Promise<Response>)(event);
  } catch (e) {
    return e as Response;
  }
}

describe("GET /api/hub/pages/[id] — ?run= variant", () => {
  test("passes ?run through to renderExtensionPage AND into the limiter key", async () => {
    const res = await run(getEvent("?run=run_abc123"));
    expect(res.status).toBe(200);

    // The run id reaches the render as the 6th positional arg; without `?project=`
    // the 5th (project) stays undefined.
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]!.run).toBe("run_abc123");
    expect(renderCalls[0]!.project).toBeUndefined();

    // …and it is part of the limiter variant key
    // (`hub-render:<user>:<pageId>:<project>:<run>`).
    expect(limiterKeys).toHaveLength(1);
    expect(limiterKeys[0]).toBe(`hub-render:${MEMBER_USER.id}:${PAGE_ID}::run_abc123`);
  });

  test("a ?run at exactly MAX_RUN_PARAM_LENGTH (128) is still honoured", async () => {
    const maxLen = "r".repeat(128);
    await run(getEvent(`?run=${maxLen}`));
    expect(renderCalls[0]!.run).toBe(maxLen);
    expect(limiterKeys[0]!.endsWith(`:${maxLen}`)).toBe(true);
  });

  test("a ?run over MAX_RUN_PARAM_LENGTH (128) is clamped to undefined", async () => {
    const tooLong = "r".repeat(129);
    const res = await run(getEvent(`?run=${tooLong}`));
    expect(res.status).toBe(200);

    // Junk never reaches the render…
    expect(renderCalls[0]!.run).toBeUndefined();
    // …and the limiter key carries an EMPTY run segment (so oversized junk can't
    // exhaust a real run's budget).
    expect(limiterKeys[0]!.endsWith(":")).toBe(true);
    expect(limiterKeys[0]).not.toContain(tooLong);
  });

  test("two distinct run values land in SEPARATE limiter buckets", async () => {
    await run(getEvent("?run=run_a"));
    await run(getEvent("?run=run_b"));
    expect(limiterKeys).toHaveLength(2);
    expect(limiterKeys[0]).not.toBe(limiterKeys[1]);
    expect(limiterKeys[0]).toBe(`hub-render:${MEMBER_USER.id}:${PAGE_ID}::run_a`);
    expect(limiterKeys[1]).toBe(`hub-render:${MEMBER_USER.id}:${PAGE_ID}::run_b`);
  });

  test("no ?run at all → run undefined, empty run segment in the key", async () => {
    await run(getEvent(""));
    expect(renderCalls[0]!.run).toBeUndefined();
    expect(limiterKeys[0]).toBe(`hub-render:${MEMBER_USER.id}:${PAGE_ID}::`);
  });

  test("a rate-limit hit short-circuits with 429 before the render", async () => {
    limiterAllowed = false;
    const res = await run(getEvent("?run=run_abc123"));
    expect(res.status).toBe(429);
    expect(renderCalls).toHaveLength(0);
  });
});
