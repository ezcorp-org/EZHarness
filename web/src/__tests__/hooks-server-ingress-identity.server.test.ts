/**
 * The hook's trusted-ingress check (C01): a provisioned installation answers a
 * request only when its Host is the installation's own hostname and the
 * ingress set its installation header. Refusal happens before any auth, any
 * route, and any request accounting.
 */
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { test, expect, describe, vi, afterEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({ getUserCount: vi.fn(async () => 1), getUserById: vi.fn() }));
vi.mock("$lib/server/context", () => ({ ensureInitialized: vi.fn(async () => {}) }));
vi.mock("$server/startup/background-timers", () => ({ startBackgroundTimers: vi.fn(async () => {}) }));
vi.mock("$lib/server/security/bearer-auth", () => ({ attachBearerAuth: vi.fn(async () => {}) }));
vi.mock("$server/db/queries/settings", () => ({ getSetting: vi.fn(async () => undefined) }));

const { handle } = await import("../hooks.server");

function event(path: string, headers: Record<string, string>) {
  return {
    request: new Request(`http://tenant-01.fleet.test${path}`, { method: "GET", headers }),
    url: new URL(`http://tenant-01.fleet.test${path}`),
    cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    locals: {}, getClientAddress: () => "127.0.0.1", route: { id: path }, params: {}, setHeaders: vi.fn(), fetch: vi.fn(), isDataRequest: false, isSubRequest: false,
  } as any;
}

describe("hooks.server.ts — trusted ingress identity", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  test("a provisioned installation refuses a foreign host, a missing header, and a foreign installation with 421 before resolving", async () => {
    vi.stubEnv("EZCORP_INSTALLATION_HOSTNAME", "tenant-01.fleet.test");
    vi.stubEnv("EZCORP_INSTALLATION_ID", "inst-1");
    const resolve = vi.fn(async () => new Response("reached"));
    for (const [headers, reason] of [
      [{ host: "tenant-02.fleet.test", "x-ezcorp-installation": "inst-1" }, "host"],
      [{ host: "tenant-01.fleet.test:32005", "x-forwarded-host": "tenant-02.fleet.test", "x-ezcorp-installation": "inst-1" }, "host"],
      [{ host: "tenant-01.fleet.test" }, "installation"],
      [{ host: "tenant-01.fleet.test", "x-ezcorp-installation": "inst-2" }, "installation"],
    ] as const) {
      const response = await handle({ event: event("/api/projects", headers), resolve });
      expect(response.status).toBe(421);
      expect(await response.json()).toEqual({ error: "misdirected_request", reason });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  test("health and readiness stay answerable to a direct probe", async () => {
    vi.stubEnv("EZCORP_INSTALLATION_HOSTNAME", "tenant-01.fleet.test");
    vi.stubEnv("EZCORP_INSTALLATION_ID", "inst-1");
    const resolve = vi.fn(async () => new Response("ready"));
    const response = await handle({ event: event("/api/ready", { host: "127.0.0.1:31010" }), resolve });
    expect(response.status).not.toBe(421);
  });

  test("an installation that was not provisioned applies no ingress check", async () => {
    vi.stubEnv("EZCORP_INSTALLATION_HOSTNAME", "");
    const resolve = vi.fn(async () => new Response("ok"));
    const response = await handle({ event: event("/api/health", { host: "anything.example" }), resolve });
    expect(response.status).not.toBe(421);
  });
});
