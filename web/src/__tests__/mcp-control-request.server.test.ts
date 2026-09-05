import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("$server/auth/middleware", () => ({ requireSessionAuth: mocks.auth }));
import { mcpControlRequest } from "../lib/server/extensions/mcp-request";

beforeEach(() => mocks.auth.mockReturnValue({ id: "admin", role: "admin" }));

test("requires an administrator session and returns staged operations", async () => {
  const action = vi.fn().mockResolvedValue({ operation: { state: "queued" } });
  mocks.auth.mockReturnValue(new Response("unauthorized", { status: 401 }));
  expect((await mcpControlRequest({} as never, null, action)).status).toBe(401);
  mocks.auth.mockReturnValue({ id: "member", role: "member" });
  expect((await mcpControlRequest({} as never, null, action)).status).toBe(403);
  expect(action).not.toHaveBeenCalled();
  mocks.auth.mockReturnValue({ id: "admin", role: "admin" });
  expect((await mcpControlRequest({} as never, null, action)).status).toBe(202);
  expect(action).toHaveBeenCalledWith({ principalId: "admin", scope: "global", kind: "human" }, {});
  expect((await mcpControlRequest({} as never, new Request("https://host", { method: "POST", body: '{"name":"test"}' }), action)).status).toBe(202);
  expect(action).toHaveBeenLastCalledWith(expect.anything(), { name: "test" });
});

test("bounds and validates request bytes before staging", async () => {
  const action = vi.fn();
  expect((await mcpControlRequest({} as never, new Request("https://host"), action)).status).toBe(400);
  for (const body of ["{", "x".repeat(65_537), new Uint8Array([255]), new Uint8Array([0xc3])]) {
    const response = await mcpControlRequest({} as never, new Request("https://host", { method: "POST", body }), action);
    expect(response.status).toBe(body.length > 65_536 ? 413 : 400);
  }
  expect(action).not.toHaveBeenCalled();
  action.mockRejectedValue({ code: "forbidden", message: "denied" });
  expect((await mcpControlRequest({} as never, null, action)).status).toBe(403);
});
