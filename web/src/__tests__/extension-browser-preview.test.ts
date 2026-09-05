import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../../src/__tests__/helpers/mock-cleanup";

const binding = "a".repeat(64);
const nonce = crypto.randomUUID();
let permitted = true;
let calls: unknown[] = [];
let invoked: Request | undefined;
mock.module("$server/auth/middleware", () => ({ requireSessionAuth: (locals: any) => locals.user ?? new Response("Denied", { status: 401 }) }));
mock.module("$lib/server/context", () => ({ ensureInitialized: async () => {} }));
mock.module("$lib/server/extension-browser", () => ({
  authorizeExtensionBrowser: async (...args: unknown[]) => {
    calls.push(args);
    if (!permitted) throw new Error("private denial");
    return { binding, extension: { name: "sealed" }, active: { release: { artifactDigest: "digest" } }, conversation: { id: "owned" } };
  },
  extensionBrowserBundle: async () => ({ html: "<button>Protected app</button>", spec: { tools: ["allowed"] } }),
}));
mock.module("../routes/api/tool-invoke/+server", () => ({ POST: async ({ request }: { request: Request }) => { invoked = request; return Response.json({ success: true, output: "result" }); } }));
const { GET, POST } = await import("../routes/api/extensions/[name]/preview/+server");
afterAll(() => restoreModuleMocks());
beforeEach(() => { permitted = true; calls = []; invoked = undefined; });

function event(body?: unknown, overrides: Record<string, unknown> = {}) {
  const url = new URL(`https://app.example/api/extensions/sealed/preview?${new URLSearchParams({ nonce, binding, conversationId: "owned" })}`);
  return { url, params: { name: "sealed" }, locals: { user: { id: "owner" } }, request: new Request(url, body === undefined ? {} : { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify(body) }), ...overrides } as never;
}

test("serves only live bound sandboxed bundles with immutable nonce", async () => {
  const response = await GET(event());
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(`Object.defineProperty(window,'__EZCORP_CANVAS_NONCE__',{value:"${nonce}"})`);
  expect(response.headers.get("content-security-policy")).toContain("sandbox allow-scripts;");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(calls).toEqual([["sealed", "owner", "owned", binding], ["sealed", "owner", "owned", binding]]);
  expect((await GET(event(undefined, { locals: {} }))).status).toBe(401);
  expect((await GET(event(undefined, { url: new URL("https://app.example/api/extensions/sealed/preview") }))).status).toBe(400);
  permitted = false;
  expect((await GET(event())).status).toBe(404);
});

test("forwards only sealed tools, host-selected identity, exact binding and cancellation", async () => {
  const requestEvent: any = event({ binding, conversationId: "owned", method: "tool.invoke", toolName: "allowed", input: { value: 1 } });
  const response = await POST(requestEvent);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await invoked!.json()).toMatchObject({ extensionName: "sealed", toolName: "allowed", input: { value: 1 }, conversationId: "owned", expectedReleaseBinding: binding });
  const controller = new AbortController();
  requestEvent.request = new Request(requestEvent.request.url, { method: "POST", headers: { origin: "https://app.example" }, signal: controller.signal, body: JSON.stringify({ binding, conversationId: "owned", method: "tool.invoke", toolName: "allowed", input: {} }) });
  await POST(requestEvent);
  controller.abort();
  expect(invoked!.signal.aborted).toBe(true);
});

test("denies missing sessions, null-origin CSRF, forged authority and undeclared tools", async () => {
  const body = { binding, conversationId: "owned", method: "tool.invoke", toolName: "allowed", input: {} };
  expect((await POST(event(body, { locals: {} }))).status).toBe(401);
  expect((await POST(event(body, { request: new Request("https://app.example", { method: "POST", headers: { origin: "null" }, body: JSON.stringify(body) }) }))).status).toBe(403);
  expect((await POST(event({ ...body, userId: "admin" }))).status).toBe(400);
  expect((await POST(event({ ...body, binding: "wrong" }))).status).toBe(400);
  expect((await POST(event({ ...body, toolName: "unlisted" }))).status).toBe(403);
  expect((await POST(event({ ...body, input: [] }))).status).toBe(403);
  expect((await POST(event({ ...body, method: "check" }))).status).toBe(200);
  permitted = false;
  expect((await POST(event(body))).status).toBe(403);
  expect(invoked).toBeUndefined();
});
