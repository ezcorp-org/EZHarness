import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enabled: false, getExtensionProjectBinding: vi.fn(), getProject: vi.fn(), readProjectGit: vi.fn(), execute: vi.fn() }));
vi.mock("$lib/server/test-surface", () => ({ isTestSurfaceEnabled: () => mocks.enabled }));
vi.mock("$server/auth/middleware", () => ({ requireSessionAuth: (locals: { authMethod: string }) => locals.authMethod === "session" ? { id: "owner" } : new Response("Forbidden", { status: 403 }) }));
vi.mock("$server/extensions/project-binding", () => mocks);
vi.mock("$server/extensions/project-git-broker", () => mocks);
vi.mock("$server/db/queries/projects", () => mocks);
vi.mock("$server/db/connection", () => ({ getDb: () => ({ execute: mocks.execute }) }));
import { POST } from "../routes/api/__test/project-proposal/+server";
function event(authMethod = "session", body: unknown = { installationId: "installation" }) { return { locals: { authMethod }, request: new Request("http://localhost/api/__test/project-proposal", { method: "POST", body: JSON.stringify(body) }) } as unknown as Parameters<typeof POST>[0]; }
beforeEach(() => { vi.clearAllMocks(); mocks.enabled = false; mocks.getExtensionProjectBinding.mockResolvedValue({ id: "binding", ownerId: "owner", projectId: "project" }); mocks.getProject.mockResolvedValue({ path: "/project" }); mocks.readProjectGit.mockResolvedValue("https://github.com/owner/repository"); });
test("fixture endpoint is absent unless test mode and a human owner are present", async () => {
  expect((await POST(event())).status).toBe(404);
  expect(mocks.getExtensionProjectBinding).not.toHaveBeenCalled();
  mocks.enabled = true;
  expect((await POST(event("api-key"))).status).toBe(403);
  expect((await POST(event("session", null))).status).toBe(400);
  mocks.getExtensionProjectBinding.mockResolvedValue(null);
  expect((await POST(event())).status).toBe(404);
  expect(mocks.execute).not.toHaveBeenCalled();
});
test("controlled fixture uses a host binding and exact GitHub project only", async () => {
  mocks.enabled = true;
  mocks.getProject.mockResolvedValue(null); expect((await POST(event())).status).toBe(400);
  mocks.getProject.mockResolvedValue({ path: "/project" }); mocks.readProjectGit.mockResolvedValue(null); expect((await POST(event())).status).toBe(400);
  mocks.readProjectGit.mockResolvedValue("https://github.com/owner/repository");
  const response = await POST(event());
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ controlledFixture: true, reviewUrl: expect.stringMatching(/^\/extensions\/project-proposals\//) });
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});
