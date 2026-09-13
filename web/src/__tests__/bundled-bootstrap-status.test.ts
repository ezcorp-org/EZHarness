/** The bundled-bootstrap status surface is read-only, admin-only, and closed outside a test server. */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";

const status = mock(async (_entries: readonly { name: string }[]) => ({ staged: 29, pending: 3 }));
mock.module("../../../src/extensions/bundled-bootstrap", () => ({ bundledBootstrapStatus: status }));
const { GET } = await import("../routes/api/__test/bundled-bootstrap/+server");
const savedEnvironment = { PI_E2E_REAL: process.env.PI_E2E_REAL, EZCORP_ALLOW_TEST_SURFACE: process.env.EZCORP_ALLOW_TEST_SURFACE, NODE_ENV: process.env.NODE_ENV };
const admin = { id: "admin", email: "admin@example.test", name: "Admin", role: "admin" };
const event = (locals: unknown) => ({ locals }) as Parameters<typeof GET>[0];

beforeEach(() => {
  process.env.PI_E2E_REAL = "1";
  process.env.EZCORP_ALLOW_TEST_SURFACE = "1";
  delete process.env.NODE_ENV;
  status.mockClear();
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterAll(restoreModuleMocks);

test("the status surface stays closed outside an explicitly enabled test server", async () => {
  for (const [key, value] of [["PI_E2E_REAL", "0"], ["EZCORP_ALLOW_TEST_SURFACE", "0"], ["NODE_ENV", "production"]]) {
    const original = process.env[key!];
    process.env[key!] = value;
    expect((await GET(event({ user: admin }))).status).toBe(404);
    if (original === undefined) delete process.env[key!]; else process.env[key!] = original;
  }
  expect(status).not.toHaveBeenCalled();
});

test("anonymous and member callers are refused", async () => {
  for (const [locals, code] of [[{}, 401], [{ user: { ...admin, role: "member" } }, 403]] as const) {
    expect((await GET(event(locals))).status).toBe(code);
  }
  expect(status).not.toHaveBeenCalled();
});

test("an administrator reads the bundled inventory's build progress", async () => {
  const response = await GET(event({ user: admin }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ staged: 29, pending: 3 });
  expect(status).toHaveBeenCalledTimes(1);
  const [entries] = status.mock.calls[0]!;
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.every((entry) => typeof entry.name === "string" && entry.name.length > 0)).toBe(true);
});
