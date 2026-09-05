import { beforeEach, expect, test, vi } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const mocks = vi.hoisted(() => ({ updateExtension: vi.fn(), upsertSetting: vi.fn(), insertAuditEntry: vi.fn() }));
vi.mock("$server/db/queries/extensions", () => mocks);
vi.mock("$server/db/queries/settings", () => mocks);
vi.mock("$server/db/queries/audit-log", () => mocks);
import { POST } from "../routes/api/extensions/[id]/reapprove/+server";

beforeEach(() => vi.clearAllMocks());
for (const role of ["admin", "member"]) for (const scope of ["session", "conversation", "project", "forever"]) {
  test(`${role} cannot restore expired grants with ${scope} TTL consent`, async () => {
    for (const ttlOverrideMs of [undefined, null, 7 * 86400000, 0, -1]) {
      const response = await POST(makeRequestEvent("http://localhost/api/extensions/ext-1/reapprove", { params: { id: "ext-1" }, locals: { user: { id: "owner", role } }, request: { method: "POST", body: JSON.stringify({ capability: "shell", scope, ttlOverrideMs }) } }));
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: "extension_v4_required" });
    }
    expect(mocks.updateExtension).not.toHaveBeenCalled();
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
    expect(mocks.insertAuditEntry).not.toHaveBeenCalled();
  });
}
