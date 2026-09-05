import { describe, expect, test } from "bun:test";
import { clampExtensionPermissions } from "../clamp-permissions";
import { buildFullGrantFromManifest } from "../install-grant";
import type { ExtensionManifestV2 } from "../types";

describe("host API permission grants", () => {
  test("exact release grants retain trigger and message declarations without changing exclusion policy", () => {
    const permissions = { webhooks: ["tickets"], loopEvents: true, appendMessages: { excludedDefault: true } };
    const manifest: ExtensionManifestV2 = { schemaVersion: 4, name: "fixture", version: "1.0.0", description: "Fixture", author: { name: "Test" }, permissions };
    const grant = buildFullGrantFromManifest(manifest, 123);
    expect(grant).toMatchObject({ ...permissions, grantedAt: { webhooks: 123, loopEvents: 123, appendMessages: 123 } });
    expect(clampExtensionPermissions({ appendMessages: { excludedDefault: false } }, permissions).appendMessages).toBeUndefined();
    expect(clampExtensionPermissions(permissions, {}).appendMessages).toBeUndefined();
  });
  test("intersects exact route and event IDs without wildcard escalation", () => {
    const grant = clampExtensionPermissions({ hostApi: { routes: [{ method: "GET", path: "/api/tasks" }, { method: "POST", path: "/api/admin" }, { method: "GET", path: "/api/*" }], events: true } }, { hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: false } });
    expect(grant.hostApi).toEqual({ routes: [{ method: "GET", path: "/api/tasks" }], events: false });
    expect(clampExtensionPermissions({}, { hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: false } }).hostApi).toBeUndefined();
    expect(clampExtensionPermissions({ hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: false } }, {}).hostApi).toBeUndefined();
  });

  test("full exact-release grants retain and timestamp host API permissions", () => {
    const manifest: ExtensionManifestV2 = { schemaVersion: 3, name: "fixture", version: "1.0.0", description: "Test", author: { name: "Test" }, permissions: { hostApi: { routes: [{ method: "GET", path: "/api/tasks" }], events: true } } };
    const grant = buildFullGrantFromManifest(manifest, 12_345);
    expect(grant.hostApi).toEqual({ routes: [{ method: "GET", path: "/api/tasks" }], events: true });
    expect(grant.grantedAt.hostApi).toBe(12_345);
  });
});
