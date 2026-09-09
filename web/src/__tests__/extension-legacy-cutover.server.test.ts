import { expect, test, vi } from "vitest";
vi.mock("$server/auth/middleware", () => ({ requireAuth: (locals: { user: unknown }) => locals.user }));
vi.mock("$lib/server/security/api-keys", () => ({ requireScope: () => null }));
import { POST as activate } from "../routes/api/extensions/[id]/activate/+server";
import { legacyExtensionEndpoint } from "$lib/server/extensions/legacy-endpoint";
import { activateExtension } from "$lib/server/extensions/activate-extension";

test("legacy activation provides a structured migration response without granting permissions", async () => {
  const response = await activate({ locals: { user: { id: "admin" } } } as unknown as Parameters<typeof activate>[0]);
  expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({ code: "extension_v4_required", controlUrl: "/api/extensions/control", importUrl: "/api/extensions/import-source" });
  expect((await activateExtension("legacy", { submittedPermissions: { shell: true } }, "admin"))).toMatchObject({ ok: false, status: 410 });
  expect(legacyExtensionEndpoint().status).toBe(410);
});
