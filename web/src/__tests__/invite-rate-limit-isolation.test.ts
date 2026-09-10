import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mockDbConnection, mockRealSettings } from "../../../src/__tests__/helpers/test-pglite";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";

mockDbConnection();
mockRealSettings();
const { POST } = await import("../routes/api/__test/invite-rate-limit/+server");
const { __rateLimiter } = await import("../routes/api/auth/invite/[token]/+server");
const savedEnvironment = { PI_E2E_REAL: process.env.PI_E2E_REAL, EZCORP_ALLOW_TEST_SURFACE: process.env.EZCORP_ALLOW_TEST_SURFACE, NODE_ENV: process.env.NODE_ENV };
const admin = { id: "admin", email: "admin@example.test", name: "Admin", role: "admin" };
const event = (locals: unknown) => ({ locals }) as Parameters<typeof POST>[0];

beforeEach(() => {
  process.env.PI_E2E_REAL = "1";
  process.env.EZCORP_ALLOW_TEST_SURFACE = "1";
  delete process.env.NODE_ENV;
  __rateLimiter.reset();
  for (let count = 0; count < 10; count++) __rateLimiter.check("127.0.0.1");
  expect(__rateLimiter.peek("127.0.0.1").allowed).toBe(false);
});
afterEach(() => {
  __rateLimiter.reset();
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterAll(restoreModuleMocks);

test("the reset surface stays closed outside an explicitly enabled test server", async () => {
  for (const [key, value] of [["PI_E2E_REAL", "0"], ["EZCORP_ALLOW_TEST_SURFACE", "0"], ["NODE_ENV", "production"]]) {
    const original = process.env[key!];
    process.env[key!] = value;
    expect((await POST(event({ user: admin }))).status).toBe(404);
    expect(__rateLimiter.peek("127.0.0.1").allowed).toBe(false);
    if (original === undefined) delete process.env[key!]; else process.env[key!] = original;
  }
});

test("anonymous, member and insufficient-scope callers cannot clear counters", async () => {
  for (const [locals, status] of [
    [{}, 401],
    [{ user: { ...admin, role: "member" } }, 403],
    [{ user: admin, authMethod: "api-key", apiKeyScopes: ["read"] }, 403],
  ] as const) {
    expect((await POST(event(locals))).status).toBe(status);
    expect(__rateLimiter.peek("127.0.0.1").allowed).toBe(false);
  }
});

test("an administrator resets counters without changing the next case's ten-attempt limit", async () => {
  const reset = await POST(event({ user: admin }));
  expect(reset.status).toBe(200);
  expect(await reset.json()).toEqual({ reset: true });
  for (let count = 0; count < 10; count++) expect(__rateLimiter.check("127.0.0.1").allowed).toBe(true);
  expect(__rateLimiter.check("127.0.0.1").allowed).toBe(false);
});
