/** Requests sent to preview-shaped Host headers stay out of app login routing. */
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(async () => 1),
  getUserById: vi.fn(),
}));
vi.mock("$lib/server/context", () => ({ ensureInitialized: vi.fn(async () => {}) }));
vi.mock("$server/startup/background-timers", () => ({
  startBackgroundTimers: vi.fn(async () => {}),
}));
vi.mock("$lib/server/security/bearer-auth", () => ({ attachBearerAuth: vi.fn(async () => {}) }));

const { handle } = await import("../hooks.server");
const PREVIEW_ID = "abcdefghjkmnpqrstvwxyz0123";

function eventFor(host: string) {
  const url = new URL(`http://${host}/proof`);
  return {
    request: new Request(url, { headers: { Host: host } }),
    url,
    cookies: { get: vi.fn(() => undefined), set: vi.fn(), delete: vi.fn() },
    locals: {},
    getClientAddress: () => "127.0.0.1",
    route: { id: "/proof" },
    params: {},
    setHeaders: vi.fn(),
    fetch: vi.fn(),
    isDataRequest: false,
    isSubRequest: false,
  };
}

describe("preview Host dispatch at the app handler", () => {
  beforeEach(() => {
    process.env.EZCORP_PREVIEW_APP_HOST = "ezcorp.example.com";
    delete process.env.EZCORP_PUBLIC_URL;
  });

  test.each([
    "invalid!.preview.ezcorp.example.com",
    "invalid.preview.invalid",
  ])("rejects %s before app auth can redirect", async host => {
    const resolve = vi.fn(async () => new Response("app"));
    const response = await handle({ event: eventFor(host), resolve } as never);
    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  test("keeps the app Host on the ordinary login path", async () => {
    const resolve = vi.fn(async () => new Response("app"));
    await expect(handle({ event: eventFor("ezcorp.example.com"), resolve } as never))
      .rejects.toMatchObject({ status: 302 });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("does not mistake an app Host that contains .preview. for a preview origin", async () => {
    process.env.EZCORP_PREVIEW_APP_HOST = "app.preview.example.com";
    const resolve = vi.fn(async () => new Response("app"));
    await expect(handle({ event: eventFor("app.preview.example.com"), resolve } as never))
      .rejects.toMatchObject({ status: 302 });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("keeps preview dispatch disabled when no preview app Host is configured", async () => {
    delete process.env.EZCORP_PREVIEW_APP_HOST;
    const resolve = vi.fn(async () => new Response("app"));
    await expect(handle({ event: eventFor("app.preview.example.com"), resolve } as never))
      .rejects.toMatchObject({ status: 302 });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("keeps a separate public app Host on app routing", async () => {
    process.env.EZCORP_PREVIEW_APP_HOST = "previews.example.com";
    process.env.EZCORP_PUBLIC_URL = "https://app.preview.example.com";
    const resolve = vi.fn(async () => new Response("app"));
    await expect(handle({ event: eventFor("app.preview.example.com"), resolve } as never))
      .rejects.toMatchObject({ status: 302 });
    expect((await handle({ event: eventFor("invalid.preview.invalid"), resolve } as never)).status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });

  test("keeps a valid preview Host on preview dispatch", async () => {
    const resolve = vi.fn(async () => new Response("app"));
    const response = await handle({ event: eventFor(`${PREVIEW_ID}.preview.ezcorp.example.com`), resolve } as never);
    expect(response.status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });
});
