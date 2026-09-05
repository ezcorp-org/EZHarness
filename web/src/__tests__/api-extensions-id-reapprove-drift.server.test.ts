import { beforeEach, expect, test, vi } from "vitest";
import { makeRequestEvent, expectThrownResponse } from "./helpers/server-route-test-utils";

const mocks = vi.hoisted(() => ({ previewBundledDrift: vi.fn(), reapproveBundledDrift: vi.fn(), updateExtension: vi.fn() }));
vi.mock("$server/extensions/bundled-drift-reapprove", () => mocks);
vi.mock("$server/db/queries/extensions", () => mocks);
import { GET, POST } from "../routes/api/extensions/[id]/reapprove-drift/+server";

beforeEach(() => vi.clearAllMocks());
for (const [method, handler] of [["GET", GET], ["POST", POST]] as const) {
  test(`${method} never evaluates disk config or changes grants, even for administrators`, async () => {
    for (const role of ["admin", "member"]) {
      const response = await handler(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove-drift", { params: { id: "ext-1" }, locals: { user: { id: "owner", role } }, request: { method } }));
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ reviewUrl: "/extensions/author?installation=ext-1" });
    }
    expect(mocks.previewBundledDrift).not.toHaveBeenCalled();
    expect(mocks.reapproveBundledDrift).not.toHaveBeenCalled();
    expect(mocks.updateExtension).not.toHaveBeenCalled();
  });
  test(`${method} requires authentication`, async () => {
    await expectThrownResponse(() => handler(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove-drift", { params: { id: "ext-1" }, request: { method } })), 401);
  });
}
