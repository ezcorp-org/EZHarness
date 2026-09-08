import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ importSource: vi.fn() }));
vi.mock("$server/extensions/source-import", async () => ({ importExtensionSource: mocks.importSource, parseExtensionSourceInput: (await import("$server/extensions/source-input")).parseExtensionSourceInput }));
import { POST as importSource } from "../routes/api/extensions/import-source/+server";

function importEvent(body: unknown, authMethod = "session", role = "admin") {
  return { request: new Request("http://localhost/api/extensions/import-source", { method: "importSource", body: JSON.stringify(body) }), locals: { user: { id: "admin", role }, authMethod } } as unknown as Parameters<typeof importSource>[0];
}
beforeEach(() => { vi.clearAllMocks(); mocks.importSource.mockResolvedValue({ workspace: { id: "workspace" }, operation: { id: "build" }, openUrl: "/extensions/author" }); });

test("only a human administrator can import host sources", async () => {
  expect((await importSource(importEvent({ kind: "local", path: "/etc" }, "api-key"))).status).toBe(403);
  expect((await importSource(importEvent({ kind: "local", path: "/etc" }, "session", "member"))).status).toBe(403);
  expect(mocks.importSource).not.toHaveBeenCalled();
});
test("stages source with host-derived principal and no automatic approval", async () => {
  const response = await importSource(importEvent({ kind: "github", repository: "owner/repo" }));
  expect(response.status).toBe(200);
  expect(mocks.importSource).toHaveBeenCalledWith({ principalId: "admin", scope: "global", kind: "human" }, { kind: "github", repository: "owner/repo" });
  expect((await response.json()).operation.id).toBe("build");
});
test("marketplace source references stage a rebuild instead of activating a published artifact", async () => {
  const response = await importSource(importEvent({ kind: "marketplace", versionId: "version-1" }));
  expect(response.status).toBe(200);
  expect(mocks.importSource).toHaveBeenCalledWith({ principalId: "admin", scope: "global", kind: "human" }, { kind: "marketplace", versionId: "version-1" });
  expect((await response.json()).operation.id).toBe("build");
});
test("private source carries a project selection, not caller-supplied credentials", async () => {
  const source = { kind: "github", repository: "owner/private", projectId: "project" };
  expect((await importSource(importEvent(source))).status).toBe(200);
  expect(mocks.importSource).toHaveBeenCalledWith({ principalId: "admin", scope: "global", kind: "human" }, source);
  expect((await importSource(importEvent({ ...source, projectId: { token: "untrusted" } }))).status).toBe(400);
  expect(mocks.importSource).toHaveBeenCalledTimes(1);
});
test("rejects malformed and oversized import requests", async () => {
  expect((await importSource(importEvent({ kind: "github", repository: 5 }))).status).toBe(400);
  expect((await importSource(importEvent({ kind: "local", path: "a".repeat(20_000) }))).status).toBe(413);
  expect(mocks.importSource).not.toHaveBeenCalled();
});

test("reports source collection failure without granting or activating a release", async () => {
  mocks.importSource.mockRejectedValue(new Error("Source collection failed"));
  const response = await importSource(importEvent({ kind: "bundled", name: "ask-user" }));
  expect(response.status).toBe(500);
  expect(mocks.importSource).toHaveBeenCalledTimes(1);
});

test("members can submit an explicit target for shared owner authorization but cannot create installations", async () => {
  const targeted = { kind: "github", repository: "owner/repo", targetInstallationId: "existing" };
  expect((await importSource(importEvent(targeted, "session", "member"))).status).toBe(200);
  expect(mocks.importSource).toHaveBeenCalledWith({ principalId: "admin", scope: "global", kind: "human" }, targeted);
  mocks.importSource.mockClear();
  expect((await importSource(importEvent({ kind: "github", repository: "owner/repo" }, "session", "member"))).status).toBe(403);
  expect(mocks.importSource).not.toHaveBeenCalled();
});

test("rejects credential injection and malformed JSON before source effects", async () => {
  expect((await importSource(importEvent({ kind: "github", repository: "owner/repo", token: "secret" }))).status).toBe(400);
  const malformed = importEvent({});
  malformed.request = new Request("http://localhost/api/extensions/import-source", { method: "importSource", body: "{" });
  expect((await importSource(malformed)).status).toBe(400);
  expect(mocks.importSource).not.toHaveBeenCalled();
});

import { makeRequestEvent } from "./helpers/server-route-test-utils";
import { POST as legacyInstall } from "../routes/api/extensions/author/install/+server";
import { POST as legacyValidate } from "../routes/api/extensions/author/draft/[id]/validate/+server";
for (const [name, handler] of [["install", legacyInstall], ["validate", legacyValidate]] as const) {
  test(`${name} requires authentication and redirects old draft requests to immutable workspaces`, async () => {
    const event = makeRequestEvent("http://localhost/api/extensions/author/install", { params: { id: "draft" }, request: { method: "POST" } });
    expect((await handler(event as never)).status).toBe(401);
    event.locals = { user: { id: "admin", role: "admin" } } as never;
    const response = await handler(event as never);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "extension_v4_required", controlUrl: "/api/extensions/control", openUrl: "/extensions/author" });
    expect(mocks.importSource).not.toHaveBeenCalled();
  });
}

test("missing human identity is rejected before malformed request bytes are read", async () => {
  const event = importEvent({});
  event.locals = {};
  event.request = new Request(event.request.url, { method: "POST", body: "{" });
  const response = await importSource(event);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Authentication required" });
  expect(mocks.importSource).not.toHaveBeenCalled();
});

test("a selected host directory is passed unchanged under human authority", async () => {
  const source = { kind: "local", path: "/reviewed/extensions/weather" };
  const response = await importSource(importEvent(source));
  expect(response.status).toBe(200);
  expect(mocks.importSource).toHaveBeenCalledExactlyOnceWith({ principalId: "admin", scope: "global", kind: "human" }, source);
  expect(await response.json()).toEqual({ workspace: { id: "workspace" }, operation: { id: "build" }, openUrl: "/extensions/author" });
});

test("a bundled source name selects a rebuild without supplying grants", async () => {
  const source = { kind: "bundled", name: "ask-user" };
  const response = await importSource(importEvent(source));
  expect(response.status).toBe(200);
  expect(mocks.importSource).toHaveBeenCalledExactlyOnceWith({ principalId: "admin", scope: "global", kind: "human" }, source);
  expect((await response.json()).workspace.id).toBe("workspace");
});

test("a target installation cannot let a member read host-local source", async () => {
  const response = await importSource(importEvent({ kind: "local", path: "/etc", targetInstallationId: "owned" }, "session", "member"));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "forbidden" });
  expect(mocks.importSource).not.toHaveBeenCalled();
});

test("source revision conflicts remain actionable without exposing private errors", async () => {
  mocks.importSource.mockRejectedValueOnce({ code: "revision_conflict", message: "Read current revision." });
  const response = await importSource(importEvent({ kind: "github", repository: "owner/repo" }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: "revision_conflict", message: "Read current revision." });
  expect(mocks.importSource).toHaveBeenCalledTimes(1);
});

test("a delegated source refusal preserves the opaque HTTP denial", async () => {
  mocks.importSource.mockRejectedValueOnce(Response.json({ code: "not_found", message: "Installation not found." }, { status: 404 }));
  const response = await importSource(importEvent({ kind: "github", repository: "owner/repo", targetInstallationId: "foreign" }, "session", "member"));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ code: "not_found", message: "Installation not found." });
  expect(mocks.importSource).toHaveBeenCalledTimes(1);
});
