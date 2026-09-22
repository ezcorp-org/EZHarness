/**
 * The hook's trusted-ingress check (C01): a provisioned installation answers a
 * request only when its Host is the installation's own hostname, the
 * ingress set its installation header, and, once delivered, the ingress's
 * per-installation proof matches. Refusal happens before any auth, any route,
 * and any request accounting.
 */
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, expect, describe, vi, afterEach, beforeAll, afterAll } from "vitest";

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

  describe("with a delivered ingress proof", () => {
    const proof = "c".repeat(64);
    let root: string;
    beforeAll(async () => {
      // The private reader refuses a world-writable ancestor such as /tmp.
      root = await mkdtemp(join(process.env.XDG_RUNTIME_DIR ?? homedir(), "w16-hooks-"));
      await chmod(root, 0o700);
      await writeFile(join(root, "ingress-proof"), `${proof}\n`, { mode: 0o600 });
      await chmod(join(root, "ingress-proof"), 0o600);
    });
    afterAll(async () => { await rm(root, { recursive: true, force: true }); });
    const provisioned = (proofFile: string) => {
      vi.stubEnv("EZCORP_INSTALLATION_HOSTNAME", "tenant-01.fleet.test");
      vi.stubEnv("EZCORP_INSTALLATION_ID", "inst-1");
      vi.stubEnv("EZCORP_INGRESS_PROOF_FILE", proofFile);
    };
    const routed = { host: "tenant-01.fleet.test", "x-ezcorp-installation": "inst-1" };

    test("a request without the proof, or with a forged one, is refused 421 proof before resolving", async () => {
      provisioned(join(root, "ingress-proof"));
      const resolve = vi.fn(async () => new Response("reached"));
      for (const headers of [routed, { ...routed, "x-ezcorp-ingress-proof": "d".repeat(64) }]) {
        const response = await handle({ event: event("/api/projects", headers), resolve });
        expect(response.status).toBe(421);
        expect(await response.json()).toEqual({ error: "misdirected_request", reason: "proof" });
      }
      expect(resolve).not.toHaveBeenCalled();
    });

    test("the ingress's own proof passes the check", async () => {
      provisioned(join(root, "ingress-proof"));
      const resolve = vi.fn(async () => new Response("reached"));
      const response = await handle({ event: event("/api/health", { ...routed, "x-ezcorp-ingress-proof": proof }), resolve });
      expect(response.status).not.toBe(421);
      const routedResponse = await handle({ event: event("/api/projects", { ...routed, "x-ezcorp-ingress-proof": proof }), resolve });
      expect(routedResponse.status).not.toBe(421);
    });

    test("an undelivered proof refuses every routed request, even one carrying the right value", async () => {
      provisioned(join(root, "not-yet-delivered"));
      const resolve = vi.fn(async () => new Response("reached"));
      const response = await handle({ event: event("/api/projects", { ...routed, "x-ezcorp-ingress-proof": proof }), resolve });
      expect(response.status).toBe(421);
      expect(await response.json()).toEqual({ error: "misdirected_request", reason: "proof" });
    });
  });
});
