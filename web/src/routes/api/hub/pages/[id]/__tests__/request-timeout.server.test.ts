import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ authenticated: true, allowed: true, renderCalls: 0 }));

vi.mock("$server/auth/middleware", () => ({
  requireAuth: () => {
    if (!state.authenticated) throw new Response("Unauthorized", { status: 401 });
    return { id: "alice" };
  },
}));
vi.mock("$lib/server/security/api-keys", () => ({ requireScope: () => null }));
vi.mock("$lib/server/security/rate-limiter", () => ({ RateLimiter: class { check() { return { allowed: state.allowed, retryAfter: 1 }; } } }));
vi.mock("$lib/hub", () => ({ parseHubPageId: () => ({ kind: "ext", extension: "private-page", pageId: "dashboard" }) }));
vi.mock("$lib/server/hub-render-pull", () => ({ renderExtensionPage: async () => {
  state.renderCalls++;
  return { error: "page render timed out after 10000ms" };
} }));
vi.mock("$server/db/queries/projects", () => ({ getProject: async () => undefined }));
vi.mock("$server/runtime/hub-pages", () => ({ getHubPageProvider: () => undefined }));
vi.mock("$server/extensions/page-schema", () => ({ validatePageTree: (tree: unknown) => tree }));
vi.mock("$server/logger", () => ({ logger: { child: () => ({ warn() {} }) } }));
vi.mock("$lib/server/http-errors", () => ({ errorJson: (status: number, message: string) => new Response(JSON.stringify({ error: message }), { status }) }));

const { GET } = await import("../+server");

beforeEach(() => {
  state.authenticated = true;
  state.allowed = true;
  state.renderCalls = 0;
});

function requestEvent() {
  const request = new Request("http://localhost/api/hub/pages/ext:private-page:dashboard");
  const timeout = vi.fn();
  return {
    request,
    timeout,
    event: {
      request,
      url: new URL(request.url),
      params: { id: "ext:private-page:dashboard" },
      locals: {},
      setHeaders() {},
      platform: { request, server: { timeout } },
    },
  };
}

test("an admitted extension render disables the transport timer but returns its bounded error envelope", async () => {
  const { event, request, timeout } = requestEvent();
  const response = await GET(event as never);
  expect(timeout).toHaveBeenCalledExactlyOnceWith(request, 0);
  expect(state.renderCalls).toBe(1);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ error: "page render timed out after 10000ms" });
});

test("unauthorized and rate-limited requests leave the transport timer intact", async () => {
  state.authenticated = false;
  const unauthorized = requestEvent();
  await expect(GET(unauthorized.event as never)).rejects.toBeInstanceOf(Response);
  expect(unauthorized.timeout).not.toHaveBeenCalled();

  state.authenticated = true;
  state.allowed = false;
  const limited = requestEvent();
  expect((await GET(limited.event as never)).status).toBe(429);
  expect(limited.timeout).not.toHaveBeenCalled();
  expect(state.renderCalls).toBe(0);
});
