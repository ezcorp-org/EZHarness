import { beforeEach, expect, test, vi } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";
import { POST as install } from "../routes/api/extensions/author/install/+server";
import { POST as validate } from "../routes/api/extensions/author/draft/[id]/validate/+server";

const ports = vi.hoisted(() => ({ draft: vi.fn(), load: vi.fn(), verify: vi.fn(), install: vi.fn() }));
vi.mock("$server/db/queries/ez-drafts", () => ({ getDraft: ports.draft }));
vi.mock("$server/extensions/loader", () => ({ loadManifest: ports.load, loadManifestFresh: ports.load }));
vi.mock("$server/extensions/sdk/verify", () => ({ verifyExtension: ports.verify }));
vi.mock("$server/extensions/installer", () => ({ installFromLocal: ports.install }));
beforeEach(() => vi.clearAllMocks());

for (const [name, handler, scope] of [["install", install, "extensions"], ["validate", validate, "chat"]] as const) {
  test(`${name} returns 401 without a user and 403 for an insufficient key scope`, async () => {
    const event = makeRequestEvent("http://localhost/api/extensions/author/install", { params: { id: "draft" }, locals: {} });
    expect((await handler(event as never)).status).toBe(401);
    const denied = makeRequestEvent(event.url.href, { params: { id: "draft" }, locals: { user: { id: "owner", role: "admin" }, apiKeyScopes: ["read"] } });
    expect((await handler(denied as never)).status).toBe(403);
    expect(ports.draft).not.toHaveBeenCalled();
  });
  for (const role of ["admin", "member"]) {
    for (const input of [{}, { draftId: "../outside" }, { draftId: "owned", manifest: { permissions: { shell: true } } }, { draftId: "broken", skipVerify: true }]) {
      test(`${name} requires v4 for ${role} with ${JSON.stringify(input)} without reading or executing a draft`, async () => {
        const event = makeRequestEvent("http://localhost/api/extensions/author/install", { request: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }, params: { id: "owned" }, locals: { user: { id: "owner", role }, apiKeyScopes: [scope] } });
        const response = await handler(event as never);
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({ code: "extension_v4_required", controlUrl: "/api/extensions/control", openUrl: "/extensions/author" });
        for (const port of Object.values(ports)) expect(port).not.toHaveBeenCalled();
      });
    }
  }
}
