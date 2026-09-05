import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ importSource: vi.fn() }));
vi.mock("$server/extensions/source-import", () => ({ importExtensionSource: mocks.importSource }));
vi.mock("$server/auth/middleware", () => ({ requireSessionAuth: (locals: { user?: unknown; authMethod?: string }) => locals.user && locals.authMethod === "session" ? locals.user : new Response("Session required", { status: 403 }) }));
import { POST } from "../routes/api/extensions/import-source/+server";

function event(body: unknown, authMethod = "session", role = "admin") {
  return { request: new Request("http://localhost/api/extensions/import-source", { method: "POST", body: JSON.stringify(body) }), locals: { user: { id: "admin", role }, authMethod } } as unknown as Parameters<typeof POST>[0];
}
beforeEach(() => { vi.clearAllMocks(); mocks.importSource.mockResolvedValue({ workspace: { id: "workspace" }, operation: { id: "build" }, openUrl: "/extensions/author" }); });

test("only a human administrator can import host sources", async () => {
  expect((await POST(event({ kind: "local", path: "/etc" }, "api-key"))).status).toBe(403);
  expect((await POST(event({ kind: "local", path: "/etc" }, "session", "member"))).status).toBe(403);
  expect(mocks.importSource).not.toHaveBeenCalled();
});
test("stages source with host-derived principal and no automatic approval", async () => {
  const response = await POST(event({ kind: "github", repository: "owner/repo" }));
  expect(response.status).toBe(200);
  expect(mocks.importSource).toHaveBeenCalledWith({ principalId: "admin", scope: "global", kind: "human" }, { kind: "github", repository: "owner/repo" });
  expect((await response.json()).operation.id).toBe("build");
});
test("rejects malformed and oversized import requests", async () => {
  expect((await POST(event({ kind: "github", repository: 5 }))).status).toBe(400);
  expect((await POST(event({ kind: "local", path: "a".repeat(20_000) }))).status).toBe(413);
  expect(mocks.importSource).not.toHaveBeenCalled();
});

test("reports source collection failure without granting or activating a release", async () => {
  mocks.importSource.mockRejectedValue(new Error("Source collection failed"));
  const response = await POST(event({ kind: "bundled", name: "ask-user" }));
  expect(response.status).toBe(500);
  expect(mocks.importSource).toHaveBeenCalledTimes(1);
});
