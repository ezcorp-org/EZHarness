import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setExtensionProjectBinding: vi.fn() }));
vi.mock("$server/extensions/project-binding", () => mocks);
vi.mock("$server/auth/middleware", () => ({ requireSessionAuth: (locals: { authMethod: string }) => locals.authMethod === "session" ? { id: "owner" } : new Response("Human session required", { status: 403 }) }));
vi.mock("$lib/server/extensions/control-errors", () => ({ extensionControlError: () => new Response("Failed", { status: 400 }) }));
import { POST } from "../routes/api/extensions/releases/[installationId]/project/+server";
function event(body: unknown, authMethod = "session") { return { params: { installationId: "installation" }, locals: { authMethod }, request: new Request("http://localhost/api/extensions/releases/installation/project", { method: "POST", body: JSON.stringify(body) }) } as unknown as Parameters<typeof POST>[0]; }
beforeEach(() => { vi.clearAllMocks(); mocks.setExtensionProjectBinding.mockResolvedValue({ projectId: "project" }); });
test("project binding accepts only session identity and exact release proof", async () => {
  const input = { projectId: "project", releaseId: "release", generation: 4 };
  expect((await POST(event(input))).status).toBe(200);
  expect(mocks.setExtensionProjectBinding).toHaveBeenCalledWith({ principalId: "owner", scope: "global", kind: "human" }, { installationId: "installation", ...input });
  mocks.setExtensionProjectBinding.mockClear();
  for (const method of ["api-key", "internal", "bearer"]) expect((await POST(event(input, method))).status).toBe(403);
  expect(mocks.setExtensionProjectBinding).not.toHaveBeenCalled();
});
test("project binding validates input permits revoke and handles errors", async () => {
  for (const input of [null, {}, { projectId: 1, releaseId: "release", generation: 1 }, { projectId: "project", releaseId: "release", generation: "1" }]) expect((await POST(event(input))).status).toBe(400);
  expect((await POST(event({ projectId: null, releaseId: "release", generation: 1 }))).status).toBe(200);
  mocks.setExtensionProjectBinding.mockRejectedValue(new Error("stale"));
  expect((await POST(event({ projectId: "project", releaseId: "release", generation: 1 }))).status).toBe(400);
});
