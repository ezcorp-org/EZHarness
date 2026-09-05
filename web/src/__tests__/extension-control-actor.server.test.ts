import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("$server/db/connection", () => ({ getDb: () => ({}) }));
vi.mock("$server/db/queries/extension-releases", () => ({ DatabaseLifecycleRepository: class { read = mocks.read; } }));
import { resolveControlActor } from "$lib/server/extensions/control-actor";
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue({ installation: { ownerId: "owner", scope: "project:owned" } }); });

test("no target uses global scope without reading installation data", async () => {
  expect(await resolveControlActor({ id: "owner", role: "member" }, "human")).toEqual({ principalId: "owner", scope: "global", kind: "human" });
  expect(mocks.read).not.toHaveBeenCalled();
});
test("owner and administrator receive only the stored target scope", async () => {
  for (const user of [{ id: "owner", role: "member" }, { id: "admin", role: "admin" }]) expect(await resolveControlActor(user, "human", "installation")).toEqual({ principalId: user.id, scope: "project:owned", kind: "human" });
  expect(mocks.read).toHaveBeenCalledWith("installation");
});
test("foreign and missing installations have the same non-disclosing refusal", async () => {
  await expect(resolveControlActor({ id: "stranger", role: "member" }, "agent", "installation")).rejects.toMatchObject({ code: "not_found", message: "Installation not found." });
  mocks.read.mockResolvedValue(null);
  await expect(resolveControlActor({ id: "owner", role: "member" }, "human", "missing")).rejects.toMatchObject({ code: "not_found", message: "Installation not found." });
});
