import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), approve: vi.fn() }));
vi.mock("$server/extensions/extension-lifecycle-service", () => ({ getExtensionControl: async () => mocks, getExtensionLifecycle: async () => mocks }));
vi.mock("$server/auth/middleware", () => ({
  requireAuth: (locals: { user?: { id: string } }) => { if (!locals.user) throw new Response("Unauthorized", { status: 401 }); return locals.user; },
  requireSessionAuth: (locals: { user?: { id: string }; authMethod?: string }) => locals.user && locals.authMethod === "session" ? locals.user : new Response("Human session required", { status: 403 }),
}));
vi.mock("$lib/server/security/api-keys", () => ({ requireScope: (locals: { scopes?: string[]; authMethod?: string }, scope: string) => locals.authMethod === "session" || locals.scopes?.includes(scope) ? null : new Response("Missing scope", { status: 403 }) }));
import { POST as control } from "../routes/api/extensions/control/+server";
import { POST as approve } from "../routes/api/extensions/releases/[installationId]/approve/+server";
import { extensionControlError } from "$lib/server/extensions/control-errors";

function event(body: unknown, authMethod = "api-key", scopes = ["extensions"]) {
  return { request: new Request("http://localhost/api/extensions/control", { method: "POST", body: JSON.stringify(body) }), locals: { user: { id: "user" }, authMethod, scopes }, params: { installationId: "installation" } } as unknown as Parameters<typeof control>[0] & Parameters<typeof approve>[0];
}

beforeEach(() => { vi.clearAllMocks(); mocks.execute.mockResolvedValue({ ok: true }); mocks.approve.mockResolvedValue({ status: "approved" }); });

test("API keys can drive control only with the extensions scope", async () => {
  expect((await control(event({ tool: "extensions_describe", input: {} }, "api-key", []))).status).toBe(403);
  expect(mocks.execute).not.toHaveBeenCalled();
  expect((await control(event({ tool: "extensions_describe", input: {} }))).status).toBe(200);
  expect(mocks.execute.mock.calls[0]![0]).toEqual({ principalId: "user", scope: "global", kind: "agent" });
});

test("unknown tools and malformed input cannot reach lifecycle", async () => {
  for (const body of [null, {}, { tool: "extensions_approve", input: {} }, { tool: "extensions_build", input: [] }]) expect((await control(event(body))).status).toBe(400);
  expect(mocks.execute).not.toHaveBeenCalled();
});

test("approval rejects API keys, internal credentials and unstamped authentication", async () => {
  for (const authMethod of ["api-key", "internal", ""]) expect((await approve(event({ approvalId: "approval", decision: true }, authMethod, ["admin", "extensions"]))).status).toBe(403);
  expect(mocks.approve).not.toHaveBeenCalled();
});

test("human sessions approve the exact named release approval", async () => {
  expect((await approve(event({ approvalId: "approval", decision: true }, "session"))).status).toBe(200);
  expect(mocks.approve).toHaveBeenCalledWith({ principalId: "user", scope: "global", kind: "human" }, "installation", "approval", true);
  expect((await approve(event({ approvalId: 3, decision: true }, "session"))).status).toBe(400);
});

test("lifecycle conflicts and denial codes remain machine-readable", async () => {
  mocks.execute.mockRejectedValue({ code: "revision_conflict", message: "Read the current revision." });
  const response = await control(event({ tool: "extensions_build", input: {} }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "revision_conflict" });
  expect(extensionControlError(new Response("denied", { status: 403 })).status).toBe(403);
  expect(extensionControlError({ code: "generation_superseded", message: "Release changed." }).status).toBe(409);
  mocks.approve.mockRejectedValue({ code: "stale_approval", message: "Release changed." });
  expect((await approve(event({ approvalId: "approval", decision: true }, "session"))).status).toBe(409);
});
