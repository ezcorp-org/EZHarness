/**
 * Tests for the OpenAPI 3 builder generated from the api-registry. Verifies
 * structure, Express→OpenAPI path templating, scope-based security, and path
 * parameters.
 */
import { describe, expect, test } from "bun:test";
import { buildOpenApiSpec } from "../openapi";
import { apiRegistry } from "../api-registry";

describe("buildOpenApiSpec", () => {
  const spec = buildOpenApiSpec({ serverUrl: "http://localhost:3000" }) as any;

  test("valid OpenAPI 3 envelope with bearer security scheme", () => {
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info.title).toBe("EZCorp API");
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(spec.servers).toEqual([{ url: "http://localhost:3000" }]);
  });

  test("the session-cookie scheme exists and is a COOKIE, not a bearer", () => {
    // A session-only route is secured by the browser's cookie. Declaring the
    // scheme as `http/bearer` — or omitting it and reusing `bearerAuth` — is
    // how a generated client would end up attaching an `ezk_*` key to a route
    // that refuses every key.
    expect(spec.components.securitySchemes.sessionCookie).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "ezcorp_session",
    });
  });

  test("the published cookie name is the one the app actually sets", async () => {
    // `src/openapi.ts` cannot import `web/src/lib/server/auth/session-cookie.ts`
    // ($lib is a web alias, and a bun:test under src/ importing a web/src/lib
    // module corrupts that module's coverage), so the name is spelled twice and
    // pinned here. Without this, a rename would publish a cookie that no client
    // sets — and the first draft of this file shipped `pi_session`, which is the
    // LEGACY cookie the hooks migration bridge clears, not the live one.
    const src = await Bun.file(
      new URL("../../web/src/lib/server/auth/session-cookie.ts", import.meta.url),
    ).text();
    expect(src).toContain('const SESSION_COOKIE_NAME = "ezcorp_session";');
  });

  test("Express :id paths become OpenAPI {id} with a path parameter", () => {
    const op = spec.paths["/api/conversations/{id}/messages"]?.post;
    expect(op).toBeDefined();
    expect(op.parameters).toEqual([{ name: "id", in: "path", required: true, schema: { type: "string" } }]);
  });

  test("scoped routes carry bearer security with the scope name", () => {
    const send = spec.paths["/api/conversations/{id}/messages"].post;
    expect(send.security).toEqual([{ bearerAuth: ["chat"] }]);
    const getRun = spec.paths["/api/runs/{id}"].get;
    expect(getRun.security).toEqual([{ bearerAuth: ["read"] }]);
  });

  test("public routes carry no security requirement", () => {
    const login = spec.paths["/api/auth/login"].post;
    expect(login.security).toBeUndefined();
  });

  test("SESSION-ONLY routes carry the cookie scheme and NEVER a bearer scope", () => {
    // The whole point of the `"session"` value. `bearerAuth: ["session"]`
    // would publish two lies at once: that `session` is a scope an operator
    // can mint, and that a key holding it could call the route. Every
    // session-only operation in the spec is checked, not one sample, because
    // the branch that could regress is a single `if` and one arm of it is the
    // published security contract for thirteen consent surfaces.
    const answer = spec.paths["/api/workflows/approvals/{id}"].post;
    expect(answer.security).toEqual([{ sessionCookie: [] }]);
    const permMode = spec.paths["/api/projects/{id}/tool-permission-mode"].put;
    expect(permMode.security).toEqual([{ sessionCookie: [] }]);

    const sessionOnly = apiRegistry.filter((e) => e.scope === "session");
    expect(sessionOnly.length).toBeGreaterThan(10);
    const wrong = sessionOnly
      .map((e) => {
        const path = e.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
        return { key: `${e.method} ${e.path}`, op: spec.paths[path]?.[e.method.toLowerCase()] };
      })
      .filter(({ op }) => JSON.stringify(op?.security) !== JSON.stringify([{ sessionCookie: [] }]))
      .map(({ key }) => key);
    expect(wrong).toEqual([]);
    // And the string never appears inside a bearer requirement anywhere.
    expect(JSON.stringify(spec)).not.toContain('"bearerAuth":["session"]');
  });

  test("each operation has a summary, tag, and 200 response", () => {
    const op = spec.paths["/api/runs/{id}"].get;
    expect(typeof op.summary).toBe("string");
    expect(op.tags).toEqual(["runs"]);
    expect(op.responses["200"]).toBeDefined();
    expect(op.operationId).toBe("get_api_runs_id");
  });
});
