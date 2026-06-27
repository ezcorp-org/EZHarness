/**
 * Unit tests for the generic extension-secrets entry route
 * (web/src/routes/api/extensions/[id]/secrets/+server.ts).
 *
 * The secrets store, the extension/project query layers, and the scope helper
 * are all mocked so the tests are pure and focused on the handler's
 * auth/validation/branch logic. We drive every line to 100% and assert that:
 *   - setSecret/deleteSecret are called with (ext.name, projectId, name, …),
 *   - the plaintext `value` is NEVER present in any response body,
 *   - unknown extension / unknown project / missing fields short-circuit, and
 *   - auth + `extensions` scope are both enforced.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../../../../../src/__tests__/helpers/mock-cleanup";
import {
  mockServerAlias,
  MEMBER_USER,
  createMockEvent,
} from "../../../../../../src/__tests__/helpers/mock-request";

mockServerAlias();

// Generated SvelteKit `$types` module doesn't exist under bun:test — stub it.
mock.module(
  "../../../../../../web/src/routes/api/extensions/[id]/secrets/$types",
  () => ({}),
);

// Real pass-through for the response helper — we inspect statuses + bodies.
import * as httpErrorsActual from "../../../../lib/server/http-errors";
mock.module("$lib/server/http-errors", () => httpErrorsActual);

// Scope gate: allowed by default; overridden per-test via `scopeResponse`.
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => scopeResponse,
}));

// requireAuth real impl throws a 401 Response when no user — keep it real.
import * as middlewareActual from "../../../../../../src/auth/middleware";
mock.module("$server/auth/middleware", () => middlewareActual);

// ── Mock state (reset per test) ─────────────────────────────────────────
let scopeResponse: Response | null = null;
let extensionsById: Record<string, { id: string; name: string }> = {};
let projectsById: Record<string, { id: string; name: string }> = {};
// deleteSecret return value (true = a row was actually removed).
let deleteResult = true;

// Captured side effects.
const setSecretCalls: Array<{
  extensionId: string;
  projectId: string | null;
  name: string;
  value: string;
  opts: unknown;
}> = [];
const deleteSecretCalls: Array<{
  extensionId: string;
  projectId: string | null;
  name: string;
  opts: unknown;
}> = [];

mock.module("$server/db/queries/extensions", () => ({
  getExtension: async (id: string) => extensionsById[id] ?? null,
}));

mock.module("$server/db/queries/projects", () => ({
  getProject: async (id: string) => projectsById[id] ?? undefined,
}));

mock.module("$server/extensions/secrets-store", () => ({
  setSecret: async (
    extensionId: string,
    projectId: string | null,
    name: string,
    value: string,
    opts: unknown,
  ) => {
    setSecretCalls.push({ extensionId, projectId, name, value, opts });
  },
  deleteSecret: async (
    extensionId: string,
    projectId: string | null,
    name: string,
    opts: unknown,
  ) => {
    deleteSecretCalls.push({ extensionId, projectId, name, opts });
    return deleteResult;
  },
}));

// ── Import handlers AFTER mocks ─────────────────────────────────────────
const { POST, DELETE } = await import(
  "../../../../../../web/src/routes/api/extensions/[id]/secrets/+server"
);

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  scopeResponse = null;
  extensionsById = { "ext-uuid-1": { id: "ext-uuid-1", name: "github-projects" } };
  projectsById = { "proj-1": { id: "proj-1", name: "Proj One" } };
  deleteResult = true;
  setSecretCalls.length = 0;
  deleteSecretCalls.length = 0;
});

function ev(
  opts: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
    user?: typeof MEMBER_USER | null;
  } = {},
) {
  return createMockEvent({
    method: opts.method ?? "POST",
    url: "http://localhost/api/extensions/ext-uuid-1/secrets",
    body: opts.body,
    params: opts.params ?? { id: "ext-uuid-1" },
    user: opts.user === null ? undefined : opts.user ?? MEMBER_USER,
  });
}

async function run(handler: any, event: any): Promise<Response> {
  try {
    return await handler(event);
  } catch (e) {
    return e as Response;
  }
}

// ════════════════════════ POST ════════════════════════
describe("POST secrets", () => {
  test("happy path: stores under ext.name, returns {ok:true}, never echoes value", async () => {
    const res = await run(
      POST,
      ev({ body: { projectId: "proj-1", name: "apiToken", value: "ghp_secret" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    // Stored under the resolved slug + supplied project, with the user id.
    expect(setSecretCalls).toHaveLength(1);
    expect(setSecretCalls[0]).toMatchObject({
      extensionId: "github-projects",
      projectId: "proj-1",
      name: "apiToken",
      value: "ghp_secret",
      opts: { userId: MEMBER_USER.id },
    });
    // The plaintext value is NEVER in the response.
    expect(JSON.stringify(body)).not.toContain("ghp_secret");
  });

  test("no projectId → instance-wide (null) scope", async () => {
    const res = await run(POST, ev({ body: { name: "apiToken", value: "v" } }));
    expect(res.status).toBe(200);
    expect(setSecretCalls[0].projectId).toBe(null);
  });

  test("explicit null projectId → null scope", async () => {
    const res = await run(
      POST,
      ev({ body: { projectId: null, name: "apiToken", value: "v" } }),
    );
    expect(res.status).toBe(200);
    expect(setSecretCalls[0].projectId).toBe(null);
  });

  test("invalid body (null) → 400, nothing stored", async () => {
    const e = createMockEvent({
      method: "POST",
      url: "http://localhost/x",
      params: { id: "ext-uuid-1" },
      user: MEMBER_USER,
    });
    (e as any).request = new Request("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    const res = await run(POST, e);
    expect(res.status).toBe(400);
    expect(setSecretCalls).toHaveLength(0);
  });

  test("missing name → 400", async () => {
    const res = await run(POST, ev({ body: { value: "v" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("name");
    expect(setSecretCalls).toHaveLength(0);
  });

  test("missing value → 400", async () => {
    const res = await run(POST, ev({ body: { name: "apiToken" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("value");
    expect(setSecretCalls).toHaveLength(0);
  });

  test("unknown extension → 404, nothing stored", async () => {
    const res = await run(
      POST,
      ev({ params: { id: "nope" }, body: { name: "apiToken", value: "v" } }),
    );
    expect(res.status).toBe(404);
    expect(setSecretCalls).toHaveLength(0);
  });

  test("non-string projectId → 400", async () => {
    const res = await run(
      POST,
      ev({ body: { projectId: 7, name: "apiToken", value: "v" } }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("projectId");
    expect(setSecretCalls).toHaveLength(0);
  });

  test("unknown project → 404, nothing stored", async () => {
    const res = await run(
      POST,
      ev({ body: { projectId: "ghost", name: "apiToken", value: "v" } }),
    );
    expect(res.status).toBe(404);
    expect(setSecretCalls).toHaveLength(0);
  });

  test("missing user → 401, nothing stored", async () => {
    const res = await run(
      POST,
      ev({ user: null, body: { name: "apiToken", value: "v" } }),
    );
    expect(res.status).toBe(401);
    expect(setSecretCalls).toHaveLength(0);
  });

  test("scope denied → 403, nothing stored", async () => {
    scopeResponse = new Response(JSON.stringify({ error: "Insufficient scope" }), {
      status: 403,
    });
    const res = await run(POST, ev({ body: { name: "apiToken", value: "v" } }));
    expect(res.status).toBe(403);
    expect(setSecretCalls).toHaveLength(0);
  });
});

// ════════════════════════ DELETE ════════════════════════
describe("DELETE secrets", () => {
  test("happy path: returns {deleted:true} when a row was removed", async () => {
    const res = await run(
      DELETE,
      ev({ method: "DELETE", body: { projectId: "proj-1", name: "apiToken" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ deleted: true });
    expect(deleteSecretCalls).toHaveLength(1);
    expect(deleteSecretCalls[0]).toMatchObject({
      extensionId: "github-projects",
      projectId: "proj-1",
      name: "apiToken",
      opts: { userId: MEMBER_USER.id },
    });
  });

  test("nothing existed → {deleted:false}", async () => {
    deleteResult = false;
    const res = await run(
      DELETE,
      ev({ method: "DELETE", body: { name: "apiToken" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ deleted: false });
    expect(deleteSecretCalls[0].projectId).toBe(null);
  });

  test("invalid body (null) → 400, nothing deleted", async () => {
    const e = createMockEvent({
      method: "DELETE",
      url: "http://localhost/x",
      params: { id: "ext-uuid-1" },
      user: MEMBER_USER,
    });
    (e as any).request = new Request("http://localhost/x", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    const res = await run(DELETE, e);
    expect(res.status).toBe(400);
    expect(deleteSecretCalls).toHaveLength(0);
  });

  test("missing name → 400", async () => {
    const res = await run(DELETE, ev({ method: "DELETE", body: {} }));
    expect(res.status).toBe(400);
    expect(deleteSecretCalls).toHaveLength(0);
  });

  test("unknown extension → 404", async () => {
    const res = await run(
      DELETE,
      ev({ method: "DELETE", params: { id: "nope" }, body: { name: "apiToken" } }),
    );
    expect(res.status).toBe(404);
    expect(deleteSecretCalls).toHaveLength(0);
  });

  test("non-string projectId → 400", async () => {
    const res = await run(
      DELETE,
      ev({ method: "DELETE", body: { projectId: 7, name: "apiToken" } }),
    );
    expect(res.status).toBe(400);
    expect(deleteSecretCalls).toHaveLength(0);
  });

  test("unknown project → 404", async () => {
    const res = await run(
      DELETE,
      ev({ method: "DELETE", body: { projectId: "ghost", name: "apiToken" } }),
    );
    expect(res.status).toBe(404);
    expect(deleteSecretCalls).toHaveLength(0);
  });

  test("missing user → 401", async () => {
    const res = await run(
      DELETE,
      ev({ method: "DELETE", user: null, body: { name: "apiToken" } }),
    );
    expect(res.status).toBe(401);
    expect(deleteSecretCalls).toHaveLength(0);
  });

  test("scope denied → 403", async () => {
    scopeResponse = new Response("{}", { status: 403 });
    const res = await run(DELETE, ev({ method: "DELETE", body: { name: "apiToken" } }));
    expect(res.status).toBe(403);
    expect(deleteSecretCalls).toHaveLength(0);
  });
});
