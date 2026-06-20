/**
 * Tests for the OpenAPI 3 builder generated from the api-registry. Verifies
 * structure, Express→OpenAPI path templating, scope-based security, and path
 * parameters.
 */
import { describe, expect, test } from "bun:test";
import { buildOpenApiSpec } from "../openapi";

describe("buildOpenApiSpec", () => {
  const spec = buildOpenApiSpec({ serverUrl: "http://localhost:3000" }) as any;

  test("valid OpenAPI 3 envelope with bearer security scheme", () => {
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info.title).toBe("EZCorp API");
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(spec.servers).toEqual([{ url: "http://localhost:3000" }]);
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

  test("each operation has a summary, tag, and 200 response", () => {
    const op = spec.paths["/api/runs/{id}"].get;
    expect(typeof op.summary).toBe("string");
    expect(op.tags).toEqual(["runs"]);
    expect(op.responses["200"]).toBeDefined();
    expect(op.operationId).toBe("get_api_runs_id");
  });
});
