import { beforeEach, expect, test, vi } from "vitest";
import { LifecycleError } from "$server/extensions/v4/types";
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), decide: vi.fn() }));
vi.mock("$server/extensions/project-pull-request-broker", () => ({ getProjectPullRequests: () => mocks }));
vi.mock("$server/auth/middleware", () => ({ requireSessionAuth: (locals: { authMethod: string }) => locals.authMethod === "session" ? { id: "owner" } : new Response("Forbidden", { status: 403 }) }));
import { actions, load } from "../routes/(app)/extensions/project-proposals/[id]/+page.server";
function event(authMethod = "session", fields = { decision: "finalize", digest: "digest", reviewed: "yes" }) { return { params: { id: "proposal" }, locals: { authMethod }, request: new Request("http://localhost/extensions/project-proposals/proposal", { method: "POST", body: new URLSearchParams(fields) }) } as unknown as Parameters<NonNullable<typeof actions.default>>[0]; }
beforeEach(() => { vi.clearAllMocks(); mocks.inspect.mockResolvedValue({ state: "proposed", proposal: {} }); mocks.decide.mockResolvedValue({ state: "completed" }); });
test("review and decision require a real human session", async () => {
  expect(await load(event() as unknown as Parameters<typeof load>[0])).toMatchObject({ state: "proposed" });
  expect(mocks.inspect).toHaveBeenCalledWith({ principalId: "owner", scope: "global", kind: "human" }, "proposal");
  expect(await actions.default!(event())).toMatchObject({ message: expect.stringContaining("Decision recorded") });
  expect(mocks.decide).toHaveBeenCalledWith({ principalId: "owner", scope: "global", kind: "human" }, "proposal", "finalize", "digest");
  for (const auth of ["api-key", "internal"]) {
    await expect(load(event(auth) as unknown as Parameters<typeof load>[0])).rejects.toMatchObject({ status: 403 });
    await expect(actions.default!(event(auth))).rejects.toMatchObject({ status: 403 });
  }
});
test("unchecked or invalid actions never call broker and failures remain visible", async () => {
  for (const fields of [{ decision: "shell", digest: "digest", reviewed: "yes" }, { decision: "close", digest: "digest", reviewed: "no" }]) expect(await actions.default!(event("session", fields))).toMatchObject({ status: 400 });
  expect(mocks.decide).not.toHaveBeenCalled();
  mocks.decide.mockRejectedValue(new LifecycleError("changed", "Review changed"));
  expect(await actions.default!(event())).toMatchObject({ status: 409, data: { message: "Review changed" } });
  mocks.decide.mockRejectedValue(new Error("host-only-token"));
  expect(await actions.default!(event())).toMatchObject({ status: 409, data: { message: expect.stringContaining("Verify any partial") } });
  mocks.inspect.mockRejectedValue(new LifecycleError("missing", "Not found"));
  await expect(load(event() as unknown as Parameters<typeof load>[0])).rejects.toMatchObject({ status: 403, body: { message: "Not found" } });
  mocks.inspect.mockRejectedValue(new Error("host-only-token"));
  await expect(load(event() as unknown as Parameters<typeof load>[0])).rejects.toMatchObject({ status: 403, body: { message: "This project proposal cannot be reviewed." } });
});
