import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { restoreModuleMocks, contextModule } from "../../../src/__tests__/helpers/mock-cleanup";

const binding = "a".repeat(64);
const nonce = crypto.randomUUID();
const requestId = crypto.randomUUID();
let permitted = true;
let calls: unknown[] = [];
let invoked: Request | undefined;
let controller = new AbortController();
let prepared: any;
let cancelled: any;
let claimed: any;
// $server/auth/middleware: spyOn()'d on the module `$server/auth/middleware`
// itself currently resolves to, not mock.module()'d — item C2 (W18
// hygiene). That alias is claimed by many files repo-wide (commit.test.ts
// among them, via mockServerAlias()); once ANY file's mock.module() call
// registers a given specifier string, a LATER mock.module() call for that
// same exact string is silently ignored for a consumer that links after it
// — measured directly, in every form tried (a beforeAll override, a
// module-top-level override, and a mock.module() of the underlying relative
// path instead of the alias): paired with commit.test.ts in one order, this
// file's route kept running the real, unmocked `requireSessionAuth` against
// every synthetic `locals` shape used here, failing closed with 403 instead
// of the intended 200/401/403-by-test-design. What DOES work: dynamically
// importing the alias to get whatever object it CURRENTLY resolves to
// (mocked or real), then `spyOn().mockImplementation()` to mutate that
// object's method in place — every future consumer of the same specifier,
// including this file's own route (imported right below), reads the SAME
// object, so the mutation reaches it regardless of registration order.
// Confirmed fixed in all three orders: alone, after commit.test.ts, and
// before it.
const aliasAuthMiddleware: any = await import("$server/auth/middleware");
const authSpy = spyOn(aliasAuthMiddleware, "requireSessionAuth")
  .mockImplementation((locals: any) => locals.user ?? new Response("Denied", { status: 401 }));
const contextExports = contextModule({ ensureInitialized: async () => {} });
mock.module("$lib/server/context", () => contextExports);
mock.module("$lib/server/extension-browser", () => ({
  authorizeExtensionBrowser: async (...args: unknown[]) => {
    calls.push(args);
    if (!permitted) throw new Error("private denial");
    return { binding, extension: { id: "installation", name: "sealed" }, active: { release: { artifactDigest: "digest" } }, conversation: { id: "owned" } };
  },
  extensionBrowserBundle: async () => ({ html: "<button>Protected app</button>", spec: { tools: ["allowed"] } }),
}));
mock.module("$server/extensions/browser-invocation-control", () => ({
  prepareBrowserInvocation: async (input: unknown) => { prepared = input; return { requestId, deadline: Date.now() + 60000 }; },
  cancelBrowserInvocation: async (...input: unknown[]) => { cancelled = input; return { state: "cancel_requested" }; },
  claimBrowserInvocation: async (...input: unknown[]) => { claimed = input; return { signal: controller.signal, assertActive: async () => {}, finish: async () => {}, dispose: async () => {} }; },
}));
mock.module("../routes/api/tool-invoke/+server", () => ({ _invokeWithControl: async ({ request }: { request: Request }, options: { signal: AbortSignal; invocationGuard: () => Promise<void> }) => { expect(options.signal).toBe(controller.signal); await options.invocationGuard(); invoked = request; return Response.json({ success: true, output: "result" }); } }));
const { GET, POST } = await import("../routes/api/extensions/[name]/preview/+server");
afterAll(() => {
  restoreModuleMocks();
  authSpy.mockRestore();
});
beforeEach(() => { permitted = true; calls = []; invoked = undefined; controller = new AbortController(); prepared = undefined; cancelled = undefined; claimed = undefined; });

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
  const requestEvent: any = event({ binding, conversationId: "owned", method: "tool.invoke", requestId, toolName: "allowed", input: { value: 1 } });
  const response = await POST(requestEvent);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await invoked!.json()).toMatchObject({ extensionName: "sealed", toolName: "allowed", input: { value: 1 }, conversationId: "owned", expectedReleaseBinding: binding });
  controller.abort();
  expect(invoked!.signal.aborted).toBe(true);
  expect(claimed[0]).toEqual({ principalId: "owner", installationId: "installation", releaseBinding: binding, conversationId: "owned" });
  expect(claimed[1]).toBe(requestId);
});

test("denies missing sessions, null-origin CSRF, forged authority and undeclared tools", async () => {
  const body = { binding, conversationId: "owned", method: "tool.invoke", requestId, toolName: "allowed", input: {} };
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

test("issues bound preparation and permits exact cancellation after release revocation", async () => {
  const response = await POST(event({ binding, conversationId: "owned", method: "prepare", toolName: "allowed", input: {} }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ requestId, installationId: "installation" });
  expect(prepared).toMatchObject({ principalId: "owner", installationId: "installation", releaseBinding: binding, conversationId: "owned" });
  expect(prepared.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(prepared.deadline).toBeGreaterThan(Date.now());
  expect((await POST(event({ binding, conversationId: "owned", method: "prepare", requestId, toolName: "allowed", input: {} }))).status).toBe(400);
  expect((await POST(event({ binding, conversationId: "owned", method: "tool.invoke", toolName: "allowed", input: {} }))).status).toBe(400);
  permitted = false;
  const cancel = await POST(event({ binding, conversationId: "owned", method: "cancel", requestId, installationId: "installation" }));
  expect(cancel.status).toBe(200);
  expect(cancelled).toEqual([{ principalId: "owner", installationId: "installation", releaseBinding: binding, conversationId: "owned" }, requestId]);
  expect((await POST(event({ binding, conversationId: "owned", method: "cancel", requestId: "forged", installationId: "installation" }))).status).toBe(400);
});
